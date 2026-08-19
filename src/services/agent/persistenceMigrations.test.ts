import 'fake-indexeddb/auto';

import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TabsCRMFormsDB, crmFormsDb } from '../../data/crmFormsDb';
import { TabsDB, db } from '../db';

const MAIN_DB_NAME = 'ZenEditorDB';
const COMPANION_DB_NAME = 'ZenEditorCRMFormsDB';

const MAIN_V12_STORES = {
  workspaces: 'id, name, updatedAt, order',
  chatMessages: 'id, threadId, mode, agentId, timestamp, settingsTab, workspaceId',
  chatThreads: 'id, mode, updatedAt, workspaceId, taskId, settingsTab',
  agents: 'id, name, isDefault, scope',
  providerConfigs: 'id, provider, isActive',
  settings: 'key',
  quickPrompts: 'id, createdAt, scope, groupId, order',
  actionGroups: 'id, scope, order',
  tasks: 'id, title, updatedAt, order, projectId, status, parentId',
  projects: 'id, name',
  taskComments: 'id, taskId, createdAt',
  taskAIChangeBatches: 'id, taskId, createdAt, expiresAt',
};

const COMPANION_V1_STORES = {
  crmLeads: 'id, status, stage, contactId, companyId, ownerId, source, sourceFormId, createdAt, updatedAt, lastActivityAt',
  crmContacts: 'id, email, companyId, createdAt, updatedAt, lastActivityAt',
  crmCompanies: 'id, name, industry, ownerId, createdAt, updatedAt, lastActivityAt',
  crmDeals: 'id, stage, leadId, contactId, companyId, ownerId, createdAt, updatedAt',
  crmActivities: 'id, type, leadId, contactId, companyId, dealId, formId, submissionId, taskId, createdAt',
  crmNotes: 'id, leadId, contactId, companyId, dealId, createdAt, updatedAt',
  crmTaskLinks: 'id, taskId, leadId, contactId, companyId, dealId, createdAt',
  crmSavedViews: 'id, entity, isDefault, createdAt, updatedAt',
  crmPipelineStages: 'id, key, order',
  forms: 'id, status, name, createdAt, updatedAt',
  formSubmissions: 'id, formId, status, sourceDomain, leadId, contactId, companyId, createdAt',
  formTemplates: 'id, name, category, createdAt, updatedAt',
  formWebhooks: 'id, formId, enabled, createdAt, updatedAt',
  crmSettings: 'key',
};

const MAIN_RETAINED_TABLES = Object.keys(MAIN_V12_STORES);
const MAIN_HARNESS_TABLES = [
  'agentRuns',
  'agentEvents',
  'agentMessages',
  'agentProviderAttempts',
  'agentToolCalls',
  'agentToolAttempts',
  'agentApprovals',
  'agentPolicyGrants',
  'agentArtifacts',
  'agentProfiles',
  'agentOperationReceipts',
  'agentRuntimeLeases',
  'taskProjectionJobs',
];
const COMPANION_RETAINED_TABLES = Object.keys(COMPANION_V1_STORES);

async function resetDatabases(): Promise<void> {
  db.close();
  crmFormsDb.close();
  await Dexie.delete(MAIN_DB_NAME);
  await Dexie.delete(COMPANION_DB_NAME);
}

async function seedLegacyMain(): Promise<void> {
  const legacy = new Dexie(MAIN_DB_NAME);
  legacy.version(12).stores(MAIN_V12_STORES);
  await legacy.open();
  await legacy.transaction('rw', legacy.tables, async () => {
    for (const tableName of MAIN_RETAINED_TABLES) {
      const primaryKey = tableName === 'settings' ? 'key' : 'id';
      await legacy.table(tableName).add({ [primaryKey]: `retained-${tableName}` });
    }
  });
  legacy.close();
}

async function seedLegacyCompanion(): Promise<void> {
  const legacy = new Dexie(COMPANION_DB_NAME);
  legacy.version(1).stores(COMPANION_V1_STORES);
  await legacy.open();
  await legacy.transaction('rw', legacy.tables, async () => {
    for (const tableName of COMPANION_RETAINED_TABLES) {
      const primaryKey = tableName === 'crmSettings' ? 'key' : 'id';
      await legacy.table(tableName).add({ [primaryKey]: `retained-${tableName}` });
    }
  });
  legacy.close();
}

async function expectUnique(
  database: Dexie,
  tableName: string,
  first: Record<string, unknown>,
  duplicate: Record<string, unknown>,
): Promise<void> {
  await database.table(tableName).add(first);
  await expect(database.table(tableName).add(duplicate)).rejects.toMatchObject({
    name: 'ConstraintError',
  });
}

