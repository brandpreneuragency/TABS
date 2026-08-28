// ---------------------------------------------------------------------------
// TABS Work-OS Harness — Shared mutation-tool helpers
// Runtime-generated operation IDs, effect fingerprints, receipts, and
// structured mutation results. Handlers call domain commands only.
// ---------------------------------------------------------------------------

import type {
  AgentArtifactRef,
  AgentChange,
  AgentOperationReceipt,
  AgentPolicyGrant,
  AgentToolDefinition,
  AgentToolErrorCode,
  AgentToolResult,
  JsonSchema,
  ToolExecutionContext,
  ToolRiskClass,
} from '../../../types/agent';
import { buildOperationId, MAX_TOOL_RESULT_BYTES } from '../helpers';
import { asRecord, fail } from './readSupport';

export const MUTATION_TOOL_VERSION = '1.0.0';

/** Concurrency / transport fields never enter the effect fingerprint. */
export const EFFECT_EXCLUDED_FIELDS = [
  'expectedRevision',
  'expectedUpdatedAt',
  'expectedWorkspaceRevision',
  'expectedHash',
  'timeoutMs',
  'cursor',
  'limit',
] as const;

/** Desired-effect fields that fingerprints must include. */
export const EFFECT_INCLUDED_FIELDS = [
  'toolVersion',
  'resourceKeys',
  'desiredFields',
  'parentKeys',
  'targetPath',
  'contentHash',
] as const;

export const DOCUMENT_MUTATION_TOOL_NAMES = ['document_create', 'document_update'] as const;

export const TASK_MUTATION_TOOL_NAMES = [
  'task_create',
  'task_update',
  'task_comment_add',
  'task_soft_delete',
] as const;

export const CRM_MUTATION_TOOL_NAMES = [
  'crm_contact_create',
  'crm_company_create',
  'crm_lead_create',
  'crm_entity_update',
  'crm_deal_stage_set',
  'crm_note_add',
  'crm_task_link_create',
] as const;

export const MUTATION_TOOL_NAMES = [
  ...DOCUMENT_MUTATION_TOOL_NAMES,
  ...TASK_MUTATION_TOOL_NAMES,
  ...CRM_MUTATION_TOOL_NAMES,
] as const;

export type MutationToolName = (typeof MUTATION_TOOL_NAMES)[number];

export interface MutationResourceLink {
  kind: string;
  id: string;
  resourceKey: string;
  label: string;
}

export interface MutationResultData {
  operationId: string;
  effectFingerprint: string;
  receipt: {
    operationId: string;
    effectFingerprint: string;
    status: AgentOperationReceipt['status'];
    committedAt: number;
    replayed: boolean;
    repeatedEffect: boolean;
  };
  resourceLinks: MutationResourceLink[];
  projectionPending: boolean;
  entity?: unknown;
  before?: unknown;
  after?: unknown;
  filesystem?: {
    expectedInputHash: string;
    expectedOutputHash: string;
    observedHash?: string;
    outcome: 'committed' | 'not_applied' | 'unknown';
  };
}

export interface MutationReceiptStore {
  getByOperationId(operationId: string): Promise<AgentOperationReceipt | undefined>;
  getByEffectFingerprint(effectFingerprint: string): Promise<AgentOperationReceipt | undefined>;
  put(receipt: AgentOperationReceipt): Promise<void>;
}

export class MemoryReceiptStore implements MutationReceiptStore {
  private readonly byOperation = new Map<string, AgentOperationReceipt>();
  private readonly byFingerprint = new Map<string, AgentOperationReceipt>();

  async getByOperationId(operationId: string): Promise<AgentOperationReceipt | undefined> {
    return this.byOperation.get(operationId);
  }

  async getByEffectFingerprint(effectFingerprint: string): Promise<AgentOperationReceipt | undefined> {
    return this.byFingerprint.get(effectFingerprint);
  }

  async put(receipt: AgentOperationReceipt): Promise<void> {
    this.byOperation.set(receipt.operationId, receipt);
    if (!this.byFingerprint.has(receipt.effectFingerprint)) {
      this.byFingerprint.set(receipt.effectFingerprint, receipt);
    }
  }
}

export class FilesystemUncertaintyError extends Error {
  readonly expectedInputHash: string;
  readonly expectedOutputHash: string;
  readonly observedHash?: string;

  constructor(
    message: string,
    hashes: { expectedInputHash: string; expectedOutputHash: string; observedHash?: string },
  ) {
    super(message);
    this.name = 'FilesystemUncertaintyError';
    this.expectedInputHash = hashes.expectedInputHash;
    this.expectedOutputHash = hashes.expectedOutputHash;
    this.observedHash = hashes.observedHash;
  }
}

