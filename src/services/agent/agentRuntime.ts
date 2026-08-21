// ---------------------------------------------------------------------------
// TABS Work-OS Harness — Agent runtime service
// TypeScript runtime under src/services/agent/. Does not import React, hooks,
// or Zustand. React calls a narrow client API; this service owns execution.
// ---------------------------------------------------------------------------

import type {
  AgentApproval,
  AgentContextRef,
  AgentMessage,
  AgentProfileSnapshot,
  AgentPolicySnapshot,
  AgentRun,
  AgentToolDefinition,
  InstructionSnapshot,
  ProviderSnapshot,
  WorkspaceScopeSnapshot,
} from '../../types/agent';
import {
  contextRefForModel,
  nextMessageIndex,
  workspaceScopeForModel,
} from './contextManager';
import { generateId } from './helpers';
import type { ProviderAdapter } from './providers/providerAdapter';
import {
  RunExecutor,
  clampRunLimits,
  createExecutorStoreFromRepository,
  RUNTIME_HARD_MAX_DURATION_MS,
  RUNTIME_HARD_MAX_TURNS,
  type ExecutorPersistence,
} from './runExecutor';
import type { RunRepository } from './runRepository';
import {
  isTerminalRunStatus,
  shouldCreateChildRun,
  transitionRun,
} from './runStateMachine';

export interface CreateAgentRunInput {
  goal: string;
  title?: string;
  mode?: AgentRun['mode'];
  contextRefs?: AgentContextRef[];
  providerSnapshot: ProviderSnapshot;
  profileSnapshot: AgentProfileSnapshot;
  instructionSnapshot: InstructionSnapshot;
  policySnapshot: AgentPolicySnapshot;
  workspaceScope?: WorkspaceScopeSnapshot;
  toolRegistryVersion: string;
  toolRegistryHash: string;
  appVersion?: string;
  maxTurns?: number;
  maxDurationMs?: number;
  initialInput?: unknown;
}

export type CompatibilityIssue =
  | 'missing_credentials'
  | 'unavailable_model'
  | 'unavailable_tool_version'
  | 'workspace_scope_mismatch';

export interface CompatibilityReview {
  ok: boolean;
  issues: CompatibilityIssue[];
  reason?: string;
}

export interface RuntimeCompatibilityState {
  credentialPresent: boolean;
  modelAvailable: boolean;
  currentToolRegistryHash: string;
  liveWorkspaceScope?: WorkspaceScopeSnapshot;
}

export interface AgentRuntimeOptions {
  store?: ExecutorPersistence;
  repository?: RunRepository;
  provider: ProviderAdapter;
  tools?: AgentToolDefinition[];
  resolveCredential: (credentialAccount: string) => Promise<string | undefined>;
  isModelAvailable?: (snapshot: ProviderSnapshot) => boolean;
  resolveToolRegistryHash?: () => string;
  resolveLiveWorkspaceScope?: (run: AgentRun) => Promise<WorkspaceScopeSnapshot | undefined>;
  now?: () => number;
  createId?: () => string;
}

export function captureWorkspaceScopeSnapshot(
  input: WorkspaceScopeSnapshot,
): WorkspaceScopeSnapshot {
  return {
    workspaceId: input.workspaceId,
    rootPath: input.rootPath,
    rootRevision: input.rootRevision,
    nativeScopeId: input.nativeScopeId,
  };
}

export function workspaceScopesMatch(
  snapshot: WorkspaceScopeSnapshot,
  live: WorkspaceScopeSnapshot,
): boolean {
  return snapshot.workspaceId === live.workspaceId
    && snapshot.rootPath === live.rootPath
    && snapshot.rootRevision === live.rootRevision
    && snapshot.nativeScopeId === live.nativeScopeId;
}

export function reviewRunCompatibility(
  run: AgentRun,
  live: RuntimeCompatibilityState,
): CompatibilityReview {
  const issues: CompatibilityIssue[] = [];
  if (!live.credentialPresent) issues.push('missing_credentials');
  if (!live.modelAvailable) issues.push('unavailable_model');
  if (live.currentToolRegistryHash !== run.toolRegistryHash) {
    issues.push('unavailable_tool_version');
  }
  if (run.workspaceScope) {
    if (!live.liveWorkspaceScope || !workspaceScopesMatch(run.workspaceScope, live.liveWorkspaceScope)) {
      issues.push('workspace_scope_mismatch');
    }
  }
  return issues.length === 0
    ? { ok: true, issues }
    : { ok: false, issues, reason: issues[0] };
}

/**
 * Non-React orchestration boundary. Captures workspace scope before queueing,
 * reviews delayed-run compatibility, creates child runs after terminal input,
 * and delegates the model loop to RunExecutor.
 */
