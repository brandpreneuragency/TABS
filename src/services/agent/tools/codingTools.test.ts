import { describe, expect, it } from 'vitest';
import type { AgentToolResult, ToolExecutionContext } from '../../../types/agent';
import { classifyToolRecoveryClass } from '../recoveryManager';
import { MemoryPolicyStore, PolicyEngine } from '../policyEngine';
import { redactSecrets } from '../redaction';
import { ToolRegistry } from '../toolRegistry';
import {
  CODING_TOOL_NAMES,
  FILE_READ_DEFAULT_LIMIT,
  FILE_READ_MAX_LIMIT,
  SEARCH_MATCH_LIMIT,
  SHELL_DEFAULT_TIMEOUT_MS,
  SHELL_MAX_TIMEOUT_MS,
  hashContent,
  normalizeGlobPattern,
  normalizeRelativeToolPath,
} from './codingSupport';
import {
  createCodingNativeAdapter,
  type CodingNativeAdapter,
  type NativeFileReadResult,
  type NativeFileTextResult,
  type NativeGitResult,
  type NativeGlobResult,
  type NativeGrepResult,
  type NativeShellResult,
} from './codingNativeAdapter';
import { FILE_TOOL_NAMES, createFileTools, type OpenWorkspaceFile } from './fileTools';
import { SHELL_TOOL_NAMES, createShellTools } from './shellTools';
import { WEB_TOOL_NAMES, createWebTools } from './webTools';

function context(extra: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    runId: 'run-1',
    turn: 1,
    executionEpoch: 0,
    mode: extra.mode ?? 'guided',
    contextRefs: [],
    abortSignal: extra.abortSignal ?? new AbortController().signal,
    workspaceScope: extra.workspaceScope ?? {
      workspaceId: 'ws-1',
      rootPath: '/workspace',
      rootRevision: 'ws-rev',
      nativeScopeId: 'scope-1',
    },
    operationId: extra.operationId ?? 'run-1:t1:tc0',
    toolIndex: extra.toolIndex ?? 0,
  };
}

async function exec(
  tool: { execute: (context: ToolExecutionContext, args: unknown) => Promise<unknown> },
  ctx: ToolExecutionContext,
  args: unknown,
): Promise<AgentToolResult> {
  return await tool.execute(ctx, args) as AgentToolResult;
}

function byName(tools: ReturnType<typeof createFileTools>) {
  return Object.fromEntries(tools.map((tool) => [tool.name, tool]));
}

class FakeNative implements CodingNativeAdapter {
  files = new Map<string, string>();
  globPaths: string[] = [];
  grepCancelled = false;
  shell: NativeShellResult = {
    stdout: 'ok',
    stderr: '',
    exitCode: 0,
    timedOut: false,
    truncated: false,
    cancelled: false,
  };
  git: NativeGitResult = { output: '', truncated: false };
  cancelledIds: string[] = [];
  writes = 0;
  edits = 0;
  shells = 0;

  async fileText(_scopeId: string, path: string): Promise<NativeFileTextResult> {
    const content = this.files.get(path);
    return content === undefined ? { exists: false, content: '' } : { exists: true, content };
  }

  async fileRead(input: {
    scopeId: string;
    path: string;
    offset?: number;
    limit?: number;
  }): Promise<NativeFileReadResult> {
    const text = this.files.get(input.path);
    if (text === undefined) throw new Error(`not a file: ${input.path}`);
    const lines = text.split('\n');
    const total = lines.length === 1 && lines[0] === '' ? 0 : lines.length;
    const offset = input.offset ?? 1;
    if (offset < 1 || (total === 0 && offset > 1) || (total > 0 && offset > total)) {
      throw new Error('ReadOffsetOutOfRange');
    }
    const start = offset - 1;
    const limit = input.limit ?? FILE_READ_DEFAULT_LIMIT;
    const end = Math.min(start + limit, total);
    return {
      content: lines.slice(start, end).map((line, index) => `${String(start + index + 1).padStart(6, ' ')}\t${line}`).join('\n'),
      lineCount: total,
      truncated: end < total,
    };
  }

  async fileWrite(_scopeId: string, path: string, content: string) {
    this.writes += 1;
    this.files.set(path, content);
    return { bytesWritten: content.length };
  }

  async fileEdit(input: { path: string; oldText: string; newText: string; replaceAll: boolean }) {
    const current = this.files.get(input.path);
    if (current === undefined) throw new Error(`not a file: ${input.path}`);
    this.edits += 1;
    this.files.set(input.path, input.replaceAll ? current.split(input.oldText).join(input.newText) : current.replace(input.oldText, input.newText));
    return { replacements: 1 };
  }

  async glob(): Promise<NativeGlobResult> {
    return { paths: this.globPaths, truncated: this.globPaths.length > SEARCH_MATCH_LIMIT, cancelled: false };
  }

  async grep(): Promise<NativeGrepResult> {
    if (this.grepCancelled) return { matches: [], truncated: false, cancelled: true };
    return { matches: [{ path: 'notes.md', line: 1, text: 'hello' }], truncated: false, cancelled: false };
  }

