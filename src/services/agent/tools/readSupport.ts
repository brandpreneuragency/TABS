// ---------------------------------------------------------------------------
// TABS Work-OS Harness — Shared helpers for bounded domain read tools
// Pagination 1–100, stable source identifiers, revision checks, artifact spill.
// ---------------------------------------------------------------------------

import type {
  AgentArtifactRef,
  AgentContextKind,
  AgentContextRef,
  AgentToolDefinition,
  AgentToolErrorCode,
  AgentToolResult,
  JsonSchema,
  ToolExecutionContext,
} from '../../../types/agent';
import {
  MAX_ARTIFACT_READ_LIMIT,
  MAX_LIST_PAGE_SIZE,
  MAX_TOOL_RESULT_BYTES,
  MIN_LIST_PAGE_SIZE,
} from '../helpers';
import { frozenContextRef } from '../contextManager';

export const READ_TOOL_VERSION = '1.0.0';
export const INLINE_RESULT_BYTE_LIMIT = 8_192;
export const LIST_LIMIT_MIN = MIN_LIST_PAGE_SIZE;
export const LIST_LIMIT_MAX = MAX_LIST_PAGE_SIZE;

export const DOCUMENT_READ_TOOL_NAMES = [
  'workspace_list',
  'workspace_get',
  'document_read',
  'document_search',
] as const;

export const TASK_READ_TOOL_NAMES = ['task_list', 'task_get', 'project_list'] as const;

export const CRM_READ_TOOL_NAMES = ['crm_search', 'crm_entity_get'] as const;

export const FORM_READ_TOOL_NAMES = [
  'form_list',
  'form_get',
  'form_validate',
  'submission_list',
  'submission_get',
] as const;

export const READ_TOOL_NAMES = [
  ...DOCUMENT_READ_TOOL_NAMES,
  ...TASK_READ_TOOL_NAMES,
  ...CRM_READ_TOOL_NAMES,
  ...FORM_READ_TOOL_NAMES,
  'artifact_read',
] as const;

export type ReadToolName = (typeof READ_TOOL_NAMES)[number];

export interface ArtifactPutInput {
  runId: string;
  label: string;
  content: string;
}

export type ArtifactSink = (input: ArtifactPutInput) => Promise<AgentArtifactRef>;

export interface PageSlice<T> {
  items: T[];
  offset: number;
  count: number;
  total: number;
  truncated: boolean;
  nextCursor?: string;
}

export const CURSOR_SCHEMA: JsonSchema = { type: ['string', 'number'] };

export const LIMIT_SCHEMA: JsonSchema = {
  type: 'integer',
  minimum: LIST_LIMIT_MIN,
  maximum: LIST_LIMIT_MAX,
};

export function listInputSchema(filters: JsonSchema): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['filters'],
    properties: {
      filters,
      cursor: CURSOR_SCHEMA,
      limit: LIMIT_SCHEMA,
    },
  };
}

export function entityReadSchema(extra: Record<string, JsonSchema> = {}): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: {
      id: { type: 'string', minLength: 1 },
      revision: { type: 'string' },
      section: { type: 'string' },
      cursor: CURSOR_SCHEMA,
      limit: LIMIT_SCHEMA,
      ...extra,
    },
  };
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function fail(code: AgentToolErrorCode, message: string): AgentToolResult {
  return {
    ok: false,
    summary: message,
    error: { code, message, retryable: false },
  };
}

export function ok(
  summary: string,
  data: unknown,
  extras: Partial<Pick<AgentToolResult, 'artifacts' | 'observedRevision'>> = {},
): AgentToolResult {
  return {
    ok: true,
    summary,
    data,
    observedRevision: extras.observedRevision,
    artifacts: extras.artifacts,
  };
}

export function normalizeListLimit(limit: unknown): number {
  if (typeof limit !== 'number') return LIST_LIMIT_MAX;
  return limit;
}

export function parseCursor(cursor: unknown): number {
  if (cursor === undefined || cursor === null || cursor === '') return 0;
  const value = typeof cursor === 'number' ? cursor : Number.parseInt(String(cursor), 10);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error('cursor must be a non-negative integer');
  }
  return value;
}

