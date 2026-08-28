import 'fake-indexeddb/auto';

import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TabsCRMFormsDB } from '../../data/crmFormsDb';
import type {
  AgentApproval,
  AgentOperationReceipt,
  AgentProviderAttempt,
  AgentRun,
  AgentToolCall,
} from '../../types/agent';
import { TabsDB } from '../db';
import {
  AgentScheduler,
  SCHEDULER_LEASE_DURATION_MS,
  SCHEDULER_LEASE_RENEWAL_INTERVAL_MS,
  sortQueuedRuns,
} from './agentScheduler';
import { RecoveryManager, classifyToolRecoveryClass } from './recoveryManager';
import { RunRepository } from './runRepository';
import { STARTUP_BARRIER_STEPS, StartupBarrier, type StartupBarrierHooks } from './startupBarrier';

const DATABASE_NAME = 'ZenEditorDB';
const COMPANION_NAME = 'ZenEditorCRMFormsDB';

function runFixture(id: string, overrides: Partial<AgentRun> = {}): AgentRun {
  const timestamp = 1_700_000_000_000;
  return {
    id,
    title: `Run ${id}`,
    goal: 'Scheduler recovery fixture',
    status: 'queued',
    mode: 'guided',
    contextRefs: [],
    providerSnapshot: {
      providerId: 'fixture-provider',
      adapter: 'openai_compatible',
      adapterVersion: '1',
      baseUrl: 'https://provider.invalid/v1',
      modelId: 'fixture-model',
      credentialAccount: 'fixture-account',
      reasoning: 'standard',
      capabilities: {
        streaming: true,
        toolCalling: true,
        vision: false,
        reasoning: false,
        contextWindow: 16_000,
        maxOutputTokens: 2_000,
      },
      contextWindow: 16_000,
      maxOutputTokens: 2_000,
    },
    profileSnapshot: {
      name: 'Fixture',
      description: 'Fixture profile',
      systemInstructions: '',
      defaultMode: 'guided',
      allowedToolGroups: [],
      defaultSkills: [],
    },
    instructionSnapshot: {
      safetyInstructionsHash: 'safe',
      policyHash: 'policy',
      skillHashes: [],
      compiledContent: 'fixture',
      compiledContentHash: 'compiled',
    },
    policySnapshot: { revision: 1, mode: 'guided', rulesHash: 'rules' },
    policyRevision: 1,
    toolRegistryVersion: 'fixture@1',
    toolRegistryHash: 'registry',
    appVersion: 'test',
    nextSequence: 0,
    activeTurn: 1,
    executionEpoch: 0,
    queuePriority: 0,
    pendingInputCount: 0,
    maxTurns: 10,
    maxDurationMs: 60_000,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

function toolCallFixture(
  runId: string,
  toolName: string,
  overrides: Partial<AgentToolCall> = {},
): AgentToolCall {
  return {
    id: `${runId}-tool`,
    runId,
    turn: 1,
    toolIndex: 0,
    providerToolCallId: 'provider-tool-1',
    operationId: `${runId}:t1:tc0`,
    effectFingerprint: 'effect-one',
    toolName,
    toolVersion: '1',
    normalizedArgs: {},
    resourceKeys: ['fixture:one'],
    status: 'executing',
    resultArtifactIds: [],
    createdAt: 1_700_000_000_002,
    ...overrides,
  };
}

function approvalFixture(runId: string, toolCallId: string): AgentApproval {
  return {
    id: `${runId}-approval`,
    runId,
    toolCallId,
    policyRevision: 1,
    risk: 'local_update',
    resourceKeys: ['fixture:one'],
    resourceRevisions: {},
    status: 'pending',
    requestedAt: 30,
    expiresAt: 300_000,
  };
}

function providerAttemptFixture(runId: string): AgentProviderAttempt {
  return {
    id: `${runId}-provider`,
    runId,
    executionEpoch: 0,
    turn: 1,
    attempt: 1,
    status: 'started',
    requestHash: 'request',
    startedAt: 50,
    safeRetry: true,
  };
}

let clock = 1_000;
let database: TabsDB;
let companion: TabsCRMFormsDB;
let repository: RunRepository;
let scheduler: AgentScheduler;
let recovery: RecoveryManager;

function makeScheduler(ownerId: string): AgentScheduler {
  return new AgentScheduler({
    database,
    repository,
    ownerId,
    now: () => clock,
  });
}

async function seedQueued(id: string, overrides: Partial<AgentRun> = {}): Promise<AgentRun> {
  return repository.createRun(runFixture(id, overrides));
}

async function seedOpenTool(input: {
  runId: string;
  status?: AgentRun['status'];
  toolName: string;
  normalizedArgs?: unknown;
  receipt?: AgentOperationReceipt;
  companionReceipt?: AgentOperationReceipt;
}): Promise<AgentToolCall> {
  await repository.createRun(runFixture(input.runId, { status: input.status ?? 'running' }));
  const call = toolCallFixture(input.runId, input.toolName, {
    normalizedArgs: input.normalizedArgs ?? {},
  });
  await repository.addToolCalls([call]);
  await repository.startToolExecution(call.id, 0, 80);
  if (input.receipt) await repository.addReceipt(input.receipt);
  if (input.companionReceipt) await companion.agentOperationReceipts.add(input.companionReceipt);
  await repository.addApproval(approvalFixture(input.runId, call.id));
  return call;
}

beforeEach(async () => {
  clock = 1_000;
  await Dexie.delete(DATABASE_NAME);
  await Dexie.delete(COMPANION_NAME);
  database = new TabsDB();
  companion = new TabsCRMFormsDB();
  await database.open();
  await companion.open();
  repository = new RunRepository(database);
  scheduler = makeScheduler('owner-a');
  recovery = new RecoveryManager({
    database,
    repository,
    companion,
    now: () => clock,
  });
});

afterEach(async () => {
  scheduler.stopRenewalLoop();
  database.close();
  companion.close();
  await Dexie.delete(DATABASE_NAME);
  await Dexie.delete(COMPANION_NAME);
});

describe('one-worker scheduler queue order', () => {
  it('sorts queued runs by descending priority then ascending creation time', async () => {
    await seedQueued('low-late', { queuePriority: 1, createdAt: 30 });
    await seedQueued('high-late', { queuePriority: 5, createdAt: 40 });
    await seedQueued('high-early', { queuePriority: 5, createdAt: 10 });
    await seedQueued('mid', { queuePriority: 3, createdAt: 20 });

    const ordered = await scheduler.listQueued();
    expect(ordered.map((run) => run.id)).toEqual(['high-early', 'high-late', 'mid', 'low-late']);
    expect(sortQueuedRuns(ordered).map((run) => run.id)).toEqual([
      'high-early',
      'high-late',
      'mid',
      'low-late',
    ]);
  });

  it('claims the highest-priority oldest queued run after the lease is acquired', async () => {
    await seedQueued('second', { queuePriority: 1, createdAt: 10 });
    await seedQueued('first', { queuePriority: 2, createdAt: 20 });
    expect(await scheduler.claimNext()).toBeUndefined();

    await scheduler.acquireLease();
    const claimed = await scheduler.claimNext();
    expect(claimed?.run.id).toBe('first');
    expect(claimed?.lease.ownerId).toBe('owner-a');
    expect(claimed?.lease.expiresAt).toBe(clock + SCHEDULER_LEASE_DURATION_MS);

    expect(await scheduler.claimNext()).toBeUndefined();
    await repository.updateRunWithEvent('first', { status: 'completed' }, 'run.completed', {});
    await scheduler.releaseClaim('first');
    const second = await scheduler.claimNext();
    expect(second?.run.id).toBe('second');
  });

  it('moves a queued run to the front with maximum priority plus one', async () => {
    await seedQueued('a', { queuePriority: 4 });
    await seedQueued('b', { queuePriority: 7 });
    const priority = await scheduler.prioritize('a');
    expect(priority).toBe(8);
    expect((await scheduler.listQueued())[0]?.id).toBe('a');
  });
});

describe('durable worker lease', () => {
  it('transfers the scheduler lease only after the prior lease expires', async () => {
    const other = makeScheduler('owner-b');
    expect((await scheduler.acquireLease())?.ownerId).toBe('owner-a');
    expect(await other.acquireLease()).toBeUndefined();

    clock = 1_000 + SCHEDULER_LEASE_DURATION_MS - 1;
    expect(await other.acquireLease()).toBeUndefined();

    clock = 1_000 + SCHEDULER_LEASE_DURATION_MS;
    expect((await other.acquireLease())?.ownerId).toBe('owner-b');
    expect((await other.getLease())?.mode).toBe('active');
  });

  it('transfers a run-level claim only after the previous owner lease expires', async () => {
    await seedQueued('lease-run');
    await scheduler.acquireLease();
    expect((await scheduler.claimNext())?.run.workerOwnerId).toBe('owner-a');

    const other = makeScheduler('owner-b');
    clock = 1_000 + SCHEDULER_LEASE_DURATION_MS + 1;
    await repository.updateRunWithEvent('lease-run', { status: 'queued' }, 'run.queued', {});
    await other.acquireLease();
    const transferred = await other.claimNext();
    expect(transferred?.run.workerOwnerId).toBe('owner-b');
    expect(transferred?.lease.ownerId).toBe('owner-b');
  });

  it('renews for 15000ms on the 5000ms interval and preserves quiescing mode', async () => {
    expect(SCHEDULER_LEASE_DURATION_MS).toBe(15000);
    expect(SCHEDULER_LEASE_RENEWAL_INTERVAL_MS).toBe(5000);
    await scheduler.acquireLease();
    const quiescing = await scheduler.beginQuiescing('shutdown', 'req-1');
    expect(quiescing?.mode).toBe('quiescing');
    clock = 4_000;
    expect(await scheduler.renewLease()).toBe(true);
    expect((await scheduler.getLease())?.mode).toBe('quiescing');
    expect((await scheduler.getLease())?.expiresAt).toBe(clock + 15000);
    expect((await scheduler.getLease())?.requestId).toBe('req-1');
  });

  it('blocks new claims, provider turns, and tool starts while quiescing', async () => {
    await seedQueued('blocked');
    await scheduler.acquireLease();
    await scheduler.beginQuiescing('update', 'req-2');

    expect(await scheduler.allowsClaim()).toBe(false);
    expect(await scheduler.allowsProviderTurn()).toBe(false);
    expect(await scheduler.allowsToolStart()).toBe(false);
    expect(await scheduler.claimNext()).toBeUndefined();

    await scheduler.endQuiescing();
    expect(await scheduler.allowsProviderTurn()).toBe(true);
    expect(await scheduler.allowsToolStart()).toBe(true);
    expect((await scheduler.claimNext())?.run.id).toBe('blocked');
  });

  it('stops claiming while the runtime is paused', async () => {
    await seedQueued('paused-claim');
    await scheduler.acquireLease();
    scheduler.pauseRuntime();
    expect(await scheduler.claimNext()).toBeUndefined();
    scheduler.resumeRuntime();
    expect((await scheduler.claimNext())?.run.id).toBe('paused-claim');
  });
});

describe('startup recovery matrix', () => {
  it('keeps queued runs queued without incrementing the epoch', async () => {
    await seedQueued('still-queued');
    const { run, decision } = await recovery.recoverRun('still-queued');
    expect(decision.recoveryClass).toBe('queued');
    expect(decision.action).toBe('keep_queued');
    expect(run.status).toBe('queued');
    expect(run.executionEpoch).toBe(0);
  });

  it('restores pending approvals for waiting runs', async () => {
    await repository.createRun(runFixture('waiting', { status: 'awaiting_approval' }));
    const call = toolCallFixture('waiting', 'task_create', { status: 'awaiting_approval' });
    await repository.addToolCalls([call]);
    await repository.addApproval(approvalFixture('waiting', call.id));

    const { run, decision } = await recovery.recoverRun('waiting');
    expect(decision.recoveryClass).toBe('awaiting_approval');
    expect(decision.action).toBe('restore_approval');
    expect(decision.restoreApprovals).toBe(true);
    expect(decision.approvals).toHaveLength(1);
    expect(decision.approvals[0]?.status).toBe('pending');
    expect(run.status).toBe('awaiting_approval');
    expect(run.policyRevision).toBe(1);
    expect(run.executionEpoch).toBe(0);
  });

  it('retries a started provider request safely and reuses the logical operation id', async () => {
    await repository.createRun(runFixture('provider-run', { status: 'running' }));
    await database.agentProviderAttempts.add(providerAttemptFixture('provider-run'));
    const call = toolCallFixture('provider-run', 'task_create', { status: 'requested' });
    await repository.addToolCalls([call]);
    await repository.addApproval(approvalFixture('provider-run', call.id));

    const { run, decision } = await recovery.recoverRun('provider-run');
    expect(decision.recoveryClass).toBe('provider');
    expect(decision.action).toBe('interrupt_then_retry_safely');
    expect(run.status).toBe('queued');
    expect(run.executionEpoch).toBe(1);
    expect(decision.reuseOperationIds).toBe(true);
    expect((await repository.getToolCallByOperationId(call.operationId))?.operationId).toBe(call.operationId);
    expect((await database.agentApprovals.get('provider-run-approval'))?.status).toBe('pending');

    const recoveredAttempt = await repository.recoverToolExecution(call.id, run.executionEpoch);
    expect(recoveredAttempt.operationId).toBe(call.operationId);
    expect(recoveredAttempt.executionEpoch).toBe(1);
  });

  it('retries a started read tool safely', async () => {
    const call = await seedOpenTool({ runId: 'read-run', toolName: 'document_read' });
    const { run, decision } = await recovery.recoverRun('read-run');
    expect(classifyToolRecoveryClass({ toolName: 'document_read' })).toBe('read');
    expect(decision.recoveryClass).toBe('read');
    expect(decision.action).toBe('interrupt_then_retry_safely');
    expect(run.status).toBe('queued');
    expect(run.executionEpoch).toBe(1);
    expect(decision.operationId).toBe(call.operationId);
    expect((await database.agentApprovals.get('read-run-approval'))?.status).toBe('pending');
  });

  it('inspects a main-database receipt and continues after a committed mutation', async () => {
    const call = await seedOpenTool({
      runId: 'receipt-run',
      toolName: 'task_create',
      receipt: {
        id: 'receipt-run-receipt',
        operationId: 'receipt-run:t1:tc0',
        effectFingerprint: 'effect-one',
        domain: 'tasks',
        resourceKeys: ['fixture:one'],
        status: 'committed',
        resultSummary: 'created',
        committedAt: 90,
      },
    });
    const { run, decision } = await recovery.recoverRun('receipt-run');
    expect(decision.recoveryClass).toBe('receipt_backed_mutation');
    expect(decision.action).toBe('inspect_receipt');
    expect(decision.receiptStatus).toBe('committed');
    expect(run.status).toBe('queued');
    expect(run.executionEpoch).toBe(1);
    expect(decision.operationId).toBe(call.operationId);
  });

  it('requires review when a receipt-backed mutation has no receipt', async () => {
    await seedOpenTool({ runId: 'missing-receipt', toolName: 'task_update' });
    const { run, decision } = await recovery.recoverRun('missing-receipt');
    expect(decision.recoveryClass).toBe('receipt_backed_mutation');
    expect(decision.nextStatus).toBe('needs_review');
    expect(run.status).toBe('needs_review');
    expect(run.executionEpoch).toBe(0);
  });

  it('inspects a companion receipt after an interrupted CRM mutation', async () => {
    await seedOpenTool({
      runId: 'crm-run',
      toolName: 'crm_contact_create',
      companionReceipt: {
        id: 'crm-run-receipt',
        operationId: 'crm-run:t1:tc0',
        effectFingerprint: 'effect-one',
        domain: 'crm',
        resourceKeys: ['fixture:one'],
        status: 'committed',
        resultSummary: 'created',
        committedAt: 90,
      },
    });
    const { run, decision } = await recovery.recoverRun('crm-run');
    expect(decision.receiptStatus).toBe('committed');
    expect(run.status).toBe('queued');
    expect(run.executionEpoch).toBe(1);
  });

  it('compares filesystem hashes and retries when the write was not applied', async () => {
    const call = await seedOpenTool({
      runId: 'file-run',
      toolName: 'file_write',
      normalizedArgs: {
        expectedInputHash: 'in-1',
        expectedOutputHash: 'out-1',
        observedHash: 'in-1',
      },
    });
    const { run, decision } = await recovery.recoverRun('file-run');
    expect(decision.recoveryClass).toBe('file_hash');
    expect(decision.action).toBe('compare_hashes');
    expect(decision.hashOutcome).toBe('not_applied');
    expect(run.status).toBe('queued');
    expect(run.executionEpoch).toBe(1);
    expect(decision.operationId).toBe(call.operationId);
  });

  it('requires review when the filesystem hash is unknown', async () => {
    await seedOpenTool({
      runId: 'file-unknown',
      toolName: 'file_write',
      normalizedArgs: {
        expectedInputHash: 'in-1',
        expectedOutputHash: 'out-1',
        observedHash: 'other',
      },
    });
    const { run, decision } = await recovery.recoverRun('file-unknown');
    expect(decision.hashOutcome).toBe('unknown');
    expect(run.status).toBe('needs_review');
    expect(run.executionEpoch).toBe(0);
  });

  it('requires review for an interrupted shell command and never auto-retries', async () => {
    const call = await seedOpenTool({ runId: 'shell-run', toolName: 'shell_exec' });
    const { run, decision } = await recovery.recoverRun('shell-run');
    expect(decision.recoveryClass).toBe('shell');
    expect(decision.action).toBe('require_review');
    expect(run.status).toBe('needs_review');
    expect(run.executionEpoch).toBe(0);
    expect(decision.operationId).toBe(call.operationId);
  });

  it('requires review for an interrupted external write', async () => {
    await seedOpenTool({ runId: 'external-run', toolName: 'web_post_external' });
    const { run, decision } = await recovery.recoverRun('external-run');
    expect(decision.recoveryClass).toBe('external_write');
    expect(decision.action).toBe('require_review');
    expect(run.status).toBe('needs_review');
    expect(run.executionEpoch).toBe(0);
  });
});

describe('offline resume and restart compatibility', () => {
  it('resumes after offline stream failure without resetting policy or approvals', async () => {
    await repository.createRun(runFixture('offline-run', { status: 'running', policyRevision: 4 }));
    await database.agentProviderAttempts.add(providerAttemptFixture('offline-run'));
    const call = toolCallFixture('offline-run', 'task_create', { status: 'requested' });
    await repository.addToolCalls([call]);
    await repository.addApproval(approvalFixture('offline-run', call.id));

    const { run, decision } = await recovery.resumeAfterOffline('offline-run', 'network_loss');
    expect(decision.recoveryClass).toBe('provider');
    expect(run.status).toBe('queued');
    expect(run.executionEpoch).toBe(1);
    expect(run.policyRevision).toBe(4);
    expect(run.interruptionReason).toBe('network_loss');
    expect((await database.agentApprovals.get('offline-run-approval'))?.status).toBe('pending');
  });

  it('discards an expired quiescing lease on restart and then claims work', async () => {
    await seedQueued('restart-run');
    await scheduler.acquireLease();
    await scheduler.beginQuiescing('shutdown', 'shutdown-1');
    expect(await scheduler.claimNext()).toBeUndefined();

    clock = 1_000 + SCHEDULER_LEASE_DURATION_MS + 5;
    const restarted = makeScheduler('owner-restart');
    expect(await restarted.discardExpiredQuiescingLease()).toBe(true);
    expect(await restarted.getLease()).toBeUndefined();
    await restarted.acquireLease();
    expect((await restarted.claimNext())?.run.id).toBe('restart-run');
  });

  it('runs the exact eight-step startup barrier and forbids claims before step seven', async () => {
    expect(STARTUP_BARRIER_STEPS).toHaveLength(8);
    await seedQueued('barrier-run');
    const seen: string[] = [];
    let claimsBeforeLease = 0;

    const hooks: StartupBarrierHooks = {
      async openAndMigrateDatabases() {
        seen.push('open_and_migrate_databases');
      },
      async completeCredentialMigrations() {
        seen.push('complete_credential_migrations');
      },
      async loadApplicationState() {
        seen.push('load_application_state');
      },
      async registerDomainEventSubscribers() {
        seen.push('register_domain_event_subscribers');
      },
      async reregisterNativeWorkspaceScopes() {
        seen.push('reregister_native_workspace_scopes');
      },
      async runRecoveryClassification() {
        seen.push('run_recovery_classification');
        if (await scheduler.claimNext()) claimsBeforeLease += 1;
        await recovery.recoverAll();
      },
      async acquireSchedulerLease() {
        seen.push('acquire_scheduler_lease');
        await scheduler.acquireLease();
      },
      async markHarnessClientReady() {
        seen.push('mark_harness_client_ready');
      },
    };

    const barrier = new StartupBarrier({ hooks });
    expect(barrier.canSchedulerClaim).toBe(false);
    const result = await barrier.run();

    expect(result.completedSteps).toEqual([...STARTUP_BARRIER_STEPS]);
    expect(seen).toEqual([...STARTUP_BARRIER_STEPS]);
    expect(claimsBeforeLease).toBe(0);
    expect(result.schedulerMayClaim).toBe(true);
    expect(result.ready).toBe(true);
    expect((await scheduler.claimNext())?.run.id).toBe('barrier-run');
  });
});
