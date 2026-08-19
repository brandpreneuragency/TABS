import Dexie from 'dexie';
import type {
  AgentApproval,
  AgentEvent,
  AgentEventType,
  AgentMessage,
  AgentOperationReceipt,
  AgentPolicyGrant,
  AgentProviderAttempt,
  AgentRun,
  AgentRunStatus,
  AgentToolCall,
  AgentToolExecutionAttempt,
} from '../../types/agent';
import { db, type AgentRuntimeLeaseRecord, type TabsDB } from '../db';
import { generateId } from './helpers';

export type RunProjectionPatch = Partial<Omit<AgentRun, 'id' | 'nextSequence'>>;

export interface RunClaim {
  run: AgentRun;
  lease: AgentRuntimeLeaseRecord;
}

export interface CleanupResult {
  events: number;
  messages: number;
  providerAttempts: number;
  toolCalls: number;
  toolAttempts: number;
  approvals: number;
  grants: number;
  artifacts: number;
  receiptsRetained: number;
}

const TERMINAL_STATUSES: ReadonlySet<AgentRunStatus> = new Set<AgentRunStatus>([
  'completed',
  'failed',
  'cancelled',
]);

function now(): number {
  return Date.now();
}

/** Durable, transactional access to the harness run model. */
export class RunRepository {
  private readonly database: TabsDB;

  constructor(database: TabsDB = db) {
    this.database = database;
  }

  async createRun(run: AgentRun, eventData: unknown = {}): Promise<AgentRun> {
    return this.database.transaction('rw', this.database.agentRuns, this.database.agentEvents, async () => {
      if (await this.database.agentRuns.get(run.id)) {
        throw new Error(`Run ${run.id} already exists.`);
      }
      const sequence = run.nextSequence;
      const created: AgentRun = { ...run, nextSequence: sequence + 1 };
      await this.database.agentRuns.add(created);
      await this.database.agentEvents.add(this.makeEvent(run.id, sequence, 'run.created', eventData));
      return created;
    });
  }

  getRun(runId: string): Promise<AgentRun | undefined> {
    return this.database.agentRuns.get(runId);
  }

  async listRuns(): Promise<AgentRun[]> {
    return this.database.agentRuns.orderBy('createdAt').reverse().toArray();
  }

  async listQueuedRuns(): Promise<AgentRun[]> {
    const runs = await this.database.agentRuns.where('status').equals('queued').toArray();
    return runs.sort((left, right) =>
      right.queuePriority - left.queuePriority || left.createdAt - right.createdAt,
    );
  }

  getEvents(runId: string, afterSequence = -1): Promise<AgentEvent[]> {
    return this.database.agentEvents
      .where('[runId+sequence]')
      .between([runId, afterSequence + 1], [runId, Dexie.maxKey])
      .sortBy('sequence');
  }

  async appendEvent(
    runId: string,
    type: AgentEventType,
    data: unknown,
    projection: RunProjectionPatch = {},
  ): Promise<AgentEvent> {
    return this.database.transaction('rw', this.database.agentRuns, this.database.agentEvents, async () =>
      this.appendEventInTransaction(runId, type, data, projection),
    );
  }

  updateRunWithEvent(
    runId: string,
    projection: RunProjectionPatch,
    type: AgentEventType,
    data: unknown,
  ): Promise<AgentEvent> {
    return this.appendEvent(runId, type, data, projection);
  }

  async addMessage(message: AgentMessage, eventType?: AgentEventType): Promise<AgentMessage> {
    const tables = [this.database.agentRuns, this.database.agentMessages, this.database.agentEvents];
    return this.database.transaction('rw', tables, async () => {
      await this.requireRun(message.runId);
      await this.database.agentMessages.add(message);
      if (eventType) {
        await this.appendEventInTransaction(message.runId, eventType, { messageId: message.id });
      }
      return message;
    });
  }