export function djb2(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index++) {
    hash = ((hash << 5) + hash + value.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

/**
 * Canonical effect fingerprint. Includes tool version, resource keys, and
 * `buildEffectPayload()` output. Callers must omit concurrency fields.
 */
export function effectFingerprint(input: {
  toolVersion: string;
  resourceKeys: string[];
  payload: unknown;
}): string {
  return djb2(canonicalJson({
    toolVersion: input.toolVersion,
    resourceKeys: [...input.resourceKeys].sort(),
    payload: input.payload,
  }));
}

export function effectContentHash(content: string): string {
  return `djb2:${djb2(content)}`;
}

export function omitEffectExcludedFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitEffectExcludedFields);
  if (value === null || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(record)) {
    if ((EFFECT_EXCLUDED_FIELDS as readonly string[]).includes(key)) continue;
    next[key] = omitEffectExcludedFields(nested);
  }
  return next;
}

export function mutationIdentity(
  context: ToolExecutionContext,
  toolVersion: string,
  resourceKeys: string[],
  payload: unknown,
): { operationId: string; effectFingerprint: string } {
  const operationId = context.operationId ?? buildOperationId(
    context.runId,
    context.turn,
    context.toolIndex ?? 0,
  );
  const fingerprint = context.effectFingerprint ?? effectFingerprint({
    toolVersion,
    resourceKeys,
    payload,
  });
  return { operationId, effectFingerprint: fingerprint };
}

export function mutationReceipt(input: {
  operationId: string;
  effectFingerprint: string;
  domain: string;
  resourceKeys: string[];
  summary: string;
  resultData: unknown;
  committedAt?: number;
}): AgentOperationReceipt {
  return {
    id: `receipt:${input.operationId}`,
    operationId: input.operationId,
    effectFingerprint: input.effectFingerprint,
    domain: input.domain,
    resourceKeys: input.resourceKeys,
    status: 'committed',
    resultSummary: input.summary,
    resultData: input.resultData,
    committedAt: input.committedAt ?? Date.now(),
  };
}

export function resourceLink(
  kind: string,
  id: string,
  resourceKey: string,
  label: string,
): MutationResourceLink {
  return { kind, id, resourceKey, label };
}

export function change(
  resourceKey: string,
  type: AgentChange['type'],
  summary: string,
): AgentChange {
  return { resourceKey, type, summary };
}

export function mutationOk(input: {
  summary: string;
  operationId: string;
  effectFingerprint: string;
  receipt: AgentOperationReceipt;
  resourceLinks: MutationResourceLink[];
  changes: AgentChange[];
  projectionPending?: boolean;
  replayed?: boolean;
  repeatedEffect?: boolean;
  entity?: unknown;
  before?: unknown;
  after?: unknown;
  artifacts?: AgentArtifactRef[];
  observedRevision?: string;
  filesystem?: MutationResultData['filesystem'];
}): AgentToolResult {
  const data: MutationResultData = {
    operationId: input.operationId,
    effectFingerprint: input.effectFingerprint,
    receipt: {
      operationId: input.receipt.operationId,
      effectFingerprint: input.receipt.effectFingerprint,
      status: input.receipt.status,
      committedAt: input.receipt.committedAt,
      replayed: input.replayed === true,
      repeatedEffect: input.repeatedEffect === true,
    },
    resourceLinks: input.resourceLinks,
    projectionPending: input.projectionPending === true,
    entity: input.entity,
    before: input.before,
    after: input.after,
    filesystem: input.filesystem,
  };
  return {
    ok: true,
    summary: input.summary,
    data,
    changes: input.changes,
    artifacts: input.artifacts,
    observedRevision: input.observedRevision,
  };
}

export async function resolvePriorReceipt(
  store: MutationReceiptStore | undefined,
  operationId: string,
  fingerprint: string,
): Promise<
  | { kind: 'none' }
  | { kind: 'replay'; receipt: AgentOperationReceipt }
  | { kind: 'repeat'; receipt: AgentOperationReceipt }
  | { kind: 'mismatch'; receipt: AgentOperationReceipt }
> {
  if (!store) return { kind: 'none' };
  const byOperation = await store.getByOperationId(operationId);
  if (byOperation) {
    if (byOperation.effectFingerprint !== fingerprint) return { kind: 'mismatch', receipt: byOperation };
    return { kind: 'replay', receipt: byOperation };
  }
  const byFingerprint = await store.getByEffectFingerprint(fingerprint);
  if (byFingerprint && byFingerprint.operationId !== operationId) {
    return { kind: 'repeat', receipt: byFingerprint };
  }
  return { kind: 'none' };
}

export function cancelledResult(name: string): AgentToolResult {
  return fail('cancelled', `Tool ${name} was cancelled`);
}

export function classifyFilesystemOutcome(input: {
  expectedInputHash: string;
  expectedOutputHash: string;
  observedHash?: string;
}): 'committed' | 'not_applied' | 'unknown' {
  if (!input.observedHash) return 'unknown';
  if (input.observedHash === input.expectedOutputHash) return 'committed';
  if (input.observedHash === input.expectedInputHash) return 'not_applied';
  return 'unknown';
}