export class AgentRuntime {
  private readonly store: ExecutorPersistence;
  private readonly executor: RunExecutor;
  private readonly tools: AgentToolDefinition[];
  private readonly resolveCredential: (credentialAccount: string) => Promise<string | undefined>;
  private readonly isModelAvailable: (snapshot: ProviderSnapshot) => boolean;
  private readonly resolveToolRegistryHash?: () => string;
  private readonly resolveLiveWorkspaceScope?: (run: AgentRun) => Promise<WorkspaceScopeSnapshot | undefined>;
  private readonly now: () => number;
  private readonly createId: () => string;
  readonly approvals = new Map<string, AgentApproval[]>();

  constructor(options: AgentRuntimeOptions) {
    if (!options.store && !options.repository) {
      throw new Error('AgentRuntime requires a store or repository.');
    }
    this.store = options.store ?? createExecutorStoreFromRepository(options.repository as RunRepository);
    this.tools = options.tools ?? [];
    this.resolveCredential = options.resolveCredential;
    this.isModelAvailable = options.isModelAvailable ?? (() => true);
    this.resolveToolRegistryHash = options.resolveToolRegistryHash;
    this.resolveLiveWorkspaceScope = options.resolveLiveWorkspaceScope;
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? generateId;
    this.executor = new RunExecutor({
      store: this.store,
      provider: options.provider,
      tools: this.tools,
      resolveCredential: this.resolveCredential,
      now: this.now,
      createId: this.createId,
    });
  }

  get persistence(): ExecutorPersistence {
    return this.store;
  }