  /** Persists one complete assistant protocol message and all of its logical calls atomically. */
  async persistAssistantTurn(message: AgentMessage, toolCalls: AgentToolCall[]): Promise<void> {
    if (message.role !== 'assistant' || message.state !== 'complete') {
      throw new Error('Only a complete assistant message can be accepted as a turn.');
    }
    if (toolCalls.some((call) => call.runId !== message.runId || call.turn !== message.turn)) {
      throw new Error('Assistant messages and logical tool calls must share a run and turn.');
    }
    await this.database.transaction(
      'rw',
      this.database.agentRuns,
      this.database.agentMessages,
      this.database.agentToolCalls,
      this.database.agentEvents,
      async () => {
        await this.requireRun(message.runId);
        await this.database.agentMessages.add(message);
        await this.database.agentToolCalls.bulkAdd(toolCalls);
        for (const call of toolCalls) {
          await this.appendEventInTransaction(message.runId, 'tool.requested', {
            toolCallId: call.id,
            operationId: call.operationId,
            toolName: call.toolName,
          });
        }
      },
    );
  }

  getMessages(runId: string): Promise<AgentMessage[]> {
    return this.database.agentMessages.where('[runId+messageIndex]').between(
      [runId, Dexie.minKey],
      [runId, Dexie.maxKey],
    ).sortBy('messageIndex');
  }

  async checkpointMessage(
    messageId: string,
    streamVersion: number,
    content: unknown,
  ): Promise<boolean> {
    return this.database.transaction('rw', this.database.agentMessages, async () => {
      const message = await this.database.agentMessages.get(messageId);
      if (!message || message.state !== 'pending' || streamVersion <= message.streamVersion) return false;
      await this.database.agentMessages.put({ ...message, streamVersion, content });
      return true;
    });
  }

  async finalizeMessage(
    messageId: string,
    streamVersion: number,
    content: unknown,
  ): Promise<boolean> {
    return this.database.transaction('rw', this.database.agentMessages, async () => {
      const message = await this.database.agentMessages.get(messageId);
      if (!message || message.state !== 'pending' || streamVersion < message.streamVersion) return false;
      await this.database.agentMessages.put({
        ...message,
        state: 'complete',
        streamVersion,
        content,
      });
      return true;
    });
  }

  async startProviderAttempt(attempt: AgentProviderAttempt): Promise<AgentProviderAttempt> {
    return this.database.transaction(
      'rw',
      this.database.agentRuns,
      this.database.agentProviderAttempts,
      this.database.agentEvents,
      async () => {
        await this.database.agentProviderAttempts.add(attempt);
        await this.appendEventInTransaction(attempt.runId, 'model.requested', {
          providerAttemptId: attempt.id,
          turn: attempt.turn,
          attempt: attempt.attempt,
        });
        return attempt;
      },
    );
  }

  async updateProviderAttempt(
    attemptId: string,
    patch: Partial<Omit<AgentProviderAttempt, 'id' | 'runId'>>,
    eventType?: AgentEventType,
  ): Promise<AgentProviderAttempt> {
    return this.database.transaction(
      'rw',
      this.database.agentRuns,
      this.database.agentProviderAttempts,
      this.database.agentEvents,
      async () => {
        const attempt = await this.database.agentProviderAttempts.get(attemptId);
        if (!attempt) throw new Error(`Provider attempt ${attemptId} was not found.`);
        const updated = { ...attempt, ...patch };
        await this.database.agentProviderAttempts.put(updated);
        if (eventType) {
          await this.appendEventInTransaction(attempt.runId, eventType, { providerAttemptId: attemptId });
        }
        return updated;
      },
    );
  }

  async addToolCalls(toolCalls: AgentToolCall[]): Promise<void> {
    if (toolCalls.length === 0) return;
    const runId = toolCalls[0].runId;
    if (toolCalls.some((call) => call.runId !== runId)) {
      throw new Error('A persisted assistant turn cannot span runs.');
    }
    await this.database.transaction(
      'rw',
      this.database.agentRuns,
      this.database.agentToolCalls,
      this.database.agentEvents,
      async () => {
        await this.requireRun(runId);
        await this.database.agentToolCalls.bulkAdd(toolCalls);
        for (const call of toolCalls) {
          await this.appendEventInTransaction(runId, 'tool.requested', {
            toolCallId: call.id,
            operationId: call.operationId,
            toolName: call.toolName,
          });
        }
      },
    );
  }

  getToolCallByOperationId(operationId: string): Promise<AgentToolCall | undefined> {
    return this.database.agentToolCalls.where('operationId').equals(operationId).first();
  }

