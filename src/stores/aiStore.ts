// AI store. Local-first using Dexie and Tauri secure storage (Tauri desktop).
// Agent and provider config data stored in IndexedDB.
// API keys stored securely in Tauri keychain via secureStorage.ts.

import { create } from 'zustand';
import type { AIProviderConfig, ModelItem, ModelReasoning, ProviderStatus, SearchConfig, SearchProvider, TaskModelDefault, TaskModelDefaultKey } from '../types';
import { db } from '../services/db';
import { secureStorage } from '../services/secureStorage';
import {
  migrateHarnessCredentialsAndPreferences,
  readSearchCredentials,
  saveSearchCredentials,
} from '../services/agent/credentialMigration';
import {
  importProviderModels as fetchProviderModels,
  normalizeProviderBaseUrl,
  ProviderImportError,
  type ProviderImportErrorCode,
  type SyncModelsResult,
  type SyncModelsError,
} from '../services/ai/importProviderModels';
import {
  PROVIDER_PRESETS,
  createPresetProviderConfig,
  isPresetProviderId,
} from '../components/settings/modelProviders/providerPresets';
import { useUIStore } from './uiStore';

function defaultSearchConfig(): SearchConfig {
  return {
    exaKey: '',
    tavilyKey: '',
    firecrawlKey: '',
    braveKey: '',
    enabled: false,
    searchProvider: 'tavily',
  };
}

function showError(err: unknown, fallback: string): void {
  const msg = err instanceof Error ? err.message : fallback;
  useUIStore.getState().showToast(msg, 'error');
}

// ---------------------------------------------------------------------------
// Provider helpers
// ---------------------------------------------------------------------------

function modelKey(configId: string, modelId: string): string {
  return `${configId}:${modelId}`;
}

function providerApiKeyName(providerId: string): string {
  return `providerApiKey_${providerId}`;
}

let providerIdCounter = 0;
function generateProviderId(): string {
  providerIdCounter += 1;
  return `provider-${Date.now()}-${providerIdCounter}`;
}

function deriveProviderStatus(input: {
  hasBaseUrl: boolean;
  hasKey: boolean;
  modelCount: number;
  selectedModel?: string;
  lastError?: string;
  currentStatus?: ProviderStatus;
}): ProviderStatus {
  if (input.lastError) return 'connection_failed';
  if (!input.hasBaseUrl) return 'needs_setup';
  if (!input.hasKey) return 'needs_key';
  if (input.modelCount <= 0) return 'sync_needed';
  if (!input.selectedModel) return 'sync_needed';
  return 'connected';
}

function refreshStatus(
  hasKey: boolean,
  hasBaseUrl: boolean,
  modelCount: number,
  selectedModel: string,
  currentStatus?: ProviderStatus,
): ProviderStatus {
  const derived = deriveProviderStatus({
    hasBaseUrl,
    hasKey,
    modelCount,
    selectedModel,
    currentStatus,
  });
  // Keep a prior failure visible until the provider is actually usable again.
  // Once key + models + selection exist, facts win over a stale failure flag.
  if (currentStatus === 'connection_failed' && derived !== 'connected') {
    return 'connection_failed';
  }
  return derived;
}

