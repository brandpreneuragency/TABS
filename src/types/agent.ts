// ---------------------------------------------------------------------------
// TABS Work-OS Harness — Frozen Type Contracts
// Source of truth: TABS_WORK_OS_HARNESS_PLAN.md sections 12–14
// ---------------------------------------------------------------------------

// ── Run ──────────────────────────────────────────────────────────────────────

/** Stable run status values. Terminal states: completed, failed, cancelled. */
export type AgentRunStatus =
  | 'queued'
  | 'planning'
  | 'awaiting_approval'
  | 'running'
  | 'cancelling'
  | 'paused'
  | 'interrupted'
  | 'needs_review'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface AgentRun {
  id: string;
  parentRunId?: string;
  title: string;
  goal: string;
  status: AgentRunStatus;
  mode: 'guided' | 'delegated' | 'read_only';
  contextRefs: AgentContextRef[];
  providerSnapshot: ProviderSnapshot;
  profileSnapshot: AgentProfileSnapshot;
  instructionSnapshot: InstructionSnapshot;
  policySnapshot: AgentPolicySnapshot;
  policyRevision: number;
  toolRegistryVersion: string;
  toolRegistryHash: string;
  appVersion: string;
  nextSequence: number;
  activeTurn: number;
  executionEpoch: number;
  queuePriority: number;
  workerOwnerId?: string;
  workerLeaseExpiresAt?: number;
  archivedAt?: number;
  pendingInputCount: number;
  pauseRequestedAt?: number;
  cancelRequestedAt?: number;
  workspaceScope?: WorkspaceScopeSnapshot;
  maxTurns: number;
  maxDurationMs: number;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  interruptionReason?: string;
  finalSummary?: string;
}

// ── Context ──────────────────────────────────────────────────────────────────

export type AgentContextKind =
  | 'workspace'
  | 'document'
  | 'task'
  | 'crm'
  | 'form'
  | 'submission'
  | 'file';

/** Identifies data without containing the full payload. */
export interface AgentContextRef {
  kind: AgentContextKind;
  id: string;
  label: string;
  revision?: string;
  scope?: Record<string, string>;
}

export interface WorkspaceScopeSnapshot {
  workspaceId: string;
  rootPath: string;
  rootRevision: string;
  nativeScopeId?: string;
}

// ── Snapshots ────────────────────────────────────────────────────────────────

export interface ModelCapabilities {
  streaming: boolean;
  toolCalling: boolean;
  vision: boolean;
  reasoning: boolean;
  contextWindow: number;
  maxOutputTokens: number;
}

/** Frozen provider snapshot — never stores credentials. */
export interface ProviderSnapshot {
  providerId: string;
  adapter: 'openai_compatible';
  adapterVersion: string;
  baseUrl: string;
  modelId: string;
  /** Keychain reference only — not a secret value. */
  credentialAccount: string;
  reasoning: string;
  capabilities: ModelCapabilities;
  contextWindow: number;
  maxOutputTokens: number;
}

export interface AgentProfileSnapshot {
  name: string;
  description: string;
  systemInstructions: string;
  preferredProviderId?: string;
  preferredModelId?: string;
  preferredReasoning?: string;
  defaultMode: 'guided' | 'delegated' | 'read_only';
  allowedToolGroups: string[];
  defaultSkills: string[];
}

export interface InstructionSnapshot {
  safetyInstructionsHash: string;
  policyHash: string;
  globalInstructionsHash?: string;
  workspaceInstructionsHash?: string;
  profileHash?: string;
  skillHashes: string[];
  compiledContent: string;
  compiledContentHash: string;
}

export interface AgentPolicySnapshot {
  revision: number;
  mode: 'read_only' | 'guided' | 'delegated';
  rulesHash: string;
}

// ── Message ──────────────────────────────────────────────────────────────────

export type AgentMessageRole = 'system' | 'user' | 'assistant' | 'tool';
export type AgentMessageState = 'pending' | 'complete' | 'compacted';

export interface AgentMessage {
  id: string;
  runId: string;
  messageIndex: number;
  turn: number;
  role: AgentMessageRole;
  content: unknown;
  assistantToolCalls?: ProviderToolCall[];
  providerToolCallId?: string;
  state: AgentMessageState;
  streamVersion: number;
  consumedAtTurn?: number;
  createdAt: number;
}

/** A tool call preserved from the provider protocol. */
export interface ProviderToolCall {
  id: string;
  name: string;
  arguments: string;
}