  async startToolExecution(
    toolCallId: string,
    executionEpoch: number,
    startedAt = now(),
  ): Promise<AgentToolExecutionAttempt> {
    return this.database.transaction(
      'rw',
      this.database.agentRuns,
      this.database.agentToolCalls,
      this.database.agentToolAttempts,
      this.database.agentEvents,
      async () => {
        const call = await this.database.agentToolCalls.get(toolCallId);
        if (!call) throw new Error(`Tool call ${toolCallId} was not found.`);
        const prior = await this.database.agentToolAttempts.where('toolCallId').equals(toolCallId).toArray();
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
        await this.database.agentToolAttempts.add(attempt);
        await this.database.agentToolCalls.put({ ...call, status: 'executing', startedAt });
        await this.appendEventInTransaction(call.runId, 'tool.started', {
          toolCallId,
          toolAttemptId: attempt.id,
          operationId: call.operationId,
        });
        return attempt;
      },
    );
  }

  /** Safe recovery keeps the logical operation ID and creates a fresh execution attempt. */
  recoverToolExecution(toolCallId: string, executionEpoch: number): Promise<AgentToolExecutionAttempt> {
    return this.startToolExecution(toolCallId, executionEpoch);
  }

  async completeToolExecution(
    attemptId: string,
    status: 'succeeded' | 'failed' | 'interrupted',
    options: { errorCode?: string; resultArtifactIds?: string[]; finishedAt?: number } = {},
  ): Promise<AgentToolExecutionAttempt> {
    return this.database.transaction(
      'rw',
      this.database.agentRuns,
      this.database.agentToolCalls,
      this.database.agentToolAttempts,
      this.database.agentEvents,
      async () => {
        const attempt = await this.database.agentToolAttempts.get(attemptId);
        if (!attempt) throw new Error(`Tool attempt ${attemptId} was not found.`);
        const call = await this.database.agentToolCalls.get(attempt.toolCallId);
        if (!call) throw new Error(`Tool call ${attempt.toolCallId} was not found.`);
        const finishedAt = options.finishedAt ?? now();
        const updatedAttempt = { ...attempt, status, errorCode: options.errorCode, finishedAt };
        await this.database.agentToolAttempts.put(updatedAttempt);
        await this.database.agentToolCalls.put({
          ...call,
          status,
          errorCode: options.errorCode,
          finishedAt,
          resultArtifactIds: options.resultArtifactIds ?? call.resultArtifactIds,
        });
        const eventType: AgentEventType = status === 'succeeded'
          ? 'tool.completed'
          : status === 'failed' ? 'tool.failed' : 'tool.interrupted';
        await this.appendEventInTransaction(call.runId, eventType, {
          toolCallId: call.id,
          toolAttemptId: attempt.id,
          operationId: call.operationId,
        });
        return updatedAttempt;
      },
    );
  }

  async addApproval(approval: AgentApproval): Promise<AgentApproval> {
    return this.database.transaction(
      'rw',
      this.database.agentRuns,
      this.database.agentApprovals,
      this.database.agentEvents,
      async () => {
        await this.database.agentApprovals.add(approval);
        await this.appendEventInTransaction(approval.runId, 'approval.requested', {
          approvalId: approval.id,
          toolCallId: approval.toolCallId,
        });
        return approval;
      },
    );
  }

  async answerApproval(
    approvalId: string,
    status: 'approved' | 'rejected' | 'expired' | 'cancelled',
    decidedAt = now(),
  ): Promise<AgentApproval> {
    return this.database.transaction(
      'rw',
      this.database.agentRuns,
      this.database.agentApprovals,
      this.database.agentEvents,
      async () => {
        const approval = await this.database.agentApprovals.get(approvalId);
        if (!approval) throw new Error(`Approval ${approvalId} was not found.`);
        if (approval.status !== 'pending') throw new Error(`Approval ${approvalId} is already resolved.`);
        const updated = { ...approval, status, decidedAt };
        await this.database.agentApprovals.put(updated);
        await this.appendEventInTransaction(approval.runId, 'approval.answered', {
          approvalId,
          status,
        });
        return updated;
      },
    );
  }