  async shellExec(): Promise<NativeShellResult> {
    this.shells += 1;
    return { ...this.shell };
  }

  async gitStatus(): Promise<NativeGitResult> {
    return this.git;
  }

  async gitDiff(): Promise<NativeGitResult> {
    return this.git;
  }

  async cancel(cancelId: string): Promise<boolean> {
    this.cancelledIds.push(cancelId);
    this.shell = { ...this.shell, cancelled: true };
    return true;
  }
}

describe('coding path helpers', () => {
  it('rejects path traversal and glob escapes', () => {
    expect(() => normalizeRelativeToolPath('../secret')).toThrow(/parent/);
    expect(() => normalizeRelativeToolPath('/etc/passwd')).toThrow(/relative path/);
    expect(() => normalizeGlobPattern('../*.ts')).toThrow(/parent/);
    expect(() => normalizeGlobPattern('/tmp/*.ts')).toThrow(/relative/);
    expect(normalizeGlobPattern('src/**/*.ts')).toBe('src/**/*.ts');
  });
});

describe('file tools', () => {
  it('registers the coding file tools', () => {
    expect(FILE_TOOL_NAMES).toEqual(['file_read', 'file_write', 'file_edit', 'glob', 'grep']);
    expect(CODING_TOOL_NAMES).toEqual([
      'file_read', 'file_write', 'file_edit', 'glob', 'grep',
      'shell_exec', 'git_status', 'git_diff', 'web_search',
    ]);
  });

  it('returns the editor buffer for an open dirty file', async () => {
    const native = new FakeNative();
    native.files.set('notes.md', 'disk');
    const open: OpenWorkspaceFile = {
      workspaceId: 'ws-1',
      path: '/workspace/notes.md',
      relativePath: 'notes.md',
      documentId: 'scope:scope-1:notes.md',
      content: 'dirty editor\nsecond',
      isDirty: true,
      isOpen: true,
    };
    const tools = byName(createFileTools({
      native,
      isDesktop: () => true,
      getOpenFile: () => open,
    }));
    const result = await exec(tools.file_read, context(), { path: 'notes.md', offset: 1, limit: 10 });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ source: 'editor' });
    expect(String((result.data as { content: string }).content)).toContain('dirty editor');
  });

  it('rejects stale hashes on closed files and accepts absent creates', async () => {
    const native = new FakeNative();
    native.files.set('notes.md', 'old');
    const tools = byName(createFileTools({ native, isDesktop: () => true }));
    const stale = await exec(tools.file_write, context(), {
      path: 'notes.md',
      expectedHash: await hashContent('other'),
      content: 'new',
    });
    expect(stale.ok).toBe(false);
    expect(stale.error?.code).toBe('stale_revision');
    expect(native.writes).toBe(0);

    const created = await exec(tools.file_write, context(), {
      path: 'fresh.md',
      expectedHash: 'absent',
      content: 'hello',
    });
    expect(created.ok).toBe(true);
    expect(native.writes).toBe(1);
    expect(native.files.get('fresh.md')).toBe('hello');
  });

  it('routes open-file writes through document commands', async () => {
    let updated = 0;
    const native = new FakeNative();
    const content = 'open body';
    const revision = await hashContent(content);
    const tools = byName(createFileTools({
      native,
      isDesktop: () => true,
      getOpenFile: () => ({
        workspaceId: 'ws-1',
        path: '/workspace/notes.md',
        relativePath: 'notes.md',
        documentId: 'doc-1',
        content,
        isDirty: true,
        isOpen: true,
      }),
      updateDocument: async (args) => {
        updated += 1;
        expect(args.documentId).toBe('doc-1');
        expect(args.expectedRevision).toBe(revision);
        return {
          ok: true,
          documentId: 'doc-1',
          revision: await hashContent('next'),
          operation: 'updated',
          snapshot: {
            documentId: 'doc-1',
            workspaceId: 'ws-1',
            title: 'notes.md',
            content: 'next',
            revision: await hashContent('next'),
            path: '/workspace/notes.md',
            relativePath: 'notes.md',
            scopeId: 'scope-1',
            kind: 'file',
            isDirty: true,
          },
        };
      },
    }));
    const result = await exec(tools.file_write, context(), {
      path: 'notes.md',
      expectedHash: revision,
      content: 'next',
    });
    expect(result.ok).toBe(true);
    expect(updated).toBe(1);
    expect(native.writes).toBe(0);
  });

  it('rejects out-of-range reads', async () => {
    const native = new FakeNative();
    native.files.set('notes.md', 'only one line');
    const tools = byName(createFileTools({ native, isDesktop: () => true }));
    const result = await exec(tools.file_read, context(), { path: 'notes.md', offset: 40, limit: 10 });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('validation_failed');
    expect(FILE_READ_MAX_LIMIT).toBe(2_000);
  });

  it('cancels grep when the native search is cancelled', async () => {
    const native = new FakeNative();
    native.grepCancelled = true;
    const tools = byName(createFileTools({ native, isDesktop: () => true }));
    const result = await exec(tools.grep, context(), { pattern: 'hello' });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('cancelled');
  });
});