async function hasSecureKey(providerId: string): Promise<boolean> {
  try {
    const value = await secureStorage.secureGet(providerApiKeyName(providerId));
    return Boolean(value && value.length > 0);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface AIStore {
  providerConfigs: AIProviderConfig[];
  activeProviderId: string | null;
  appManagementProviderId: string | null;
  isLoaded: boolean;
  hiddenModels: string[]; // "configId:modelId" strings
  taskModelDefaults: TaskModelDefault[];

  loadAISettings: () => Promise<void>;
  getActiveProvider: () => AIProviderConfig | null;
  getAppManagementProvider: () => AIProviderConfig | null;
  setAppManagementProvider: (id: string | null) => Promise<void>;

  saveCustomProvider: (config: AIProviderConfig) => Promise<void>;
  deleteCustomProvider: (id: string) => Promise<void>;
  addProvider: (name: string, baseUrl: string, apiKey: string) => Promise<AIProviderConfig | null>;
  setActiveProvider: (id: string) => void;
  setActiveModel: (configId: string, modelSlug: string) => void;
  setModelReasoning: (configId: string, modelSlug: string, value: string) => void;
  setModelReasoningDescriptor: (configId: string, modelSlug: string, reasoning: ModelReasoning | undefined) => void;
  setModelSupportsTools: (configId: string, modelSlug: string, supportsTools: boolean) => void;
  addModelToProvider: (configId: string, modelSlug: string) => void;
  removeModelFromProvider: (configId: string, modelSlug: string) => void;
  toggleHiddenModel: (key: string) => void;
  setModelHidden: (providerId: string, modelId: string, hidden: boolean) => void;
  setProviderModelsHidden: (providerId: string, hidden: boolean) => void;
  setHiddenModels: (keys: string[]) => void;
  isModelHidden: (configId: string, modelSlug: string) => boolean;

  refreshProviderStatus: (id: string) => Promise<void>;
  refreshAllProviderStatuses: () => Promise<void>;
  saveProviderApiKey: (id: string, key: string) => Promise<void>;
  deleteProviderApiKey: (id: string) => Promise<void>;
  setProviderStatus: (id: string, status: ProviderStatus) => void;
  saveProviderConfig: (
    config: Partial<AIProviderConfig> & { id: string },
    options?: { refreshStatus?: boolean },
  ) => Promise<void>;
  connectProvider: (id: string, baseUrl: string, apiKey: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  connectNewProvider: (input: { name: string; baseUrl: string; apiKey: string; presetId?: string }) => Promise<
    | { ok: true; provider: AIProviderConfig; modelCount: number }
    | { ok: false; code: string; error: string }
  >;
  importProviderModels: (id: string, baseUrl: string, apiKey: string) => Promise<{ ok: true } | { ok: false; error: string; code: string }>;
  /**
   * Read-only credential validation.  Fetches the model list from the given
   * endpoint to verify the base URL and API key, but does NOT persist
   * anything — no config write, no secure-storage write, no model update.
   */
  testProviderConnection: (id: string, baseUrl: string, apiKey: string) => Promise<{ ok: true } | { ok: false; error: string; code: ProviderImportErrorCode }>;
  /**
   * Re-sync the model list for an already-persisted provider using its
   * stored credentials.  Does NOT change the base URL or API key in
   * secure storage.  Preserves custom models and hidden-model choices.
   */
  syncProviderModels: (id: string) => Promise<SyncModelsResult | SyncModelsError>;
  getEnabledModels: (providerId: string) => ModelItem[];
  getAllEnabledModels: () => { provider: AIProviderConfig; model: ModelItem }[];

  getTaskDefault: (taskKey: TaskModelDefaultKey) => TaskModelDefault | undefined;
  setTaskDefault: (taskKey: TaskModelDefaultKey, providerId: string, modelId: string) => Promise<void>;
  removeTaskDefault: (taskKey: TaskModelDefaultKey) => Promise<void>;

  searchConfig: SearchConfig;
  saveSearchConfig: (config: SearchConfig) => Promise<void>;
}

export const useAIStore = create<AIStore>((set, get) => ({
  providerConfigs: [],
  activeProviderId: null,
  appManagementProviderId: null,
  isLoaded: false,
  hiddenModels: [],
  taskModelDefaults: [],
  searchConfig: defaultSearchConfig(),

  loadAISettings: async () => {
    try {
      await migrateHarnessCredentialsAndPreferences();

      // Load provider configs from Dexie
      const providerConfigsFromDb = await db.providerConfigs.toArray();

      // Load settings from Dexie
      const settingsRows = await db.settings.toArray();
      const settings: Record<string, string | number | boolean | Record<string, unknown>> = {};
      settingsRows.forEach(row => {
        settings[row.key] = row.value;
      });

      let hiddenModels: string[] = [];
      const hiddenRaw = settings['hiddenModels'];
      if (typeof hiddenRaw === 'string' && hiddenRaw.length > 0) {
        try {
          const parsed = JSON.parse(hiddenRaw);
          if (Array.isArray(parsed)) hiddenModels = parsed.filter((v): v is string => typeof v === 'string');
        } catch {
          hiddenModels = [];
        }
      }

      // Drop truly obsolete built-in ids that are no longer in the product.
      // Active presets (openai, anthropic, gemini, …) are seeded below.
      const LEGACY_REMOVED_IDS = new Set([
        'mistral',
        'groq',
        'custom-endpoint',
      ]);
      for (const legacy of providerConfigsFromDb) {
        if (LEGACY_REMOVED_IDS.has(legacy.id)) {
          await db.providerConfigs.delete(legacy.id).catch(() => undefined);
          await secureStorage.secureDelete(providerApiKeyName(legacy.id)).catch(() => undefined);
        }
      }

      // Merge seeded presets (stable ids) with user-added custom providers.
      const savedById = new Map(
        providerConfigsFromDb
          .filter((p) => !LEGACY_REMOVED_IDS.has(p.id))
          .map((p) => [p.id, p] as const),
      );
      const providerConfigs: AIProviderConfig[] = [];
      for (const preset of PROVIDER_PRESETS) {
        const existing = savedById.get(preset.id);
        if (existing) {
          // Ensure provider field stays the stable preset id (for OpenRouter headers, etc.).
          const merged: AIProviderConfig = {
            ...existing,
            provider: existing.provider || preset.id,
            name: existing.name || preset.name,
            baseUrl: existing.baseUrl || preset.defaultBaseUrl,
          };
          providerConfigs.push(merged);
          savedById.delete(preset.id);
          if (
            merged.provider !== existing.provider ||
            merged.name !== existing.name ||
            merged.baseUrl !== existing.baseUrl
          ) {
            await db.providerConfigs.put(merged).catch(() => undefined);
          }
        } else {
          const seeded = createPresetProviderConfig(preset);
          providerConfigs.push(seeded);
          await db.providerConfigs.put(seeded).catch(() => undefined);
        }
      }
      for (const custom of savedById.values()) {
        providerConfigs.push(custom);
      }

      // Refresh connection status from secure storage
      await Promise.all(
        providerConfigs.map(async (config) => {
          const hasKey = config.isActive && (config.apiKey
            ? Boolean(config.apiKey)
            : await hasSecureKey(config.id));
          const modelCount = (config.models ?? []).filter(
            (m) => !hiddenModels.includes(`${config.id}:${m.id}`),
          ).length;
          config.status = refreshStatus(
            hasKey,
            Boolean(config.baseUrl),
            modelCount,
            config.selectedModel,
            config.status,
          );
        })
      );

      const activeProviderId =
        (settings['activeProviderId'] as string | undefined) ??
        providerConfigs.find((p) => p.status === 'connected')?.id ??
        providerConfigs[0]?.id ??
        null;
      const appManagementProviderId =
        (settings['appManagementProviderId'] as string | null | undefined) ?? null;

      // Load task model defaults from settings. Version 14 deletes legacy
      // modelDefaults; do not seed replacements from the old chat path.
      let taskModelDefaults: TaskModelDefault[] = [];
      const defaultsRaw = settings['modelDefaults'];
      if (typeof defaultsRaw === 'string' && defaultsRaw.length > 0) {
        try {
          const parsed = JSON.parse(defaultsRaw);
          if (Array.isArray(parsed)) {
            taskModelDefaults = parsed.filter(
              (d: unknown): d is TaskModelDefault =>
                typeof d === 'object' && d !== null &&
                'taskKey' in d && 'providerId' in d && 'modelId' in d &&
                typeof (d as Record<string, unknown>).taskKey === 'string' &&
                typeof (d as Record<string, unknown>).providerId === 'string' &&
                typeof (d as Record<string, unknown>).modelId === 'string',
            );
          }
        } catch {
          taskModelDefaults = [];
        }
      }

      const searchCredentials = await readSearchCredentials();

      set({
        providerConfigs,
        activeProviderId,
        appManagementProviderId,
        isLoaded: true,
        hiddenModels,
        taskModelDefaults,
        searchConfig: {
          ...searchCredentials,
          enabled: Boolean(settings['enabled'] ?? false),
          searchProvider: (settings['searchProvider'] as SearchProvider) ?? 'tavily',
        },
      });
    } catch (err) {
      set({ isLoaded: true });
      showError(err, 'Failed to load AI settings.');
    }
  },

  saveCustomProvider: async (config) => {
    const id = config.id || generateProviderId();
    const credential = config.apiKey;
    const normalized: AIProviderConfig = { ...config, id, provider: 'custom', apiKey: '' };
    try {
      if (credential) {
        await secureStorage.secureSet(providerApiKeyName(id), credential);
        if ((await secureStorage.secureGet(providerApiKeyName(id))) !== credential) {
          throw new Error('Could not verify the saved provider credential.');
        }
      }
      await db.providerConfigs.put(normalized);

      set((state) => {
        const providerConfigs = state.providerConfigs.map((candidate) =>
          candidate.id === id ? normalized : candidate
        );
        return {
          providerConfigs,
          activeProviderId: state.activeProviderId ?? id,
        };
      });
    } catch (err) {
      showError(err, 'Failed to save provider config.');
    }
  },

  deleteCustomProvider: async (id) => {
    try {
      // Built-in presets are permanent list slots: reset credentials/models
      // instead of removing the row from the left panel.
      if (isPresetProviderId(id)) {
        const preset = PROVIDER_PRESETS.find((p) => p.id === id);
        if (!preset) return;
        const reset = createPresetProviderConfig(preset);
        await secureStorage.secureDelete(providerApiKeyName(id)).catch(() => undefined);
        await db.providerConfigs.put(reset);
        set((state) => {
          const providerConfigs = state.providerConfigs.map((candidate) =>
            candidate.id === id ? reset : candidate,
          );
          const nextActiveId =
            state.activeProviderId === id
              ? providerConfigs.find((p) => p.status === 'connected')?.id ??
                providerConfigs[0]?.id ??
                null
              : state.activeProviderId;
          const nextAppMgmtId =
            state.appManagementProviderId === id ? null : state.appManagementProviderId;
          return {
            providerConfigs,
            activeProviderId: nextActiveId,
            appManagementProviderId: nextAppMgmtId,
          };
        });
        return;
      }

      await db.providerConfigs.delete(id);
      await secureStorage.secureDelete(providerApiKeyName(id)).catch(() => undefined);

      set((state) => {
        const providerConfigs = state.providerConfigs.filter((candidate) => candidate.id !== id);
        let nextActiveId = state.activeProviderId;
        if (state.activeProviderId === id) {
          // Prefer a connected provider, then fall back to the first remaining.
          nextActiveId =
            providerConfigs.find((p) => p.status === 'connected')?.id ??
            providerConfigs[0]?.id ??
            null;
        }
        // Clear appManagementProvider if it pointed to the deleted provider.
        const nextAppMgmtId =
          state.appManagementProviderId === id ? null : state.appManagementProviderId;
        return {
          providerConfigs,
          activeProviderId: nextActiveId,
          appManagementProviderId: nextAppMgmtId,
        };
      });
    } catch (err) {
      showError(err, 'Failed to delete provider.');
    }
  },

  addProvider: async (name, baseUrl, apiKey) => {
    const trimmedName = name.trim();
    const trimmedBaseUrl = normalizeProviderBaseUrl(baseUrl);
    const trimmedKey = apiKey.trim();
    if (!trimmedName || !trimmedBaseUrl) {
      showError(new Error('Name and Base URL are required.'), 'Failed to add provider.');
      return null;
    }
    const id = generateProviderId();
    const newConfig: AIProviderConfig = {
      id,
      name: trimmedName,
      provider: 'custom',
      apiKey: '',
      selectedModel: '',
      isActive: true,
      baseUrl: trimmedBaseUrl,
      customModels: [],
      status: deriveProviderStatus({
        hasBaseUrl: Boolean(trimmedBaseUrl),
        hasKey: Boolean(trimmedKey),
        modelCount: 0,
      }),
      models: [],
    };
    try {
      await db.providerConfigs.put(newConfig);
      if (trimmedKey) {
        await secureStorage.secureSet(providerApiKeyName(id), trimmedKey);
      }
      set((state) => ({
        providerConfigs: [...state.providerConfigs, newConfig],
        activeProviderId: state.activeProviderId ?? id,
      }));
      return newConfig;
    } catch (err) {
      showError(err, 'Failed to add provider.');
      return null;
    }
  },

  setActiveProvider: (id) => {
    set({ activeProviderId: id });
    void db.settings.put({ key: 'activeProviderId', value: id }).catch(() => undefined);
  },

  getActiveProvider: () => {
    const { providerConfigs, activeProviderId } = get();
    return providerConfigs.find((config) => config.id === activeProviderId) ?? null;
  },

  getAppManagementProvider: () => {
    const { providerConfigs, appManagementProviderId } = get();
    if (appManagementProviderId) {
      const config = providerConfigs.find((candidate) => candidate.id === appManagementProviderId);
      if (config) return config;
    }
    return get().getActiveProvider();
  },

  setAppManagementProvider: async (id) => {
    set({ appManagementProviderId: id });
    try {
      await db.settings.put({ key: 'appManagementProviderId', value: id ?? '' });
    } catch (err) {
      showError(err, 'Failed to save app management provider.');
    }
  },

  setActiveModel: (configId, modelSlug) => {
    const providerConfigs = get().providerConfigs.map((config) =>
      config.id === configId ? { ...config, selectedModel: modelSlug } : config
    );
    set({ providerConfigs });
    void db.providerConfigs.update(configId, { selectedModel: modelSlug }).catch(() => undefined);
  },

  setModelReasoning: (configId, modelSlug, value) => {
    const providerConfigs = get().providerConfigs.map((config) => {
      if (config.id !== configId) return config;
      const models = (config.models ?? []).map((m) =>
        m.id === modelSlug ? { ...m, selectedReasoning: value } : m,
      );
      return { ...config, models };
    });
    set({ providerConfigs });
    const models = providerConfigs.find((c) => c.id === configId)?.models;
    if (models) void db.providerConfigs.update(configId, { models }).catch(() => undefined);
  },

  setModelReasoningDescriptor: (configId, modelSlug, reasoning) => {
    const providerConfigs = get().providerConfigs.map((config) => {
      if (config.id !== configId) return config;
      const models = (config.models ?? []).map((m) =>
        m.id === modelSlug ? { ...m, reasoning } : m,
      );
      return { ...config, models };
    });
    set({ providerConfigs });
    const models = providerConfigs.find((c) => c.id === configId)?.models;
    if (models) void db.providerConfigs.update(configId, { models }).catch(() => undefined);
  },

  setModelSupportsTools: (configId, modelSlug, supportsTools) => {
    const providerConfigs = get().providerConfigs.map((config) => {
      if (config.id !== configId) return config;
      const models = (config.models ?? []).map((m) =>
        m.id === modelSlug ? { ...m, supportsTools } : m,
      );
      return { ...config, models };
    });
    set({ providerConfigs });
    const models = providerConfigs.find((c) => c.id === configId)?.models;
    if (models) void db.providerConfigs.update(configId, { models }).catch(() => undefined);
  },

  addModelToProvider: (configId, modelSlug) => {
    const slug = modelSlug.trim();
    if (!slug) return;
    const current = get().providerConfigs.find((config) => config.id === configId);
    if (!current) return;
    if (current.customModels.includes(slug)) return;
    const next = [...current.customModels, slug];
    const newModel: ModelItem = {
      id: slug,
      name: slug,
      enabled: true,
      custom: true,
      capabilities: {
        vision: false,
        toolCalling: true,
        contextLength: 'Unknown',
        speed: 'Medium',
        cost: 'External',
        reasoning: 'Unknown',
        endpointType: current.provider === 'custom' ? 'Custom' : 'Native',
        lastSynced: 'Unknown',
      },
    };
    const models = [...(current.models ?? []), newModel];
    set((state) => ({
      providerConfigs: state.providerConfigs.map((config) =>
        config.id === configId ? { ...config, customModels: next, models } : config
      ),
    }));
    void db.providerConfigs.update(configId, { customModels: next, models }).catch(() => undefined);
  },

  removeModelFromProvider: (configId, modelSlug) => {
    const current = get().providerConfigs.find((config) => config.id === configId);
    if (!current) return;
    const customModels = current.customModels.filter((model) => model !== modelSlug);
    const models = (current.models ?? []).filter((m) => m.id !== modelSlug);
    const selectedModel =
      current.selectedModel === modelSlug ? (models[0]?.id ?? '') : current.selectedModel;
    const removedKey = modelKey(configId, modelSlug);
    const hiddenModels = get().hiddenModels.filter((key) => key !== removedKey);
    set((state) => ({
      providerConfigs: state.providerConfigs.map((config) =>
        config.id === configId ? { ...config, customModels, models, selectedModel } : config
      ),
      hiddenModels,
    }));
    void db.providerConfigs.update(configId, { customModels, models, selectedModel }).catch(() => undefined);
    void db.settings.put({ key: 'hiddenModels', value: JSON.stringify(hiddenModels) }).catch(() => undefined);
  },

  toggleHiddenModel: (key) => {
    const current = get().hiddenModels;
    const hiddenModels = current.includes(key)
      ? current.filter((candidate) => candidate !== key)
      : [...current, key];
    set({ hiddenModels });
    void db.settings.put({ key: 'hiddenModels', value: JSON.stringify(hiddenModels) }).catch(() => undefined);
  },

  setModelHidden: (providerId, modelId, hidden) => {
    const key = modelKey(providerId, modelId);
    const current = get().hiddenModels;
    const isCurrentlyHidden = current.includes(key);
    if (hidden === isCurrentlyHidden) return;
    const hiddenModels = hidden
      ? [...current, key]
      : current.filter((k) => k !== key);
    set({ hiddenModels });
    void db.settings.put({ key: 'hiddenModels', value: JSON.stringify(hiddenModels) }).catch(() => undefined);
  },

  setProviderModelsHidden: (providerId, hidden) => {
    const provider = get().providerConfigs.find((config) => config.id === providerId);
    if (!provider) return;
    const modelKeys = new Set((provider.models ?? []).map((model) => modelKey(providerId, model.id)));
    if (modelKeys.size === 0) return;

    const current = get().hiddenModels;
    const withoutProviderModels = current.filter((key) => !modelKeys.has(key));
    const hiddenModels = hidden
      ? [...withoutProviderModels, ...modelKeys]
      : withoutProviderModels;

    set({ hiddenModels });
    void db.settings.put({ key: 'hiddenModels', value: JSON.stringify(hiddenModels) }).catch(() => undefined);
  },

  setHiddenModels: (keys) => {
    const hiddenModels = Array.from(new Set(keys));
    set({ hiddenModels });
    void db.settings.put({ key: 'hiddenModels', value: JSON.stringify(hiddenModels) }).catch(() => undefined);
  },

  isModelHidden: (configId, modelSlug) => get().hiddenModels.includes(modelKey(configId, modelSlug)),

  refreshProviderStatus: async (id) => {
    const config = get().providerConfigs.find((p) => p.id === id);
    if (!config) return;

    const hasKey = config.isActive && await hasSecureKey(id);
    const modelCount = (config.models ?? []).filter(
      (m) => !get().isModelHidden(id, m.id),
    ).length;
    const nextStatus = refreshStatus(
      hasKey,
      Boolean(config.baseUrl),
      modelCount,
      config.selectedModel,
      config.status,
    );

    set((state) => ({
      providerConfigs: state.providerConfigs.map((p) =>
        p.id === id ? { ...p, status: nextStatus } : p
      ),
    }));
  },

  refreshAllProviderStatuses: async () => {
    const { providerConfigs, hiddenModels } = get();
    const updates = await Promise.all(
      providerConfigs.map(async (config) => {
        const hasKey = config.isActive && await hasSecureKey(config.id);
        const modelCount = (config.models ?? []).filter(
          (m) => !hiddenModels.includes(`${config.id}:${m.id}`),
        ).length;
        return {
          id: config.id,
          status: refreshStatus(
            hasKey,
            Boolean(config.baseUrl),
            modelCount,
            config.selectedModel,
            config.status,
          ),
        };
      })
    );

    set((state) => ({
      providerConfigs: state.providerConfigs.map((p) => {
        const update = updates.find((u) => u.id === p.id);
        return update ? { ...p, status: update.status } : p;
      }),
    }));
  },

  saveProviderApiKey: async (id, key) => {
    try {
      if (key.trim().length > 0) {
        await secureStorage.secureSet(providerApiKeyName(id), key.trim());
      } else {
        await secureStorage.secureDelete(providerApiKeyName(id)).catch(() => undefined);
      }
      await get().refreshProviderStatus(id);
    } catch (err) {
      showError(err, 'Failed to save API key.');
    }
  },

  deleteProviderApiKey: async (id) => {
    try {
      await secureStorage.secureDelete(providerApiKeyName(id)).catch(() => undefined);
      await get().refreshProviderStatus(id);
    } catch (err) {
      showError(err, 'Failed to remove API key.');
    }
  },

  setProviderStatus: (id, status) => {
    set((state) => ({
      providerConfigs: state.providerConfigs.map((p) =>
        p.id === id ? { ...p, status } : p
      ),
    }));
  },

  saveProviderConfig: async (updates, options) => {
    const { id } = updates;
    const current = get().providerConfigs.find((p) => p.id === id);
    if (!current) return;
    const refreshStatus = options?.refreshStatus ?? true;

    const normalized: AIProviderConfig = { ...current, ...updates };
    try {
      await db.providerConfigs.put(normalized);
      set((state) => ({
        providerConfigs: state.providerConfigs.map((p) =>
          p.id === id ? normalized : p
        ),
      }));
      if (refreshStatus) {
        await get().refreshProviderStatus(id);
      }
    } catch (err) {
      showError(err, 'Failed to save provider config.');
    }
  },

  connectProvider: async (id, baseUrl, apiKey) => {
    const current = get().providerConfigs.find((provider) => provider.id === id);
    if (!current) return { ok: false, error: 'Provider not found.' };

    const normalizedBaseUrl = normalizeProviderBaseUrl(baseUrl);
    const trimmedKey = apiKey.trim();
    if (!normalizedBaseUrl || !trimmedKey) {
      return { ok: false, error: 'Base URL and API key are required.' };
    }

    try {
      const parsed = new URL(normalizedBaseUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { ok: false, error: 'Base URL must use http or https.' };
      }
    } catch {
      return { ok: false, error: 'Base URL is not a valid URL.' };
    }

    const availableModels = (current.models ?? []).filter(
      (model) => !get().isModelHidden(id, model.id),
    );
    if (availableModels.length === 0) {
      return { ok: false, error: 'Import and enable at least one model before connecting.' };
    }

    try {
      const selectedModel = availableModels.some((model) => model.id === current.selectedModel)
        ? current.selectedModel
        : availableModels[0].id;
      const connected: AIProviderConfig = {
        ...current,
        baseUrl: normalizedBaseUrl,
        selectedModel,
        status: 'connected',
        isActive: true,
      };

      await secureStorage.secureSet(providerApiKeyName(id), trimmedKey);
      const savedKey = await secureStorage.secureGet(providerApiKeyName(id));
      if (savedKey !== trimmedKey) {
        throw new Error(`Could not verify the saved API key for ${current.name}.`);
      }
      await db.providerConfigs.put(connected);
      await db.settings.put({ key: 'activeProviderId', value: id });
      set((state) => ({
        activeProviderId: id,
        providerConfigs: state.providerConfigs.map((provider) =>
          provider.id === id ? connected : provider
        ),
      }));
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to connect provider.';
      return { ok: false, error: message };
    }
  },

  connectNewProvider: async ({ name, baseUrl, apiKey }) => {
    const trimmedName = name.trim();
    const trimmedBaseUrl = normalizeProviderBaseUrl(baseUrl);
    const trimmedKey = apiKey.trim();

    if (!trimmedName) {
      return { ok: false, code: 'validation', error: 'Provider name is required.' };
    }
    if (!trimmedBaseUrl) {
      return { ok: false, code: 'invalid_url', error: 'Base URL is required.' };
    }

    // Validate URL shape before any persistence
    try {
      const parsed = new URL(trimmedBaseUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { ok: false, code: 'invalid_url', error: 'Base URL must use http or https.' };
      }
    } catch {
      return { ok: false, code: 'invalid_url', error: 'Base URL is not valid.' };
    }

    const id = generateProviderId();

    // 1. Fetch models BEFORE persisting anything
    let imported: ModelItem[];
    try {
      imported = await fetchProviderModels({
        providerId: id,
        baseUrl: trimmedBaseUrl,
        apiKey: trimmedKey,
      });
    } catch (err) {
      if (err instanceof ProviderImportError) {
        return { ok: false, code: err.code, error: err.message };
      }
      const message = err instanceof Error ? err.message : 'Failed to reach provider.';
      return { ok: false, code: 'request_failed', error: message };
    }

    if (imported.length === 0) {
      return { ok: false, code: 'empty_response', error: 'Provider returned no models.' };
    }

    // 2. Write the API key and verify read-back
    if (trimmedKey) {
      try {
        await secureStorage.secureSet(providerApiKeyName(id), trimmedKey);
        const savedKey = await secureStorage.secureGet(providerApiKeyName(id));
        if (savedKey !== trimmedKey) {
          // Best-effort cleanup of the written secret
          await secureStorage.secureDelete(providerApiKeyName(id)).catch(() => undefined);
          return { ok: false, code: 'storage', error: 'Could not verify the saved API key.' };
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to store API key.';
        return { ok: false, code: 'storage', error: message };
      }
    }

    // 3. Build the provider config and persist
    const selectedModel = imported[0]?.id ?? '';
    const newConfig: AIProviderConfig = {
      id,
      name: trimmedName,
      provider: 'custom',
      apiKey: '',
      selectedModel,
      isActive: true,
      baseUrl: trimmedBaseUrl,
      customModels: [],
      status: 'connected',
      models: imported,
      lastImportedAt: Date.now(),
    };

    try {
      await db.providerConfigs.put(newConfig);
      await db.settings.put({ key: 'activeProviderId', value: id });
    } catch (err) {
      // Best-effort cleanup of the written secret on persistence failure
      if (trimmedKey) {
        await secureStorage.secureDelete(providerApiKeyName(id)).catch(() => undefined);
      }
      const message = err instanceof Error ? err.message : 'Failed to save provider.';
      return { ok: false, code: 'storage', error: message };
    }

    // 4. Update Zustand state atomically
    set((state) => ({
      providerConfigs: [...state.providerConfigs, newConfig],
      activeProviderId: id,
    }));

    return { ok: true, provider: newConfig, modelCount: imported.length };
  },

  importProviderModels: async (id, baseUrl, apiKey) => {
    const current = get().providerConfigs.find((p) => p.id === id);
    if (!current) {
      return { ok: false, error: 'Provider not found.', code: 'unknown' };
    }

    const trimmedBaseUrl = normalizeProviderBaseUrl(baseUrl);
    const trimmedKey = apiKey.trim();

    try {
      // Fetch FIRST — persist only after a successful fetch so that a
      // failed reconnect leaves the previous working config untouched.
      const imported = await fetchProviderModels({
        providerId: id,
        baseUrl: trimmedBaseUrl,
        apiKey: trimmedKey,
      });

      // Save the API key to secure storage.
      if (trimmedKey) {
        await secureStorage.secureSet(providerApiKeyName(id), trimmedKey);
      } else {
        await secureStorage.secureDelete(providerApiKeyName(id));
      }

      // Preserve user-added custom models across re-imports.
      const customModels = current.customModels ?? [];
      const customIds = new Set(customModels);
      const customItems: ModelItem[] = imported
        .filter((m) => customIds.has(m.id))
        .map((m) => ({ ...m, custom: true }));
      // Also keep any custom models that weren't in the imported list.
      const importedIds = new Set(imported.map((m) => m.id));
      const orphanCustoms: ModelItem[] = customModels
        .filter((slug) => !importedIds.has(slug))
        .map((slug) => ({
          id: slug,
          name: slug,
          enabled: true,
          custom: true,
          capabilities: {
            vision: false,
            toolCalling: true,
            contextLength: 'Unknown',
            speed: 'Unknown',
            cost: 'Unknown',
            reasoning: 'Unknown',
            endpointType: 'Custom',
            lastSynced: 'Unknown',
          },
        }));
      const models: ModelItem[] = [...imported, ...customItems, ...orphanCustoms];

      // Keep the existing selection when possible; otherwise fall back to the
      // first imported model.
      const stillExists = current.selectedModel
        ? models.some((m) => m.id === current.selectedModel)
        : false;
      const nextSelected = stillExists
        ? current.selectedModel
        : imported[0]?.id ?? current.selectedModel;

      // Persist only after a successful fetch.
      const nextConfig: AIProviderConfig = {
        ...current,
        baseUrl: trimmedBaseUrl,
        models,
        selectedModel: nextSelected,
        lastImportedAt: Date.now(),
        status: deriveProviderStatus({
          hasBaseUrl: Boolean(trimmedBaseUrl),
          hasKey: Boolean(trimmedKey),
          modelCount: models.length,
          selectedModel: nextSelected,
        }),
      };
      await db.providerConfigs.put(nextConfig);
      set((state) => ({
        providerConfigs: state.providerConfigs.map((p) =>
          p.id === id ? nextConfig : p
        ),
      }));

      // If the active provider is this one, ensure the selected model
      // still points at something that exists.
      if (get().activeProviderId === id) {
        get().setActiveModel(id, nextConfig.selectedModel);
      }

      return { ok: true };
    } catch (err) {
      if (err instanceof ProviderImportError) {
        // Mark as connection_failed so the UI reflects the failure.
        const currentAfter = get().providerConfigs.find((p) => p.id === id);
        if (currentAfter) {
          const failed: AIProviderConfig = {
            ...currentAfter,
            status: 'connection_failed',
          };
          await db.providerConfigs.put(failed).catch(() => undefined);
          set((state) => ({
            providerConfigs: state.providerConfigs.map((p) =>
              p.id === id ? failed : p
            ),
          }));
        }
        return { ok: false, error: err.message, code: err.code };
      }
      const message = err instanceof Error ? err.message : 'Failed to import models.';
      return { ok: false, error: message, code: 'unknown' };
    }
  },

  testProviderConnection: async (id, baseUrl, apiKey) => {
    const current = get().providerConfigs.find((p) => p.id === id);
    if (!current) {
      return { ok: false, error: 'Provider not found.', code: 'request_failed' };
    }

    const trimmedBaseUrl = normalizeProviderBaseUrl(baseUrl);
    const trimmedKey = apiKey.trim();

    try {
      // Validate URL shape.
      try {
        const parsed = new URL(trimmedBaseUrl);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          return { ok: false, error: 'Base URL must use http or https.', code: 'invalid_url' };
        }
      } catch {
        return { ok: false, error: 'Base URL is not a valid URL.', code: 'invalid_url' };
      }

      // Fetch models to verify endpoint and authentication.
      // Nothing is persisted — this is read-only.
      await fetchProviderModels({
        providerId: id,
        baseUrl: trimmedBaseUrl,
        apiKey: trimmedKey,
      });

      return { ok: true };
    } catch (err) {
      if (err instanceof ProviderImportError) {
        return { ok: false, error: err.message, code: err.code };
      }
      const message = err instanceof Error ? err.message : 'Connection test failed.';
      return { ok: false, error: message, code: 'request_failed' };
    }
  },

  syncProviderModels: async (id) => {
    const current = get().providerConfigs.find((p) => p.id === id);
    if (!current) {
      return { ok: false, error: 'Provider not found.', code: 'request_failed' };
    }

    // Use stored credentials — sync never changes the base URL or API key.
    const storedKey = await secureStorage.secureGet(providerApiKeyName(id));

    try {
      const modelsBefore = (current.models ?? []).length;

      const imported = await fetchProviderModels({
        providerId: id,
        baseUrl: current.baseUrl,
        apiKey: storedKey ?? '',
      });

      // Preserve user-added custom models.
      const customModels = current.customModels ?? [];
      const customIds = new Set(customModels);
      const customItems: ModelItem[] = imported
        .filter((m) => customIds.has(m.id))
        .map((m) => ({ ...m, custom: true }));
      const importedIds = new Set(imported.map((m) => m.id));
      const orphanCustoms: ModelItem[] = customModels
        .filter((slug) => !importedIds.has(slug))
        .map((slug) => ({
          id: slug,
          name: slug,
          enabled: true,
          custom: true,
          capabilities: {
            vision: false,
            toolCalling: true,
            contextLength: 'Unknown',
            speed: 'Unknown',
            cost: 'Unknown',
            reasoning: 'Unknown',
            endpointType: 'Custom',
            lastSynced: 'Unknown',
          },
        }));
      const models: ModelItem[] = [...imported, ...customItems, ...orphanCustoms];

      const stillExists = current.selectedModel
        ? models.some((m) => m.id === current.selectedModel)
        : false;
      const nextSelected = stillExists
        ? current.selectedModel
        : imported[0]?.id ?? current.selectedModel;

      const nextConfig: AIProviderConfig = {
        ...current,
        models,
        selectedModel: nextSelected,
        lastImportedAt: Date.now(),
        status: deriveProviderStatus({
          hasBaseUrl: Boolean(current.baseUrl),
          hasKey: Boolean(storedKey),
          modelCount: models.length,
          selectedModel: nextSelected,
        }),
      };
      await db.providerConfigs.put(nextConfig);
      set((state) => ({
        providerConfigs: state.providerConfigs.map((p) =>
          p.id === id ? nextConfig : p
        ),
      }));

      if (get().activeProviderId === id) {
        get().setActiveModel(id, nextConfig.selectedModel);
      }

      // Compute sync result counts.
      const added = Math.max(0, models.length - modelsBefore);
      const removed = 0; // Sync never removes; orphan customs are kept.
      const unchanged = Math.max(0, modelsBefore - removed);

      return { ok: true, added, removed, unchanged, updatedAt: nextConfig.lastImportedAt };
    } catch (err) {
      if (err instanceof ProviderImportError) {
        const currentAfter = get().providerConfigs.find((p) => p.id === id);
        if (currentAfter) {
          const failed: AIProviderConfig = {
            ...currentAfter,
            status: 'connection_failed',
          };
          await db.providerConfigs.put(failed).catch(() => undefined);
          set((state) => ({
            providerConfigs: state.providerConfigs.map((p) =>
              p.id === id ? failed : p
            ),
          }));
        }
        return { ok: false, error: err.message, code: err.code };
      }
      const message = err instanceof Error ? err.message : 'Failed to sync models.';
      return { ok: false, error: message, code: 'request_failed' };
    }
  },

  getEnabledModels: (providerId) => {
    const config = get().providerConfigs.find((p) => p.id === providerId);
    if (!config || config.status !== 'connected') return [];
    return (config.models ?? []).filter((m) => !get().isModelHidden(config.id, m.id));
  },

  getAllEnabledModels: () => {
    const result: { provider: AIProviderConfig; model: ModelItem }[] = [];
    for (const provider of get().providerConfigs) {
      for (const model of get().getEnabledModels(provider.id)) {
        result.push({ provider, model });
      }
    }
    return result;
  },

  saveSearchConfig: async (config) => {
    set({ searchConfig: config });
    try {
      await saveSearchCredentials(config);
      await Promise.all([
        db.settings.delete('exaKey'),
        db.settings.delete('tavilyKey'),
        db.settings.delete('firecrawlKey'),
        db.settings.delete('braveKey'),
      ]);
      await db.settings.put({ key: 'enabled', value: config.enabled });
      await db.settings.put({ key: 'searchProvider', value: config.searchProvider });
    } catch (err) {
      showError(err, 'Failed to save search config.');
    }
  },

  getTaskDefault: (taskKey) => {
    return get().taskModelDefaults.find((d) => d.taskKey === taskKey);
  },

  setTaskDefault: async (taskKey, providerId, modelId) => {
    const defaults = get().taskModelDefaults.filter((d) => d.taskKey !== taskKey);
    const next: TaskModelDefault = { taskKey, providerId, modelId };
    const updated = [...defaults, next];
    set({ taskModelDefaults: updated });
    try {
      await db.settings.put({ key: 'modelDefaults', value: JSON.stringify(updated) });
    } catch (err) {
      showError(err, 'Failed to save task default.');
    }
  },

  removeTaskDefault: async (taskKey) => {
    const updated = get().taskModelDefaults.filter((d) => d.taskKey !== taskKey);
    set({ taskModelDefaults: updated });
    try {
      await db.settings.put({ key: 'modelDefaults', value: JSON.stringify(updated) });
    } catch (err) {
      showError(err, 'Failed to remove task default.');
    }
  },
}));
