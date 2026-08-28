// ---------------------------------------------------------------------------
// TABS Work-OS Harness — Shell, Git status, and Git diff tools
// Exact command approval, bounded environment/cwd/timeout/output, process-tree
// cancellation, streamed events. Interrupted shells never retry automatically.
// Browser preview disables shell and Git.
// ---------------------------------------------------------------------------

import type { AgentPolicyGrant, AgentToolDefinition, AgentToolResult, ToolExecutionContext } from '../../../types/agent';
import { digestCommand } from '../policyEngine';
import {
  asRecord,
  asString,
  browserDisabled,
  cancelled,
  clampShellTimeout,
  defaultIsDesktop,
  defineCodingTool,
  fail,
  interrupted,
  MAX_TOOL_RESULT_BYTES,
  objectSchema,
  READ_TOOL_TIMEOUT_MS,
  requireNativeScope,
  SHELL_DEFAULT_TIMEOUT_MS,
  SHELL_MAX_TIMEOUT_MS,
  SHELL_TOOL_NAMES,
  workspaceCwdKey,
} from './codingSupport';
import { codingNativeAdapter, type CodingNativeAdapter } from './codingNativeAdapter';

export { SHELL_TOOL_NAMES };

export interface ShellToolDependencies {
  native?: CodingNativeAdapter;
  isDesktop?: () => boolean;
}

function workingDirectoryFromKey(key: string): string {
  if (key === 'workspace' || key === '.') return '';
  return key;
}

function shellGrantValid(grant: AgentPolicyGrant, args: unknown): boolean {
  const record = asRecord(args);
  const command = asString(record.command);
  const workingDirectoryKey = asString(record.workingDirectoryKey);
  if (!command || !workingDirectoryKey) return false;
  const digest = digestCommand(command, workingDirectoryKey);
  const expected = grant.commandDigest ?? (grant.argumentConstraints.commandDigest as string | undefined);
  if (expected && expected !== digest) return false;
  const cwd = grant.argumentConstraints.workingDirectoryKey;
  if (typeof cwd === 'string' && cwd !== workingDirectoryKey) return false;
  return true;
}

