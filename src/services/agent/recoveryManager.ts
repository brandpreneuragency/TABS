// ---------------------------------------------------------------------------
// TABS Work-OS Harness — Startup recovery classification
// Plan 25.2 matrix, 24.4–24.5 hash/shell rules, 13 safe-recovery epoch.
// Logical operation IDs are reused. Approvals stay pending.
// ---------------------------------------------------------------------------

import type {
  AgentApproval,
  AgentOperationReceipt,
  AgentProviderAttempt,
  AgentRun,
  AgentRunStatus,
  AgentToolCall,
  AgentToolExecutionAttempt,
  ToolRiskClass,
} from '../../types/agent';
import type { TabsCRMFormsDB } from '../../data/crmFormsDb';
import type { TabsDB } from '../db';
import { classifyFilesystemOutcome } from './tools/mutationSupport';
import { transitionRun } from './runStateMachine';
import type { RunRepository } from './runRepository';

export const RECOVERY_MATRIX_CLASSES = [
  'provider',
  'read',
  'receipt_backed_mutation',
  'file_hash',
  'shell',
  'external_write',
] as const;

export type RecoveryMatrixClass = (typeof RECOVERY_MATRIX_CLASSES)[number];

export type RecoveryClass =
  | 'queued'
  | 'awaiting_approval'
  | RecoveryMatrixClass;

export type RecoveryAction =
  | 'keep_queued'
  | 'restore_approval'
  | 'interrupt_then_retry_safely'
  | 'inspect_receipt'
  | 'compare_hashes'
  | 'require_review';

export interface FilesystemHashObservation {
  expectedInputHash: string;
  expectedOutputHash: string;
  observedHash?: string;
}

export interface RecoveryDecision {
  runId: string;
  recoveryClass: RecoveryClass;
  action: RecoveryAction;
  nextStatus: AgentRunStatus;
  incrementEpoch: boolean;
  reuseOperationIds: true;
  restoreApprovals: boolean;
  operationId?: string;
  interruptionReason?: string;
  receiptStatus?: AgentOperationReceipt['status'];
  hashOutcome?: 'committed' | 'not_applied' | 'unknown';
  approvals: AgentApproval[];
}

export interface RecoveryManagerOptions {
  database: TabsDB;
  repository: RunRepository;
  companion?: TabsCRMFormsDB;
  now?: () => number;
  observeFilesystemHash?: (
    call: AgentToolCall,
  ) => Promise<FilesystemHashObservation | undefined>;
  verifyCompatibility?: (run: AgentRun) => Promise<{ ok: boolean; reason?: string }>;
}

const OPEN_PROVIDER = new Set<AgentProviderAttempt['status']>(['started', 'streaming']);
const OPEN_TOOL = new Set<AgentToolExecutionAttempt['status']>(['started']);
const NON_TERMINAL = new Set<AgentRunStatus>([
  'queued',
  'planning',
  'awaiting_approval',
  'running',
  'cancelling',
  'paused',
  'interrupted',
  'needs_review',
]);

function hasHashArgs(args: unknown): boolean {
  if (!args || typeof args !== 'object') return false;
  const record = args as Record<string, unknown>;
  return typeof record.expectedInputHash === 'string'
    || typeof record.expectedOutputHash === 'string';
}

export function classifyToolRecoveryClass(input: {
  toolName: string;
  normalizedArgs?: unknown;
  risk?: ToolRiskClass;
  sideEffect?: 'none' | 'reversible' | 'irreversible' | 'external';
}): RecoveryMatrixClass {
  if (input.risk === 'process_execute') return 'shell';
  if (input.risk === 'external_write' || input.sideEffect === 'external') return 'external_write';
  if (input.risk === 'local_read' || input.risk === 'network_read') return 'read';

  const name = input.toolName.toLowerCase();
  if (name.includes('shell') || name.includes('exec_command') || name === 'exec') return 'shell';
  if (name.includes('external') || name.includes('web_post') || name.includes('http_write')) {
    return 'external_write';
  }
  if (
    hasHashArgs(input.normalizedArgs)
    || name.includes('file_write')
    || name.includes('write_file')
    || name.includes('fs_write')
    || name.includes('file_edit')
  ) {
    return 'file_hash';
  }
  if (
    name.includes('read')
    || name.includes('list_')
    || name.includes('search_')
    || name.startsWith('get_')
  ) {
    return 'read';
  }
  return 'receipt_backed_mutation';
}

function latest<T extends { startedAt: number }>(items: T[]): T | undefined {
  return items.reduce<T | undefined>(
    (winner, item) => (!winner || item.startedAt > winner.startedAt ? item : winner),
    undefined,
  );
}

