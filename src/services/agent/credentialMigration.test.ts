import 'fake-indexeddb/auto';

import Dexie, { type Table } from 'dexie';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AIProviderConfig, AppSettings } from '../../types';
import type { Storage } from '../secureStorage';
import {
  CREDENTIAL_MIGRATION_MARKER,
  SEARCH_CREDENTIAL_ACCOUNTS,
  migrateHarnessCredentialsAndPreferences,
  readSearchCredentials,
  type CredentialMigrationDatabase,
} from './credentialMigration';

class MemoryDatabase implements CredentialMigrationDatabase {
  readonly settingRows = new Map<string, AppSettings>();
  readonly providerRows = new Map<string, AIProviderConfig>();

  readonly settings = {
    get: async (key: string) => this.settingRows.get(key),
    put: async (row: AppSettings) => {
      this.settingRows.set(row.key, { ...row });
    },
    delete: async (key: string) => {
      this.settingRows.delete(key);
    },
  };

  readonly providerConfigs = {
    toArray: async () => [...this.providerRows.values()].map((row) => ({ ...row })),
    put: async (row: AIProviderConfig) => {
      this.providerRows.set(row.id, { ...row });
    },
  };
}

class MemorySecureStorage implements Storage {
  readonly values = new Map<string, string>();
  readonly mismatchedAccounts = new Set<string>();

  async secureGet(key: string): Promise<string | null> {
    const value = this.values.get(key) ?? null;
    if (value !== null && this.mismatchedAccounts.has(key)) return `${value}-mismatch`;
    return value;
  }

