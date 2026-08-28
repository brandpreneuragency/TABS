// ---------------------------------------------------------------------------
// TABS Work-OS Harness — File read, write, edit, glob, and grep tools
// Native workspace scopes only. Open dirty files use document commands.
// Closed files use expected SHA-256 hashes or the `absent` sentinel.
// ---------------------------------------------------------------------------

import type { AgentToolDefinition, AgentToolResult, ToolExecutionContext } from '../../../types/agent';
import type { DocumentMutationResult, DocumentUpdateArgs } from '../../documents/documentCommands';
import { omitEffectExcludedFields } from './mutationSupport';
import {
  ABSENT_HASH,
  asRecord,
  asString,
  browserDisabled,
  cancelled,
  clampSearchLimit,
  defaultIsDesktop,
  defineCodingTool,
  EXPECTED_HASH_SCHEMA,
  fail,
  FILE_READ_DEFAULT_LIMIT,
  FILE_READ_MAX_LIMIT,
  FILE_TOOL_NAMES,
  hashContent,
  isExpectedFileHash,
  mapNativeError,
  normalizeGlobPattern,
  normalizeRelativeToolPath,
  objectSchema,
  READ_TOOL_TIMEOUT_MS,
  requireNativeScope,
  SEARCH_MATCH_LIMIT,
  workspaceFileKey,
} from './codingSupport';
import {
  codingNativeAdapter,
  type CodingNativeAdapter,
  type NativeGrepMatch,
} from './codingNativeAdapter';

export { FILE_TOOL_NAMES };

export interface OpenWorkspaceFile {
  workspaceId: string;
  path: string;
  relativePath?: string;
  documentId?: string;
  content: string;
  isDirty: boolean;
  isOpen: boolean;
}

export interface FileToolDependencies {
  native?: CodingNativeAdapter;
  isDesktop?: () => boolean;
  getOpenFile?: (workspaceId: string, relativePath: string) => OpenWorkspaceFile | undefined;
  updateDocument?: (args: DocumentUpdateArgs) => Promise<DocumentMutationResult>;
}

function matchOpenPath(open: OpenWorkspaceFile, relativePath: string, rootPath?: string): boolean {
  const needle = relativePath.replace(/\\/g, '/');
  const path = open.path.replace(/\\/g, '/');
  const relative = (open.relativePath ?? '').replace(/\\/g, '/');
  if (relative === needle || path === needle || path.endsWith(`/${needle}`)) return true;
  if (rootPath) {
    const full = `${rootPath.replace(/\\/g, '/').replace(/\/$/, '')}/${needle}`;
    if (path === full) return true;
  }
  return false;
}

function openFileFor(
  deps: FileToolDependencies,
  context: ToolExecutionContext,
  relativePath: string,
): OpenWorkspaceFile | undefined {
  const workspaceId = context.workspaceScope?.workspaceId;
  if (!workspaceId || !deps.getOpenFile) return undefined;
  const open = deps.getOpenFile(workspaceId, relativePath);
  if (!open || !open.isOpen) return undefined;
  if (!matchOpenPath(open, relativePath, context.workspaceScope?.rootPath)) return undefined;
  return open;
}

function usesDocumentBoundary(open: OpenWorkspaceFile | undefined): open is OpenWorkspaceFile {
  return Boolean(open?.isOpen);
}

async function currentClosedHash(
  native: CodingNativeAdapter,
  scopeId: string,
  path: string,
): Promise<string> {
  const text = await native.fileText(scopeId, path);
  if (!text.exists) return ABSENT_HASH;
  return hashContent(text.content);
}

function staleHash(expected: string, observed: string): AgentToolResult {
  return {
    ok: false,
    summary: `File hash ${observed} does not match expected ${expected}`,
    observedRevision: observed,
    error: {
      code: 'stale_revision',
      message: `File hash ${observed} does not match expected ${expected}`,
      retryable: false,
    },
  };
}

function documentConflict(result: Extract<DocumentMutationResult, { ok: false }>): AgentToolResult {
  const code = result.reason === 'stale_revision' ? 'stale_revision' : 'conflict';
  return {
    ok: false,
    summary: `Open file ${result.reason.replace(/_/g, ' ')}`,
    observedRevision: result.currentRevision,
    data: { reason: result.reason, documentId: result.documentId, content: result.content },
    error: { code, message: `Open file ${result.reason.replace(/_/g, ' ')}`, retryable: false },
  };
}

