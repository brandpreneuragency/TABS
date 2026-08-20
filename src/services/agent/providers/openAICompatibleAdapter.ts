// ---------------------------------------------------------------------------
// TABS Work-OS Harness — OpenAI-compatible streaming adapter
// Preserves full assistant tool_calls payloads and tool_call_id on tool messages.
// ---------------------------------------------------------------------------

import { runtimeFetch } from '../../http';
import type { AgentProviderAttempt } from '../../../types/agent';
import {
  PROVIDER_ADAPTER_KIND,
  PROVIDER_ADAPTER_VERSION,
  ProviderError,
  classifyProviderHttpStatus,
  completeWithRetries,
  estimateInputTokens,
  toProviderError,
  type OpenAIProtocolToolCall,
  type ProviderAdapter,
  type ProviderAttemptFn,
  type ProviderCompletionRequest,
  type ProviderCompletionResult,
  type ProviderRetryHooks,
} from './providerAdapter';

export interface OpenAICompatibleAdapterOptions extends ProviderRetryHooks {
  fetch?: typeof fetch;
}

interface StreamAccumulator {
  content: string;
  toolCalls: Map<number, OpenAIProtocolToolCall>;
  finishReason?: string;
  outputTokens?: number;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

function toWireMessages(messages: ProviderCompletionRequest['messages']): unknown[] {
  return messages.map((message) => {
    if (message.role === 'tool') {
      return {
        role: 'tool',
        content: message.content,
        tool_call_id: message.tool_call_id,
      };
    }
    if (message.role === 'assistant' && message.tool_calls && message.tool_calls.length > 0) {
      return {
        role: 'assistant',
        content: message.content,
        tool_calls: message.tool_calls,
      };
    }
    return { role: message.role, content: message.content };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function accumulateToolCallDelta(
  acc: StreamAccumulator,
  rawCalls: unknown,
): void {
  if (!Array.isArray(rawCalls)) return;
  for (const raw of rawCalls) {
    if (!isRecord(raw)) continue;
    const index = typeof raw.index === 'number' ? raw.index : acc.toolCalls.size;
    const current = acc.toolCalls.get(index) ?? {
      id: '',
      type: 'function' as const,
      function: { name: '', arguments: '' },
    };
    const id = asString(raw.id);
    if (id) current.id = id;
    const fn = isRecord(raw.function) ? raw.function : undefined;
    const name = asString(fn?.name);
    if (name) current.function.name = name;
    const args = asString(fn?.arguments);
    if (args) current.function.arguments += args;
    acc.toolCalls.set(index, current);
  }
}

function completedToolCalls(acc: StreamAccumulator): OpenAIProtocolToolCall[] | undefined {
  if (acc.toolCalls.size === 0) return undefined;
  const calls = Array.from(acc.toolCalls.entries())
    .sort(([left], [right]) => left - right)
    .map(([, call]) => ({
      id: call.id,
      type: 'function' as const,
      function: {
        name: call.function.name,
        arguments: call.function.arguments,
      },
    }));
  if (calls.some((call) => !call.id || !call.function.name)) {
    throw new ProviderError(
      'incomplete_stream',
      'Discarded incomplete tool_calls fragments from the provider stream.',
      { retryable: true },
    );
  }
  return calls;
}

function applyUsage(acc: StreamAccumulator, usage: unknown): void {
  if (!isRecord(usage)) return;
  if (typeof usage.completion_tokens === 'number') {
    acc.outputTokens = usage.completion_tokens;
  }
}

function applyChoice(acc: StreamAccumulator, choice: unknown): void {
  if (!isRecord(choice)) return;
  const finish = asString(choice.finish_reason);
  if (finish) acc.finishReason = finish;
  const delta = isRecord(choice.delta) ? choice.delta : undefined;
  const message = isRecord(choice.message) ? choice.message : undefined;
  const content = asString(delta?.content) ?? asString(message?.content);
  if (content) acc.content += content;
  accumulateToolCallDelta(acc, delta?.tool_calls ?? message?.tool_calls);
}

async function consumeSseStream(
  response: Response,
  onDelta: ((text: string) => void) | undefined,
  signal: AbortSignal | undefined,
): Promise<StreamAccumulator> {
  if (!response.body) {
    throw new ProviderError('incomplete_stream', 'Provider response had no body.', {
      retryable: true,
      status: response.status,
    });
  }

  const acc: StreamAccumulator = { content: '', toolCalls: new Map() };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      if (signal?.aborted) {
        throw new ProviderError('cancelled', 'Provider request was cancelled.', { retryable: false });
      }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue;
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') {
          return acc;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          throw new ProviderError(
            'malformed_stream',
            'Provider stream contained malformed JSON.',
            { retryable: false },
          );
        }
        if (!isRecord(parsed)) {
          throw new ProviderError(
            'malformed_stream',
            'Provider stream contained a non-object event.',
            { retryable: false },
          );
        }
        applyUsage(acc, parsed.usage);
        const choices = parsed.choices;
        if (Array.isArray(choices) && choices.length > 0) {
          const before = acc.content.length;
          applyChoice(acc, choices[0]);
          if (onDelta && acc.content.length > before) {
            onDelta(acc.content.slice(before));
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return acc;
}

function emptyApiKeyError(): ProviderError {
  return new ProviderError(
    'authentication',
    'No provider credential was resolved for this request.',
    { retryable: false },
  );
}

export function createOpenAICompatibleAdapter(
  options: OpenAICompatibleAdapterOptions,
): ProviderAdapter {
  const fetchImpl = options.fetch ?? runtimeFetch;

  const attemptOnce: ProviderAttemptFn = async (
    request: ProviderCompletionRequest,
    attempt: AgentProviderAttempt,
  ): Promise<ProviderCompletionResult> => {
    const startedAt = attempt.startedAt;
    if (!request.apiKey.trim()) {
      throw emptyApiKeyError();
    }

    const body: Record<string, unknown> = {
      model: request.snapshot.modelId,
      messages: toWireMessages(request.messages),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools;
      body.tool_choice = 'auto';
    }
    if (
      request.snapshot.capabilities.reasoning
      && request.snapshot.reasoning
      && request.snapshot.reasoning !== 'none'
      && request.snapshot.reasoning !== 'off'
    ) {
      body.reasoning_effort = request.snapshot.reasoning;
    }

    await options.attemptStore.updateProviderAttempt(attempt.id, { status: 'streaming' });

    let response: Response;
    try {
      response = await fetchImpl(joinUrl(request.snapshot.baseUrl, '/chat/completions'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${request.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: request.abortSignal,
      });
    } catch (error) {
      throw toProviderError(error);
    }

    const providerRequestId =
      response.headers.get('x-request-id') ?? response.headers.get('x-openai-request-id') ?? undefined;

    if (!response.ok) {
      const raw = await response.text().catch(() => '');
      const classified = classifyProviderHttpStatus(response.status);
      throw new ProviderError(
        classified.kind,
        `OpenAI-compatible error ${response.status}: ${raw || response.statusText}`,
        { retryable: classified.retryable, status: response.status },
      );
    }

    const acc = await consumeSseStream(response, request.onDelta, request.abortSignal);
    const durationMs = Math.max(0, (options.now ?? Date.now)() - startedAt);

    if (!acc.finishReason) {
      acc.toolCalls.clear();
      throw new ProviderError(
        'incomplete_stream',
        'Discarded tool fragments from an incomplete provider stream.',
        { retryable: true },
      );
    }

    let tool_calls: OpenAIProtocolToolCall[] | undefined;
    try {
      tool_calls = acc.finishReason === 'tool_calls' ? completedToolCalls(acc) : undefined;
    } catch (error) {
      acc.toolCalls.clear();
      throw error;
    }

    if (acc.finishReason !== 'tool_calls') {
      acc.toolCalls.clear();
    }

    return {
      role: 'assistant',
      content: acc.content,
      tool_calls,
      finishReason: acc.finishReason,
      attempt,
      request: {
        providerId: request.snapshot.providerId,
        modelId: request.snapshot.modelId,
        adapterVersion: PROVIDER_ADAPTER_VERSION,
        toolRegistryVersion: request.toolRegistryVersion,
        messageCount: request.messages.length,
        estimatedInputTokens: estimateInputTokens(request.messages),
        outputTokens: acc.outputTokens,
        finishReason: acc.finishReason,
        durationMs,
        providerRequestId,
      },
    };
  };

  return {
    kind: PROVIDER_ADAPTER_KIND,
    version: PROVIDER_ADAPTER_VERSION,
    complete(request: ProviderCompletionRequest): Promise<ProviderCompletionResult> {
      return completeWithRetries(attemptOnce, request, options);
    },
  };
}
