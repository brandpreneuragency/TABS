// ---------------------------------------------------------------------------
// TABS Work-OS Harness — One-worker scheduler and durable runtime lease
// Plan 25.1: one active job, 15-second lease, five-second renewal.
// Claim and lease share one Dexie transaction. Transfer only after expiry.
// ---------------------------------------------------------------------------

import type { AgentRun } from '../../types/agent';
import type { AgentRuntimeLeaseRecord, TabsDB } from '../db';
import { generateId } from './helpers';
import { isTerminalRunStatus } from './runStateMachine';
import type { RunClaim, RunRepository } from './runRepository';

/** Plan 25.1: 15-second worker lease. Literal form required by the gate. */
export const SCHEDULER_LEASE_DURATION_MS = 15000;

/** Plan 25.1: renew the lease every five seconds. Literal form required by the gate. */
export const SCHEDULER_LEASE_RENEWAL_INTERVAL_MS = 5000;

export const SCHEDULER_LEASE_ID = 'scheduler' as const;

export interface AgentRuntimeLease {
  id: 'scheduler';
  ownerId: string;
  mode: 'active' | 'quiescing';
  reason?: 'shutdown' | 'update';
  requestId?: string;
  expiresAt: number;
}

export interface AgentSchedulerOptions {
  database: TabsDB;
  repository: RunRepository;
  ownerId?: string;
  now?: () => number;
  createId?: () => string;
  leaseDurationMs?: number;
  renewalIntervalMs?: number;
}

export function sortQueuedRuns(runs: readonly AgentRun[]): AgentRun[] {
  return [...runs].sort(
    (left, right) => right.queuePriority - left.queuePriority || left.createdAt - right.createdAt,
  );
}

function asLease(record: AgentRuntimeLeaseRecord): AgentRuntimeLease {
  return {
    id: 'scheduler',
    ownerId: record.ownerId,
    mode: record.mode,
    reason: record.reason,
    requestId: record.requestId,
    expiresAt: record.expiresAt,
  };
}

/**
 * Single-worker durable scheduler. One random owner ID is created at startup.
 * Quiescing stops new claims, provider turns, and tool starts.
 */
export class AgentScheduler {
  readonly ownerId: string;
  readonly leaseDurationMs: number;
  readonly renewalIntervalMs: number;
  private readonly database: TabsDB;
  private readonly repository: RunRepository;
  private readonly now: () => number;
  private runtimePaused = false;
  private renewalTimer: ReturnType<typeof setInterval> | undefined;

  constructor(options: AgentSchedulerOptions) {
    this.database = options.database;
    this.repository = options.repository;
    this.ownerId = options.ownerId ?? (options.createId ?? generateId)();
    this.now = options.now ?? Date.now;
    this.leaseDurationMs = options.leaseDurationMs ?? SCHEDULER_LEASE_DURATION_MS;
    this.renewalIntervalMs = options.renewalIntervalMs ?? SCHEDULER_LEASE_RENEWAL_INTERVAL_MS;
  }

  pauseRuntime(): void {
    this.runtimePaused = true;
  }

  resumeRuntime(): void {
    this.runtimePaused = false;
  }

  isRuntimePaused(): boolean {
    return this.runtimePaused;
  }

  listQueued(): Promise<AgentRun[]> {
    return this.repository.listQueuedRuns();
  }

  async getLease(): Promise<AgentRuntimeLease | undefined> {
    const record = await this.database.agentRuntimeLeases.get(SCHEDULER_LEASE_ID);
    return record ? asLease(record) : undefined;
  }

  /**
   * Step 7 of the startup barrier. Overwrites an expired lease, including an
   * expired quiescing lease. Another live owner is not displaced.
   */
  async acquireLease(): Promise<AgentRuntimeLease | undefined> {
    const currentTime = this.now();
    return this.database.transaction('rw', this.database.agentRuntimeLeases, async () => {
      const existing = await this.database.agentRuntimeLeases.get(SCHEDULER_LEASE_ID);
      if (existing && existing.ownerId !== this.ownerId && existing.expiresAt > currentTime) {
        return undefined;
      }
      const next: AgentRuntimeLeaseRecord = {
        id: SCHEDULER_LEASE_ID,
        ownerId: this.ownerId,
        mode: 'active',
        expiresAt: currentTime + this.leaseDurationMs,
      };
      await this.database.agentRuntimeLeases.put(next);
      return asLease(next);
    });
  }

  async renewLease(): Promise<boolean> {
    return this.repository.renewLease(
      this.ownerId,
      this.now() + this.leaseDurationMs,
      this.now(),
    );
  }

  startRenewalLoop(): void {
    this.stopRenewalLoop();
    this.renewalTimer = setInterval(() => {
      void this.renewLease();
    }, this.renewalIntervalMs);
  }

  stopRenewalLoop(): void {
    if (this.renewalTimer !== undefined) {
      clearInterval(this.renewalTimer);
      this.renewalTimer = undefined;
    }
  }