function countMatches(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) break;
    count += 1;
    from = at + needle.length;
  }
  return count;
}

function applyEdit(content: string, oldText: string, newText: string, replaceAll: boolean): string {
  return replaceAll ? content.split(oldText).join(newText) : content.replace(oldText, newText);
}

function sliceLines(content: string, offset: number, limit: number): {
  content: string;
  offset: number;
  lineCount: number;
  truncated: boolean;
} {
  const lines = content.split('\n');
  const total = lines.length === 1 && lines[0] === '' ? 0 : lines.length;
  if (offset < 1 || (total === 0 && offset > 1) || (total > 0 && offset > total)) {
    throw new Error('ReadOffsetOutOfRange');
  }
  if (total === 0) {
    return { content: '', offset: 1, lineCount: 0, truncated: false };
  }
  const start = offset - 1;
  const end = Math.min(start + limit, total);
  const sliced = lines.slice(start, end).map((line, index) => {
    const lineNumber = String(start + index + 1).padStart(6, ' ');
    return `${lineNumber}\t${line}`;
  });
  return {
    content: sliced.join('\n'),
    offset,
    lineCount: total,
    truncated: end < total,
  };
}

export function createFileTools(deps: FileToolDependencies = {}): AgentToolDefinition[] {
  const native = deps.native ?? codingNativeAdapter;
  const isDesktop = deps.isDesktop ?? defaultIsDesktop;

  const fileRead = defineCodingTool({
    name: 'file_read',
    description: 'Read a bounded workspace file range. Open dirty files return the editor buffer.',
    risk: 'local_read',
    sideEffect: 'none',
    supportsRetry: true,
    timeoutMs: READ_TOOL_TIMEOUT_MS,
    inputSchema: objectSchema({
      path: { type: 'string', minLength: 1 },
      offset: { type: 'integer', minimum: 1 },
      limit: { type: 'integer', minimum: 1, maximum: FILE_READ_MAX_LIMIT },
    }, ['path']),
    normalizeArgs: (args) => {
      const record = asRecord(args);
      return {
        path: normalizeRelativeToolPath(String(record.path ?? '')),
        offset: typeof record.offset === 'number' ? record.offset : 1,
        limit: typeof record.limit === 'number' ? record.limit : FILE_READ_DEFAULT_LIMIT,
      };
    },
    resolveResourceKeys: (context, args) => [workspaceFileKey(context, String(asRecord(args).path ?? ''))],
    async execute(context: ToolExecutionContext, args: unknown): Promise<AgentToolResult> {
      if (context.abortSignal.aborted) return cancelled('file_read');
      const record = asRecord(args);
      const path = String(record.path ?? '');
      const offset = typeof record.offset === 'number' ? record.offset : 1;
      const limit = typeof record.limit === 'number' ? record.limit : FILE_READ_DEFAULT_LIMIT;
      const open = openFileFor(deps, context, path);
      if (open?.isDirty) {
        const sliced = sliceLines(open.content, offset, limit);
        const revision = await hashContent(open.content);
        return {
          ok: true,
          summary: `Read open dirty file ${path}`,
          observedRevision: revision,
          data: {
            path,
            source: 'editor',
            ...sliced,
            contentHash: revision,
          },
        };
      }
      const desktop = browserDisabled('file_read', isDesktop);
      if (desktop) return desktop;
      const scope = requireNativeScope(context, 'file_read');
      if (typeof scope !== 'string') return scope;
      const result = await native.fileRead({
        scopeId: scope,
        path,
        offset,
        limit,
        cancelId: context.operationId,
      });
      if (context.abortSignal.aborted) return cancelled('file_read');
      const text = await native.fileText(scope, path);
      const revision = text.exists ? await hashContent(text.content) : ABSENT_HASH;
      return {
        ok: true,
        summary: `Read ${path}`,
        observedRevision: revision,
        data: {
          path,
          source: 'disk',
          content: result.content,
          offset,
          lineCount: result.lineCount,
          truncated: result.truncated,
          contentHash: revision,
        },
      };
    },
  });

  const fileWrite = defineCodingTool({
    name: 'file_write',
    description: 'Write a workspace file using an expected SHA-256 hash or the absent sentinel.',
    risk: 'local_update',
    sideEffect: 'reversible',
    supportsRetry: true,
    timeoutMs: READ_TOOL_TIMEOUT_MS,
    inputSchema: objectSchema({
      path: { type: 'string', minLength: 1 },
      expectedHash: EXPECTED_HASH_SCHEMA,
      content: { type: 'string' },
    }, ['path', 'expectedHash', 'content']),
    normalizeArgs: (args) => {
      const record = asRecord(args);
      return {
        path: normalizeRelativeToolPath(String(record.path ?? '')),
        expectedHash: record.expectedHash,
        content: String(record.content ?? ''),
      };
    },
    resolveResourceKeys: (context, args) => [workspaceFileKey(context, String(asRecord(args).path ?? ''))],
    buildEffectPayload: (args) => omitEffectExcludedFields({
      tool: 'file_write',
      path: asRecord(args).path,
      content: asRecord(args).content,
    }),
    async execute(context: ToolExecutionContext, args: unknown): Promise<AgentToolResult> {
      if (context.abortSignal.aborted) return cancelled('file_write');
      const record = asRecord(args);
      const path = String(record.path ?? '');
      const expectedHash = record.expectedHash;
      const content = String(record.content ?? '');
      if (!isExpectedFileHash(expectedHash)) {
        return fail('validation_failed', 'expectedHash must be sha256:<hex> or absent');
      }
      const outputHash = await hashContent(content);
      const open = openFileFor(deps, context, path);
      if (usesDocumentBoundary(open)) {
        if (!deps.updateDocument) {
          return fail('unavailable', 'Open files require the document command boundary.');
        }
        const currentHash = await hashContent(open.content);
        if (currentHash !== expectedHash) return staleHash(expectedHash, currentHash);
        const documentId = open.documentId ?? `file:${open.path}`;
        const result = await deps.updateDocument({
          workspaceId: open.workspaceId,
          documentId,
          expectedRevision: currentHash,
          edit: { kind: 'replace_all', content },
          operationId: context.operationId,
        });
        if (result.ok === false) return documentConflict(result);
        return {
          ok: true,
          summary: `Wrote open file ${path}`,
          observedRevision: result.revision,
          changes: [{ resourceKey: workspaceFileKey(context, path), type: expectedHash === ABSENT_HASH ? 'created' : 'updated', summary: `Wrote ${path}` }],
          data: {
            path,
            source: 'editor',
            contentHash: result.revision,
            filesystem: {
              expectedInputHash: expectedHash,
              expectedOutputHash: outputHash,
              observedHash: result.revision,
              outcome: 'committed' as const,
            },
          },
        };
      }
      const desktop = browserDisabled('file_write', isDesktop);
      if (desktop) return desktop;
      const scope = requireNativeScope(context, 'file_write');
      if (typeof scope !== 'string') return scope;
      const currentHash = await currentClosedHash(native, scope, path);
      if (currentHash !== expectedHash) return staleHash(expectedHash, currentHash);
      if (expectedHash !== ABSENT_HASH && currentHash === ABSENT_HASH) {
        return fail('not_found', `File ${path} is absent`);
      }
      await native.fileWrite(scope, path, content);
      const observed = await currentClosedHash(native, scope, path);
      return {
        ok: true,
        summary: expectedHash === ABSENT_HASH ? `Created ${path}` : `Wrote ${path}`,
        observedRevision: observed,
        changes: [{
          resourceKey: workspaceFileKey(context, path),
          type: expectedHash === ABSENT_HASH ? 'created' : 'updated',
          summary: `Wrote ${path}`,
        }],
        data: {
          path,
          source: 'disk',
          contentHash: observed,
          filesystem: {
            expectedInputHash: expectedHash,
            expectedOutputHash: outputHash,
            observedHash: observed,
            outcome: observed === outputHash ? 'committed' : observed === expectedHash ? 'not_applied' : 'unknown',
          },
        },
      };
    },
  });

  const fileEdit = defineCodingTool({
    name: 'file_edit',
    description: 'Apply a checked text replacement using an expected SHA-256 hash.',
    risk: 'local_update',
    sideEffect: 'reversible',
    supportsRetry: true,
    timeoutMs: READ_TOOL_TIMEOUT_MS,
    inputSchema: objectSchema({
      path: { type: 'string', minLength: 1 },
      expectedHash: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
      oldText: { type: 'string', minLength: 1 },
      newText: { type: 'string' },
      replaceAll: { type: 'boolean' },
      expectedMatchCount: { type: 'integer', minimum: 1 },
    }, ['path', 'expectedHash', 'oldText', 'newText', 'replaceAll', 'expectedMatchCount']),
    normalizeArgs: (args) => {
      const record = asRecord(args);
      return {
        path: normalizeRelativeToolPath(String(record.path ?? '')),
        expectedHash: record.expectedHash,
        oldText: String(record.oldText ?? ''),
        newText: String(record.newText ?? ''),
        replaceAll: record.replaceAll === true,
        expectedMatchCount: record.expectedMatchCount,
      };
    },
    resolveResourceKeys: (context, args) => [workspaceFileKey(context, String(asRecord(args).path ?? ''))],
    buildEffectPayload: (args) => omitEffectExcludedFields({
      tool: 'file_edit',
      path: asRecord(args).path,
      oldText: asRecord(args).oldText,
      newText: asRecord(args).newText,
      replaceAll: asRecord(args).replaceAll,
      expectedMatchCount: asRecord(args).expectedMatchCount,
    }),
    async execute(context: ToolExecutionContext, args: unknown): Promise<AgentToolResult> {
      if (context.abortSignal.aborted) return cancelled('file_edit');
      const record = asRecord(args);
      const path = String(record.path ?? '');
      const expectedHash = String(record.expectedHash ?? '');
      const oldText = String(record.oldText ?? '');
      const newText = String(record.newText ?? '');
      const replaceAll = record.replaceAll === true;
      const expectedMatchCount = typeof record.expectedMatchCount === 'number' ? record.expectedMatchCount : 1;
      const open = openFileFor(deps, context, path);
      const applyTo = async (content: string): Promise<{ next: string; count: number } | AgentToolResult> => {
        const currentHash = await hashContent(content);
        if (currentHash !== expectedHash) return staleHash(expectedHash, currentHash);
        const count = countMatches(content, oldText);
        if (count === 0) return fail('not_found', 'oldText was not found in the file');
        if (count !== expectedMatchCount) {
          return fail('conflict', `expected ${expectedMatchCount} matches but found ${count}`);
        }
        return { next: applyEdit(content, oldText, newText, replaceAll), count };
      };
      if (usesDocumentBoundary(open)) {
        if (!deps.updateDocument) {
          return fail('unavailable', 'Open files require the document command boundary.');
        }
        const edited = await applyTo(open.content);
        if ('ok' in edited) return edited;
        const result = await deps.updateDocument({
          workspaceId: open.workspaceId,
          documentId: open.documentId ?? `file:${open.path}`,
          expectedRevision: expectedHash,
          edit: {
            kind: 'replace_text',
            oldText,
            newText,
            replaceAll,
            expectedMatchCount,
          },
          operationId: context.operationId,
        });
        if (result.ok === false) return documentConflict(result);
        return {
          ok: true,
          summary: `Edited open file ${path}`,
          observedRevision: result.revision,
          changes: [{ resourceKey: workspaceFileKey(context, path), type: 'updated', summary: `Edited ${path}` }],
          data: { path, source: 'editor', replacements: edited.count, contentHash: result.revision },
        };
      }
      const desktop = browserDisabled('file_edit', isDesktop);
      if (desktop) return desktop;
      const scope = requireNativeScope(context, 'file_edit');
      if (typeof scope !== 'string') return scope;
      const text = await native.fileText(scope, path);
      if (!text.exists) return fail('not_found', `File ${path} is absent`);
      const edited = await applyTo(text.content);
      if ('ok' in edited) return edited;
      await native.fileEdit({
        scopeId: scope,
        path,
        oldText,
        newText,
        replaceAll,
        expectedMatchCount,
      });
      const observed = await hashContent((await native.fileText(scope, path)).content);
      return {
        ok: true,
        summary: `Edited ${path}`,
        observedRevision: observed,
        changes: [{ resourceKey: workspaceFileKey(context, path), type: 'updated', summary: `Edited ${path}` }],
        data: { path, source: 'disk', replacements: edited.count, contentHash: observed },
      };
    },
  });

  const glob = defineCodingTool({
    name: 'glob',
    description: 'Find files inside the captured run workspace.',
    risk: 'local_read',
    sideEffect: 'none',
    supportsRetry: true,
    timeoutMs: READ_TOOL_TIMEOUT_MS,
    inputSchema: objectSchema({
      pattern: { type: 'string', minLength: 1 },
      path: { type: 'string', minLength: 1 },
    }, ['pattern']),
    normalizeArgs: (args) => {
      const record = asRecord(args);
      return {
        pattern: normalizeGlobPattern(String(record.pattern ?? '')),
        path: asString(record.path) ? normalizeRelativeToolPath(String(record.path)) : undefined,
      };
    },
    resolveResourceKeys: (context) => {
      const workspaceId = context.workspaceScope?.workspaceId ?? 'unknown';
      return [`workspace:${workspaceId}`];
    },
    async execute(context: ToolExecutionContext, args: unknown): Promise<AgentToolResult> {
      if (context.abortSignal.aborted) return cancelled('glob');
      const desktop = browserDisabled('glob', isDesktop);
      if (desktop) return desktop;
      const scope = requireNativeScope(context, 'glob');
      if (typeof scope !== 'string') return scope;
      const record = asRecord(args);
      const result = await native.glob({
        scopeId: scope,
        pattern: String(record.pattern ?? ''),
        path: asString(record.path),
        cancelId: context.operationId,
        maxResults: SEARCH_MATCH_LIMIT,
      });
      if (result.cancelled || context.abortSignal.aborted) return cancelled('glob');
      return {
        ok: true,
        summary: `Found ${result.paths.length} files`,
        data: {
          paths: result.paths.slice(0, SEARCH_MATCH_LIMIT),
          truncated: result.truncated || result.paths.length > SEARCH_MATCH_LIMIT,
          maxResults: SEARCH_MATCH_LIMIT,
        },
      };
    },
  });

  const grep = defineCodingTool({
    name: 'grep',
    description: 'Search bounded file content inside the captured run workspace.',
    risk: 'local_read',
    sideEffect: 'none',
    supportsRetry: true,
    timeoutMs: READ_TOOL_TIMEOUT_MS,
    inputSchema: objectSchema({
      pattern: { type: 'string', minLength: 1 },
      path: { type: 'string', minLength: 1 },
      glob: { type: 'string', minLength: 1 },
      caseInsensitive: { type: 'boolean' },
    }, ['pattern']),
    normalizeArgs: (args) => {
      const record = asRecord(args);
      return {
        pattern: String(record.pattern ?? ''),
        path: asString(record.path) ? normalizeRelativeToolPath(String(record.path)) : undefined,
        glob: asString(record.glob) ? normalizeGlobPattern(String(record.glob)) : undefined,
        caseInsensitive: record.caseInsensitive === true,
      };
    },
    resolveResourceKeys: (context, args) => {
      const path = asString(asRecord(args).path);
      return path ? [workspaceFileKey(context, path)] : [`workspace:${context.workspaceScope?.workspaceId ?? 'unknown'}`];
    },
    async execute(context: ToolExecutionContext, args: unknown): Promise<AgentToolResult> {
      if (context.abortSignal.aborted) return cancelled('grep');
      const desktop = browserDisabled('grep', isDesktop);
      if (desktop) return desktop;
      const scope = requireNativeScope(context, 'grep');
      if (typeof scope !== 'string') return scope;
      const record = asRecord(args);
      const result = await native.grep({
        scopeId: scope,
        pattern: String(record.pattern ?? ''),
        path: asString(record.path),
        glob: asString(record.glob),
        caseInsensitive: record.caseInsensitive === true,
        cancelId: context.operationId,
        maxResults: clampSearchLimit(SEARCH_MATCH_LIMIT),
      });
      if (result.cancelled || context.abortSignal.aborted) return cancelled('grep');
      const matches: NativeGrepMatch[] = result.matches.slice(0, SEARCH_MATCH_LIMIT);
      return {
        ok: true,
        summary: `Found ${matches.length} matches`,
        data: {
          matches,
          truncated: result.truncated || result.matches.length > SEARCH_MATCH_LIMIT,
          maxResults: SEARCH_MATCH_LIMIT,
        },
      };
    },
  });

  return [fileRead, fileWrite, fileEdit, glob, grep];
}

export { mapNativeError };
