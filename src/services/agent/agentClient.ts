import type {
  AgentApproval,
  AgentArtifact,
  AgentClientCommand,
  AgentEvent,
  AgentMessage,
  AgentRun,
  AgentRunStatus,
  AgentToolCall,
} from '../../types/agent';
import { generateId } from './helpers';
import { RunRepository } from './runRepository';
import {
  isTerminalRunStatus,
  shouldCreateChildRun,
  transitionRun,
  type RunTransitionEvent,
} from './runStateMachine';

export interface AgentClientDependencies {
  repository: RunRepository;
  createId?: () => string;
  now?: () => number;
}

export interface SubmitInputOptions {
  content: unknown;
  selectedContextRefs?: AgentRun['contextRefs'];
}

export interface RetryOptions {
  selectedContextRefs?: AgentRun['contextRefs'];
}

const COMMAND_FOR_EVENT: Partial<Record<RunTransitionEvent, AgentClientCommand>> = {
  queue: 'run.queue',
  pause: 'run.pause',
  resume: 'run.resume',
  cancel_safe_work: 'run.cancel',
  cancel_mutation: 'run.cancel',
  cancel_interrupted_safe_work: 'run.cancel',
  review_resolved_queue: 'review.resolve',
  review_resolved_cancel: 'review.resolve',
};

let defaultClient: AgentClient | undefined;

/** Shared command/query client for the harness UI. Does not execute models. */
export function getDefaultAgentClient(): AgentClient {
  if (!defaultClient) {
    defaultClient = new AgentClient({ repository: new RunRepository() });
  }
  return defaultClient;
}

/**
 * Narrow command boundary for the run center and future runtime adapter.
 * React dispatches these commands; it never calculates lifecycle transitions.
 */
export class AgentClient {
  private readonly repository: RunRepository;
  private readonly createId: () => string;
  private readonly clock: () => number;

  constructor({ repository, createId = generateId, now = Date.now }: AgentClientDependencies) {
    this.repository = repository;
    this.createId = createId;
    this.clock = now;
  }

  /**
   * Materializes a new run already in `queued` status.
   * AgentRunStatus has no persisted `new` row; create applies New|Queue|queued.
   */
  create(run: AgentRun): Promise<AgentRun> {
    if (run.status !== 'queued') {
      throw new Error('New runs must be created in queued state.');
    }
    return this.repository.createRun(run, { command: 'run.create' });
  }

  listRuns(): Promise<AgentRun[]> {
    return this.repository.listRuns();
  }

  getRun(runId: string): Promise<AgentRun | undefined> {
    return this.repository.getRun(runId);
  }

  getEvents(runId: string): Promise<AgentEvent[]> {
    return this.repository.getEvents(runId);
  }

  getMessages(runId: string): Promise<AgentMessage[]> {
    return this.repository.getMessages(runId);
  }

  getApprovals(runId: string): Promise<AgentApproval[]> {
    return this.repository.getApprovals(runId);
  }

  getArtifacts(runId: string): Promise<AgentArtifact[]> {
    return this.repository.getArtifacts(runId);
  }

  getToolCalls(runId: string): Promise<AgentToolCall[]> {
    return this.repository.getToolCalls(runId);
  }

  /**
   * `run.queue` is idempotent for persisted queued runs.
   * The plan's New→queued edge is applied at create time (no durable `new` status).
   */
  async queue(runId: string): Promise<AgentRunStatus> {
    const run = await this.requireRun(runId);
    if (run.status === 'queued') {
      await this.repository.updateRunWithEvent(
        run.id,
        { status: 'queued' },
        'run.queued',
        { command: 'run.queue', status: 'queued' },
      );
      return 'queued';
    }
    // Reject non-queued statuses — other paths use resume / review / recovery events.
    transitionRun(run.status, 'queue');
    return 'queued';
  }

  async submitInput(runId: string, options: SubmitInputOptions): Promise<AgentRun> {
    const run = await this.requireRun(runId);
    if (shouldCreateChildRun(run.status)) {
      const child = this.makeChild(run, options.selectedContextRefs);
      await this.repository.createRun(child, { command: 'run.input.submit', parentRunId: run.id });
      await this.addInputMessage(child, options.content);
      return child;
    }

    const status = transitionRun(run.status, 'input_submitted');
    await this.repository.addMessage(this.inputMessage(run, options.content), 'user.input_received');
    await this.repository.updateRunWithEvent(
      run.id,
      { status, pendingInputCount: run.pendingInputCount + 1 },
      'user.input_scheduled',
      { command: 'run.input.submit', status },
    );
    return this.requireRun(run.id);
  }

  /**
   * Pause request. Active `running` work only records `pauseRequestedAt`; the executor
   * applies `pause_at_safe_boundary` when a safe boundary is reached.
   */
  async pause(runId: string): Promise<AgentRunStatus> {
    const run = await this.requireRun(runId);
    if (run.status === 'running') {
      await this.repository.updateRunWithEvent(
        run.id,
        { pauseRequestedAt: this.clock() },
        'run.status_changed',
        { command: 'run.pause', pauseRequested: true, status: run.status },
      );
      return run.status;
    }
    return this.apply(runId, 'pause', 'run.paused');
  }

  resume(runId: string): Promise<AgentRunStatus> {
    return this.apply(runId, 'resume', 'run.resumed');
  }

