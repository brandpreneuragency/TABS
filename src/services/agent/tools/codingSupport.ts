// ---------------------------------------------------------------------------
// TABS Work-OS Harness — Shared coding/web tool helpers
// Normalized relative paths, SHA-256 hashes, desktop gating, redaction.
// ---------------------------------------------------------------------------

import type {
  AgentToolDefinition,
  AgentToolErrorCode,
  AgentToolResult,
  JsonSchema,
  ToolExecutionContext,
  ToolRiskClass,
} from '../../../types/agent';
import { computeRevision } from '../../documents/documentCommands';
import { isTauriRuntime } from '../../runtime';
import {
  FILE_READ_DEFAULT_LIMIT,
  FILE_READ_MAX_LIMIT,
  MAX_TOOL_RESULT_BYTES,
  READ_TOOL_TIMEOUT_MS,
  SEARCH_MATCH_LIMIT,
  SHELL_DEFAULT_TIMEOUT_MS,
  SHELL_MAX_TIMEOUT_MS,
  WEB_SEARCH_TIMEOUT_MS,
} from '../helpers';
import { normalizePath } from '../policyEngine';
import { redactSecrets, redactStructuredValue } from '../redaction';
import { asRecord, fail } from './readSupport';

export {
  FILE_READ_DEFAULT_LIMIT,
  FILE_READ_MAX_LIMIT,
  MAX_TOOL_RESULT_BYTES,
  READ_TOOL_TIMEOUT_MS,
  SEARCH_MATCH_LIMIT,
  SHELL_DEFAULT_TIMEOUT_MS,
  SHELL_MAX_TIMEOUT_MS,
  WEB_SEARCH_TIMEOUT_MS,
};

export const CODING_TOOL_VERSION = '1.0.0';
export const ABSENT_HASH = 'absent';
export const SHA256_RE = /^sha256:[0-9a-f]{64}$/;

export const FILE_TOOL_NAMES = ['file_read', 'file_write', 'file_edit', 'glob', 'grep'] as const;
export const SHELL_TOOL_NAMES = ['shell_exec', 'git_status', 'git_diff'] as const;
export const WEB_TOOL_NAMES = ['web_search'] as const;
export const CODING_TOOL_NAMES = [
  ...FILE_TOOL_NAMES,
  ...SHELL_TOOL_NAMES,
  ...WEB_TOOL_NAMES,
] as const;

export type FileToolName = (typeof FILE_TOOL_NAMES)[number];
export type ShellToolName = (typeof SHELL_TOOL_NAMES)[number];
export type CodingToolName = (typeof CODING_TOOL_NAMES)[number];
export type ExpectedFileHash = `sha256:${string}` | typeof ABSENT_HASH;

export const EXPECTED_HASH_SCHEMA: JsonSchema = {
  oneOf: [
    { type: 'string', const: ABSENT_HASH },
    { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
  ],
};

export function isExpectedFileHash(value: unknown): value is ExpectedFileHash {
  return value === ABSENT_HASH || (typeof value === 'string' && SHA256_RE.test(value));
}

export function hashContent(content: string): Promise<string> {
  return computeRevision(content);
}

export function normalizeRelativeToolPath(value: string): string {
  return normalizePath(value);
}

export function normalizeGlobPattern(value: string): string {
  const trimmed = value.trim().replace(/\\/g, '/');
  if (!trimmed) throw new Error('Glob pattern must be non-empty');
  if (trimmed.startsWith('/') || trimmed.startsWith('~/')) {
    throw new Error('Glob pattern must be relative');
  }
  const parts = trimmed.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error('Glob pattern must not contain parent or empty segments');
  }
  return parts.join('/');
}

export function workspaceFileKey(context: ToolExecutionContext, path: string): string {
  const workspaceId = context.workspaceScope?.workspaceId ?? 'unknown';
  return `workspace:${workspaceId}:path:${path}`;
}

export function workspaceCwdKey(context: ToolExecutionContext, workingDirectoryKey: string): string {
  const workspaceId = context.workspaceScope?.workspaceId ?? 'unknown';
  return `workspace:${workspaceId}:cwd:${workingDirectoryKey}`;
}

export function requireNativeScope(context: ToolExecutionContext, name: string): AgentToolResult | string {
  const scopeId = context.workspaceScope?.nativeScopeId;
  if (!scopeId) return fail('unavailable', `${name} requires a captured native workspace scope.`);
  return scopeId;
}

