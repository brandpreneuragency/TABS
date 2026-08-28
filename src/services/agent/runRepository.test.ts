import 'fake-indexeddb/auto';

import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentApproval,
  AgentMessage,
  AgentOperationReceipt,
  AgentPolicyGrant,
  AgentProviderAttempt,
  AgentRun,
  AgentToolCall,
} from '../../types/agent';
import { TabsDB } from '../db';
import { ArtifactStore } from './artifactStore';
import { RunRepository } from './runRepository';

const DATABASE_NAME = 'ZenEditorDB';

function runFixture(id: string, status: AgentRun['status'] = 'queued'): AgentRun {
  const timestamp = 1_700_000_000_000;
  return {
    id,
    title: `Run ${id}`,
    goal: 'Verify durable run persistence',
    status,
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
    activeTurn: 0,
    executionEpoch: 0,
    queuePriority: 0,
    pendingInputCount: 0,
    maxTurns: 10,
    maxDurationMs: 60_000,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function messageFixture(runId: string): AgentMessage {
  return {
    id: `${runId}-message`,
    runId,
    messageIndex: 0,
    turn: 0,
    role: 'assistant',
    content: '',
    state: 'pending',
    streamVersion: 0,
    createdAt: 1_700_000_000_001,
  };
}

function toolCallFixture(runId: string): AgentToolCall {
  return {
    id: `${runId}-tool`,
    runId,
    turn: 1,
    toolIndex: 0,
    providerToolCallId: 'provider-tool-1',
    operationId: `${runId}:t1:tc0`,
    effectFingerprint: 'effect-one',
    toolName: 'fixture.read',
    toolVersion: '1',
    normalizedArgs: {},
    resourceKeys: ['fixture:one'],
    status: 'requested',
    resultArtifactIds: [],
    createdAt: 1_700_000_000_002,
  };
}

async function durableReloadFixture(database: TabsDB): Promise<void> {
  const repository = new RunRepository(database);
  await repository.createRun(runFixture('reload-run'), { source: 'reload-fixture' });
  await repository.appendEvent('reload-run', 'run.queued', { durable: true }, { queuePriority: 4 });
  await new ArtifactStore(database).putArtifact({
    id: 'reload-artifact',
    runId: 'reload-run',
    kind: 'report',
    label: 'Reload report',
    content: 'survives reload',
  });
}

let database: TabsDB;
let repository: RunRepository;

beforeEach(async () => {
  await Dexie.delete(DATABASE_NAME);
  database = new TabsDB();
  await database.open();
  repository = new RunRepository(database);
});

afterEach(async () => {
  vi.restoreAllMocks();
  database.close();
  await Dexie.delete(DATABASE_NAME);
});

describe('RunRepository with real Dexie', () => {
  it('reloads the durableReloadFixture with events, projection, and artifact payload intact', async () => {
    await durableReloadFixture(database);
    database.close();

    database = new TabsDB();
    await database.open();
    repository = new RunRepository(database);

    const run = await repository.getRun('reload-run');
    const events = await repository.getEvents('reload-run');
    const artifact = await new ArtifactStore(database).getArtifactText('reload-artifact');

    expect(run?.queuePriority).toBe(4);
    expect(run?.nextSequence).toBe(3);
    expect(events.map((event) => event.sequence)).toEqual([0, 1, 2]);
    expect(artifact).toBe('survives reload');
  });

  it('rolls back a projection update when its event append fails', async () => {
    await repository.createRun(runFixture('rollback-run'));
    vi.spyOn(database.agentEvents, 'add').mockRejectedValueOnce(new Error('forced event failure'));

    await expect(repository.updateRunWithEvent(
      'rollback-run',
      { status: 'running' },
      'run.status_changed',
      { status: 'running' },
    )).rejects.toThrow('forced event failure');

    expect((await repository.getRun('rollback-run'))?.status).toBe('queued');
    expect((await repository.getRun('rollback-run'))?.nextSequence).toBe(1);
    expect(await repository.getEvents('rollback-run')).toHaveLength(1);
  });

  it('allocates unique contiguous run-local sequences under concurrent appends', async () => {
    await repository.createRun(runFixture('sequence-run'));

    await Promise.all(Array.from({ length: 24 }, (_, index) =>
      repository.appendEvent('sequence-run', 'plan.updated', { index }),
    ));

    const events = await repository.getEvents('sequence-run');
    expect(events.map((event) => event.sequence)).toEqual(Array.from({ length: 25 }, (_, index) => index));
    expect(new Set(events.map((event) => event.sequence)).size).toBe(25);
  });

  it('transfers a worker lease only after the previous owner lease expires', async () => {
    await repository.createRun(runFixture('lease-run'));

    expect((await repository.claimRun('lease-run', 'owner-a', 200, 100))?.lease.ownerId).toBe('owner-a');
    expect(await repository.claimRun('lease-run', 'owner-b', 300, 150)).toBeUndefined();
    expect((await repository.claimRun('lease-run', 'owner-b', 400, 201))?.lease.ownerId).toBe('owner-b');
    expect((await repository.getRun('lease-run'))?.workerOwnerId).toBe('owner-b');
  });

  it('rejects stale and post-final stream checkpoints', async () => {
    await repository.createRun(runFixture('checkpoint-run'));
    await repository.addMessage(messageFixture('checkpoint-run'));

    expect(await repository.checkpointMessage('checkpoint-run-message', 2, 'newer')).toBe(true);
    expect(await repository.checkpointMessage('checkpoint-run-message', 1, 'stale')).toBe(false);
    expect(await repository.finalizeMessage('checkpoint-run-message', 1, 'stale final')).toBe(false);
    expect(await repository.finalizeMessage('checkpoint-run-message', 3, 'final')).toBe(true);
    expect(await repository.checkpointMessage('checkpoint-run-message', 4, 'late')).toBe(false);

    const stored = await database.agentMessages.get('checkpoint-run-message');
    expect(stored).toMatchObject({ content: 'final', streamVersion: 3, state: 'complete' });
  });

  it('creates a fresh recovery attempt with the same logical operation ID', async () => {
    await repository.createRun(runFixture('recovery-run'));
    const call = toolCallFixture('recovery-run');
    await repository.addToolCalls([call]);

    const first = await repository.startToolExecution(call.id, 1, 100);
    await repository.completeToolExecution(first.id, 'interrupted', { finishedAt: 110 });
    const recovered = await repository.recoverToolExecution(call.id, 2);

    expect(recovered.id).not.toBe(first.id);
    expect(recovered.operationId).toBe(first.operationId);
    expect(recovered.executionEpoch).toBe(2);
    expect(recovered.attempt).toBe(2);
  });

  it('cleans all run-owned records while retaining committed domain receipts', async () => {
    const runId = 'cleanup-run';
    await repository.createRun(runFixture(runId, 'completed'));
    await repository.addMessage(messageFixture(runId));

    const providerAttempt: AgentProviderAttempt = {
      id: 'cleanup-provider',
      runId,
      executionEpoch: 0,
      turn: 1,
      attempt: 1,
      status: 'completed',
      requestHash: 'request',
      startedAt: 10,
      finishedAt: 20,
      safeRetry: true,
    };
    await database.agentProviderAttempts.add(providerAttempt);

    const call = toolCallFixture(runId);
    await repository.addToolCalls([call]);
    const execution = await repository.startToolExecution(call.id, 0, 30);
    await repository.completeToolExecution(execution.id, 'succeeded', { finishedAt: 40 });

    const approval: AgentApproval = {
      id: 'cleanup-approval',
      runId,
      toolCallId: call.id,
      policyRevision: 1,
      risk: 'local_read',
      resourceKeys: call.resourceKeys,
      resourceRevisions: {},
      status: 'pending',
      requestedAt: 30,
      expiresAt: 300,
    };
    await repository.addApproval(approval);

    const grant: AgentPolicyGrant = {
      id: 'cleanup-grant',
      runId,
      policyRevision: 1,
      toolName: call.toolName,
      toolVersion: call.toolVersion,
      resourcePatterns: call.resourceKeys,
      argumentConstraints: {},
      resourceRevisions: {},
      maxUses: 1,
      usedCount: 0,
      expiresAt: 300,
    };
    await repository.addGrant(grant);

    await new ArtifactStore(database).putArtifact({
      id: 'cleanup-artifact',
      runId,
      kind: 'tool_output',
      label: 'Cleanup artifact',
      content: 'artifact payload',
    });

    const receipt: AgentOperationReceipt = {
      id: 'cleanup-receipt',
      operationId: call.operationId,
      effectFingerprint: call.effectFingerprint,
      domain: 'tasks',
      resourceKeys: call.resourceKeys,
      status: 'committed',
      resultSummary: 'committed once',
      committedAt: 40,
    };
    await repository.addReceipt(receipt);

    const result = await repository.deleteRun(runId);

    expect(result).toMatchObject({
      messages: 1,
      providerAttempts: 1,
      toolCalls: 1,
      toolAttempts: 1,
      approvals: 1,
      grants: 1,
      artifacts: 1,
      receiptsRetained: 1,
    });
    expect(await repository.getRun(runId)).toBeUndefined();
    expect(await database.agentEvents.where('runId').equals(runId).count()).toBe(0);
    expect(await repository.getReceipt(call.operationId)).toEqual(receipt);
  });
});