export function paginateList<T>(items: T[], cursor: unknown, limit: number): PageSlice<T> {
  const offset = parseCursor(cursor);
  const slice = items.slice(offset, offset + limit);
  const next = offset + slice.length;
  return {
    items: slice,
    offset,
    count: slice.length,
    total: items.length,
    truncated: next < items.length,
    nextCursor: next < items.length ? String(next) : undefined,
  };
}

export function sliceLines(
  content: string,
  cursor: unknown,
  limit: number,
  section?: string,
): PageSlice<string> & { content: string } {
  const lines = content.split('\n');
  let offset = parseCursor(cursor);
  if (section) {
    const heading = lines.findIndex((line) => line.trim() === section || line.trim() === `# ${section}`);
    if (heading >= 0 && offset === 0) offset = heading;
  }
  const slice = lines.slice(offset, offset + limit);
  const next = offset + slice.length;
  return {
    items: slice,
    content: slice.join('\n'),
    offset,
    count: slice.length,
    total: lines.length,
    truncated: next < lines.length,
    nextCursor: next < lines.length ? String(next) : undefined,
  };
}

export function sourceRef(kind: AgentContextKind, id: string, revision: string): {
  sourceId: string;
  sourceKind: AgentContextKind;
  revision: string;
} {
  return { sourceId: `${kind}:${id}`, sourceKind: kind, revision };
}

export function byteSizeOf(value: unknown): number {
  return new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)).byteLength;
}

export async function spillIfLarge(
  runId: string,
  label: string,
  data: unknown,
  putArtifact?: ArtifactSink,
): Promise<{ data: unknown; artifacts?: AgentArtifactRef[] }> {
  const size = byteSizeOf(data);
  if (size <= INLINE_RESULT_BYTE_LIMIT) return { data };
  if (!putArtifact) {
    return {
      data: {
        truncated: true,
        byteSize: size,
        maxInlineBytes: INLINE_RESULT_BYTE_LIMIT,
      },
    };
  }
  const artifact = await putArtifact({
    runId,
    label,
    content: typeof data === 'string' ? data : JSON.stringify(data),
  });
  return {
    data: {
      truncated: true,
      artifactId: artifact.id,
      byteSize: size,
      summary: label,
    },
    artifacts: [artifact],
  };
}

export function revisionOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return '';
}

export function staleIfMismatch(
  expected: string | undefined,
  actual: string,
  label: string,
): AgentToolResult | undefined {
  if (!expected) return undefined;
  if (expected === actual) return undefined;
  return fail(
    'stale_revision',
    `${label} changed since revision ${expected}; current revision is ${actual}.`,
  );
}

export function resolveFrozenId(
  context: ToolExecutionContext,
  kind: AgentContextKind,
  id?: string,
): AgentContextRef | undefined {
  return frozenContextRef(context.contextRefs, kind, id);
}

export function defaultReadNormalize(args: unknown): unknown {
  const record = asRecord(args);
  if (!('limit' in record) || record.limit === undefined) {
    return { ...record, limit: LIST_LIMIT_MAX };
  }
  return record;
}

export function defineReadTool(input: {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  resolveResourceKeys: AgentToolDefinition['resolveResourceKeys'];
  execute: AgentToolDefinition['execute'];
  normalizeArgs?: AgentToolDefinition['normalizeArgs'];
}): AgentToolDefinition {
  return {
    name: input.name,
    version: READ_TOOL_VERSION,
    description: input.description,
    inputSchema: input.inputSchema,
    risk: 'local_read',
    sideEffect: 'none',
    supportsRetry: true,
    timeoutMs: 8_000,
    maxResultBytes: MAX_TOOL_RESULT_BYTES,
    normalizeArgs: input.normalizeArgs ?? defaultReadNormalize,
    resolveResourceKeys: input.resolveResourceKeys,
    buildEffectPayload: (args) => ({ kind: input.name, args }),
    validateGrant: () => true,
    execute: input.execute,
  };
}

export { MAX_ARTIFACT_READ_LIMIT, MAX_TOOL_RESULT_BYTES };