export function browserDisabled(name: string, isDesktop: () => boolean): AgentToolResult | undefined {
  if (isDesktop()) return undefined;
  return fail('unavailable', `${name} is disabled in the Vite browser preview.`);
}

export function defaultIsDesktop(): boolean {
  return isTauriRuntime();
}

export function cancelled(name: string): AgentToolResult {
  return fail('cancelled', `Tool ${name} was cancelled`);
}

export function interrupted(name: string, message = `${name} was interrupted and will not retry automatically.`): AgentToolResult {
  return {
    ok: false,
    summary: message,
    error: { code: 'interrupted', message, retryable: false },
  };
}

export function mapNativeError(caught: unknown, fallback: AgentToolErrorCode = 'internal_error'): AgentToolResult {
  const message = redactSecrets(caught instanceof Error ? caught.message : String(caught));
  if (/PathMustBeNormalizedRelative|must be a relative path|parent/i.test(message)) {
    return fail('validation_failed', message);
  }
  if (/PathOutsideWorkspace|SearchResultOutsideWorkspace|glob escape/i.test(message)) {
    return fail('permission_denied', message);
  }
  if (/WorkspaceScopeUnavailable|unavailable outside/i.test(message)) {
    return fail('unavailable', message);
  }
  if (/not a file|not found|No such file/i.test(message)) {
    return fail('not_found', message);
  }
  if (/ReadOffsetOutOfRange|out of range/i.test(message)) {
    return fail('validation_failed', message);
  }
  if (/stale|hash mismatch/i.test(message)) {
    return fail('stale_revision', message);
  }
  if (/timed out/i.test(message)) {
    return { ok: false, summary: message, error: { code: 'timeout', message, retryable: false } };
  }
  if (/cancelled/i.test(message)) {
    return fail('cancelled', message);
  }
  return fail(fallback, message);
}

export function clampShellTimeout(timeoutMs: unknown): number {
  if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs)) return SHELL_DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(timeoutMs, 1), SHELL_MAX_TIMEOUT_MS);
}

export function clampSearchLimit(limit: unknown, fallback = SEARCH_MATCH_LIMIT): number {
  if (typeof limit !== 'number' || !Number.isInteger(limit)) return fallback;
  return Math.min(Math.max(limit, 1), SEARCH_MATCH_LIMIT);
}

export function redactResult(result: AgentToolResult): AgentToolResult {
  return redactStructuredValue(result);
}

export function objectSchema(
  properties: Record<string, JsonSchema>,
  required: string[] = [],
): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required,
    properties,
  };
}

export function defineCodingTool(input: {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  risk: ToolRiskClass;
  sideEffect: AgentToolDefinition['sideEffect'];
  timeoutMs: number;
  supportsRetry: boolean;
  resolveResourceKeys: AgentToolDefinition['resolveResourceKeys'];
  buildEffectPayload?: AgentToolDefinition['buildEffectPayload'];
  normalizeArgs?: AgentToolDefinition['normalizeArgs'];
  validateGrant?: AgentToolDefinition['validateGrant'];
  execute: AgentToolDefinition['execute'];
}): AgentToolDefinition {
  return {
    name: input.name,
    version: CODING_TOOL_VERSION,
    description: input.description,
    inputSchema: input.inputSchema,
    risk: input.risk,
    sideEffect: input.sideEffect,
    supportsRetry: input.supportsRetry,
    timeoutMs: input.timeoutMs,
    maxResultBytes: MAX_TOOL_RESULT_BYTES,
    normalizeArgs: input.normalizeArgs ?? ((args) => args),
    resolveResourceKeys: input.resolveResourceKeys,
    buildEffectPayload: input.buildEffectPayload ?? ((args) => ({ kind: input.name, args })),
    validateGrant: input.validateGrant ?? (() => true),
    async execute(context: ToolExecutionContext, args: unknown): Promise<AgentToolResult> {
      if (context.abortSignal.aborted) return cancelled(input.name);
      try {
        const result = await input.execute(context, args) as AgentToolResult;
        if (context.abortSignal.aborted && !result.ok) return cancelled(input.name);
        return redactResult(result);
      } catch (caught) {
        if (context.abortSignal.aborted) return cancelled(input.name);
        return redactResult(mapNativeError(caught));
      }
    },
  };
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export { asRecord, fail };
