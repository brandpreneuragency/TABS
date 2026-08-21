// ---------------------------------------------------------------------------
// TABS Work-OS Harness — Durable run executor
// Owns the model loop outside React. Persists a complete assistant turn and
// every logical tool call before any tool executes. Tools run sequentially.
// Steering is consumed only at safe turn boundaries (before the next provider
// request). One AbortController cancels provider work and JavaScript tools.
// ---------------------------------------------------------------------------

import type {
  AgentEventType,
  AgentMessage,
  AgentProviderAttempt,
  AgentRun,
  AgentToolCall,
  AgentToolDefinition,
  AgentToolExecutionAttempt,
  AgentToolResult,
  ProviderToolCall,
  ToolExecutionContext,
} from '../../types/agent';
import {
  compileContextMessages,
  nextAssistantTurn,
  nextMessageIndex,
} from './contextManager';
import { buildOperationId, generateId, MAX_TOOL_RESULT_BYTES } from './helpers';
import type { OpenAIProtocolToolCall, OpenAIToolDefinition, ProviderAdapter, ProviderAttemptStore, ProviderCompletionResult } from './providers/providerAdapter';
import { ProviderError } from './providers/providerAdapter';
import { redactSecrets } from './redaction';
import { transitionRun, type RunTransitionEvent } from './runStateMachine';
import type { RunProjectionPatch, RunRepository } from './runRepository';

/** Plan 26.2 hard maximums. Settings may lower them, never raise past these. */
export const RUNTIME_HARD_MAX_TURNS = 25;
export const RUNTIME_HARD_MAX_DURATION_MS = 30 * 60 * 1000;

export interface ExecutorPersistence extends ProviderAttemptStore {
  getRun(runId: string): Promise<AgentRun | undefined>;
  createRun(run: AgentRun, eventData?: unknown): Promise<AgentRun>;
  updateRunWithEvent(
    runId: string,
    projection: RunProjectionPatch,
    type: AgentEventType,
    data: unknown,
  ): Promise<unknown>;
  getMessages(runId: string): Promise<AgentMessage[]>;
  addMessage(message: AgentMessage, eventType?: AgentEventType): Promise<AgentMessage>;
  persistAssistantTurn(message: AgentMessage, toolCalls: AgentToolCall[]): Promise<void>;
  consumePendingInput(runId: string, turn: number): Promise<AgentMessage[]>;
  getToolCalls(runId: string): Promise<AgentToolCall[]>;
  startToolExecution(
    toolCallId: string,
    executionEpoch: number,
    startedAt?: number,
  ): Promise<AgentToolExecutionAttempt>;
  completeToolExecution(
    attemptId: string,
    status: 'succeeded' | 'failed' | 'interrupted',
    options?: { errorCode?: string; resultArtifactIds?: string[]; finishedAt?: number },
  ): Promise<AgentToolExecutionAttempt>;
}

export interface RunExecutorOptions {
  store: ExecutorPersistence;
  provider: ProviderAdapter;
  tools: AgentToolDefinition[];
  resolveCredential: (credentialAccount: string) => Promise<string | undefined>;
  now?: () => number;
  createId?: () => string;
}