function hashesFromArgs(args: unknown): FilesystemHashObservation | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const record = args as Record<string, unknown>;
  if (typeof record.expectedInputHash !== 'string' || typeof record.expectedOutputHash !== 'string') {
    return undefined;
  }
  return {
    expectedInputHash: record.expectedInputHash,
    expectedOutputHash: record.expectedOutputHash,
    observedHash: typeof record.observedHash === 'string' ? record.observedHash : undefined,
  };
}

/**
 * Applies the 25.2 recovery matrix. Safe recovery increments executionEpoch
 * and reuses logical operation IDs. Pending approvals are restored, not reset.
 */
export class RecoveryManager {
  private readonly database: TabsDB;
  private readonly repository: RunRepository;
  private readonly companion?: TabsCRMFormsDB;
  private readonly now: () => number;
  private readonly observeFilesystemHash?: RecoveryManagerOptions['observeFilesystemHash'];
  private readonly verifyCompatibility?: RecoveryManagerOptions['verifyCompatibility'];

  constructor(options: RecoveryManagerOptions) {
    this.database = options.database;
    this.repository = options.repository;
    this.companion = options.companion;
    this.now = options.now ?? Date.now;
    this.observeFilesystemHash = options.observeFilesystemHash;
    this.verifyCompatibility = options.verifyCompatibility;
  }

  async listNonTerminalRuns(): Promise<AgentRun[]> {
    const runs = await this.database.agentRuns.toArray();
    return runs.filter((run) => NON_TERMINAL.has(run.status));
  }

  async classifyRun(run: AgentRun): Promise<RecoveryDecision> {
    const [attempts, toolAttempts, toolCalls, approvals] = await Promise.all([
      this.database.agentProviderAttempts.where('runId').equals(run.id).toArray(),
      this.database.agentToolAttempts.where('runId').equals(run.id).toArray(),
      this.repository.getToolCalls(run.id),
      this.database.agentApprovals.where('runId').equals(run.id).toArray(),
    ]);
    const pendingApprovals = approvals.filter((approval) => approval.status === 'pending');
    const openTool = latest(toolAttempts.filter((attempt) => OPEN_TOOL.has(attempt.status)));
    const openProvider = latest(attempts.filter((attempt) => OPEN_PROVIDER.has(attempt.status)));

    if (openTool) {
      const call = toolCalls.find((item) => item.id === openTool.toolCallId);
      return this.classifyOpenTool(run, openTool, call, pendingApprovals);
    }
    if (openProvider) {
      return this.finishDecision(run, {
        recoveryClass: 'provider',
        action: 'interrupt_then_retry_safely',
        nextStatus: 'queued',
        incrementEpoch: true,
        interruptionReason: run.interruptionReason ?? 'provider_request_started',
        approvals: pendingApprovals,
      });
    }
    if (run.status === 'awaiting_approval') {
      return {
        runId: run.id,
        recoveryClass: 'awaiting_approval',
        action: 'restore_approval',
        nextStatus: 'awaiting_approval',
        incrementEpoch: false,
        reuseOperationIds: true,
        restoreApprovals: true,
        approvals: pendingApprovals,
      };
    }
    if (run.status === 'queued') {
      return {
        runId: run.id,
        recoveryClass: 'queued',
        action: 'keep_queued',
        nextStatus: 'queued',
        incrementEpoch: false,
        reuseOperationIds: true,
        restoreApprovals: true,
        approvals: pendingApprovals,
      };
    }
    if (run.status === 'interrupted') {
      return this.finishDecision(run, {
        recoveryClass: 'provider',
        action: 'interrupt_then_retry_safely',
        nextStatus: 'queued',
        incrementEpoch: true,
        interruptionReason: run.interruptionReason ?? 'interrupted',
        approvals: pendingApprovals,
      });
    }
    return {
      runId: run.id,
      recoveryClass: 'queued',
      action: 'keep_queued',
      nextStatus: run.status,
      incrementEpoch: false,
      reuseOperationIds: true,
      restoreApprovals: true,
      approvals: pendingApprovals,
    };
  }

  async recoverRun(runId: string): Promise<{ run: AgentRun; decision: RecoveryDecision }> {
    const run = await this.repository.getRun(runId);
    if (!run) throw new Error(`Run ${runId} was not found.`);
    const decision = await this.classifyRun(run);
    const recovered = await this.applyDecision(run, decision);
    return { run: recovered, decision };
  }

