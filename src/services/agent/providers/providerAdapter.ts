// ---------------------------------------------------------------------------
// TABS Work-OS Harness — Provider adapter contract
// Source: TABS_WORK_OS_HARNESS_PLAN.md sections 12.8, 12.9, 16
// ---------------------------------------------------------------------------

import type {
  AgentProviderAttempt,
  AgentProviderAttemptStatus,
  ModelCapabilities,
  ProviderSnapshot,
} from '../../../types/agent';
import { generateId, UNKNOWN_CONTEXT_WINDOW_TOKENS } from '../helpers';
import { redactSecrets } from '../redaction';

export const PROVIDER_ADAPTER_KIND = 'openai_compatible' as const;
export const PROVIDER_ADAPTER_VERSION = '1.0.0';
/** Retry transient failures at most two times (three attempts total). */
export const MAX_PROVIDER_RETRIES = 2;
export const DEFAULT_MAX_OUTPUT_TOKENS = 2_048;
export const PROVIDER_RETRY_BACKOFF_MS = 250;

export type ProviderErrorKind =
  | 'transient'
  | 'authentication'
  | 'invalid_request'
  | 'rate_limit'
  | 'malformed_stream'
  | 'incomplete_stream'
  | 'cancelled'
  | 'capability';

export class ProviderError extends Error {
  readonly name = 'ProviderError';
  readonly kind: ProviderErrorKind;
  readonly retryable: boolean;
  readonly status?: number;
  readonly pauseRecommended: boolean;

  constructor(
    kind: ProviderErrorKind,
    message: string,
    options: { retryable: boolean; status?: number; pauseRecommended?: boolean } = {
      retryable: false,
    },
  ) {
    super(redactSecrets(message));
    this.kind = kind;
    this.retryable = options.retryable;
    this.status = options.status;
    this.pauseRecommended = options.pauseRecommended ?? (kind === 'rate_limit' && !options.retryable);
  }
}

/** Full OpenAI-compatible assistant tool-call payload. */
export interface OpenAIProtocolToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface OpenAIToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export type ProviderProtocolMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: OpenAIProtocolToolCall[] }
  | { role: 'tool'; content: string; tool_call_id: string };

export interface ProviderRequestRecord {
  providerId: string;
  modelId: string;
  adapterVersion: string;
  toolRegistryVersion?: string;
  messageCount: number;
  estimatedInputTokens: number;
  outputTokens?: number;
  finishReason?: string;
  durationMs: number;
  providerRequestId?: string;
}

export interface ProviderCompletionRequest {
  runId: string;
  executionEpoch: number;
  turn: number;
  messages: ProviderProtocolMessage[];
  tools?: OpenAIToolDefinition[];
  snapshot: ProviderSnapshot;
  /** Resolved at request time. Never stored on the snapshot. */
  apiKey: string;
  toolRegistryVersion?: string;
  abortSignal?: AbortSignal;
  onDelta?: (text: string) => void;
}

export interface ProviderCompletionResult {
  role: 'assistant';
  content: string;
  tool_calls?: OpenAIProtocolToolCall[];
  finishReason: string;
  attempt: AgentProviderAttempt;
  request: ProviderRequestRecord;
}

export interface ProviderAttemptStore {
  startProviderAttempt(attempt: AgentProviderAttempt): Promise<AgentProviderAttempt>;
  updateProviderAttempt(
    attemptId: string,
    patch: Partial<Omit<AgentProviderAttempt, 'id' | 'runId'>>,
  ): Promise<AgentProviderAttempt>;
}

export interface ProviderAdapter {
  readonly kind: typeof PROVIDER_ADAPTER_KIND;
  readonly version: string;
  complete(request: ProviderCompletionRequest): Promise<ProviderCompletionResult>;
}

export interface FreezeProviderInput {
  providerId: string;
  baseUrl: string;
  modelId: string;
  credentialAccount: string;
  reasoning?: string;
  capabilities?: Partial<ModelCapabilities> | null;
  contextWindow?: number;
  maxOutputTokens?: number;
}

export interface ProviderRetryHooks {
  attemptStore: ProviderAttemptStore;
  now?: () => number;
  createId?: () => string;
  sleep?: (ms: number) => Promise<void>;
}

export class MemoryProviderAttemptStore implements ProviderAttemptStore {
  readonly attempts: AgentProviderAttempt[] = [];

