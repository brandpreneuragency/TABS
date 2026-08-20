// ---------------------------------------------------------------------------
// TABS Work-OS Harness — Deterministic fake provider
// Used by adapter tests and later runtime-kernel evaluations.
// ---------------------------------------------------------------------------

import type { AgentProviderAttempt } from '../../../types/agent';
import {
  PROVIDER_ADAPTER_KIND,
  PROVIDER_ADAPTER_VERSION,
  ProviderError,
  completeWithRetries,
  estimateInputTokens,
  type OpenAIProtocolToolCall,
  type ProviderAdapter,
  type ProviderAttemptFn,
  type ProviderCompletionRequest,
  type ProviderCompletionResult,
  type ProviderErrorKind,
  type ProviderRetryHooks,
} from './providerAdapter';

export type FakeProviderScript =
  | {
      type: 'text';
      content: string;
      finishReason?: string;
    }
  | {
      type: 'tool_calls';
      content?: string;
      tool_calls: OpenAIProtocolToolCall[];
    }
  | {
      type: 'error';
      kind: ProviderErrorKind;
      message: string;
      retryable?: boolean;
      status?: number;
      fragments?: OpenAIProtocolToolCall[];
    }
  | {
      type: 'incomplete';
      fragments?: OpenAIProtocolToolCall[];
    }
  | {
      type: 'malformed';
      chunk?: string;
    };

export interface FakeProviderOptions extends ProviderRetryHooks {
  scripts: FakeProviderScript[];
}

export class FakeProvider implements ProviderAdapter {
  readonly kind = PROVIDER_ADAPTER_KIND;
  readonly version = PROVIDER_ADAPTER_VERSION;
  readonly scripts: FakeProviderScript[];
  private cursor = 0;
  private readonly hooks: ProviderRetryHooks;

  constructor(options: FakeProviderOptions) {
    this.scripts = options.scripts;
    this.hooks = options;
  }

  complete(request: ProviderCompletionRequest): Promise<ProviderCompletionResult> {
    return completeWithRetries(this.attemptOnce, request, this.hooks);
  }

  private readonly attemptOnce: ProviderAttemptFn = async (
    request: ProviderCompletionRequest,
    attempt: AgentProviderAttempt,
  ): Promise<ProviderCompletionResult> => {
    const script = this.scripts[this.cursor] ?? this.scripts[this.scripts.length - 1];
    this.cursor += 1;
    if (!script) {
      throw new ProviderError('invalid_request', 'Fake provider has no script.', { retryable: false });
    }
    await this.hooks.attemptStore.updateProviderAttempt(attempt.id, { status: 'streaming' });
    return this.play(script, request, attempt);
  };

  private play(
    script: FakeProviderScript,
    request: ProviderCompletionRequest,
    attempt: AgentProviderAttempt,
  ): ProviderCompletionResult {
    const durationMs = Math.max(0, (this.hooks.now ?? Date.now)() - attempt.startedAt);
    const record = {
      providerId: request.snapshot.providerId,
      modelId: request.snapshot.modelId,
      adapterVersion: PROVIDER_ADAPTER_VERSION,
      toolRegistryVersion: request.toolRegistryVersion,
      messageCount: request.messages.length,
      estimatedInputTokens: estimateInputTokens(request.messages),
      durationMs,
    };

    if (script.type === 'error') {
      throw new ProviderError(script.kind, script.message, {
        retryable: script.retryable ?? (script.kind === 'transient' || script.kind === 'rate_limit'),
        status: script.status,
      });
    }

    if (script.type === 'incomplete') {
      throw new ProviderError(
        'incomplete_stream',
        'Discarded tool fragments from an incomplete provider stream.',
        { retryable: true },
      );
    }

    if (script.type === 'malformed') {
      throw new ProviderError(
        'malformed_stream',
        script.chunk ?? 'Provider stream contained malformed JSON.',
        { retryable: false },
      );
    }

    if (script.type === 'tool_calls') {
      if (request.onDelta && script.content) request.onDelta(script.content);
      return {
        role: 'assistant',
        content: script.content ?? '',
        tool_calls: script.tool_calls.map((call) => ({
          id: call.id,
          type: 'function',
          function: {
            name: call.function.name,
            arguments: call.function.arguments,
          },
        })),
        finishReason: 'tool_calls',
        attempt,
        request: { ...record, finishReason: 'tool_calls' },
      };
    }

    if (request.onDelta && script.content) request.onDelta(script.content);
    return {
      role: 'assistant',
      content: script.content,
      finishReason: script.finishReason ?? 'stop',
      attempt,
      request: { ...record, finishReason: script.finishReason ?? 'stop' },
    };
  }
}
