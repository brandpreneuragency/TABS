import { describe, expect, it, vi } from 'vitest';
import type {
  AgentToolDefinition,
  AgentToolResult,
  WorkspaceScopeSnapshot,
} from '../../types/agent';
import {
  AgentRuntime,
  captureWorkspaceScopeSnapshot,
  reviewRunCompatibility,
} from './agentRuntime';
import { compileContextMessages } from './contextManager';
import { MAX_TOOL_RESULT_BYTES } from './helpers';
import { FakeProvider, type FakeProviderScript } from './providers/fakeProvider';
import { freezeProviderSnapshot, type OpenAIProtocolToolCall } from './providers/providerAdapter';
import {
  createMemoryExecutorStore,
  RUNTIME_HARD_MAX_DURATION_MS,
  RUNTIME_HARD_MAX_TURNS,
} from './runExecutor';

const WORKSPACE: WorkspaceScopeSnapshot = {
  workspaceId: 'workspace-1',
  rootPath: '/secret/project-root',
  rootRevision: 'rev-1',
  nativeScopeId: 'native-scope-1',
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

function profile() {
  return {
    name: 'Fixture',
    description: 'Fixture profile',
    systemInstructions: 'Follow the harness.',
    defaultMode: 'read_only' as const,
    allowedToolGroups: ['read'],
    defaultSkills: [],
  };
}

function instructions() {
  return {
    safetyInstructionsHash: 'safe',
    policyHash: 'policy',
    skillHashes: [],
    compiledContent: 'You are the TABS read-only kernel.',
    compiledContentHash: 'compiled',
  };
}

function policy() {
  return { revision: 1, mode: 'read_only' as const, rulesHash: 'rules' };
}

function toolCall(id: string, name: string, args: Record<string, unknown> = {}): OpenAIProtocolToolCall {
  return {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
}

function makeTool(
  name: string,
  execute: AgentToolDefinition['execute'] = async () => ({ ok: true, summary: name }),
): AgentToolDefinition {
  return {
    name,
    version: '1.0.0',
    description: name,
    inputSchema: { type: 'object' },
    risk: 'local_read',
    sideEffect: 'none',
    supportsRetry: true,
    timeoutMs: 5_000,
    maxResultBytes: MAX_TOOL_RESULT_BYTES,
    normalizeArgs: (args) => args,
    resolveResourceKeys: () => [`tool:${name}`],
    buildEffectPayload: (args) => args,
    validateGrant: () => true,
    execute,
  };
}

async function createHarness(options: {
  scripts?: FakeProviderScript[];
  tools?: AgentToolDefinition[];
  maxTurns?: number;
  maxDurationMs?: number;
  resolveCredential?: (account: string) => Promise<string | undefined>;
  isModelAvailable?: () => boolean;
  resolveToolRegistryHash?: () => string;
  resolveLiveWorkspaceScope?: () => Promise<WorkspaceScopeSnapshot | undefined>;
  now?: () => number;
} = {}) {
  const now = options.now ?? Date.now;
  const store = createMemoryExecutorStore(now);
  const provider = new FakeProvider({
    scripts: options.scripts ?? [{ type: 'text', content: 'done' }],
    attemptStore: store,
    now,
    sleep: async () => undefined,
  });
  const runtime = new AgentRuntime({
    store,
    provider,
    tools: options.tools ?? [makeTool('echo')],
    resolveCredential: options.resolveCredential ?? (async () => 'test-key'),
    isModelAvailable: options.isModelAvailable,
    resolveToolRegistryHash: options.resolveToolRegistryHash,
    resolveLiveWorkspaceScope: options.resolveLiveWorkspaceScope,
    now,
  });
  const run = await runtime.createRun({
    goal: 'Complete the fixture goal',
    providerSnapshot: snapshot(true),
    profileSnapshot: profile(),
    instructionSnapshot: instructions(),
    policySnapshot: policy(),
    workspaceScope: WORKSPACE,
    toolRegistryVersion: 'echo@1.0.0',
    toolRegistryHash: 'registry',
    maxTurns: options.maxTurns,
    maxDurationMs: options.maxDurationMs,
  });
  return { runtime, store, provider, run };
}

describe('agent runtime kernel', () => {
  it('captures a workspace scope snapshot before queueing and hides privileged fields from the model', async () => {
    const { run, store } = await createHarness();
    expect(run.status).toBe('queued');
    expect(run.workspaceScope).toEqual(captureWorkspaceScopeSnapshot(WORKSPACE));
    expect(run.maxTurns).toBeLessThanOrEqual(RUNTIME_HARD_MAX_TURNS);
    expect(run.maxDurationMs).toBeLessThanOrEqual(RUNTIME_HARD_MAX_DURATION_MS);

    const compiled = compileContextMessages({
      run,
      messages: await store.getMessages(run.id),
    });
    const visible = JSON.stringify(compiled);
    expect(visible).toContain('workspace-1');
    expect(visible).toContain('rev-1');
    expect(visible).not.toContain('/secret/project-root');
    expect(visible).not.toContain('native-scope-1');
  });

  it('completes a text-only turn without executing tools', async () => {
    const { runtime, store, run } = await createHarness({
      scripts: [{ type: 'text', content: 'All set.' }],
    });
    const finished = await runtime.start(run.id);
    expect(finished.status).toBe('completed');
    expect(finished.finalSummary).toBe('All set.');
    expect(await store.getToolCalls(run.id)).toEqual([]);
    const messages = await store.getMessages(run.id);
    expect(messages.some((message) => message.role === 'assistant' && message.content === 'All set.')).toBe(true);
  });

  it('persists every logical tool call before any tool executes and runs them sequentially', async () => {
    const order: string[] = [];
    const tools = [
      makeTool('alpha', async () => {
        order.push('alpha');
        return { ok: true, summary: 'alpha' };
      }),
      makeTool('beta', async () => {
        order.push('beta');
        return { ok: true, summary: 'beta' };
      }),
    ];
    const { runtime, store, run } = await createHarness({
      scripts: [
        {
          type: 'tool_calls',
          tool_calls: [toolCall('call-a', 'alpha'), toolCall('call-b', 'beta')],
        },
        { type: 'text', content: 'used both tools' },
      ],
      tools,
    });
    const persist = store.persistAssistantTurn.bind(store);
    store.persistAssistantTurn = async (message, toolCalls) => {
      if (toolCalls.length > 0) {
        expect(order.filter((item) => item === 'alpha' || item === 'beta')).toEqual([]);
        order.push(`persist:${toolCalls.length}`);
        expect(toolCalls.map((call) => call.toolName)).toEqual(['alpha', 'beta']);
      }
      await persist(message, toolCalls);
    };

    const finished = await runtime.start(run.id);
    expect(finished.status).toBe('completed');
    expect(order).toEqual(['persist:2', 'alpha', 'beta']);
    const calls = await store.getToolCalls(run.id);
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.status)).toEqual(['succeeded', 'succeeded']);
    expect(calls.map((call) => call.operationId)).toEqual([`${run.id}:t1:tc0`, `${run.id}:t1:tc1`]);
  });

  it('runs multiple model and tool turns', async () => {
    const { runtime, store, run } = await createHarness({
      scripts: [
        { type: 'tool_calls', tool_calls: [toolCall('call-1', 'echo', { n: 1 })] },
        { type: 'text', content: 'second turn' },
      ],
    });
    const finished = await runtime.start(run.id);
    expect(finished.status).toBe('completed');
    expect(finished.activeTurn).toBe(2);
    const messages = await store.getMessages(run.id);
    expect(messages.filter((message) => message.role === 'assistant')).toHaveLength(2);
    expect(messages.filter((message) => message.role === 'tool')).toHaveLength(1);
    expect(messages.filter((message) => message.role === 'tool')[0]?.providerToolCallId).toBe('call-1');
  });

  it('fails the run when the provider rejects a malformed request', async () => {
    const { runtime, run } = await createHarness({
      scripts: [{ type: 'malformed', chunk: '{bad' }],
    });
    const finished = await runtime.start(run.id);
    expect(finished.status).toBe('failed');
    expect(finished.interruptionReason).toBe('malformed_stream');
  });

  it('cancels an in-flight provider stream without persisting tool fragments', async () => {
    const { runtime, store, run } = await createHarness({
      scripts: [{
        type: 'tool_calls',
        delayMs: 8_000,
        tool_calls: [toolCall('frag-1', 'echo')],
      }],
    });
    const started = runtime.start(run.id);
    await vi.waitFor(() => {
      expect(store.attempts.some((attempt) => attempt.status === 'streaming')).toBe(true);
    });
    await runtime.cancel(run.id);
    const finished = await started;
    expect(finished.status).toBe('cancelled');
    expect(await store.getToolCalls(run.id)).toEqual([]);
    expect((await store.getMessages(run.id)).filter((message) => message.role === 'assistant')).toEqual([]);
  });

  it('cancels an in-flight read tool through the run abort controller', async () => {
    let enteredTool: () => void = () => undefined;
    const sawTool = new Promise<void>((resolve) => {
      enteredTool = resolve;
    });
    const echo = makeTool('echo', async (context) => {
      enteredTool();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 8_000);
        context.abortSignal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        });
      });
      return { ok: true, summary: 'should not finish' } satisfies AgentToolResult;
    });
    const { runtime, store, run } = await createHarness({
      scripts: [
        { type: 'tool_calls', tool_calls: [toolCall('call-1', 'echo')] },
        { type: 'text', content: 'should not reach' },
      ],
      tools: [echo],
    });
    const started = runtime.start(run.id);
    await sawTool;
    await runtime.cancel(run.id);
    const finished = await started;
    expect(finished.status).toBe('cancelled');
    const calls = await store.getToolCalls(run.id);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.status).toBe('interrupted');
  });

  it('retries a transient provider error under the same turn then completes', async () => {
    const { runtime, store, run } = await createHarness({
      scripts: [
        { type: 'error', kind: 'transient', message: 'temporary', retryable: true },
        { type: 'text', content: 'recovered' },
      ],
    });
    const finished = await runtime.start(run.id);
    expect(finished.status).toBe('completed');
    expect(finished.activeTurn).toBe(1);
    expect(store.attempts).toHaveLength(2);
    expect(store.attempts.map((attempt) => attempt.turn)).toEqual([1, 1]);
  });

  it('pauses after repeated rate limits', async () => {
    const { runtime, run } = await createHarness({
      scripts: [
        { type: 'error', kind: 'rate_limit', message: 'slow down', retryable: true, status: 429 },
        { type: 'error', kind: 'rate_limit', message: 'slow down', retryable: true, status: 429 },
        { type: 'error', kind: 'rate_limit', message: 'slow down', retryable: true, status: 429 },
      ],
    });
    const finished = await runtime.start(run.id);
    expect(finished.status).toBe('paused');
    expect(finished.interruptionReason).toBe('rate_limit');
  });

  it('moves authentication failures to needs_review', async () => {
    const { runtime, run } = await createHarness({
      scripts: [{ type: 'error', kind: 'authentication', message: 'bad key', retryable: false, status: 401 }],
    });
    const finished = await runtime.start(run.id);
    expect(finished.status).toBe('needs_review');
    expect(finished.interruptionReason).toBe('authentication');
  });

  it('fails when the turn cap is reached', async () => {
    const { runtime, run } = await createHarness({
      scripts: [
        { type: 'tool_calls', tool_calls: [toolCall('call-1', 'echo')] },
        { type: 'tool_calls', tool_calls: [toolCall('call-2', 'echo')] },
      ],
      maxTurns: 1,
    });
    const finished = await runtime.start(run.id);
    expect(finished.status).toBe('failed');
    expect(finished.interruptionReason).toBe('turn_limit');
    expect(finished.activeTurn).toBe(1);
  });

  it('fails when the run duration limit is exceeded', async () => {
    const { runtime, store, run } = await createHarness({
      scripts: [{ type: 'text', content: 'too late' }],
      maxDurationMs: 10,
    });
    await store.updateRunWithEvent(run.id, { startedAt: 1 }, 'run.status_changed', { startedAt: 1 });
    const finished = await runtime.start(run.id);
    expect(finished.status).toBe('failed');
    expect(finished.interruptionReason).toBe('duration_limit');
  });

  it('interrupts an incomplete provider stream and restarts on a new execution epoch', async () => {
    const { runtime, store, run } = await createHarness({
      scripts: [
        { type: 'incomplete', fragments: [toolCall('frag', 'echo')] },
        { type: 'incomplete', fragments: [toolCall('frag', 'echo')] },
        { type: 'incomplete', fragments: [toolCall('frag', 'echo')] },
        { type: 'text', content: 'restarted cleanly' },
      ],
    });
    const interrupted = await runtime.start(run.id);
    expect(interrupted.status).toBe('interrupted');
    expect(await store.getToolCalls(run.id)).toEqual([]);

    const recovered = await runtime.recover(run.id);
    expect(recovered.status).toBe('queued');
    expect(recovered.executionEpoch).toBe(run.executionEpoch + 1);

    const finished = await runtime.start(run.id);
    expect(finished.status).toBe('completed');
    expect(finished.finalSummary).toBe('restarted cleanly');
    expect(finished.executionEpoch).toBe(recovered.executionEpoch);
  });

  it('consumes steering at safe turn boundaries and never during tool execution', async () => {
    const events: string[] = [];
    let runtimeRef: AgentRuntime | undefined;
    let runId = '';
    const echo = makeTool('echo', async () => {
      events.push('tool');
      const steered = await runtimeRef?.submitInput(runId, 'steer during tool');
      expect(steered?.status).toBe('running');
      expect(steered?.pendingInputCount).toBe(1);
      return { ok: true, summary: 'echo' };
    });
    const harness = await createHarness({
      scripts: [
        { type: 'tool_calls', tool_calls: [toolCall('call-1', 'echo')] },
        { type: 'text', content: 'after steering' },
      ],
      tools: [echo],
    });
    runtimeRef = harness.runtime;
    runId = harness.run.id;
    const persist = harness.store.persistAssistantTurn.bind(harness.store);
    harness.store.persistAssistantTurn = async (message, toolCalls) => {
      events.push('persist');
      await persist(message, toolCalls);
    };
    const finished = await harness.runtime.start(harness.run.id);
    expect(finished.status).toBe('completed');
    expect(events[0]).toBe('persist');
    expect(events[1]).toBe('tool');
    const messages = await harness.store.getMessages(harness.run.id);
    const steered = messages.find((message) => message.content === 'steer during tool');
    expect(steered?.consumedAtTurn).toBe(2);
  });

  it('applies steering transitions for planning, approval, paused, and terminal states', async () => {
    const { runtime, store, run } = await createHarness();

    await store.updateRunWithEvent(run.id, { status: 'planning' }, 'run.status_changed', { status: 'planning' });
    const fromPlanning = await runtime.submitInput(run.id, 'planning input');
    expect(fromPlanning.status).toBe('queued');

    await store.updateRunWithEvent(run.id, { status: 'awaiting_approval' }, 'run.status_changed', { status: 'awaiting_approval' });
    runtime.approvals.set(run.id, [{
      id: 'approval-1',
      runId: run.id,
      policyRevision: 1,
      risk: 'local_read',
      resourceKeys: [],
      resourceRevisions: {},
      status: 'pending',
      requestedAt: 1,
      expiresAt: 9_999,
    }]);
    const fromApproval = await runtime.submitInput(run.id, 'approval input');
    expect(fromApproval.status).toBe('queued');
    expect(runtime.approvals.get(run.id)?.[0]?.status).toBe('cancelled');

    await store.updateRunWithEvent(run.id, { status: 'paused' }, 'run.status_changed', { status: 'paused' });
    const fromPaused = await runtime.submitInput(run.id, 'paused input');
    expect(fromPaused.status).toBe('queued');

    await store.updateRunWithEvent(run.id, { status: 'completed', finalSummary: 'parent done' }, 'run.completed', {});
    const child = await runtime.submitInput(run.id, 'continue in child');
    expect(child.id).not.toBe(run.id);
    expect(child.parentRunId).toBe(run.id);
    expect(child.status).toBe('queued');
    expect(child.executionEpoch).toBe((await store.getRun(run.id))!.executionEpoch + 1);
    expect(child.finalSummary).toBe('parent done');
    const childMessages = await store.getMessages(child.id);
    expect(childMessages.some((message) => message.content === 'continue in child')).toBe(true);
  });

  it('reviews delayed-run compatibility before executing', async () => {
    const missingCreds = await createHarness({
      scripts: [{ type: 'text', content: 'nope' }],
      resolveCredential: async () => undefined,
    });
    expect((await missingCreds.runtime.start(missingCreds.run.id)).status).toBe('needs_review');

    const missingModel = await createHarness({
      scripts: [{ type: 'text', content: 'nope' }],
      isModelAvailable: () => false,
    });
    expect((await missingModel.runtime.start(missingModel.run.id)).status).toBe('needs_review');

    const toolMismatch = await createHarness({
      scripts: [{ type: 'text', content: 'nope' }],
      resolveToolRegistryHash: () => 'other-registry',
    });
    expect((await toolMismatch.runtime.start(toolMismatch.run.id)).status).toBe('needs_review');

    const scopeMismatch = await createHarness({
      scripts: [{ type: 'text', content: 'nope' }],
      resolveLiveWorkspaceScope: async () => ({ ...WORKSPACE, rootRevision: 'rev-other' }),
    });
    expect((await scopeMismatch.runtime.start(scopeMismatch.run.id)).status).toBe('needs_review');

    expect(reviewRunCompatibility(missingCreds.run, {
      credentialPresent: false,
      modelAvailable: true,
      currentToolRegistryHash: 'registry',
      liveWorkspaceScope: WORKSPACE,
    }).issues).toContain('missing_credentials');
  });
});