  async recoverAll(): Promise<Array<{ run: AgentRun; decision: RecoveryDecision }>> {
    const runs = await this.listNonTerminalRuns();
    const results: Array<{ run: AgentRun; decision: RecoveryDecision }> = [];
    for (const run of runs) {
      results.push(await this.recoverRun(run.id));
    }
    return results;
  }

  /**
   * Plan 25.3: persist the interruption, retry only safe work, keep approvals,
   * and leave run policy untouched.
   */
  async resumeAfterOffline(
    runId: string,
    reason = 'network_loss',
  ): Promise<{ run: AgentRun; decision: RecoveryDecision }> {
    const run = await this.repository.getRun(runId);
    if (!run) throw new Error(`Run ${runId} was not found.`);
    await this.repository.updateRunWithEvent(
      runId,
      { interruptionReason: reason },
      'run.interrupted',
      { reason, offlineResume: true, policyRevision: run.policyRevision },
    );
    return this.recoverRun(runId);
  }

  private async classifyOpenTool(
    run: AgentRun,
    attempt: AgentToolExecutionAttempt,
    call: AgentToolCall | undefined,
    approvals: AgentApproval[],
  ): Promise<RecoveryDecision> {
    const recoveryClass = classifyToolRecoveryClass({
      toolName: call?.toolName ?? 'unknown',
      normalizedArgs: call?.normalizedArgs,
    });
    const operationId = attempt.operationId;

    if (recoveryClass === 'read') {
      return this.finishDecision(run, {
        recoveryClass,
        action: 'interrupt_then_retry_safely',
        nextStatus: 'queued',
        incrementEpoch: true,
        operationId,
        interruptionReason: 'read_tool_started',
        approvals,
      });
    }
    if (recoveryClass === 'shell' || recoveryClass === 'external_write') {
      return this.finishDecision(run, {
        recoveryClass,
        action: 'require_review',
        nextStatus: 'needs_review',
        incrementEpoch: false,
        operationId,
        interruptionReason: `${recoveryClass}_started`,
        approvals,
      });
    }
    if (recoveryClass === 'file_hash') {
      return this.classifyFileHash(run, call, operationId, approvals);
    }
    return this.classifyReceipt(run, operationId, approvals);
  }

  private async classifyReceipt(
    run: AgentRun,
    operationId: string,
    approvals: AgentApproval[],
  ): Promise<RecoveryDecision> {
    const receipt = await this.findReceipt(operationId);
    if (receipt) {
      return this.finishDecision(run, {
        recoveryClass: 'receipt_backed_mutation',
        action: 'inspect_receipt',
        nextStatus: 'queued',
        incrementEpoch: true,
        operationId,
        interruptionReason: 'receipt_backed_mutation_committed',
        receiptStatus: receipt.status,
        approvals,
      });
    }
    return this.finishDecision(run, {
      recoveryClass: 'receipt_backed_mutation',
      action: 'inspect_receipt',
      nextStatus: 'needs_review',
      incrementEpoch: false,
      operationId,
      interruptionReason: 'receipt_backed_mutation_unknown',
      approvals,
    });
  }

  private async classifyFileHash(
    run: AgentRun,
    call: AgentToolCall | undefined,
    operationId: string,
    approvals: AgentApproval[],
  ): Promise<RecoveryDecision> {
    const observed = (await this.observeFilesystemHash?.(call as AgentToolCall))
      ?? hashesFromArgs(call?.normalizedArgs);
    const hashOutcome = observed
      ? classifyFilesystemOutcome(observed)
      : 'unknown';
    if (hashOutcome === 'unknown') {
      return this.finishDecision(run, {
        recoveryClass: 'file_hash',
        action: 'compare_hashes',
        nextStatus: 'needs_review',
        incrementEpoch: false,
        operationId,
        interruptionReason: 'filesystem_hash_unknown',
        hashOutcome,
        approvals,
      });
    }
    return this.finishDecision(run, {
      recoveryClass: 'file_hash',
      action: 'compare_hashes',
      nextStatus: 'queued',
      incrementEpoch: true,
      operationId,
      interruptionReason: hashOutcome === 'committed'
        ? 'filesystem_hash_committed'
        : 'filesystem_hash_not_applied',
      hashOutcome,
      approvals,
    });
  }