export function createShellTools(deps: ShellToolDependencies = {}): AgentToolDefinition[] {
  const native = deps.native ?? codingNativeAdapter;
  const isDesktop = deps.isDesktop ?? defaultIsDesktop;

  const shellExec = defineCodingTool({
    name: 'shell_exec',
    description: 'Run one approved command in a bounded workspace directory. Interrupted shells never retry automatically.',
    risk: 'process_execute',
    sideEffect: 'irreversible',
    supportsRetry: false,
    timeoutMs: SHELL_MAX_TIMEOUT_MS,
    inputSchema: objectSchema({
      command: { type: 'string', minLength: 1 },
      workingDirectoryKey: { type: 'string', minLength: 1 },
      timeoutMs: { type: 'integer', minimum: 1, maximum: SHELL_MAX_TIMEOUT_MS },
    }, ['command', 'workingDirectoryKey', 'timeoutMs']),
    normalizeArgs: (args) => {
      const record = asRecord(args);
      return {
        command: String(record.command ?? '').trim().replace(/\s+/g, ' '),
        workingDirectoryKey: String(record.workingDirectoryKey ?? '').trim(),
        timeoutMs: clampShellTimeout(record.timeoutMs),
      };
    },
    resolveResourceKeys: (context, args) => [
      workspaceCwdKey(context, String(asRecord(args).workingDirectoryKey ?? 'workspace')),
    ],
    buildEffectPayload: (args) => ({
      tool: 'shell_exec',
      command: asRecord(args).command,
      workingDirectoryKey: asRecord(args).workingDirectoryKey,
    }),
    validateGrant: shellGrantValid,
    async execute(context: ToolExecutionContext, args: unknown): Promise<AgentToolResult> {
      if (context.abortSignal.aborted) return cancelled('shell_exec');
      const disabled = browserDisabled('shell_exec', isDesktop);
      if (disabled) return disabled;
      const scope = requireNativeScope(context, 'shell_exec');
      if (typeof scope !== 'string') return scope;
      const record = asRecord(args);
      const command = String(record.command ?? '');
      const workingDirectoryKey = String(record.workingDirectoryKey ?? 'workspace');
      const timeoutMs = clampShellTimeout(record.timeoutMs ?? SHELL_DEFAULT_TIMEOUT_MS);
      const cancelId = context.operationId;
      const abort = () => {
        if (cancelId) void native.cancel(cancelId);
      };
      context.abortSignal.addEventListener('abort', abort, { once: true });
      try {
        const result = await native.shellExec({
          scopeId: scope,
          command,
          workingDirectory: workingDirectoryFromKey(workingDirectoryKey),
          timeoutMs,
          cancelId,
          maxOutputBytes: MAX_TOOL_RESULT_BYTES,
        });
        if (context.abortSignal.aborted || result.cancelled) {
          return interrupted('shell_exec');
        }
        if (result.timedOut) {
          return {
            ok: false,
            summary: `Command timed out after ${timeoutMs} ms`,
            data: {
              stdout: result.stdout,
              stderr: result.stderr,
              exitCode: result.exitCode,
              timedOut: true,
              truncated: result.truncated,
              retryable: false,
            },
            error: { code: 'timeout', message: `Command timed out after ${timeoutMs} ms`, retryable: false },
          };
        }
        return {
          ok: result.exitCode === 0,
          summary: result.exitCode === 0
            ? `Command exited 0${result.truncated ? ' (truncated)' : ''}`
            : `Command exited ${result.exitCode}`,
          data: {
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
            timedOut: false,
            truncated: result.truncated,
            workingDirectoryKey,
            retryable: false,
          },
          error: result.exitCode === 0
            ? undefined
            : { code: 'internal_error', message: `Command exited ${result.exitCode}`, retryable: false },
        };
      } finally {
        context.abortSignal.removeEventListener('abort', abort);
      }
    },
  });

  const gitStatus = defineCodingTool({
    name: 'git_status',
    description: 'Read repository status without changing Git.',
    risk: 'local_read',
    sideEffect: 'none',
    supportsRetry: true,
    timeoutMs: READ_TOOL_TIMEOUT_MS,
    inputSchema: objectSchema({
      path: { type: 'string', minLength: 1 },
    }),
    normalizeArgs: (args) => {
      const record = asRecord(args);
      return { path: asString(record.path) };
    },
    resolveResourceKeys: (context) => [`workspace:${context.workspaceScope?.workspaceId ?? 'unknown'}:git`],
    async execute(context: ToolExecutionContext, args: unknown): Promise<AgentToolResult> {
      if (context.abortSignal.aborted) return cancelled('git_status');
      const disabled = browserDisabled('git_status', isDesktop);
      if (disabled) return disabled;
      const scope = requireNativeScope(context, 'git_status');
      if (typeof scope !== 'string') return scope;
      const path = asString(asRecord(args).path);
      const result = await native.gitStatus(scope, path, context.operationId);
      return {
        ok: true,
        summary: 'Git status',
        data: { output: result.output, truncated: result.truncated },
      };
    },
  });

  const gitDiff = defineCodingTool({
    name: 'git_diff',
    description: 'Read bounded Git differences without changing Git.',
    risk: 'local_read',
    sideEffect: 'none',
    supportsRetry: true,
    timeoutMs: READ_TOOL_TIMEOUT_MS,
    inputSchema: objectSchema({
      path: { type: 'string', minLength: 1 },
    }),
    normalizeArgs: (args) => {
      const record = asRecord(args);
      return { path: asString(record.path) };
    },
    resolveResourceKeys: (context) => [`workspace:${context.workspaceScope?.workspaceId ?? 'unknown'}:git`],
    async execute(context: ToolExecutionContext, args: unknown): Promise<AgentToolResult> {
      if (context.abortSignal.aborted) return cancelled('git_diff');
      const disabled = browserDisabled('git_diff', isDesktop);
      if (disabled) return disabled;
      const scope = requireNativeScope(context, 'git_diff');
      if (typeof scope !== 'string') return scope;
      const path = asString(asRecord(args).path);
      const result = await native.gitDiff(scope, path, context.operationId);
      return {
        ok: true,
        summary: 'Git diff',
        data: { output: result.output, truncated: result.truncated },
      };
    },
  });

  return [shellExec, gitStatus, gitDiff];
}

export { fail };