beforeEach(resetDatabases);
afterEach(resetDatabases);

describe('main database version 12 to 13', () => {
  it('adds the exact harness stores without adding version 14 or dropping retained data', async () => {
    await seedLegacyMain();

    const migrated = new TabsDB();
    await migrated.open();

    expect(migrated.verno).toBe(13);
    expect(migrated.tables.map((table) => table.name).sort()).toEqual(
      [...MAIN_RETAINED_TABLES, ...MAIN_HARNESS_TABLES].sort(),
    );
    for (const tableName of MAIN_RETAINED_TABLES) {
      expect(await migrated.table(tableName).count(), tableName).toBe(1);
    }
    for (const tableName of MAIN_HARNESS_TABLES) {
      expect(await migrated.table(tableName).count(), tableName).toBe(0);
    }

    migrated.close();
  });

  it('enforces every required unique harness index', async () => {
    await seedLegacyMain();
    const migrated = new TabsDB();
    await migrated.open();

    await expectUnique(
      migrated,
      'agentEvents',
      { id: 'event-1', runId: 'run-1', sequence: 1 },
      { id: 'event-2', runId: 'run-1', sequence: 1 },
    );
    await expectUnique(
      migrated,
      'agentMessages',
      { id: 'message-1', runId: 'run-1', messageIndex: 1 },
      { id: 'message-2', runId: 'run-1', messageIndex: 1 },
    );
    await expectUnique(
      migrated,
      'agentProviderAttempts',
      { id: 'provider-1', runId: 'run-1', executionEpoch: 2, turn: 3, attempt: 1 },
      { id: 'provider-2', runId: 'run-1', executionEpoch: 2, turn: 3, attempt: 1 },
    );
    await expectUnique(
      migrated,
      'agentToolCalls',
      { id: 'call-1', operationId: 'run-1:t3:tc0' },
      { id: 'call-2', operationId: 'run-1:t3:tc0' },
    );
    await expectUnique(
      migrated,
      'agentToolAttempts',
      { id: 'attempt-1', toolCallId: 'call-1', executionEpoch: 2, attempt: 1 },
      { id: 'attempt-2', toolCallId: 'call-1', executionEpoch: 2, attempt: 1 },
    );
    await expectUnique(
      migrated,
      'agentOperationReceipts',
      { id: 'receipt-1', operationId: 'operation-1' },
      { id: 'receipt-2', operationId: 'operation-1' },
    );
    await expectUnique(
      migrated,
      'taskProjectionJobs',
      { id: 'job-1', sourceOperationId: 'operation-1', projectionKey: 'task:1' },
      { id: 'job-2', sourceOperationId: 'operation-1', projectionKey: 'task:1' },
    );

    migrated.close();
  });

  it('rolls back harness and retained-table writes in one failed transaction', async () => {
    await seedLegacyMain();
    const migrated = new TabsDB();
    await migrated.open();

    await expect(
      migrated.transaction(
        'rw',
        migrated.settings,
        migrated.agentEvents,
        async () => {
          await migrated.settings.put({ key: 'rollback-setting', value: true });
          await migrated.agentEvents.add({
            id: 'rollback-event',
            runId: 'run-rollback',
            sequence: 1,
            type: 'run.created',
            data: {},
            createdAt: 1,
          });
          throw new Error('force rollback');
        },
      ),
    ).rejects.toThrow('force rollback');

    expect(await migrated.settings.get('rollback-setting')).toBeUndefined();
    expect(await migrated.agentEvents.get('rollback-event')).toBeUndefined();
    expect(await migrated.settings.get('retained-settings')).toBeDefined();

    migrated.close();
  });
});

describe('companion database version 1 to 2', () => {
  it('adds only operation receipts and retains every version 1 table and row', async () => {
    await seedLegacyCompanion();

    const migrated = new TabsCRMFormsDB();
    await migrated.open();

    expect(migrated.verno).toBe(2);
    expect(migrated.tables.map((table) => table.name).sort()).toEqual(
      [...COMPANION_RETAINED_TABLES, 'agentOperationReceipts'].sort(),
    );
    for (const tableName of COMPANION_RETAINED_TABLES) {
      expect(await migrated.table(tableName).count(), tableName).toBe(1);
    }
    expect(await migrated.agentOperationReceipts.count()).toBe(0);

    migrated.close();
  });

  it('enforces unique operation receipts', async () => {
    await seedLegacyCompanion();
    const migrated = new TabsCRMFormsDB();
    await migrated.open();

    await expectUnique(
      migrated,
      'agentOperationReceipts',
      { id: 'receipt-1', operationId: 'crm-operation-1' },
      { id: 'receipt-2', operationId: 'crm-operation-1' },
    );

    migrated.close();
  });
});