export function filesystemUncertaintyResult(
  error: FilesystemUncertaintyError,
): AgentToolResult {
  const outcome = classifyFilesystemOutcome(error);
  if (outcome === 'committed') {
    return {
      ok: true,
      summary: 'Filesystem write matched the expected output hash',
      data: {
        filesystem: {
          expectedInputHash: error.expectedInputHash,
          expectedOutputHash: error.expectedOutputHash,
          observedHash: error.observedHash,
          outcome,
        },
      },
      observedRevision: error.observedHash,
    };
  }
  if (outcome === 'not_applied') {
    return fail('interrupted', 'Filesystem write did not apply; retry is safe after review.');
  }
  return {
    ok: false,
    summary: 'Filesystem write outcome is unknown and needs review',
    data: {
      filesystem: {
        expectedInputHash: error.expectedInputHash,
        expectedOutputHash: error.expectedOutputHash,
        observedHash: error.observedHash,
        outcome: 'unknown' as const,
      },
      needsReview: true,
    },
    error: {
      code: 'interrupted',
      message: error.message || 'Filesystem write outcome is unknown',
      retryable: false,
    },
  };
}

export function mapMutationError(caught: unknown): AgentToolResult {
  if (caught instanceof FilesystemUncertaintyError) return filesystemUncertaintyResult(caught);
  const name = caught instanceof Error ? caught.name : '';
  const message = caught instanceof Error ? caught.message : 'Mutation failed';
  if (name === 'TaskNotFoundError' || /was not found/i.test(message)) {
    return fail('not_found', message);
  }
  if (name === 'TaskRevisionConflictError' || name === 'CrmRevisionConflictError' || /changed since/i.test(message)) {
    return fail('stale_revision', message);
  }
  if (name === 'CrmDuplicateError' || name === 'CrmStageConflictError' || /already exists|already committed|path collision|duplicate/i.test(message)) {
    return fail('conflict', message);
  }
  if (name === 'OperationReplayMismatchError' || name === 'CompanionOperationMismatchError') {
    return fail('conflict', message);
  }
  if (/required|invalid|must be|must use|not allowed/i.test(message)) {
    return fail('validation_failed', message);
  }
  return fail('internal_error', message);
}

export function allowlistedUpdateGrant(grant: AgentPolicyGrant, args: unknown): boolean {
  const allowed = grant.argumentConstraints.allowedFields;
  if (!Array.isArray(allowed)) return true;
  const updates = asRecord(asRecord(args).updates);
  const names = allowed.filter((entry): entry is string => typeof entry === 'string');
  return Object.keys(updates).every((field) => names.includes(field));
}

export function objectSchema(
  properties: Record<string, JsonSchema>,
  required: string[] = [],
  extras: Record<string, unknown> = {},
): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required,
    properties,
    ...extras,
  };
}

export function defineMutationTool(input: {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  risk: ToolRiskClass;
  sideEffect: AgentToolDefinition['sideEffect'];
  resolveResourceKeys: AgentToolDefinition['resolveResourceKeys'];
  buildEffectPayload: AgentToolDefinition['buildEffectPayload'];
  execute: AgentToolDefinition['execute'];
  normalizeArgs?: AgentToolDefinition['normalizeArgs'];
  validateGrant?: AgentToolDefinition['validateGrant'];
  supportsRetry?: boolean;
  timeoutMs?: number;
}): AgentToolDefinition {
  return {
    name: input.name,
    version: MUTATION_TOOL_VERSION,
    description: input.description,
    inputSchema: input.inputSchema,
    risk: input.risk,
    sideEffect: input.sideEffect,
    supportsRetry: input.supportsRetry ?? true,
    timeoutMs: input.timeoutMs ?? 15_000,
    maxResultBytes: MAX_TOOL_RESULT_BYTES,
    normalizeArgs: input.normalizeArgs ?? ((args) => args),
    resolveResourceKeys: input.resolveResourceKeys,
    buildEffectPayload: input.buildEffectPayload,
    validateGrant: input.validateGrant ?? (() => true),
    async execute(context: ToolExecutionContext, args: unknown): Promise<AgentToolResult> {
      if (context.abortSignal.aborted) return cancelledResult(input.name);
      const resourceKeys = input.resolveResourceKeys(context, args);
      const payload = input.buildEffectPayload(args);
      const identity = mutationIdentity(context, MUTATION_TOOL_VERSION, resourceKeys, payload);
      const inner: ToolExecutionContext = {
        ...context,
        operationId: identity.operationId,
        effectFingerprint: identity.effectFingerprint,
      };
      try {
        const result = await input.execute(inner, args) as AgentToolResult;
        if (context.abortSignal.aborted && !result.ok) return cancelledResult(input.name);
        return result;
      } catch (caught) {
        if (context.abortSignal.aborted) return cancelledResult(input.name);
        return mapMutationError(caught);
      }
    },
  };
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === 'string');
}

export { fail };
export type { AgentToolErrorCode };