  addGrant(grant: AgentPolicyGrant): Promise<string> {
    return this.database.agentPolicyGrants.add(grant);
  }

  async consumeGrant(grantId: string): Promise<AgentPolicyGrant | undefined> {
    return this.database.transaction('rw', this.database.agentPolicyGrants, async () => {
      const grant = await this.database.agentPolicyGrants.get(grantId);
      if (!grant || grant.expiresAt <= now() || grant.usedCount >= grant.maxUses) return undefined;
      const updated = { ...grant, usedCount: grant.usedCount + 1 };
      await this.database.agentPolicyGrants.put(updated);
      return updated;
    });
  }

  /** Consumes a grant and approves its pending logical tool call in one transaction. */
  async consumeGrantAndApproveTool(
    grantId: string,
    approvalId: string,
    currentTime = now(),
  ): Promise<boolean> {
    return this.database.transaction(
      'rw',
      this.database.agentRuns,
      this.database.agentPolicyGrants,
      this.database.agentApprovals,
      this.database.agentToolCalls,
      this.database.agentEvents,
      async () => {
        const grant = await this.database.agentPolicyGrants.get(grantId);
        const approval = await this.database.agentApprovals.get(approvalId);
        const call = approval?.toolCallId
          ? await this.database.agentToolCalls.get(approval.toolCallId)
          : undefined;
        if (
          !grant
          || !approval
          || !call
          || approval.status !== 'pending'
          || approval.expiresAt <= currentTime
          || grant.expiresAt <= currentTime
          || grant.usedCount >= grant.maxUses
          || grant.runId !== approval.runId
          || grant.policyRevision !== approval.policyRevision
          || grant.toolName !== call.toolName
          || grant.toolVersion !== call.toolVersion
        ) return false;

        await this.database.agentPolicyGrants.put({ ...grant, usedCount: grant.usedCount + 1 });
        await this.database.agentApprovals.put({ ...approval, status: 'approved', decidedAt: currentTime });
        await this.database.agentToolCalls.put({ ...call, status: 'approved' });
        await this.appendEventInTransaction(approval.runId, 'approval.answered', {
          approvalId,
          status: 'approved',
          grantId,
          toolCallId: call.id,
        });
        return true;
      },
    );
  }

  addReceipt(receipt: AgentOperationReceipt): Promise<string> {
    return this.database.agentOperationReceipts.add(receipt);
  }

  getReceipt(operationId: string): Promise<AgentOperationReceipt | undefined> {
    return this.database.agentOperationReceipts.where('operationId').equals(operationId).first();
  }

  async claimRun(
    runId: string,
    ownerId: string,
    leaseExpiresAt: number,
    currentTime = now(),
  ): Promise<RunClaim | undefined> {
    return this.database.transaction(
      'rw',
      this.database.agentRuns,
      this.database.agentRuntimeLeases,
      async () => {
        const run = await this.database.agentRuns.get(runId);
        if (!run || run.status !== 'queued') return undefined;
        const lease = await this.database.agentRuntimeLeases.get('scheduler');
        if (lease && lease.ownerId !== ownerId && lease.expiresAt > currentTime) return undefined;
        const nextLease: AgentRuntimeLeaseRecord = {
          id: 'scheduler',
          ownerId,
          mode: 'active',
          expiresAt: leaseExpiresAt,
        };
        const claimed = { ...run, workerOwnerId: ownerId, workerLeaseExpiresAt: leaseExpiresAt, updatedAt: currentTime };
        await this.database.agentRuntimeLeases.put(nextLease);
        await this.database.agentRuns.put(claimed);
        return { run: claimed, lease: nextLease };
      },
    );
  }

  async renewLease(ownerId: string, leaseExpiresAt: number, currentTime = now()): Promise<boolean> {
    return this.database.transaction(
      'rw',
      this.database.agentRuns,
      this.database.agentRuntimeLeases,
      async () => {
        const lease = await this.database.agentRuntimeLeases.get('scheduler');
        if (!lease || lease.ownerId !== ownerId || lease.expiresAt <= currentTime) return false;
        await this.database.agentRuntimeLeases.put({ ...lease, expiresAt: leaseExpiresAt });
        const claimedRuns = await this.database.agentRuns.filter((run) => run.workerOwnerId === ownerId).toArray();
        await this.database.agentRuns.bulkPut(claimedRuns.map((run) => ({
          ...run,
          workerLeaseExpiresAt: leaseExpiresAt,
          updatedAt: currentTime,
        })));
        return true;
      },
    );
  }