  async secureSet(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async secureDelete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

class RestartDatabase extends Dexie implements CredentialMigrationDatabase {
  settings!: Table<AppSettings, string>;
  providerConfigs!: Table<AIProviderConfig, string>;

  constructor(name: string) {
    super(name);
    this.version(1).stores({
      settings: 'key',
      providerConfigs: 'id, provider, isActive',
    });
  }
}

function customProvider(credential: string): AIProviderConfig {
  return {
    id: 'custom-one',
    name: 'Custom One',
    provider: 'custom',
    apiKey: credential,
    selectedModel: 'model-one',
    isActive: true,
    baseUrl: 'https://provider.invalid/v1',
    customModels: [],
    status: 'connected',
  };
}

const credentialFixtures = {
  exaKey: 'fixture-exa-value',
  tavilyKey: 'fixture-tavily-value',
  firecrawlKey: 'fixture-firecrawl-value',
  braveKey: 'fixture-brave-value',
} as const;

function seedLegacySearch(database: MemoryDatabase): void {
  for (const [key, value] of Object.entries(credentialFixtures)) {
    database.settingRows.set(key, { key, value });
  }
  database.settingRows.set('enabled', { key: 'enabled', value: true });
  database.settingRows.set('searchProvider', { key: 'searchProvider', value: 'exa' });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('verified harness credential migration', () => {
  it('moves every credential group and deletes legacy values only after matching readback', async () => {
    const database = new MemoryDatabase();
    const storage = new MemorySecureStorage();
    seedLegacySearch(database);
    database.providerRows.set('custom-one', customProvider('fixture-custom-value'));
    storage.values.set('activeProviderId', 'custom-one');
    storage.values.set('appManagementProviderId', 'custom-one');
    storage.values.set('hiddenModels', '["custom-one:model-two"]');

    const result = await migrateHarnessCredentialsAndPreferences(database, storage);

    expect(result).toMatchObject({ completed: true, alreadyCompleted: false });
    expect(result.failedCredentialKinds).toHaveLength(0);
    for (const key of Object.keys(credentialFixtures)) {
      expect(database.settingRows.has(key)).toBe(false);
    }
    expect([...Object.values(SEARCH_CREDENTIAL_ACCOUNTS)].every((key) => storage.values.has(key))).toBe(true);
    expect(database.providerRows.get('custom-one')?.apiKey).toHaveLength(0);
    expect(storage.values.has('providerApiKey_custom-one')).toBe(true);
    expect(database.settingRows.get(CREDENTIAL_MIGRATION_MARKER)?.value).toBe(true);
    expect(storage.values.has('activeProviderId')).toBe(false);
    expect(storage.values.has('appManagementProviderId')).toBe(false);
    expect(storage.values.has('hiddenModels')).toBe(false);
  });

  it('preserves a legacy search value, disables search, and omits the marker on mismatch', async () => {
    const database = new MemoryDatabase();
    const storage = new MemorySecureStorage();
    seedLegacySearch(database);
    storage.mismatchedAccounts.add(SEARCH_CREDENTIAL_ACCOUNTS.exaKey);

    const result = await migrateHarnessCredentialsAndPreferences(database, storage);

    expect(result.completed).toBe(false);
    expect(result.failedCredentialKinds).toContain('exaKey');
    expect(typeof database.settingRows.get('exaKey')?.value).toBe('string');
    expect(database.settingRows.get('enabled')?.value).toBe(false);
    expect(database.settingRows.has(CREDENTIAL_MIGRATION_MARKER)).toBe(false);
  });

  it('retries preserved values and marks completion after storage readback recovers', async () => {
    const database = new MemoryDatabase();
    const storage = new MemorySecureStorage();
    seedLegacySearch(database);
    storage.mismatchedAccounts.add(SEARCH_CREDENTIAL_ACCOUNTS.tavilyKey);

    const first = await migrateHarnessCredentialsAndPreferences(database, storage);
    storage.mismatchedAccounts.clear();
    const second = await migrateHarnessCredentialsAndPreferences(database, storage);

    expect(first.completed).toBe(false);
    expect(second.completed).toBe(true);
    expect(database.settingRows.has('tavilyKey')).toBe(false);
    expect(database.settingRows.get(CREDENTIAL_MIGRATION_MARKER)?.value).toBe(true);
  });

  it('preserves and disables a custom provider when its secure readback mismatches', async () => {
    const database = new MemoryDatabase();
    const storage = new MemorySecureStorage();
    database.providerRows.set('custom-one', customProvider('fixture-custom-value'));
    storage.mismatchedAccounts.add('providerApiKey_custom-one');

    const result = await migrateHarnessCredentialsAndPreferences(database, storage);
    const provider = database.providerRows.get('custom-one');

    expect(result.completed).toBe(false);
    expect(result.failedCredentialKinds).toContain('custom-provider:custom-one');
    expect(provider?.apiKey).toHaveLength('fixture-custom-value'.length);
    expect(provider?.isActive).toBe(false);
    expect(provider?.status).toBe('not_connected');
    expect(database.settingRows.has(CREDENTIAL_MIGRATION_MARKER)).toBe(false);
  });

  it('restores secure credentials and Dexie preferences through a real database restart', async () => {
    const databaseName = `credential-restart-${crypto.randomUUID()}`;
    const durableDatabase = new RestartDatabase(databaseName);
    const durableStorage = new MemorySecureStorage();
    await durableDatabase.settings.bulkPut(
      Object.entries(credentialFixtures).map(([key, value]) => ({ key, value })),
    );
    await durableDatabase.settings.put({ key: 'enabled', value: true });
    durableStorage.values.set('activeProviderId', 'provider-after-restart');
    durableStorage.values.set('hiddenModels', '["provider-after-restart:model-hidden"]');

    await migrateHarnessCredentialsAndPreferences(durableDatabase, durableStorage);
    durableDatabase.close();

    const restartedDatabase = new RestartDatabase(databaseName);
    await restartedDatabase.open();
    const restoredCredentials = await readSearchCredentials(durableStorage);

    expect(Object.values(restoredCredentials).every((value) => value.length > 0)).toBe(true);
    expect((await restartedDatabase.settings.get('activeProviderId'))?.value).toBe('provider-after-restart');
    expect(typeof (await restartedDatabase.settings.get('hiddenModels'))?.value).toBe('string');
    expect(durableStorage.values.has('activeProviderId')).toBe(false);
    expect(durableStorage.values.has('hiddenModels')).toBe(false);

    restartedDatabase.close();
    await Dexie.delete(databaseName);
  });
});