export interface MemoryExecutorStore extends ExecutorPersistence {
  readonly runs: Map<string, AgentRun>;
  readonly messagesByRun: Map<string, AgentMessage[]>;
  readonly toolCallsByRun: Map<string, AgentToolCall[]>;
  readonly attempts: AgentProviderAttempt[];
  readonly toolAttempts: AgentToolExecutionAttempt[];
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function effectFingerprint(toolName: string, args: unknown): string {
  const payload = JSON.stringify({ toolName, args });
  let hash = 5381;
  for (let index = 0; index < payload.length; index++) {
    hash = ((hash << 5) + hash + payload.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function parseArgs(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return { _unparsed: raw };
  }
}

function protocolToProviderToolCall(call: OpenAIProtocolToolCall): ProviderToolCall {
  return {
    id: call.id,
    name: call.function.name,
    arguments: call.function.arguments,
  };
}

function asToolDefinitions(tools: AgentToolDefinition[]): OpenAIToolDefinition[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

function boundToolContent(result: AgentToolResult): string {
  const payload = JSON.stringify({
    ok: result.ok,
    summary: result.summary,
    data: result.data,
    error: result.error,
  });
  const encoded = new TextEncoder().encode(payload);
  if (encoded.byteLength <= MAX_TOOL_RESULT_BYTES) return redactSecrets(payload);
  return redactSecrets(JSON.stringify({
    ok: result.ok,
    summary: result.summary,
    truncated: true,
  }));
}

export function clampRunLimits(maxTurns: number, maxDurationMs: number): {
  maxTurns: number;
  maxDurationMs: number;
} {
  return {
    maxTurns: Math.max(1, Math.min(maxTurns, RUNTIME_HARD_MAX_TURNS)),
    maxDurationMs: Math.max(1, Math.min(maxDurationMs, RUNTIME_HARD_MAX_DURATION_MS)),
  };
}

export function createMemoryExecutorStore(now: () => number = Date.now): MemoryExecutorStore {
  const runs = new Map<string, AgentRun>();
  const messagesByRun = new Map<string, AgentMessage[]>();
  const toolCallsByRun = new Map<string, AgentToolCall[]>();
  const attempts: AgentProviderAttempt[] = [];
  const toolAttempts: AgentToolExecutionAttempt[] = [];

  function requireRun(runId: string): AgentRun {
    const run = runs.get(runId);
    if (!run) throw new Error(`Run ${runId} was not found.`);
    return run;
  }

  function putRun(run: AgentRun): AgentRun {
    const stored = clone(run);
    runs.set(run.id, stored);
    return clone(stored);
  }

  const store: MemoryExecutorStore = {
    runs,
    messagesByRun,
    toolCallsByRun,
    attempts,
    toolAttempts,
    async getRun(runId) {
      const run = runs.get(runId);
      return run ? clone(run) : undefined;
    },
    async createRun(run) {
      if (runs.has(run.id)) throw new Error(`Run ${run.id} already exists.`);
      const created = { ...clone(run), nextSequence: run.nextSequence + 1 };
      return putRun(created);
    },
    async updateRunWithEvent(runId, projection, _type, _data) {
      const run = requireRun(runId);
      putRun({
        ...run,
        ...projection,
        id: run.id,
        nextSequence: run.nextSequence + 1,
        updatedAt: now(),
      });
    },
    async getMessages(runId) {
      return clone(messagesByRun.get(runId) ?? []);
    },
    async addMessage(message) {
      const list = messagesByRun.get(message.runId) ?? [];
      list.push(clone(message));
      messagesByRun.set(message.runId, list);
      return clone(message);
    },
    async persistAssistantTurn(message, toolCalls) {
      if (message.role !== 'assistant' || message.state !== 'complete') {
        throw new Error('Only a complete assistant message can be accepted as a turn.');
      }
      const list = messagesByRun.get(message.runId) ?? [];
      list.push(clone(message));
      messagesByRun.set(message.runId, list);
      const existing = toolCallsByRun.get(message.runId) ?? [];
      existing.push(...toolCalls.map((call) => clone(call)));
      toolCallsByRun.set(message.runId, existing);
    },
    async consumePendingInput(runId, turn) {
      const run = requireRun(runId);
      const list = messagesByRun.get(runId) ?? [];
      const consumed: AgentMessage[] = [];
      for (let index = 0; index < list.length; index++) {
        const message = list[index];
        if (message.role !== 'user' || message.consumedAtTurn !== undefined) continue;
        const updated = { ...message, consumedAtTurn: turn };
        list[index] = updated;
        consumed.push(clone(updated));
      }
      messagesByRun.set(runId, list);
      if (run.pendingInputCount !== 0) {
        putRun({ ...run, pendingInputCount: 0, updatedAt: now() });
      }
      return consumed;
    },
    async getToolCalls(runId) {
      return clone(toolCallsByRun.get(runId) ?? []);
    },
    async startToolExecution(toolCallId, executionEpoch, startedAt = now()) {
      const calls = Array.from(toolCallsByRun.values()).flat();
      const call = calls.find((item) => item.id === toolCallId);
      if (!call) throw new Error(`Tool call ${toolCallId} was not found.`);
      const prior = toolAttempts.filter((item) => item.toolCallId === toolCallId);
      const attemptNumber = prior.reduce((maximum, item) => Math.max(maximum, item.attempt), 0) + 1;
      const attempt: AgentToolExecutionAttempt = {
        id: generateId(),
        runId: call.runId,
        toolCallId,
        operationId: call.operationId,
        executionEpoch,
        attempt: attemptNumber,
        status: 'started',
        startedAt,
      };
      toolAttempts.push(attempt);
      const runCalls = toolCallsByRun.get(call.runId) ?? [];
      const index = runCalls.findIndex((item) => item.id === toolCallId);
      if (index >= 0) {
        runCalls[index] = { ...runCalls[index], status: 'executing', startedAt };
        toolCallsByRun.set(call.runId, runCalls);
      }
      return clone(attempt);
    },
    async completeToolExecution(attemptId, status, options = {}) {
      const index = toolAttempts.findIndex((item) => item.id === attemptId);
      if (index === -1) throw new Error(`Tool attempt ${attemptId} was not found.`);
      const finishedAt = options.finishedAt ?? now();
      const updated = {
        ...toolAttempts[index],
        status,
        errorCode: options.errorCode,
        finishedAt,
      };
      toolAttempts[index] = updated;
      const runCalls = toolCallsByRun.get(updated.runId) ?? [];
      const callIndex = runCalls.findIndex((item) => item.id === updated.toolCallId);
      if (callIndex >= 0) {
        runCalls[callIndex] = {
          ...runCalls[callIndex],
          status,
          errorCode: options.errorCode,
          finishedAt,
          resultArtifactIds: options.resultArtifactIds ?? runCalls[callIndex].resultArtifactIds,
        };
        toolCallsByRun.set(updated.runId, runCalls);
      }
      return clone(updated);
    },
    async startProviderAttempt(attempt) {
      attempts.push(clone(attempt));
      return clone(attempt);
    },
    async updateProviderAttempt(attemptId, patch) {
      const index = attempts.findIndex((item) => item.id === attemptId);
      if (index === -1) throw new Error(`Provider attempt ${attemptId} was not found.`);
      const updated = { ...attempts[index], ...patch };
      attempts[index] = updated;
      return clone(updated);
    },
  };
  return store;
}

export function createExecutorStoreFromRepository(repository: RunRepository): ExecutorPersistence {
  return {
    getRun: (runId) => repository.getRun(runId),
    createRun: (run, eventData) => repository.createRun(run, eventData),
    updateRunWithEvent: (runId, projection, type, data) =>
      repository.updateRunWithEvent(runId, projection, type, data),
    getMessages: (runId) => repository.getMessages(runId),
    addMessage: (message, eventType) => repository.addMessage(message, eventType),
    persistAssistantTurn: (message, toolCalls) => repository.persistAssistantTurn(message, toolCalls),
    consumePendingInput: (runId, turn) => repository.consumePendingInput(runId, turn),
    getToolCalls: (runId) => repository.getToolCalls(runId),
    startToolExecution: (toolCallId, executionEpoch, startedAt) =>
      repository.startToolExecution(toolCallId, executionEpoch, startedAt),
    completeToolExecution: (attemptId, status, options) =>
      repository.completeToolExecution(attemptId, status, options),
    startProviderAttempt: (attempt) => repository.startProviderAttempt(attempt),
    updateProviderAttempt: (attemptId, patch) => repository.updateProviderAttempt(attemptId, patch),
  };
}

export class RunExecutor {
  private readonly store: ExecutorPersistence;
  private readonly provider: ProviderAdapter;
  private readonly tools: Map<string, AgentToolDefinition>;
  private readonly resolveCredential: (credentialAccount: string) => Promise<string | undefined>;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly controllers = new Map<string, AbortController>();

  constructor(options: RunExecutorOptions) {
    this.store = options.store;
    this.provider = options.provider;
    this.tools = new Map(options.tools.map((tool) => [tool.name, tool]));
    this.resolveCredential = options.resolveCredential;
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? generateId;
  }

  abortControllerFor(runId: string): AbortController | undefined {
    return this.controllers.get(runId);
  }

  requestCancel(runId: string): void {
    this.controllers.get(runId)?.abort();
  }

  async execute(runId: string): Promise<AgentRun> {
    const existing = this.controllers.get(runId);
    if (existing) existing.abort();
    const controller = new AbortController();
    this.controllers.set(runId, controller);
    try {
      return await this.runLoop(runId, controller);
    } finally {
      if (this.controllers.get(runId) === controller) {
        this.controllers.delete(runId);
      }
    }
  }

  private async runLoop(runId: string, controller: AbortController): Promise<AgentRun> {
    let run = await this.requireRun(runId);
    run = await this.enterRunning(run);

    while (run.status === 'running') {
      run = await this.requireRun(runId);
      const halted = await this.honorControlRequests(run, controller);
      if (halted) return halted;

      const messages = await this.store.getMessages(runId);
      const turn = nextAssistantTurn(messages);
      const limits = clampRunLimits(run.maxTurns, run.maxDurationMs);
      const startedAt = run.startedAt ?? this.now();
      if (turn > limits.maxTurns) {
        return this.finish(runId, 'terminal_error', 'failed', 'run.failed', {
          interruptionReason: 'turn_limit',
          finishedAt: this.now(),
        });
      }
      if (this.now() - startedAt >= limits.maxDurationMs) {
        return this.finish(runId, 'terminal_error', 'failed', 'run.failed', {
          interruptionReason: 'duration_limit',
          finishedAt: this.now(),
        });
      }

      await this.store.consumePendingInput(runId, turn);
      run = await this.requireRun(runId);
      const protocolMessages = compileContextMessages({
        run,
        messages: await this.store.getMessages(runId),
      });

      const apiKey = await this.resolveCredential(run.providerSnapshot.credentialAccount);
      if (!apiKey) {
        return this.moveToNeedsReview(runId, 'missing_credentials');
      }

      let completion: ProviderCompletionResult;
      try {
        completion = await this.provider.complete({
          runId,
          executionEpoch: run.executionEpoch,
          turn,
          messages: protocolMessages,
          tools: run.providerSnapshot.capabilities.toolCalling
            ? asToolDefinitions(Array.from(this.tools.values()))
            : undefined,
          snapshot: run.providerSnapshot,
          apiKey,
          toolRegistryVersion: run.toolRegistryVersion,
          abortSignal: controller.signal,
        });
      } catch (caught) {
        return this.handleProviderError(runId, caught, controller);
      }

      const toolCallsPayload = completion.tool_calls ?? [];
      const assistantToolCalls = toolCallsPayload.map(protocolToProviderToolCall);
      const logicalCalls = this.buildLogicalCalls(run, turn, toolCallsPayload);
      const assistantMessage: AgentMessage = {
        id: this.createId(),
        runId,
        messageIndex: nextMessageIndex(await this.store.getMessages(runId)),
        turn,
        role: 'assistant',
        content: completion.content,
        assistantToolCalls: assistantToolCalls.length > 0 ? assistantToolCalls : undefined,
        state: 'complete',
        streamVersion: 1,
        createdAt: this.now(),
      };

      // Durable acceptance of the whole turn happens before any tool runs.
      await this.store.persistAssistantTurn(assistantMessage, logicalCalls);
      await this.store.updateRunWithEvent(
        runId,
        { activeTurn: turn },
        'model.stream_completed',
        { turn, finishReason: completion.finishReason },
      );

      if (logicalCalls.length === 0) {
        return this.finish(runId, 'goal_finished', 'completed', 'run.completed', {
          finalSummary: typeof completion.content === 'string' ? completion.content : undefined,
          finishedAt: this.now(),
        });
      }

      await this.executeToolsSequentially(runId, turn, logicalCalls, controller);
      run = await this.requireRun(runId);
      const afterTools = await this.honorControlRequests(run, controller);
      if (afterTools) return afterTools;
    }

    return run;
  }

  private async executeToolsSequentially(
    runId: string,
    turn: number,
    logicalCalls: AgentToolCall[],
    controller: AbortController,
  ): Promise<void> {
    const persisted = (await this.store.getToolCalls(runId))
      .filter((call) => call.turn === turn)
      .sort((left, right) => left.toolIndex - right.toolIndex);
    const ordered = persisted.length === logicalCalls.length ? persisted : logicalCalls;

    for (const call of ordered) {
      const run = await this.requireRun(runId);
      if (controller.signal.aborted || run.cancelRequestedAt) {
        await this.markRemainingInterrupted(ordered, call, run.executionEpoch);
        return;
      }
      await this.executeOneTool(run, call, controller);
    }
  }

  private async executeOneTool(
    run: AgentRun,
    call: AgentToolCall,
    controller: AbortController,
  ): Promise<void> {
    const attempt = await this.store.startToolExecution(call.id, run.executionEpoch, this.now());
    const tool = this.tools.get(call.toolName);
    const context: ToolExecutionContext = {
      runId: run.id,
      turn: call.turn,
      executionEpoch: run.executionEpoch,
      mode: run.mode,
      workspaceScope: run.workspaceScope,
      contextRefs: run.contextRefs,
      abortSignal: controller.signal,
    };

    try {
      if (controller.signal.aborted) {
        throw new ProviderError('cancelled', 'Tool execution was cancelled.', { retryable: false });
      }
      if (!tool) {
        const missing: AgentToolResult = {
          ok: false,
          summary: `Unknown tool ${call.toolName}`,
          error: { code: 'not_found', message: `Unknown tool ${call.toolName}`, retryable: false },
        };
        await this.completeTool(run.id, call, attempt.id, missing, 'failed', 'not_found');
        return;
      }
      const args = tool.normalizeArgs(call.normalizedArgs);
      const result = await Promise.resolve(tool.execute(context, args)) as AgentToolResult;
      await this.completeTool(run.id, call, attempt.id, result, 'succeeded');
    } catch (caught) {
      const cancelled = controller.signal.aborted
        || (caught instanceof ProviderError && caught.kind === 'cancelled');
      const message = caught instanceof Error ? caught.message : 'Tool execution failed.';
      const result: AgentToolResult = {
        ok: false,
        summary: redactSecrets(message),
        error: {
          code: cancelled ? 'cancelled' : 'internal_error',
          message: redactSecrets(message),
          retryable: false,
        },
      };
      await this.completeTool(
        run.id,
        call,
        attempt.id,
        result,
        cancelled ? 'interrupted' : 'failed',
        cancelled ? 'cancelled' : 'internal_error',
      );
    }
  }

  private async completeTool(
    runId: string,
    call: AgentToolCall,
    attemptId: string,
    result: AgentToolResult,
    status: 'succeeded' | 'failed' | 'interrupted',
    errorCode?: string,
  ): Promise<void> {
    await this.store.completeToolExecution(attemptId, status, {
      errorCode: errorCode ?? result.error?.code,
      finishedAt: this.now(),
    });
    const messages = await this.store.getMessages(runId);
    await this.store.addMessage({
      id: this.createId(),
      runId,
      messageIndex: nextMessageIndex(messages),
      turn: call.turn,
      role: 'tool',
      content: boundToolContent(result),
      providerToolCallId: call.providerToolCallId,
      state: 'complete',
      streamVersion: 1,
      createdAt: this.now(),
    }, status === 'succeeded' ? 'tool.completed' : status === 'failed' ? 'tool.failed' : 'tool.interrupted');
  }

  private async markRemainingInterrupted(
    ordered: AgentToolCall[],
    current: AgentToolCall,
    executionEpoch: number,
  ): Promise<void> {
    const start = ordered.findIndex((call) => call.id === current.id);
    const remaining = start === -1 ? ordered : ordered.slice(start);
    for (const call of remaining) {
      if (call.status === 'succeeded' || call.status === 'failed' || call.status === 'interrupted') {
        continue;
      }
      const attempt = await this.store.startToolExecution(call.id, executionEpoch, this.now());
      await this.store.completeToolExecution(attempt.id, 'interrupted', {
        errorCode: 'cancelled',
        finishedAt: this.now(),
      });
    }
  }

  private buildLogicalCalls(
    run: AgentRun,
    turn: number,
    toolCalls: OpenAIProtocolToolCall[],
  ): AgentToolCall[] {
    return toolCalls.map((call, toolIndex) => {
      const tool = this.tools.get(call.function.name);
      const normalizedArgs = tool
        ? tool.normalizeArgs(parseArgs(call.function.arguments))
        : parseArgs(call.function.arguments);
      const context: ToolExecutionContext = {
        runId: run.id,
        turn,
        executionEpoch: run.executionEpoch,
        mode: run.mode,
        workspaceScope: run.workspaceScope,
        contextRefs: run.contextRefs,
        abortSignal: new AbortController().signal,
      };
      const resourceKeys = tool ? tool.resolveResourceKeys(context, normalizedArgs) : [];
      return {
        id: this.createId(),
        runId: run.id,
        turn,
        toolIndex,
        providerToolCallId: call.id,
        operationId: buildOperationId(run.id, turn, toolIndex),
        effectFingerprint: effectFingerprint(call.function.name, tool?.buildEffectPayload(normalizedArgs) ?? normalizedArgs),
        toolName: call.function.name,
        toolVersion: tool?.version ?? 'unknown',
        normalizedArgs,
        resourceKeys,
        status: 'requested' as const,
        resultArtifactIds: [],
        createdAt: this.now(),
      };
    });
  }

  private async honorControlRequests(
    run: AgentRun,
    controller: AbortController,
  ): Promise<AgentRun | undefined> {
    if (controller.signal.aborted || run.cancelRequestedAt) {
      return this.finish(run.id, 'cancel_safe_work', 'cancelled', 'run.cancelled', {
        finishedAt: this.now(),
      });
    }
    if (run.pauseRequestedAt) {
      return this.finish(run.id, 'pause_at_safe_boundary', 'paused', 'run.paused', {
        pauseRequestedAt: undefined,
      });
    }
    return undefined;
  }

  private async handleProviderError(
    runId: string,
    caught: unknown,
    controller: AbortController,
  ): Promise<AgentRun> {
    const error = caught instanceof ProviderError
      ? caught
      : new ProviderError('transient', caught instanceof Error ? caught.message : 'Provider failed.', {
        retryable: false,
      });
    const reason = error.kind;
    if (error.kind === 'cancelled' || controller.signal.aborted) {
      const run = await this.requireRun(runId);
      if (run.cancelRequestedAt || controller.signal.aborted) {
        return this.finish(runId, 'cancel_safe_work', 'cancelled', 'run.cancelled', {
          interruptionReason: 'cancelled',
          finishedAt: this.now(),
        });
      }
      return this.finish(runId, 'provider_interrupted', 'interrupted', 'run.interrupted', {
        interruptionReason: 'cancelled',
      });
    }
    if (error.kind === 'authentication') {
      return this.moveToNeedsReview(runId, 'authentication');
    }
    if (error.pauseRecommended || error.kind === 'rate_limit') {
      return this.finish(runId, 'pause_at_safe_boundary', 'paused', 'run.paused', {
        interruptionReason: 'rate_limit',
      });
    }
    if (error.kind === 'invalid_request' || error.kind === 'malformed_stream' || error.kind === 'capability') {
      return this.finish(runId, 'terminal_error', 'failed', 'run.failed', {
        interruptionReason: reason,
        finishedAt: this.now(),
      });
    }
    return this.finish(runId, 'provider_interrupted', 'interrupted', 'run.interrupted', {
      interruptionReason: reason,
    });
  }

  private async enterRunning(run: AgentRun): Promise<AgentRun> {
    if (run.status === 'running') {
      if (!run.startedAt) {
        await this.store.updateRunWithEvent(run.id, { startedAt: this.now() }, 'run.started', { status: 'running' });
        return this.requireRun(run.id);
      }
      return run;
    }
    const event: RunTransitionEvent = run.status === 'planning'
      ? 'read_only_plan_accepted'
      : 'claim_for_running';
    const status = transitionRun(run.status, event);
    await this.store.updateRunWithEvent(
      run.id,
      { status, startedAt: run.startedAt ?? this.now() },
      'run.started',
      { status },
    );
    return this.requireRun(run.id);
  }

  async moveToNeedsReview(runId: string, reason: string): Promise<AgentRun> {
    let run = await this.requireRun(runId);
    if (run.status === 'queued') {
      await this.store.updateRunWithEvent(
        runId,
        { status: transitionRun('queued', 'claim_for_running'), startedAt: run.startedAt ?? this.now() },
        'run.started',
        { status: 'running' },
      );
      run = await this.requireRun(runId);
    }
    if (run.status === 'planning' || run.status === 'running') {
      await this.store.updateRunWithEvent(
        runId,
        { status: transitionRun(run.status, 'provider_interrupted'), interruptionReason: reason },
        'run.interrupted',
        { reason },
      );
      run = await this.requireRun(runId);
    }
    if (run.status === 'interrupted') {
      await this.store.updateRunWithEvent(
        runId,
        { status: transitionRun('interrupted', 'mutation_outcome_unknown'), interruptionReason: reason },
        'run.status_changed',
        { status: 'needs_review', reason },
      );
    }
    return this.requireRun(runId);
  }

  private async finish(
    runId: string,
    event: RunTransitionEvent,
    _expected: AgentRun['status'],
    eventType: AgentEventType,
    projection: RunProjectionPatch,
  ): Promise<AgentRun> {
    const run = await this.requireRun(runId);
    if (
      run.status === 'completed'
      || run.status === 'failed'
      || run.status === 'cancelled'
      || run.status === 'paused'
      || run.status === 'interrupted'
      || run.status === 'needs_review'
    ) {
      return run;
    }
    const status = transitionRun(run.status, event);
    await this.store.updateRunWithEvent(runId, { ...projection, status }, eventType, { status });
    return this.requireRun(runId);
  }

  private async requireRun(runId: string): Promise<AgentRun> {
    const run = await this.store.getRun(runId);
    if (!run) throw new Error(`Run ${runId} was not found.`);
    return run;
  }
}