// ── Provider attempt ─────────────────────────────────────────────────────────

export type AgentProviderAttemptStatus =
  | 'started'
  | 'streaming'
  | 'completed'
  | 'failed'
  | 'interrupted';

export interface AgentProviderAttempt {
  id: string;
  runId: string;
  executionEpoch: number;
  turn: number;
  attempt: number;
  status: AgentProviderAttemptStatus;
  requestHash: string;
  startedAt: number;
  finishedAt?: number;
  finishReason?: string;
  safeRetry: boolean;
}

// ── Logical tool call ────────────────────────────────────────────────────────

export type AgentToolCallStatus =
  | 'requested'
  | 'awaiting_approval'
  | 'approved'
  | 'executing'
  | 'succeeded'
  | 'failed'
  | 'denied'
  | 'interrupted';

export interface AgentToolCall {
  id: string;
  runId: string;
  turn: number;
  toolIndex: number;
  providerToolCallId: string;
  /** Deterministic: uses only runId, turn, and toolIndex. */
  operationId: string;
  effectFingerprint: string;
  toolName: string;
  toolVersion: string;
  normalizedArgs: unknown;
  resourceKeys: string[];
  status: AgentToolCallStatus;
  startedAt?: number;
  finishedAt?: number;
  resultArtifactIds: string[];
  errorCode?: string;
  createdAt: number;
}

// ── Execution attempt ────────────────────────────────────────────────────────

export type AgentToolExecutionAttemptStatus =
  | 'started'
  | 'succeeded'
  | 'failed'
  | 'interrupted';

export interface AgentToolExecutionAttempt {
  id: string;
  runId: string;
  toolCallId: string;
  /** Same operationId as the logical tool call — reused across recovery. */
  operationId: string;
  executionEpoch: number;
  attempt: number;
  status: AgentToolExecutionAttemptStatus;
  startedAt: number;
  finishedAt?: number;
  errorCode?: string;
}

// ── Operation receipt ────────────────────────────────────────────────────────

export type AgentOperationReceiptStatus = 'committed' | 'rejected';

export interface AgentOperationReceipt {
  id: string;
  operationId: string;
  effectFingerprint: string;
  domain: string;
  resourceKeys: string[];
  status: AgentOperationReceiptStatus;
  resultSummary: string;
  resultData?: unknown;
  committedAt: number;
}

// ── Policy grant ─────────────────────────────────────────────────────────────

export interface AgentPolicyGrant {
  id: string;
  runId: string;
  policyRevision: number;
  toolName: string;
  toolVersion: string;
  resourcePatterns: string[];
  argumentConstraints: Record<string, unknown>;
  resourceRevisions: Record<string, string>;
  commandDigest?: string;
  maxUses: number;
  usedCount: number;
  expiresAt: number;
}

// ── Approval ─────────────────────────────────────────────────────────────────

export type AgentApprovalStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'cancelled';

export interface AgentApproval {
  id: string;
  runId: string;
  toolCallId?: string;
  planId?: string;
  policyRevision: number;
  risk: ToolRiskClass;
  toolName?: string;
  resourceKeys: string[];
  resourceRevisions: Record<string, string>;
  redactedArgs?: unknown;
  status: AgentApprovalStatus;
  requestedAt: number;
  decidedAt?: number;
  expiresAt: number;
}

// ── Tool definition ──────────────────────────────────────────────────────────

export type ToolRiskClass =
  | 'local_read'
  | 'network_read'
  | 'local_create'
  | 'local_update'
  | 'local_delete'
  | 'process_execute'
  | 'external_write'
  | 'secret_access';

/** Generic JSON Schema descriptor. */
export type JsonSchema = Record<string, unknown>;

/** Frozen context handed to a tool handler. */
export interface ToolExecutionContext {
  runId: string;
  turn: number;
  executionEpoch: number;
  mode: 'read_only' | 'guided' | 'delegated';
  workspaceScope?: WorkspaceScopeSnapshot;
  contextRefs: AgentContextRef[];
  abortSignal: AbortSignal;
  /** Runtime-generated after turn persistence. Format: `${runId}:t${turn}:tc${toolIndex}`. */
  operationId?: string;
  toolIndex?: number;
  effectFingerprint?: string;
}