  async releaseClaim(runId: string, ownerId: string): Promise<boolean> {
    return this.database.transaction(
      'rw',
      this.database.agentRuns,
      this.database.agentRuntimeLeases,
      async () => {
        const run = await this.database.agentRuns.get(runId);
        if (!run || run.workerOwnerId !== ownerId) return false;
        const released = { ...run, workerOwnerId: undefined, workerLeaseExpiresAt: undefined, updatedAt: now() };
        await this.database.agentRuns.put(released);
        const remaining = await this.database.agentRuns.filter((item) => item.workerOwnerId === ownerId).count();
        const lease = await this.database.agentRuntimeLeases.get('scheduler');
        if (remaining === 0 && lease?.ownerId === ownerId) {
          await this.database.agentRuntimeLeases.delete('scheduler');
        }
        return true;
      },
    );
  }

  archiveRun(runId: string, archivedAt = now()): Promise<AgentEvent> {
    return this.appendEvent(runId, 'run.status_changed', { archivedAt }, { archivedAt });
  }

  unarchiveRun(runId: string): Promise<AgentEvent> {
    return this.appendEvent(runId, 'run.status_changed', { archivedAt: null }, { archivedAt: undefined });
  }

  async cleanupRun(runId: string): Promise<CleanupResult> {
    const tables = [
      this.database.agentRuns,
      this.database.agentEvents,
      this.database.agentMessages,
      this.database.agentProviderAttempts,
      this.database.agentToolCalls,
      this.database.agentToolAttempts,
      this.database.agentApprovals,
      this.database.agentPolicyGrants,
      this.database.agentArtifacts,
      this.database.agentOperationReceipts,
    ];
    return this.database.transaction('rw', tables, async () => {
      const run = await this.requireRun(runId);
      if (!TERMINAL_STATUSES.has(run.status)) throw new Error('Only terminal runs can be deleted.');
      const receiptsRetained = await this.database.agentOperationReceipts.count();
      const counts = await Promise.all([
        this.database.agentEvents.where('runId').equals(runId).delete(),
        this.database.agentMessages.where('runId').equals(runId).delete(),
        this.database.agentProviderAttempts.where('runId').equals(runId).delete(),
        this.database.agentToolCalls.where('runId').equals(runId).delete(),
        this.database.agentToolAttempts.where('runId').equals(runId).delete(),
        this.database.agentApprovals.where('runId').equals(runId).delete(),
        this.database.agentPolicyGrants.where('runId').equals(runId).delete(),
        this.database.agentArtifacts.where('runId').equals(runId).delete(),
      ]);
      await this.database.agentRuns.delete(runId);
      return {
        events: counts[0],
        messages: counts[1],
        providerAttempts: counts[2],
        toolCalls: counts[3],
        toolAttempts: counts[4],
        approvals: counts[5],
        grants: counts[6],
        artifacts: counts[7],
        receiptsRetained,
      };
    });
  }

  deleteRun(runId: string): Promise<CleanupResult> {
    return this.cleanupRun(runId);
  }

  private makeEvent(
    runId: string,
    sequence: number,
    type: AgentEventType,
    data: unknown,
  ): AgentEvent {
    return { id: generateId(), runId, sequence, type, data, createdAt: now() };
  }

  private async requireRun(runId: string): Promise<AgentRun> {
    const run = await this.database.agentRuns.get(runId);
    if (!run) throw new Error(`Run ${runId} was not found.`);
    return run;
  }

  private async appendEventInTransaction(
    runId: string,
    type: AgentEventType,
    data: unknown,
    projection: RunProjectionPatch = {},
  ): Promise<AgentEvent> {
    const run = await this.requireRun(runId);
    const event = this.makeEvent(runId, run.nextSequence, type, data);
    await this.database.agentRuns.put({
      ...run,
      ...projection,
      id: run.id,
      nextSequence: run.nextSequence + 1,
      updatedAt: now(),
    });
    await this.database.agentEvents.add(event);
    return event;
  }
}