  /** Captures the workspace scope snapshot before the run enters the queue. */
  async createRun(input: CreateAgentRunInput): Promise<AgentRun> {
    const timestamp = this.now();
    const limits = clampRunLimits(
      input.maxTurns ?? RUNTIME_HARD_MAX_TURNS,
      input.maxDurationMs ?? RUNTIME_HARD_MAX_DURATION_MS,
    );
    const workspaceScope = input.workspaceScope
      ? captureWorkspaceScopeSnapshot(input.workspaceScope)
      : undefined;
    const run: AgentRun = {
      id: this.createId(),
      title: input.title ?? input.goal.slice(0, 80),
      goal: input.goal,
      status: 'queued',
      mode: input.mode ?? 'read_only',
      contextRefs: (input.contextRefs ?? []).map(contextRefForModel),
      providerSnapshot: input.providerSnapshot,
      profileSnapshot: input.profileSnapshot,
      instructionSnapshot: input.instructionSnapshot,
      policySnapshot: input.policySnapshot,
      policyRevision: input.policySnapshot.revision,
      toolRegistryVersion: input.toolRegistryVersion,
      toolRegistryHash: input.toolRegistryHash,
      appVersion: input.appVersion ?? 'dev',
      nextSequence: 0,
      activeTurn: 0,
      executionEpoch: 0,
      queuePriority: 0,
      pendingInputCount: 0,
      workspaceScope,
      maxTurns: limits.maxTurns,
      maxDurationMs: limits.maxDurationMs,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const created = await this.store.createRun(run, { command: 'run.create' });
    await this.store.addMessage(
      this.userMessage(created, input.initialInput ?? input.goal, 0),
      'user.input_received',
    );
    return this.requireRun(created.id);
  }

  async start(runId: string): Promise<AgentRun> {
    const run = await this.requireRun(runId);
    const live = await this.collectCompatibility(run);
    const review = reviewRunCompatibility(run, live);
    if (!review.ok) {
      return this.executor.moveToNeedsReview(runId, review.reason ?? 'compatibility');
    }
    return this.executor.execute(runId);
  }

  async cancel(runId: string): Promise<AgentRun> {
    const run = await this.requireRun(runId);
    await this.store.updateRunWithEvent(
      runId,
      { cancelRequestedAt: this.now() },
      'run.status_changed',
      { command: 'run.cancel', cancelRequested: true },
    );
    this.executor.requestCancel(runId);
    if (!this.executor.abortControllerFor(runId)) {
      const event = run.status === 'interrupted'
        ? 'cancel_interrupted_safe_work' as const
        : 'cancel_safe_work' as const;
      const status = transitionRun(run.status, event);
      await this.store.updateRunWithEvent(
        runId,
        { status, finishedAt: this.now() },
        'run.cancelled',
        { status },
      );
    }
    return this.requireRun(runId);
  }

  async pause(runId: string): Promise<AgentRun> {
    const run = await this.requireRun(runId);
    if (run.status === 'running') {
      await this.store.updateRunWithEvent(
        runId,
        { pauseRequestedAt: this.now() },
        'run.status_changed',
        { command: 'run.pause', pauseRequested: true },
      );
      return this.requireRun(runId);
    }
    const status = transitionRun(run.status, 'pause');
    await this.store.updateRunWithEvent(runId, { status }, 'run.paused', { status });
    return this.requireRun(runId);
  }

  async recover(runId: string): Promise<AgentRun> {
    const run = await this.requireRun(runId);
    const status = transitionRun(run.status, 'safe_recovery');
    await this.store.updateRunWithEvent(
      runId,
      {
        status,
        executionEpoch: run.executionEpoch + 1,
        workerOwnerId: undefined,
        workerLeaseExpiresAt: undefined,
        interruptionReason: undefined,
        cancelRequestedAt: undefined,
        pauseRequestedAt: undefined,
      },
      'run.queued',
      { status, executionEpoch: run.executionEpoch + 1 },
    );
    return this.requireRun(runId);
  }

  /**
   * Durable steering. Consumed by the executor only before the next provider
   * request. Terminal runs create a child instead of reopening.
   */
  async submitInput(
    runId: string,
    content: unknown,
    selectedContextRefs?: AgentContextRef[],
  ): Promise<AgentRun> {
    const run = await this.requireRun(runId);
    if (shouldCreateChildRun(run.status) || isTerminalRunStatus(run.status)) {
      return this.createChildRun(run, content, selectedContextRefs);
    }
    if (run.status === 'awaiting_approval') {
      this.invalidateApprovals(runId);
    }
    const status = transitionRun(run.status, 'input_submitted');
    const messages = await this.store.getMessages(runId);
    await this.store.addMessage(
      this.userMessage(run, content, nextMessageIndex(messages)),
      'user.input_received',
    );
    await this.store.updateRunWithEvent(
      runId,
      { status, pendingInputCount: run.pendingInputCount + 1 },
      'user.input_scheduled',
      { command: 'run.input.submit', status },
    );
    return this.requireRun(runId);
  }

  async retry(runId: string, selectedContextRefs?: AgentContextRef[]): Promise<AgentRun> {
    const parent = await this.requireRun(runId);
    if (!isTerminalRunStatus(parent.status)) {
      throw new Error('Only terminal runs can be retried.');
    }
    return this.createChildRun(parent, parent.goal, selectedContextRefs);
  }

  modelVisibleWorkspaceScope(scope: WorkspaceScopeSnapshot): {
    workspaceId: string;
    rootRevision: string;
  } {
    return workspaceScopeForModel(scope);
  }

  private async createChildRun(
    parent: AgentRun,
    content: unknown,
    selectedContextRefs?: AgentContextRef[],
  ): Promise<AgentRun> {
    const timestamp = this.now();
    const child: AgentRun = {
      ...parent,
      id: this.createId(),
      parentRunId: parent.id,
      status: 'queued',
      contextRefs: selectedContextRefs ?? parent.contextRefs,
      nextSequence: 0,
      activeTurn: 0,
      executionEpoch: parent.executionEpoch + 1,
      workerOwnerId: undefined,
      workerLeaseExpiresAt: undefined,
      archivedAt: undefined,
      pendingInputCount: 0,
      pauseRequestedAt: undefined,
      cancelRequestedAt: undefined,
      interruptionReason: undefined,
      finalSummary: parent.finalSummary,
      createdAt: timestamp,
      updatedAt: timestamp,
      startedAt: undefined,
      finishedAt: undefined,
    };
    const created = await this.store.createRun(child, {
      command: 'run.retry',
      parentRunId: parent.id,
    });
    await this.store.addMessage(this.userMessage(created, content, 0), 'user.input_received');
    return this.requireRun(created.id);
  }

  private async collectCompatibility(run: AgentRun): Promise<RuntimeCompatibilityState> {
    const credential = await this.resolveCredential(run.providerSnapshot.credentialAccount);
    return {
      credentialPresent: Boolean(credential),
      modelAvailable: this.isModelAvailable(run.providerSnapshot),
      currentToolRegistryHash: this.resolveToolRegistryHash?.() ?? run.toolRegistryHash,
      liveWorkspaceScope: this.resolveLiveWorkspaceScope
        ? await this.resolveLiveWorkspaceScope(run)
        : run.workspaceScope,
    };
  }

  private invalidateApprovals(runId: string): void {
    const pending = this.approvals.get(runId) ?? [];
    this.approvals.set(
      runId,
      pending.map((approval) => (
        approval.status === 'pending'
          ? { ...approval, status: 'cancelled' as const, decidedAt: this.now() }
          : approval
      )),
    );
  }

  private userMessage(run: AgentRun, content: unknown, messageIndex: number): AgentMessage {
    return {
      id: this.createId(),
      runId: run.id,
      messageIndex,
      turn: run.activeTurn,
      role: 'user',
      content,
      state: 'complete',
      streamVersion: 0,
      createdAt: this.now(),
    };
  }

  private async requireRun(runId: string): Promise<AgentRun> {
    const run = await this.store.getRun(runId);
    if (!run) throw new Error(`Run ${runId} was not found.`);
    return run;
  }
}