  async startProviderAttempt(attempt: AgentProviderAttempt): Promise<AgentProviderAttempt> {
    this.attempts.push({ ...attempt });
    return attempt;
  }

  async updateProviderAttempt(
    attemptId: string,
    patch: Partial<Omit<AgentProviderAttempt, 'id' | 'runId'>>,
  ): Promise<AgentProviderAttempt> {
    const index = this.attempts.findIndex((attempt) => attempt.id === attemptId);
    if (index === -1) {
      throw new Error(`Provider attempt ${attemptId} was not found.`);
    }
    const updated = { ...this.attempts[index], ...patch };
    this.attempts[index] = updated;
    return updated;
  }
}

function positiveInt(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

/**
 * Freeze safe provider, model, reasoning, context, and capability values.
 * Unknown tool support defaults to disabled. Unknown context uses 16,000 tokens.
 * Never reads secure storage and never copies a secret value onto the snapshot.
 */
export function freezeProviderSnapshot(input: FreezeProviderInput): ProviderSnapshot {
  const contextWindow =
    positiveInt(input.contextWindow)
    ?? positiveInt(input.capabilities?.contextWindow)
    ?? UNKNOWN_CONTEXT_WINDOW_TOKENS;
  const maxOutputTokens =
    positiveInt(input.maxOutputTokens)
    ?? positiveInt(input.capabilities?.maxOutputTokens)
    ?? DEFAULT_MAX_OUTPUT_TOKENS;

  const capabilities: ModelCapabilities = {
    streaming: input.capabilities?.streaming !== false,
    toolCalling: input.capabilities?.toolCalling === true,
    vision: input.capabilities?.vision === true,
    reasoning: input.capabilities?.reasoning === true,
    contextWindow,
    maxOutputTokens,
  };

  return {
    providerId: input.providerId,
    adapter: PROVIDER_ADAPTER_KIND,
    adapterVersion: PROVIDER_ADAPTER_VERSION,
    baseUrl: input.baseUrl.replace(/\/+$/, ''),
    modelId: input.modelId,
    credentialAccount: input.credentialAccount,
    reasoning: input.reasoning ?? '',
    capabilities,
    contextWindow,
    maxOutputTokens,
  };
}

export function assertProviderCapabilities(
  snapshot: ProviderSnapshot,
  toolsRequested: boolean,
): void {
  if (!snapshot.capabilities.streaming) {
    throw new ProviderError(
      'capability',
      'Streaming is required for the OpenAI-compatible adapter.',
      { retryable: false },
    );
  }
  if (toolsRequested && !snapshot.capabilities.toolCalling) {
    throw new ProviderError(
      'capability',
      'This model does not support tool calling.',
      { retryable: false },
    );
  }
}

export function encodeProtocolMessages(
  messages: ProviderProtocolMessage[],
): ProviderProtocolMessage[] {
  return messages.map((message) => {
    if (message.role === 'tool') {
      if (!message.tool_call_id) {
        throw new ProviderError(
          'invalid_request',
          'Tool messages require tool_call_id.',
          { retryable: false },
        );
      }
      return {
        role: 'tool',
        content: message.content,
        tool_call_id: message.tool_call_id,
      };
    }
    if (message.role === 'assistant') {
      const encoded: ProviderProtocolMessage = {
        role: 'assistant',
        content: message.content,
      };
      if (message.tool_calls && message.tool_calls.length > 0) {
        encoded.tool_calls = message.tool_calls.map((call) => {
          if (!call.id || !call.function?.name) {
            throw new ProviderError(
              'invalid_request',
              'Assistant tool_calls payloads require id and function.name.',
              { retryable: false },
            );
          }
          return {
            id: call.id,
            type: 'function',
            function: {
              name: call.function.name,
              arguments: call.function.arguments ?? '',
            },
          };
        });
      }
      return encoded;
    }
    return { role: message.role, content: message.content };
  });
}

export function estimateInputTokens(messages: ProviderProtocolMessage[]): number {
  const serialized = JSON.stringify(messages);
  return Math.max(1, Math.ceil(serialized.length / 4));
}

export function hashProviderRequest(parts: {
  modelId: string;
  messages: ProviderProtocolMessage[];
  tools?: OpenAIToolDefinition[];
}): string {
  const payload = JSON.stringify({
    modelId: parts.modelId,
    messages: parts.messages,
    tools: parts.tools?.map((tool) => tool.function.name) ?? [],
  });
  let hash = 5381;
  for (let i = 0; i < payload.length; i++) {
    hash = ((hash << 5) + hash + payload.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function classifyProviderHttpStatus(status: number): {
  kind: ProviderErrorKind;
  retryable: boolean;
} {
  if (status === 401 || status === 403) {
    return { kind: 'authentication', retryable: false };
  }
  if (status === 429) {
    return { kind: 'rate_limit', retryable: true };
  }
  if (status === 408 || status === 409 || status >= 500) {
    return { kind: 'transient', retryable: true };
  }
  if (status >= 400 && status < 500) {
    return { kind: 'invalid_request', retryable: false };
  }
  return { kind: 'transient', retryable: true };
}

export function toProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  if (error instanceof DOMException && error.name === 'AbortError') {
    return new ProviderError('cancelled', 'Provider request was cancelled.', { retryable: false });
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return new ProviderError('cancelled', 'Provider request was cancelled.', { retryable: false });
  }
  const message = error instanceof Error ? error.message : 'Provider request failed.';
  return new ProviderError('transient', message, { retryable: true });
}

export function providerRetryBackoffMs(retryNumber: number): number {
  return Math.min(PROVIDER_RETRY_BACKOFF_MS * 2 ** (retryNumber - 1), 2_000);
}

export type ProviderAttemptFn = (
  request: ProviderCompletionRequest,
  attempt: AgentProviderAttempt,
) => Promise<ProviderCompletionResult>;

function attemptStatusForError(
  error: ProviderError,
): Extract<AgentProviderAttemptStatus, 'failed' | 'interrupted'> {
  return error.kind === 'cancelled' ? 'interrupted' : 'failed';
}

export async function completeWithRetries(
  attemptOnce: ProviderAttemptFn,
  request: ProviderCompletionRequest,
  hooks: ProviderRetryHooks,
): Promise<ProviderCompletionResult> {
  const now = hooks.now ?? Date.now;
  const createId = hooks.createId ?? generateId;
  const sleep = hooks.sleep ?? ((ms: number) => new Promise((resolve) => {
    setTimeout(resolve, ms);
  }));
  const encoded = encodeProtocolMessages(request.messages);
  const toolsRequested = (request.tools?.length ?? 0) > 0;
  assertProviderCapabilities(request.snapshot, toolsRequested);
  const prepared: ProviderCompletionRequest = { ...request, messages: encoded };
  const requestHash = hashProviderRequest({
    modelId: request.snapshot.modelId,
    messages: encoded,
    tools: request.tools,
  });
  const maxAttempts = 1 + MAX_PROVIDER_RETRIES;
  let lastError: ProviderError | undefined;

  for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber++) {
    if (prepared.abortSignal?.aborted) {
      throw new ProviderError('cancelled', 'Provider request was cancelled.', { retryable: false });
    }
    const startedAt = now();
    const attempt = await hooks.attemptStore.startProviderAttempt({
      id: createId(),
      runId: prepared.runId,
      executionEpoch: prepared.executionEpoch,
      turn: prepared.turn,
      attempt: attemptNumber,
      status: 'started',
      requestHash,
      startedAt,
      safeRetry: true,
    });
    try {
      const result = await attemptOnce(prepared, attempt);
      const finished = await hooks.attemptStore.updateProviderAttempt(attempt.id, {
        status: 'completed',
        finishedAt: now(),
        finishReason: result.finishReason,
        safeRetry: false,
      });
      return { ...result, attempt: finished };
    } catch (caught) {
      const error = toProviderError(caught);
      lastError = error;
      await hooks.attemptStore.updateProviderAttempt(attempt.id, {
        status: attemptStatusForError(error),
        finishedAt: now(),
        finishReason: error.kind,
        safeRetry: error.retryable,
      });
      const retriesRemain = attemptNumber < maxAttempts;
      if (!error.retryable || !retriesRemain) {
        if (error.retryable && !retriesRemain) {
          throw new ProviderError(error.kind, error.message, {
            retryable: false,
            status: error.status,
            pauseRecommended: error.kind === 'rate_limit',
          });
        }
        throw error;
      }
      await sleep(providerRetryBackoffMs(attemptNumber));
    }
  }

  throw lastError ?? new ProviderError('transient', 'Provider request failed.', { retryable: false });
}