export interface AgentToolDefinition<TArgs = unknown, TResult = unknown> {
  name: string;
  version: string;
  description: string;
  inputSchema: JsonSchema;
  risk: ToolRiskClass;
  sideEffect: 'none' | 'reversible' | 'irreversible' | 'external';
  supportsRetry: boolean;
  timeoutMs: number;
  maxResultBytes: number;
  normalizeArgs(args: TArgs): TArgs;
  resolveResourceKeys(
    context: ToolExecutionContext,
    args: TArgs,
  ): string[];
  buildEffectPayload(args: TArgs): unknown;
  validateGrant(grant: AgentPolicyGrant, args: TArgs): boolean;
  execute(
    context: ToolExecutionContext,
    args: TArgs,
  ): Promise<TResult>;
}

// ── Tool result ──────────────────────────────────────────────────────────────

export type AgentToolErrorCode =
  | 'not_found'
  | 'validation_failed'
  | 'permission_denied'
  | 'approval_rejected'
  | 'stale_revision'
  | 'conflict'
  | 'timeout'
  | 'cancelled'
  | 'unavailable'
  | 'rate_limited'
  | 'interrupted'
  | 'internal_error';

export interface AgentToolError {
  code: AgentToolErrorCode;
  message: string;
  retryable: boolean;
}

export interface AgentChange {
  resourceKey: string;
  type: 'created' | 'updated' | 'deleted';
  summary: string;
}

export interface AgentArtifactRef {
  id: string;
  kind: string;
  label: string;
  byteSize?: number;
}

export interface AgentToolResult {
  ok: boolean;
  summary: string;
  data?: unknown;
  artifacts?: AgentArtifactRef[];
  changes?: AgentChange[];
  error?: AgentToolError;
  observedRevision?: string;
}

// ── Artifact ─────────────────────────────────────────────────────────────────

export type AgentArtifactKind =
  | 'tool_output'
  | 'file_content'
  | 'shell_output'
  | 'compaction_summary'
  | 'report';

export interface AgentArtifact {
  id: string;
  runId: string;
  kind: AgentArtifactKind;
  label: string;
  mimeType?: string;
  byteSize: number;
  contentHash: string;
  createdAt: number;
}

// ── Task projection job ──────────────────────────────────────────────────────

export type TaskProjectionJobStatus =
  | 'queued'
  | 'running'
  | 'retry_wait'
  | 'succeeded'
  | 'superseded'
  | 'failed';

export type TaskProjectionJobKind =
  | 'write_task'
  | 'write_project_index'
  | 'remove_path';

export interface TaskProjectionJob {
  id: string;
  sourceOperationId: string;
  taskId?: string;
  projectId?: string;
  projectionKey: string;
  kind: TaskProjectionJobKind;
  desiredRevision: string;
  targetPath: string;
  stalePaths: string[];
  serializedContent?: string;
  contentHash?: string;
  status: TaskProjectionJobStatus;
  attempt: number;
  maxAttempts: number;
  nextAttemptAt: number;
  lastError?: string;
  createdAt: number;
  finishedAt?: number;
}

// ── Persisted event ──────────────────────────────────────────────────────────

export type AgentEventType =
  | 'run.created'
  | 'run.queued'
  | 'run.started'
  | 'user.input_received'
  | 'user.input_scheduled'
  | 'run.status_changed'
  | 'plan.created'
  | 'plan.updated'
  | 'approval.requested'
  | 'approval.answered'
  | 'approval.invalidated'
  | 'model.requested'
  | 'model.stream_started'
  | 'model.stream_completed'
  | 'model.failed'
  | 'tool.requested'
  | 'tool.started'
  | 'tool.completed'
  | 'tool.failed'
  | 'tool.interrupted'
  | 'artifact.created'
  | 'context.compacted'
  | 'run.paused'
  | 'run.resumed'
  | 'run.cancelled'
  | 'run.completed'
  | 'run.failed'
  | 'run.interrupted';

export interface AgentEvent {
  id: string;
  runId: string;
  sequence: number;
  type: AgentEventType;
  data: unknown;
  createdAt: number;
}

// ── Client commands ──────────────────────────────────────────────────────────

export type AgentClientCommand =
  | 'run.create'
  | 'run.queue'
  | 'run.input.submit'
  | 'run.pause'
  | 'run.resume'
  | 'run.cancel'
  | 'run.retry'
  | 'approval.answer'
  | 'review.resolve'
  | 'run.rename'
  | 'run.archive'
  | 'run.unarchive'
  | 'run.queue.prioritize';

// ── Harness feature flag ─────────────────────────────────────────────────────

/** Settings key for the harness feature toggle. Disabled by default. */
export const HARNESS_ENABLED_SETTING_KEY = 'agent.harness.enabled';