  private async finishDecision(
    run: AgentRun,
    partial: Omit<RecoveryDecision, 'runId' | 'reuseOperationIds' | 'restoreApprovals'>,
  ): Promise<RecoveryDecision> {
    const compatibility = this.verifyCompatibility ? await this.verifyCompatibility(run) : { ok: true };
    if (!compatibility.ok) {
      return {
        runId: run.id,
        recoveryClass: partial.recoveryClass,
        action: 'require_review',
        nextStatus: 'needs_review',
        incrementEpoch: false,
        reuseOperationIds: true,
        restoreApprovals: true,
        operationId: partial.operationId,
        interruptionReason: compatibility.reason ?? 'compatibility',
        receiptStatus: partial.receiptStatus,
        hashOutcome: partial.hashOutcome,
        approvals: partial.approvals,
      };
    }
    return {
      runId: run.id,
      reuseOperationIds: true,
      restoreApprovals: true,
      ...partial,
    };
  }

  private async applyDecision(run: AgentRun, decision: RecoveryDecision): Promise<AgentRun> {
    await this.settleOpenWork(run.id, decision);
    if (decision.nextStatus === run.status && !decision.incrementEpoch) {
      return (await this.repository.getRun(run.id)) ?? run;
    }

    let status = run.status;
    if (decision.nextStatus === 'needs_review') {
      status = this.transitionToNeedsReview(status);
    } else if (decision.nextStatus === 'queued' && decision.incrementEpoch) {
      status = this.transitionToSafeQueue(status);
    } else {
      status = decision.nextStatus;
    }

    const timestamp = this.now();
    const projection: Partial<AgentRun> = {
      status,
      interruptionReason: decision.interruptionReason ?? run.interruptionReason,
      workerOwnerId: undefined,
      workerLeaseExpiresAt: undefined,
    };
    if (decision.incrementEpoch) {
      projection.executionEpoch = run.executionEpoch + 1;
    }
    const eventType = status === 'needs_review'
      ? 'run.status_changed'
      : status === 'queued'
        ? 'run.queued'
        : 'run.interrupted';
    await this.repository.updateRunWithEvent(run.id, projection, eventType, {
      recoveryClass: decision.recoveryClass,
      action: decision.action,
      executionEpoch: projection.executionEpoch ?? run.executionEpoch,
      operationId: decision.operationId,
      restoreApprovals: decision.restoreApprovals,
      reuseOperationIds: decision.reuseOperationIds,
      recoveredAt: timestamp,
    });
    const updated = await this.repository.getRun(run.id);
    if (!updated) throw new Error(`Run ${run.id} was not found after recovery.`);
    return updated;
  }

  private async settleOpenWork(runId: string, decision: RecoveryDecision): Promise<void> {
    const toolAttempts = await this.database.agentToolAttempts.where('runId').equals(runId).toArray();
    const providerAttempts = await this.database.agentProviderAttempts.where('runId').equals(runId).toArray();
    const openTool = latest(toolAttempts.filter((attempt) => OPEN_TOOL.has(attempt.status)));
    const openProvider = latest(providerAttempts.filter((attempt) => OPEN_PROVIDER.has(attempt.status)));
    const finishedAt = this.now();

    if (openTool) {
      const succeeded = decision.hashOutcome === 'committed' || decision.receiptStatus === 'committed';
      await this.repository.completeToolExecution(
        openTool.id,
        succeeded ? 'succeeded' : 'interrupted',
        { errorCode: succeeded ? undefined : 'interrupted', finishedAt },
      );
    }
    if (openProvider) {
      await this.repository.updateProviderAttempt(openProvider.id, {
        status: 'interrupted',
        finishedAt,
        finishReason: decision.interruptionReason,
        safeRetry: decision.nextStatus === 'queued',
      });
    }
  }

  private transitionToNeedsReview(from: AgentRunStatus): AgentRunStatus {
    if (from === 'needs_review') return from;
    if (from === 'cancelling' || from === 'interrupted') {
      return transitionRun(from, 'mutation_outcome_unknown');
    }
    if (from === 'running' || from === 'planning') {
      return transitionRun(transitionRun(from, 'provider_interrupted'), 'mutation_outcome_unknown');
    }
    return 'needs_review';
  }

  private transitionToSafeQueue(from: AgentRunStatus): AgentRunStatus {
    if (from === 'queued') return from;
    if (from === 'running' || from === 'planning') {
      return transitionRun(transitionRun(from, 'provider_interrupted'), 'safe_recovery');
    }
    if (from === 'interrupted') {
      return transitionRun(from, 'safe_recovery');
    }
    if (from === 'paused') return transitionRun(from, 'resume');
    return 'queued';
  }

  private async findReceipt(operationId: string): Promise<AgentOperationReceipt | undefined> {
    const main = await this.repository.getReceipt(operationId);
    if (main) return main;
    if (!this.companion) return undefined;
    return this.companion.agentOperationReceipts.where('operationId').equals(operationId).first();
  }
}
