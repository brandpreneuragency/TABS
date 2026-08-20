import { describe, expect, it, vi } from 'vitest';

import { UNKNOWN_CONTEXT_WINDOW_TOKENS } from '../helpers';
import { FakeProvider } from './fakeProvider';
import { createOpenAICompatibleAdapter } from './openAICompatibleAdapter';
import {
  MemoryProviderAttemptStore,
  ProviderError,
  encodeProtocolMessages,
  freezeProviderSnapshot,
  type OpenAIProtocolToolCall,
  type OpenAIToolDefinition,
  type ProviderCompletionRequest,
  type ProviderProtocolMessage,
} from './providerAdapter';
import * as secureStorage from '../../secureStorage';

const TOOL: OpenAIToolDefinition = {
  type: 'function',
  function: {
    name: 'task_list',
    description: 'List tasks',
    parameters: { type: 'object' },
  },
};

const SEARCH_TOOL: OpenAIToolDefinition = {
  type: 'function',
  function: {
    name: 'crm_search',
    description: 'Search CRM',
    parameters: { type: 'object' },
  },
};

function snapshot(toolCalling = true) {
  return freezeProviderSnapshot({
    providerId: 'fixture-provider',
    baseUrl: 'https://provider.invalid/v1',
    modelId: 'fixture-model',
    credentialAccount: 'providerApiKey_fixture-provider',
    reasoning: 'standard',
    capabilities: {
      streaming: true,
      toolCalling,
      vision: false,
      reasoning: false,
    },
    contextWindow: 16_000,
    maxOutputTokens: 2_000,
  });
}

function baseRequest(
  overrides: Partial<ProviderCompletionRequest> = {},
): ProviderCompletionRequest {
  return {
    runId: 'run-1',
    executionEpoch: 0,
    turn: 1,
    messages: [{ role: 'user', content: 'Hello' }],
    snapshot: snapshot(true),
    apiKey: 'test-key',
    toolRegistryVersion: 'task_list@1',
    ...overrides,
  };
}

function sseResponse(
  events: unknown[],
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  const body = events
    .map((event) => (event === '[DONE]' ? 'data: [DONE]' : `data: ${typeof event === 'string' ? event : JSON.stringify(event)}`))
    .join('\n') + '\n';
  return new Response(body, {
    status: init.status ?? 200,
    headers: {
      'Content-Type': 'text/event-stream',
      ...init.headers,
    },
  });
}

function textEvents(content: string, finishReason = 'stop'): unknown[] {
  return [
    { choices: [{ delta: { content } }] },
    { choices: [{ delta: {}, finish_reason: finishReason }], usage: { completion_tokens: 4 } },
    '[DONE]',
  ];
}

function toolCallEvents(calls: OpenAIProtocolToolCall[]): unknown[] {
  const deltas = calls.map((call, index) => ({
    choices: [{
      delta: {
        tool_calls: [{
          index,
          id: call.id,
          type: 'function',
          function: { name: call.function.name, arguments: '' },
        }],
      },
    }],
  }));
  const argDeltas = calls.map((call, index) => ({
    choices: [{
      delta: {
        tool_calls: [{
          index,
          function: { arguments: call.function.arguments },
        }],
      },
    }],
  }));
  return [
    ...deltas,
    ...argDeltas,
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    '[DONE]',
  ];
}

function queuedFetch(responses: Array<Response | Error>): typeof fetch {
  const queue = [...responses];
  return vi.fn(async () => {
    const next = queue.shift();
    if (!next) throw new Error('Unexpected extra provider fetch.');
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
}

function createAdapter(fetchImpl: typeof fetch, store: MemoryProviderAttemptStore) {
  let clock = 1_000;
  let ids = 0;
  return createOpenAICompatibleAdapter({
    fetch: fetchImpl,
    attemptStore: store,
    now: () => {
      clock += 10;
      return clock;
    },
    createId: () => `attempt-${++ids}`,
    sleep: async () => undefined,
  });
}

describe('freezeProviderSnapshot', () => {
  it('freezes safe values and defaults unknown tool support to disabled', async () => {
    const getSpy = vi.spyOn(secureStorage.secureStorage, 'secureGet');
    const frozen = freezeProviderSnapshot({
      providerId: 'openai',
      baseUrl: 'https://api.example/v1/',
      modelId: 'model-x',
      credentialAccount: 'providerApiKey_openai',
    });

    expect(frozen.adapter).toBe('openai_compatible');
    expect(frozen.baseUrl).toBe('https://api.example/v1');
    expect(frozen.modelId).toBe('model-x');
    expect(frozen.credentialAccount).toBe('providerApiKey_openai');
    expect(frozen.capabilities.toolCalling).toBe(false);
    expect(frozen.capabilities.vision).toBe(false);
    expect(frozen.capabilities.streaming).toBe(true);
    expect(frozen.contextWindow).toBe(UNKNOWN_CONTEXT_WINDOW_TOKENS);
    expect(frozen.capabilities.contextWindow).toBe(UNKNOWN_CONTEXT_WINDOW_TOKENS);
    expect(frozen).not.toHaveProperty('apiKey');
    expect(JSON.stringify(frozen)).not.toContain('sk-');
    expect(getSpy).not.toHaveBeenCalled();
    getSpy.mockRestore();
  });
});

describe('encodeProtocolMessages', () => {
  it('preserves full assistant tool_calls payloads and tool_call_id on tool messages', () => {
    const messages: ProviderProtocolMessage[] = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'task_list', arguments: '{"limit":1}' },
        }],
      },
      { role: 'tool', content: '{"ok":true}', tool_call_id: 'call_1' },
    ];
    const encoded = encodeProtocolMessages(messages);
    expect(encoded[0]).toMatchObject({
      role: 'assistant',
      tool_calls: [{
        id: 'call_1',
        type: 'function',
        function: { name: 'task_list', arguments: '{"limit":1}' },
      }],
    });
    expect(encoded[1]).toEqual({
      role: 'tool',
      content: '{"ok":true}',
      tool_call_id: 'call_1',
    });
  });
});