  async beginQuiescing(
    reason: 'shutdown' | 'update',
    requestId: string,
  ): Promise<AgentRuntimeLease | undefined> {
    const currentTime = this.now();
    return this.database.transaction('rw', this.database.agentRuntimeLeases, async () => {
      const existing = await this.database.agentRuntimeLeases.get(SCHEDULER_LEASE_ID);
      if (!existing || existing.ownerId !== this.ownerId || existing.expiresAt <= currentTime) {
        return undefined;
      }
      const next: AgentRuntimeLeaseRecord = {
        ...existing,
        mode: 'quiescing',
        reason,
        requestId,
        expiresAt: currentTime + this.leaseDurationMs,
      };
      await this.database.agentRuntimeLeases.put(next);
      return asLease(next);
    });
  }

  async endQuiescing(): Promise<AgentRuntimeLease | undefined> {
    const currentTime = this.now();
    return this.database.transaction('rw', this.database.agentRuntimeLeases, async () => {
      const existing = await this.database.agentRuntimeLeases.get(SCHEDULER_LEASE_ID);
      if (!existing || existing.ownerId !== this.ownerId || existing.expiresAt <= currentTime) {
        return undefined;
      }
      const next: AgentRuntimeLeaseRecord = {
        id: SCHEDULER_LEASE_ID,
        ownerId: this.ownerId,
        mode: 'active',
        expiresAt: currentTime + this.leaseDurationMs,
      };
      await this.database.agentRuntimeLeases.put(next);
      return asLease(next);
    });
  }

  /** Startup recovery: a process restart discards an expired quiescing lease. */
  async discardExpiredQuiescingLease(): Promise<boolean> {
    const currentTime = this.now();
    return this.database.transaction('rw', this.database.agentRuntimeLeases, async () => {
      const existing = await this.database.agentRuntimeLeases.get(SCHEDULER_LEASE_ID);
      if (!existing || existing.mode !== 'quiescing' || existing.expiresAt > currentTime) {
        return false;
      }
      await this.database.agentRuntimeLeases.delete(SCHEDULER_LEASE_ID);
      return true;
    });
  }

  async allowsClaim(): Promise<boolean> {
    return this.allowsActiveWork();
  }

  async allowsProviderTurn(): Promise<boolean> {
    return this.allowsActiveWork();
  }

  async allowsToolStart(): Promise<boolean> {
    return this.allowsActiveWork();
  }

  /**
   * Claim the next queued run and refresh the lease in one transaction.
   * Requires an unexpired active lease owned by this scheduler. Transfer of a
   * run-level claim is allowed only after the prior worker lease expires.
   */
  async claimNext(): Promise<RunClaim | undefined> {
    if (this.runtimePaused) return undefined;
    const currentTime = this.now();
    const leaseExpiresAt = currentTime + this.leaseDurationMs;
    return this.database.transaction(
      'rw',
      this.database.agentRuns,
      this.database.agentRuntimeLeases,
      async () => {
        const lease = await this.database.agentRuntimeLeases.get(SCHEDULER_LEASE_ID);
        if (
          !lease
          || lease.ownerId !== this.ownerId
          || lease.expiresAt <= currentTime
          || lease.mode === 'quiescing'
        ) {
          return undefined;
        }

        const ownedActive = await this.database.agentRuns
          .filter((run) => run.workerOwnerId === this.ownerId && !isTerminalRunStatus(run.status))
          .count();
        if (ownedActive > 0) return undefined;

        const queued = sortQueuedRuns(
          await this.database.agentRuns.where('status').equals('queued').toArray(),
        );
        const nextRun = queued.find((run) => this.canTakeRun(run, currentTime));
        if (!nextRun) return undefined;

        const nextLease: AgentRuntimeLeaseRecord = {
          ...lease,
          ownerId: this.ownerId,
          expiresAt: leaseExpiresAt,
        };
        const claimed: AgentRun = {
          ...nextRun,
          workerOwnerId: this.ownerId,
          workerLeaseExpiresAt: leaseExpiresAt,
          updatedAt: currentTime,
        };
        await this.database.agentRuntimeLeases.put(nextLease);
        await this.database.agentRuns.put(claimed);
        return { run: claimed, lease: nextLease };
      },
    );
  }

  /** Release the run claim after a terminal state. Keep the scheduler lease. */
  async releaseClaim(runId: string): Promise<boolean> {
    const currentTime = this.now();
    return this.database.transaction('rw', this.database.agentRuns, async () => {
      const run = await this.database.agentRuns.get(runId);
      if (!run || run.workerOwnerId !== this.ownerId) return false;
      await this.database.agentRuns.put({
        ...run,
        workerOwnerId: undefined,
        workerLeaseExpiresAt: undefined,
        updatedAt: currentTime,
      });
      return true;
    });
  }

  /** Move a queued run to the front: current maximum priority plus one. */
  async prioritize(runId: string): Promise<number> {
    const run = await this.repository.getRun(runId);
    if (!run || run.status !== 'queued') {
      throw new Error('Only queued runs can be prioritized.');
    }
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

  private async allowsActiveWork(): Promise<boolean> {
    if (this.runtimePaused) return false;
    const lease = await this.database.agentRuntimeLeases.get(SCHEDULER_LEASE_ID);
    return Boolean(
      lease
      && lease.ownerId === this.ownerId
      && lease.expiresAt > this.now()
      && lease.mode === 'active',
    );
  }

  private canTakeRun(run: AgentRun, currentTime: number): boolean {
    if (!run.workerOwnerId || run.workerOwnerId === this.ownerId) return true;
    return (run.workerLeaseExpiresAt ?? 0) <= currentTime;
  }
}
