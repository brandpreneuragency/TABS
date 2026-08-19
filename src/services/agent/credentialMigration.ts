import type { AIProviderConfig, AppSettings, SearchConfig } from '../../types';
import { db } from '../db';
import { secureStorage, type Storage } from '../secureStorage';

export const CREDENTIAL_MIGRATION_MARKER = 'harnessCredentialMigrationV1';

export const SEARCH_CREDENTIAL_ACCOUNTS = {
  exaKey: 'searchApiKey_exa',
  tavilyKey: 'searchApiKey_tavily',
  firecrawlKey: 'searchApiKey_firecrawl',
  braveKey: 'searchApiKey_brave',
} as const;

export const PREFERENCE_KEYS = [
  'activeProviderId',
  'appManagementProviderId',
  'hiddenModels',
] as const;

type SearchCredentialKey = keyof typeof SEARCH_CREDENTIAL_ACCOUNTS;
type PreferenceKey = (typeof PREFERENCE_KEYS)[number];

interface SettingsTable {
  get(key: string): Promise<AppSettings | undefined>;
  put(value: AppSettings): Promise<unknown>;
  delete(key: string): Promise<void>;
}

interface ProviderConfigsTable {
  toArray(): Promise<AIProviderConfig[]>;
  put(value: AIProviderConfig): Promise<unknown>;
}

export interface CredentialMigrationDatabase {
  settings: SettingsTable;
  providerConfigs: ProviderConfigsTable;
}

export interface CredentialMigrationResult {
  completed: boolean;
  alreadyCompleted: boolean;
  failedCredentialKinds: string[];
  failedPreferenceKeys: PreferenceKey[];
}

export interface SearchCredentials {
  exaKey: string;
  tavilyKey: string;
  firecrawlKey: string;
  braveKey: string;
}

function providerApiKeyAccount(providerId: string): string {
  return `providerApiKey_${providerId}`;
}

function nonEmptyString(value: AppSettings['value'] | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

async function writeAndVerifySecure(
  storage: Storage,
  account: string,
  value: string,
): Promise<boolean> {
  try {
    await storage.secureSet(account, value);
    return (await storage.secureGet(account)) === value;
  } catch {
    return false;
  }
}

async function disableSearch(database: CredentialMigrationDatabase): Promise<void> {
  await database.settings.put({ key: 'enabled', value: false });
}

async function migrateSearchCredentials(
  database: CredentialMigrationDatabase,
  storage: Storage,
  failures: string[],
): Promise<void> {
  for (const [legacyKey, account] of Object.entries(SEARCH_CREDENTIAL_ACCOUNTS) as Array<
    [SearchCredentialKey, string]
  >) {
    const legacyRow = await database.settings.get(legacyKey);
    const legacyValue = nonEmptyString(legacyRow?.value);
    if (legacyValue === null) continue;

    if (await writeAndVerifySecure(storage, account, legacyValue)) {
      await database.settings.delete(legacyKey);
      continue;
    }

    failures.push(legacyKey);
    await disableSearch(database);
  }
}

async function migrateCustomProviderCredentials(
  database: CredentialMigrationDatabase,
  storage: Storage,
  failures: string[],
): Promise<void> {
  const providers = await database.providerConfigs.toArray();
  for (const provider of providers) {
    if (provider.provider !== 'custom' || !provider.apiKey) continue;

    const account = providerApiKeyAccount(provider.id);
    if (await writeAndVerifySecure(storage, account, provider.apiKey)) {
      await database.providerConfigs.put({ ...provider, apiKey: '' });
      continue;
    }

    failures.push(`custom-provider:${provider.id}`);
    await database.providerConfigs.put({
      ...provider,
      isActive: false,
      status: 'not_connected',
    });
  }
}

async function migratePreferences(
  database: CredentialMigrationDatabase,
  storage: Storage,
  failures: PreferenceKey[],
): Promise<void> {
  for (const key of PREFERENCE_KEYS) {
    let secureValue: string | null;
    try {
      secureValue = await storage.secureGet(key);
    } catch {
      failures.push(key);
      continue;
    }
    if (secureValue === null) continue;

    try {
      await database.settings.put({ key, value: secureValue });
      const saved = await database.settings.get(key);
      if (saved?.value !== secureValue) {
        failures.push(key);
        continue;
      }
      await storage.secureDelete(key);
    } catch {
      failures.push(key);
    }
  }
}

/**
 * Durable version-13 credential migration for credentials and ordinary provider/model preferences.
 * No secret value is included in the result or emitted to logs.
 */
export async function migrateHarnessCredentialsAndPreferences(
  database: CredentialMigrationDatabase = db,
  storage: Storage = secureStorage,
): Promise<CredentialMigrationResult> {
  const marker = await database.settings.get(CREDENTIAL_MIGRATION_MARKER);
  if (marker?.value === true) {
    return {
      completed: true,
      alreadyCompleted: true,
      failedCredentialKinds: [],
      failedPreferenceKeys: [],
    };
  }

  const failedCredentialKinds: string[] = [];
  const failedPreferenceKeys: PreferenceKey[] = [];

  await migrateSearchCredentials(database, storage, failedCredentialKinds);
  await migrateCustomProviderCredentials(database, storage, failedCredentialKinds);
  await migratePreferences(database, storage, failedPreferenceKeys);

  const completed = failedCredentialKinds.length === 0 && failedPreferenceKeys.length === 0;
  if (completed) {
    await database.settings.put({ key: CREDENTIAL_MIGRATION_MARKER, value: true });
  }

  return {
    completed,
    alreadyCompleted: false,
    failedCredentialKinds,
    failedPreferenceKeys,
  };
}

export async function readSearchCredentials(
  storage: Storage = secureStorage,
): Promise<SearchCredentials> {
  const entries = await Promise.all(
    (Object.entries(SEARCH_CREDENTIAL_ACCOUNTS) as Array<[SearchCredentialKey, string]>).map(
      async ([key, account]) => {
        try {
          return [key, (await storage.secureGet(account)) ?? ''] as const;
        } catch {
          return [key, ''] as const;
        }
      },
    ),
  );
  const credentials: SearchCredentials = {
    exaKey: '',
    tavilyKey: '',
    firecrawlKey: '',
    braveKey: '',
  };
  for (const [key, value] of entries) credentials[key] = value;
  return credentials;
}

export async function saveSearchCredentials(
  config: Pick<SearchConfig, SearchCredentialKey>,
  storage: Storage = secureStorage,
): Promise<void> {
  for (const [key, account] of Object.entries(SEARCH_CREDENTIAL_ACCOUNTS) as Array<
    [SearchCredentialKey, string]
  >) {
    const value = config[key];
    if (value.length === 0) {
      await storage.secureDelete(account);
      continue;
    }
    if (!(await writeAndVerifySecure(storage, account, value))) {
      throw new Error(`Could not verify secure storage for ${key}.`);
    }
  }
}