describe('createOpenAICompatibleAdapter', () => {
  it('streams a text completion', async () => {
    const store = new MemoryProviderAttemptStore();
    const fetchImpl = queuedFetch([sseResponse(textEvents('Hello world'))]);
    const adapter = createAdapter(fetchImpl, store);
    const result = await adapter.complete(baseRequest());

    expect(result.content).toBe('Hello world');
    expect(result.finishReason).toBe('stop');
    expect(result.tool_calls).toBeUndefined();
    expect(result.request.outputTokens).toBe(4);
    expect(store.attempts).toHaveLength(1);
    expect(store.attempts[0].status).toBe('completed');
  });

  it('preserves one complete tool call payload', async () => {
    const store = new MemoryProviderAttemptStore();
    const call: OpenAIProtocolToolCall = {
      id: 'call_1',
      type: 'function',
      function: { name: 'task_list', arguments: '{"limit":1}' },
    };
    const fetchImpl = queuedFetch([sseResponse(toolCallEvents([call]))]);
    const adapter = createAdapter(fetchImpl, store);
    const result = await adapter.complete(baseRequest( { tools: [TOOL] }));

    expect(result.finishReason).toBe('tool_calls');
    expect(result.tool_calls).toEqual([call]);
  });

  it('preserves multiple tool calls from one turn', async () => {
    const store = new MemoryProviderAttemptStore();
    const calls: OpenAIProtocolToolCall[] = [
      { id: 'call_1', type: 'function', function: { name: 'task_list', arguments: '{}' } },
      { id: 'call_2', type: 'function', function: { name: 'crm_search', arguments: '{"q":"acme"}' } },
    ];
    const fetchImpl = queuedFetch([sseResponse(toolCallEvents(calls))]);
    const adapter = createAdapter(fetchImpl, store);
    const result = await adapter.complete(baseRequest( { tools: [TOOL, SEARCH_TOOL] }));

    expect(result.tool_calls).toEqual(calls);
  });

  it('sends prior tool_calls and tool_call_id on the wire', async () => {
    const store = new MemoryProviderAttemptStore();
    const fetchImpl = queuedFetch([sseResponse(textEvents('done'))]);
    const adapter = createAdapter(fetchImpl, store);
    await adapter.complete(baseRequest( {
      messages: [
        { role: 'user', content: 'List tasks' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_9',
            type: 'function',
            function: { name: 'task_list', arguments: '{}' },
          }],
        },
        { role: 'tool', content: '[]', tool_call_id: 'call_9' },
      ],
    }));

    const init = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    const body = JSON.parse(String(init.body)) as {
      messages: ProviderProtocolMessage[];
    };
    expect(body.messages[1].role === 'assistant' && body.messages[1].tool_calls).toEqual([{
      id: 'call_9',
      type: 'function',
      function: { name: 'task_list', arguments: '{}' },
    }]);
    expect(body.messages[2]).toEqual({
      role: 'tool',
      content: '[]',
      tool_call_id: 'call_9',
    });
  });

  it('rejects malformed streams without retrying', async () => {
    const store = new MemoryProviderAttemptStore();
    const fetchImpl = queuedFetch([sseResponse(['{not-json'])]);
    const adapter = createAdapter(fetchImpl, store);

    await expect(adapter.complete(baseRequest())).rejects.toMatchObject({
      kind: 'malformed_stream',
      retryable: false,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(store.attempts).toHaveLength(1);
    expect(store.attempts[0].status).toBe('failed');
    expect(store.attempts[0].safeRetry).toBe(false);
  });

  it('retries transient failures and persists each attempt', async () => {
    const store = new MemoryProviderAttemptStore();
    const fetchImpl = queuedFetch([
      new Response('unavailable', { status: 503 }),
      sseResponse(textEvents('recovered')),
    ]);
    const adapter = createAdapter(fetchImpl, store);
    const result = await adapter.complete(baseRequest());

    expect(result.content).toBe('recovered');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(store.attempts.map((attempt) => attempt.status)).toEqual(['failed', 'completed']);
    expect(store.attempts[0].id).not.toBe(store.attempts[1].id);
    expect(store.attempts[0].attempt).toBe(1);
    expect(store.attempts[1].attempt).toBe(2);
    expect(store.attempts[0].turn).toBe(1);
    expect(store.attempts[1].turn).toBe(1);
    expect(store.attempts[0].requestHash).toBe(store.attempts[1].requestHash);
  });

  it('does not retry authentication errors', async () => {
    const store = new MemoryProviderAttemptStore();
    const fetchImpl = queuedFetch([new Response('unauthorized', { status: 401 })]);
    const adapter = createAdapter(fetchImpl, store);

    const error = await adapter.complete(baseRequest()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ kind: 'authentication', retryable: false, status: 401 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(store.attempts).toHaveLength(1);
    expect(store.attempts[0].status).toBe('failed');
    expect(store.attempts[0].safeRetry).toBe(false);
  });

  it('does not retry invalid request failures', async () => {
    const store = new MemoryProviderAttemptStore();
    const fetchImpl = queuedFetch([new Response('bad request', { status: 400 })]);
    const adapter = createAdapter(fetchImpl, store);

    const error = await adapter.complete(baseRequest()).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: 'invalid_request', retryable: false, status: 400 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries rate limits then pauses after they repeat', async () => {
    const store = new MemoryProviderAttemptStore();
    const fetchImpl = queuedFetch([
      new Response('slow down', { status: 429 }),
      new Response('slow down', { status: 429 }),
      new Response('slow down', { status: 429 }),
    ]);
    const adapter = createAdapter(fetchImpl, store);

    const error = await adapter.complete(baseRequest()).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      kind: 'rate_limit',
      retryable: false,
      pauseRecommended: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(store.attempts).toHaveLength(3);
  });

  it('discards partial tool calls from a failed stream before retrying', async () => {
    const store = new MemoryProviderAttemptStore();
    const partial = sseResponse([
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_partial',
              type: 'function',
              function: { name: 'task_list', arguments: '{"lim' },
            }],
          },
        }],
      },
    ]);
    const fetchImpl = queuedFetch([
      partial,
      sseResponse(textEvents('no tools')),
    ]);
    const adapter = createAdapter(fetchImpl, store);
    const result = await adapter.complete(baseRequest( { tools: [TOOL] }));

    expect(result.content).toBe('no tools');
    expect(result.tool_calls).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('call_partial');
    expect(store.attempts.map((attempt) => attempt.status)).toEqual(['failed', 'completed']);
    expect(store.attempts[0].finishReason).toBe('incomplete_stream');
  });

  it('rejects tool use when tool support is unknown or disabled', async () => {
    const store = new MemoryProviderAttemptStore();
    const fetchImpl = queuedFetch([]);
    const adapter = createAdapter(fetchImpl, store);
    const error = await adapter.complete(baseRequest( {
      snapshot: snapshot(false),
      tools: [TOOL],
    })).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ kind: 'capability', retryable: false });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(store.attempts).toHaveLength(0);
  });

  it('rejects models that disable streaming', async () => {
    const store = new MemoryProviderAttemptStore();
    const fetchImpl = queuedFetch([]);
    const adapter = createAdapter(fetchImpl, store);
    const frozen = freezeProviderSnapshot({
      providerId: 'fixture-provider',
      baseUrl: 'https://provider.invalid/v1',
      modelId: 'fixture-model',
      credentialAccount: 'providerApiKey_fixture',
      capabilities: { streaming: false, toolCalling: false, vision: false, reasoning: false },
    });
    const error = await adapter.complete(baseRequest( { snapshot: frozen }))
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: 'capability' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('FakeProvider', () => {
  it('returns scripted tool_calls without leaking discarded fragments', async () => {
    const store = new MemoryProviderAttemptStore();
    const provider = new FakeProvider({
      attemptStore: store,
      sleep: async () => undefined,
      createId: (() => {
        let n = 0;
        return () => `fake-${++n}`;
      })(),
      scripts: [
        {
          type: 'incomplete',
          fragments: [{
            id: 'discard-me',
            type: 'function',
            function: { name: 'task_list', arguments: '{' },
          }],
        },
        {
          type: 'tool_calls',
          tool_calls: [{
            id: 'call_ok',
            type: 'function',
            function: { name: 'task_list', arguments: '{}' },
          }],
        },
      ],
    });

    const result = await provider.complete(baseRequest( { tools: [TOOL] }));
    expect(result.tool_calls).toEqual([{
      id: 'call_ok',
      type: 'function',
      function: { name: 'task_list', arguments: '{}' },
    }]);
    expect(JSON.stringify(result)).not.toContain('discard-me');
    expect(store.attempts).toHaveLength(2);
  });
});