  /**
   * Cancel mapping:
   * - interrupted → cancel_interrupted_safe_work
   * - mutation in flight (running) → cancel_mutation (+ cancelRequestedAt)
   * - otherwise → cancel_safe_work
   */
  async cancel(runId: string, mutationInFlight: boolean): Promise<AgentRunStatus> {
    const run = await this.requireRun(runId);
    let event: RunTransitionEvent;
    if (run.status === 'interrupted') {
      event = 'cancel_interrupted_safe_work';
    } else if (mutationInFlight) {
      event = 'cancel_mutation';
    } else {
      event = 'cancel_safe_work';
    }

    const status = transitionRun(run.status, event);
    const patch: Partial<AgentRun> = { status };
    if (event === 'cancel_mutation') {
      patch.cancelRequestedAt = this.clock();
    }

    const eventType = status === 'cancelled' ? 'run.cancelled' : 'run.status_changed';
    await this.repository.updateRunWithEvent(
      run.id,
      patch,
      eventType,
      { command: 'run.cancel', status, mutationInFlight },
    );
    return status;
  }

  retry(runId: string, options: RetryOptions = {}): Promise<AgentRun> {
    return this.createChildFromTerminal(runId, 'run.retry', options.selectedContextRefs);
  }

  async answerApproval(
    approval: AgentApproval,
    decision: 'approved' | 'rejected',
    rejectedPlanAction: 'pause' | 'cancel' = 'pause',
  ): Promise<AgentRunStatus> {
    if (approval.status !== 'pending') throw new Error(`Approval ${approval.id} is already resolved.`);
    const run = await this.requireRun(approval.runId);
    const event: RunTransitionEvent = decision === 'approved'
      ? 'approval_approved'
      : approval.planId
        ? rejectedPlanAction === 'pause' ? 'plan_rejected_pause' : 'plan_rejected_cancel'
        : 'tool_rejected';
    const status = transitionRun(run.status, event);
    await this.repository.answerApproval(approval.id, decision, this.clock());
    await this.repository.updateRunWithEvent(
      run.id,
      { status },
      'run.status_changed',
      { command: 'approval.answer', approvalId: approval.id, decision, status },
    );
    return status;
  }

  resolveReview(runId: string, outcome: 'queue' | 'cancel'): Promise<AgentRunStatus> {
    return this.apply(
      runId,
      outcome === 'queue' ? 'review_resolved_queue' : 'review_resolved_cancel',
      outcome === 'queue' ? 'run.queued' : 'run.cancelled',
    );
  }

  /** Title-only update; does not change lifecycle status. */
  async rename(runId: string, title: string): Promise<AgentRun> {
    const run = await this.requireRun(runId);
    await this.repository.updateRunWithEvent(
      run.id,
      { title },
      'run.status_changed',
      { command: 'run.rename', title },
    );
    return this.requireRun(run.id);
  }

  archive(runId: string): Promise<void> {
    return this.repository.archiveRun(runId, this.clock()).then(() => undefined);
  }

  unarchive(runId: string): Promise<void> {
    return this.repository.unarchiveRun(runId).then(() => undefined);
  }

  async prioritizeQueue(runId: string): Promise<number> {
    const run = await this.requireRun(runId);
    if (run.status !== 'queued') throw new Error('Only queued runs can be prioritized.');
    const queued = await this.repository.listQueuedRuns();
    const priority = Math.max(0, ...queued.map((item) => item.queuePriority)) + 1;
    await this.repository.updateRunWithEvent(
      run.id,
      { queuePriority: priority },
      'run.status_changed',
      { command: 'run.queue.prioritize', queuePriority: priority },
    );
    return priority;
  }

  private async createChildFromTerminal(
    runId: string,
    command: 'run.retry',
    selectedContextRefs?: AgentRun['contextRefs'],
  ): Promise<AgentRun> {
    const parent = await this.requireRun(runId);
    if (!isTerminalRunStatus(parent.status)) throw new Error('Only terminal runs can be retried.');
    const child = this.makeChild(parent, selectedContextRefs);
    await this.repository.createRun(child, { command, parentRunId: parent.id });
    return child;
  }

  private makeChild(parent: AgentRun, selectedContextRefs?: AgentRun['contextRefs']): AgentRun {
    const timestamp = this.clock();
    return {
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
  }

  private inputMessage(run: AgentRun, content: unknown): AgentMessage {
    return {
      id: this.createId(),
      runId: run.id,
      messageIndex: run.nextSequence,
      turn: run.activeTurn,
      role: 'user',
      content,
      state: 'complete',
      streamVersion: 0,
      createdAt: this.clock(),
    };
  }

  private async addInputMessage(run: AgentRun, content: unknown): Promise<void> {
    await this.repository.addMessage(this.inputMessage(run, content), 'user.input_received');
  }

  private async apply(
    runId: string,
    event: RunTransitionEvent,
    eventType: 'run.queued' | 'run.paused' | 'run.resumed' | 'run.cancelled' | 'run.status_changed',
  ): Promise<AgentRunStatus> {
    const run = await this.requireRun(runId);
    const status = transitionRun(run.status, event);
    const command = COMMAND_FOR_EVENT[event] ?? event;
    await this.repository.updateRunWithEvent(
      run.id,
      { status },
      eventType,
      { command, status },
    );
    return status;
  }

  private async requireRun(runId: string): Promise<AgentRun> {
    const run = await this.repository.getRun(runId);
    if (!run) throw new Error(`Run ${runId} was not found.`);
    return run;
  }
}