describe('shell and git tools', () => {
  it('disables shell and git in browser preview', async () => {
    const native = new FakeNative();
    const tools = Object.fromEntries(createShellTools({ native, isDesktop: () => false }).map((tool) => [tool.name, tool]));
    const shell = await exec(tools.shell_exec, context(), {
      command: 'echo hi',
      workingDirectoryKey: 'workspace',
      timeoutMs: 1_000,
    });
    const git = await exec(tools.git_status, context(), {});
    expect(shell.error?.code).toBe('unavailable');
    expect(git.error?.code).toBe('unavailable');
    expect(native.shells).toBe(0);
  });

  it('never retries an interrupted shell automatically', async () => {
    const native = new FakeNative();
    native.shell = {
      stdout: '',
      stderr: '',
      exitCode: -1,
      timedOut: false,
      truncated: false,
      cancelled: true,
    };
    const [shell] = createShellTools({ native, isDesktop: () => true });
    expect(shell.supportsRetry).toBe(false);
    const result = await exec(shell, context(), {
      command: 'sleep 30',
      workingDirectoryKey: 'workspace',
      timeoutMs: 1_000,
    });
    expect(result.error?.code).toBe('interrupted');
    expect(result.error?.retryable).toBe(false);
    expect(classifyToolRecoveryClass({ toolName: 'shell_exec', risk: 'process_execute' })).toBe('shell');
    expect(SHELL_TOOL_NAMES).toEqual(['shell_exec', 'git_status', 'git_diff']);
  });

  it('records timeout and truncated shell output without retrying', async () => {
    const native = new FakeNative();
    native.shell = {
      stdout: 'x'.repeat(100),
      stderr: '',
      exitCode: -1,
      timedOut: true,
      truncated: true,
      cancelled: false,
    };
    const [shell] = createShellTools({ native, isDesktop: () => true });
    const timeout = await exec(shell, context(), {
      command: 'yes',
      workingDirectoryKey: 'workspace',
      timeoutMs: SHELL_DEFAULT_TIMEOUT_MS,
    });
    expect(timeout.error?.code).toBe('timeout');
    expect(timeout.error?.retryable).toBe(false);
    expect((timeout.data as { truncated: boolean }).truncated).toBe(true);
    expect(SHELL_MAX_TIMEOUT_MS).toBe(10 * 60 * 1_000);
  });
});

describe('web search tool', () => {
  it('runs only when selected and allowed, and redacts secrets', async () => {
    let calls = 0;
    const tools = createWebTools({
      search: async ({ query, provider }) => {
        calls += 1;
        expect(provider).toBe('tavily');
        return [{ title: `hit for ${query}`, url: 'https://example.com', excerpt: 'token sk-abcdefghijklmnopqrstuvwxyz123456' }];
      },
    });
    const registry = new ToolRegistry({
      policy: new PolicyEngine({ store: new MemoryPolicyStore() }),
      tools,
    });
    expect(WEB_TOOL_NAMES).toEqual(['web_search']);
    expect(calls).toBe(0);

    const denied = await registry.invoke(context({ mode: 'read_only' }), 'web_search', {
      query: 'today',
      provider: 'tavily',
      maxResults: 3,
    }, { run: { runId: 'run-1', mode: 'read_only', policyRevision: 1, contextRefs: [] } });
    expect(denied.decision.outcome).toBe('ask');
    expect(calls).toBe(0);

    const allowed = await exec(tools[0], context(), {
      query: 'today',
      provider: 'tavily',
      maxResults: 3,
    });
    expect(allowed.ok).toBe(true);
    expect(calls).toBe(1);
    const excerpt = (allowed.data as { results: Array<{ excerpt: string }> }).results[0]?.excerpt ?? '';
    expect(excerpt).toBe(redactSecrets('token sk-abcdefghijklmnopqrstuvwxyz123456'));
    expect(excerpt).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
  });

  it('maps missing credentials and rate limits to structured errors', async () => {
    const missing = createWebTools({
      search: async () => {
        throw new Error('No search API key configured. Add a Tavily or Exa key in Settings.');
      },
    });
    const unavailable = await exec(missing[0], context(), { query: 'q', provider: 'exa', maxResults: 1 });
    expect(unavailable.error?.code).toBe('unavailable');

    const limited = createWebTools({
      search: async () => {
        throw new Error('provider 429 rate limit');
      },
    });
    const rate = await exec(limited[0], context(), { query: 'q', provider: 'exa', maxResults: 1 });
    expect(rate.error?.code).toBe('rate_limited');
  });
});

describe('coding native adapter', () => {
  it('invokes scoped commands rather than a model-supplied root', async () => {
    const invoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
      expect(args?.workspaceRoot).toBeUndefined();
      if (command === 'ai_file_text') return { exists: true, content: 'hi' } as T;
      if (command === 'ai_tool_cancel') return true as T;
      return { content: 'hi', lineCount: 1, truncated: false } as T;
    };
    const adapter = createCodingNativeAdapter(invoke);
    await expect(adapter.fileText('scope-1', 'notes.md')).resolves.toEqual({ exists: true, content: 'hi' });
  });
});
