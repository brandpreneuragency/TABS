import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ModelItem } from '../types';

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the store
// ---------------------------------------------------------------------------

vi.mock('../services/db', () => {
  const store = new Map<string, unknown>();
  return {
    db: {
      providerConfigs: {
        toArray: vi.fn().mockResolvedValue([]),
        put: vi.fn().mockImplementation(async (config: Record<string, unknown>) => {
          store.set(config.id as string, config);
          return undefined;
        }),
        update: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockImplementation(async (id: string) => {
          store.delete(id);
          return undefined;
        }),
        get: vi.fn().mockImplementation(async (id: string) => store.get(id)),
      },
      settings: {
        toArray: vi.fn().mockResolvedValue([]),
        put: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(undefined),
      },
    },
  };
});

vi.mock('../services/secureStorage', () => {
  const keys = new Map<string, string>();
  return {
    secureStorage: {
      secureGet: vi.fn().mockImplementation(async (key: string) => keys.get(key) ?? null),
      secureSet: vi.fn().mockImplementation(async (key: string, value: string) => {
        keys.set(key, value);
      }),
      secureDelete: vi.fn().mockImplementation(async (key: string) => {
        keys.delete(key);
      }),
      __keys: keys,
    },
  };
});

// vi.hoisted() makes these available inside vi.mock factories (which are hoisted)
const { mockModels, shouldFail, failCode, failMessage } = vi.hoisted(() => ({
  mockModels: { value: [] as { id: string; name: string }[] },
  shouldFail: { value: false },
  failCode: { value: 'request_failed' },
  failMessage: { value: 'Network error' },
}));

vi.mock('../services/ai/importProviderModels', () => {
  class ProviderImportError extends Error {
    code: string;
    status?: number;
    constructor(code: string, message: string, status?: number) {
      super(message);
      this.name = 'ProviderImportError';
      this.code = code;
      this.status = status;
    }
  }

  return {
    importProviderModels: vi.fn().mockImplementation(async () => {
      if (shouldFail.value) {
        throw new ProviderImportError(failCode.value, failMessage.value);
      }
      return mockModels.value.map((m) => ({
        ...m,
        enabled: true,
        capabilities: {
          vision: false,
          toolCalling: true,
          contextLength: 'Unknown' as const,
          speed: 'Unknown' as const,
          cost: 'Unknown' as const,
          reasoning: 'Unknown' as const,
          endpointType: 'Native' as const,
          lastSynced: 'Just now',
        },
      }));
    }),
    normalizeProviderBaseUrl: vi.fn().mockImplementation((url: string) =>
      url.trim().replace(/\/+$/, '').replace(/\/(?:chat\/completions|models)$/i, '')
    ),
    ProviderImportError,
  };
});

vi.mock('../stores/uiStore', () => ({
  useUIStore: {
    getState: vi.fn().mockReturnValue({
      showToast: vi.fn(),
    }),
  },
}));

// Now import the store and the mocks for assertions
import { useAIStore } from './aiStore';
import { secureStorage } from '../services/secureStorage';
import { db } from '../services/db';

// Helper functions to control mock behavior
function setMockModels(models: { id: string; name: string }[]) {
  mockModels.value = models;
  shouldFail.value = false;
}
function setMockFailure(code: string, message: string) {
  shouldFail.value = true;
  failCode.value = code;
  failMessage.value = message;
}
function clearMockFailure() {
  shouldFail.value = false;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProvider(overrides: Partial<ReturnType<typeof useAIStore.getState>['providerConfigs'][0]> = {}) {
  const models: ModelItem[] = [
    {
      id: 'gpt-4o',
      name: 'GPT-4o',
      enabled: true,
      capabilities: {
        vision: true,
        toolCalling: true,
        contextLength: '128k',
        speed: 'Fast',
        cost: 'Paid',
        reasoning: 'High',
        endpointType: 'Native',
        lastSynced: 'Just now',
      },
    },
    {
      id: 'gpt-4o-mini',
      name: 'GPT-4o Mini',
      enabled: true,
      capabilities: {
        vision: true,
        toolCalling: true,
        contextLength: '128k',
        speed: 'Fast',
        cost: 'Paid',
        reasoning: 'Medium',
        endpointType: 'Native',
        lastSynced: 'Just now',
      },
    },
  ];
  return {
    id: 'test-provider-1',
    name: 'Test Provider',
    provider: 'custom' as const,
    apiKey: '',
    selectedModel: 'gpt-4o',
    isActive: true,
    baseUrl: 'https://api.example.com/v1',
    customModels: [],
    status: 'connected' as const,
    models,
    ...overrides,
  };
}

function seedProviders(providers: ReturnType<typeof makeProvider>[]) {
  useAIStore.setState({ providerConfigs: providers, activeProviderId: providers[0]?.id ?? null });
}

function seedHiddenModels(keys: string[]) {
  useAIStore.setState({ hiddenModels: keys });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  clearMockFailure();
  setMockModels([
    { id: 'gpt-4o', name: 'GPT-4o' },
    { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
  ]);
  // Reset store to clean state
  useAIStore.setState({
    providerConfigs: [],
    activeProviderId: null,
    hiddenModels: [],
    taskModelDefaults: [],
    isLoaded: false,
  });
});

// ---------------------------------------------------------------------------
// connectNewProvider
// ---------------------------------------------------------------------------

describe('connectNewProvider', () => {
  it('persists a new provider with fetched models on success', async () => {
    const result = await useAIStore.getState().connectNewProvider({
      name: 'My Provider',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test-123',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.provider.name).toBe('My Provider');
    expect(result.provider.status).toBe('connected');
    expect(result.modelCount).toBe(2);
    expect(result.provider.models).toHaveLength(2);
    expect(result.provider.models![0].id).toBe('gpt-4o');

    // API key stored in secure storage
    const storeKey = `providerApiKey_${result.provider.id}`;
    expect(secureStorage.secureSet).toHaveBeenCalledWith(storeKey, 'sk-test-123');

    // Provider persisted to Dexie
    expect(db.providerConfigs.put).toHaveBeenCalled();
  });

  it('returns error for empty name', async () => {
    const result = await useAIStore.getState().connectNewProvider({
      name: '',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test-123',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('validation');
  });

  it('returns error for invalid URL', async () => {
    const result = await useAIStore.getState().connectNewProvider({
      name: 'Test',
      baseUrl: 'not-a-url',
      apiKey: 'sk-test-123',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('invalid_url');
  });

  it('returns error for non-http protocol', async () => {
    const result = await useAIStore.getState().connectNewProvider({
      name: 'Test',
      baseUrl: 'ftp://example.com',
      apiKey: 'sk-test-123',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('invalid_url');
  });

  it('returns authentication error on 401', async () => {
    setMockFailure('unauthorized', 'API key was rejected.');

    const result = await useAIStore.getState().connectNewProvider({
      name: 'Test',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'bad-key',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('unauthorized');
    expect(result.error).toBe('API key was rejected.');
  });

  it('cleans up secure storage on persistence failure', async () => {
    vi.mocked(db.providerConfigs.put).mockRejectedValueOnce(new Error('DB write failed'));

    const result = await useAIStore.getState().connectNewProvider({
      name: 'Test',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test-123',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('storage');

    // The key should have been written then deleted (cleanup)
    expect(secureStorage.secureSet).toHaveBeenCalled();
    expect(secureStorage.secureDelete).toHaveBeenCalled();
  });

  it('does not persist provider config on fetch failure', async () => {
    setMockFailure('request_failed', 'Network error');

    const putCallCount = vi.mocked(db.providerConfigs.put).mock.calls.length;

    const result = await useAIStore.getState().connectNewProvider({
      name: 'Test',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test-123',
    });

    expect(result.ok).toBe(false);
    // No additional put call should have happened
    expect(vi.mocked(db.providerConfigs.put).mock.calls.length).toBe(putCallCount);
  });

  it('adds provider to store state on success', async () => {
    useAIStore.setState({ providerConfigs: [], activeProviderId: null });

    const result = await useAIStore.getState().connectNewProvider({
      name: 'New',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test-123',
    });

    expect(result.ok).toBe(true);

    const state = useAIStore.getState();
    expect(state.providerConfigs).toHaveLength(1);
    expect(state.activeProviderId).toBe(result.ok ? result.provider.id : null);
  });
});

// ---------------------------------------------------------------------------
// testProviderConnection (read-only)
// ---------------------------------------------------------------------------

describe('testProviderConnection', () => {
  it('returns ok on successful validation without persisting', async () => {
    seedProviders([makeProvider()]);

    const result = await useAIStore.getState().testProviderConnection(
      'test-provider-1',
      'https://api.example.com/v1',
      'sk-test-123',
    );

    expect(result.ok).toBe(true);

    // Should NOT have written anything to secure storage or DB
    expect(secureStorage.secureSet).not.toHaveBeenCalled();
    expect(db.providerConfigs.put).not.toHaveBeenCalled();
  });

  it('returns error for invalid URL', async () => {
    seedProviders([makeProvider()]);

    const result = await useAIStore.getState().testProviderConnection(
      'test-provider-1',
      'not-a-url',
      'sk-test-123',
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('invalid_url');
  });

  it('returns error on fetch failure', async () => {
    seedProviders([makeProvider()]);
    setMockFailure('request_failed', 'Connection refused');

    const result = await useAIStore.getState().testProviderConnection(
      'test-provider-1',
      'https://api.example.com/v1',
      'sk-test-123',
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('request_failed');
  });

  it('does not mutate models in the store', async () => {
    const provider = makeProvider();
    seedProviders([provider]);

    const modelsBefore = useAIStore.getState().providerConfigs[0].models;

    await useAIStore.getState().testProviderConnection(
      'test-provider-1',
      'https://api.example.com/v1',
      'sk-test-123',
    );

    const modelsAfter = useAIStore.getState().providerConfigs[0].models;
    expect(modelsAfter).toBe(modelsBefore);
  });
});

// ---------------------------------------------------------------------------
// syncProviderModels
// ---------------------------------------------------------------------------

describe('syncProviderModels', () => {
  it('fetches and merges models with preserved custom models', async () => {
    const provider = makeProvider({
      customModels: ['custom-model-1'],
      models: [
        {
          id: 'gpt-4o',
          name: 'GPT-4o',
          enabled: true,
          custom: true,
          capabilities: { vision: false, toolCalling: true, contextLength: 'Unknown', speed: 'Unknown', cost: 'Unknown', reasoning: 'Unknown', endpointType: 'Native', lastSynced: 'Just now' },
        },
        {
          id: 'custom-model-1',
          name: 'Custom Model 1',
          enabled: true,
          custom: true,
          capabilities: { vision: false, toolCalling: true, contextLength: 'Unknown', speed: 'Unknown', cost: 'Unknown', reasoning: 'Unknown', endpointType: 'Custom', lastSynced: 'Unknown' },
        },
      ],
    });
    seedProviders([provider]);

    setMockModels([
      { id: 'gpt-4o', name: 'GPT-4o' },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
    ]);

    const result = await useAIStore.getState().syncProviderModels('test-provider-1');

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const updated = useAIStore.getState().providerConfigs.find((p) => p.id === 'test-provider-1')!;
    const modelIds = updated.models!.map((m) => m.id);

    // Imported models present
    expect(modelIds).toContain('gpt-4o');
    expect(modelIds).toContain('gpt-4o-mini');
    // Custom model preserved
    expect(modelIds).toContain('custom-model-1');
  });

  it('preserves hidden model choices', async () => {
    const provider = makeProvider();
    seedProviders([provider]);
    seedHiddenModels(['test-provider-1:gpt-4o-mini']);

    setMockModels([
      { id: 'gpt-4o', name: 'GPT-4o' },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
    ]);

    await useAIStore.getState().syncProviderModels('test-provider-1');

    // Hidden models should remain unchanged
    expect(useAIStore.getState().hiddenModels).toContain('test-provider-1:gpt-4o-mini');
  });

  it('keeps selected model when it still exists after sync', async () => {
    const provider = makeProvider({ selectedModel: 'gpt-4o' });
    seedProviders([provider]);

    setMockModels([
      { id: 'gpt-4o', name: 'GPT-4o' },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
    ]);

    await useAIStore.getState().syncProviderModels('test-provider-1');

    const updated = useAIStore.getState().providerConfigs.find((p) => p.id === 'test-provider-1')!;
    expect(updated.selectedModel).toBe('gpt-4o');
  });

  it('falls back to first imported model when selected model disappears', async () => {
    const provider = makeProvider({ selectedModel: 'old-model' });
    seedProviders([provider]);

    setMockModels([
      { id: 'gpt-4o', name: 'GPT-4o' },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
    ]);

    await useAIStore.getState().syncProviderModels('test-provider-1');

    const updated = useAIStore.getState().providerConfigs.find((p) => p.id === 'test-provider-1')!;
    expect(updated.selectedModel).toBe('gpt-4o');
  });

  it('marks provider as connection_failed on fetch error', async () => {
    seedProviders([makeProvider()]);
    setMockFailure('request_failed', 'Connection refused');

    const result = await useAIStore.getState().syncProviderModels('test-provider-1');

    expect(result.ok).toBe(false);
    const updated = useAIStore.getState().providerConfigs.find((p) => p.id === 'test-provider-1')!;
    expect(updated.status).toBe('connection_failed');
  });

  it('returns ok with added/removed/unchanged counts', async () => {
    seedProviders([makeProvider()]);

    setMockModels([
      { id: 'gpt-4o', name: 'GPT-4o' },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
      { id: 'gpt-4-turbo', name: 'GPT-4 Turbo' },
    ]);

    const result = await useAIStore.getState().syncProviderModels('test-provider-1');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.added).toBe(1); // gpt-4-turbo is new
    expect(result.updatedAt).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Hidden models
// ---------------------------------------------------------------------------

describe('hidden model management', () => {
  it('setModelHidden adds a key when hiding', () => {
    seedHiddenModels([]);
    useAIStore.getState().setModelHidden('p1', 'model-a', true);

    expect(useAIStore.getState().hiddenModels).toContain('p1:model-a');
  });

  it('setModelHidden removes a key when showing', () => {
    seedHiddenModels(['p1:model-a']);
    useAIStore.getState().setModelHidden('p1', 'model-a', false);

    expect(useAIStore.getState().hiddenModels).not.toContain('p1:model-a');
  });

  it('setModelHidden is idempotent', () => {
    seedHiddenModels([]);
    useAIStore.getState().setModelHidden('p1', 'model-a', true);
    useAIStore.getState().setModelHidden('p1', 'model-a', true);

    expect(useAIStore.getState().hiddenModels.filter((k) => k === 'p1:model-a')).toHaveLength(1);
  });

  it('toggleHiddenModel toggles presence', () => {
    seedHiddenModels([]);
    useAIStore.getState().toggleHiddenModel('p1:model-a');
    expect(useAIStore.getState().hiddenModels).toContain('p1:model-a');

    useAIStore.getState().toggleHiddenModel('p1:model-a');
    expect(useAIStore.getState().hiddenModels).not.toContain('p1:model-a');
  });

  it('isModelHidden returns correct state', () => {
    seedHiddenModels(['p1:model-a']);
    expect(useAIStore.getState().isModelHidden('p1', 'model-a')).toBe(true);
    expect(useAIStore.getState().isModelHidden('p1', 'model-b')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// deleteCustomProvider
// ---------------------------------------------------------------------------

describe('deleteCustomProvider', () => {
  it('removes the provider from state and Dexie', async () => {
    const p1 = makeProvider({ id: 'p1' });
    const p2 = makeProvider({ id: 'p2', status: 'connected' });
    seedProviders([p1, p2]);
    useAIStore.setState({ activeProviderId: 'p1' });

    await useAIStore.getState().deleteCustomProvider('p1');

    const state = useAIStore.getState();
    expect(state.providerConfigs.find((p) => p.id === 'p1')).toBeUndefined();
    expect(db.providerConfigs.delete).toHaveBeenCalledWith('p1');
  });

  it('selects next connected provider when active is deleted', async () => {
    const p1 = makeProvider({ id: 'p1' });
    const p2 = makeProvider({ id: 'p2', status: 'connected' });
    seedProviders([p1, p2]);
    useAIStore.setState({ activeProviderId: 'p1' });

    await useAIStore.getState().deleteCustomProvider('p1');

    expect(useAIStore.getState().activeProviderId).toBe('p2');
  });

  it('falls back to first remaining provider when no connected provider exists', async () => {
    const p1 = makeProvider({ id: 'p1' });
    const p2 = makeProvider({ id: 'p2', status: 'sync_needed' });
    seedProviders([p1, p2]);
    useAIStore.setState({ activeProviderId: 'p1' });

    await useAIStore.getState().deleteCustomProvider('p1');

    expect(useAIStore.getState().activeProviderId).toBe('p2');
  });

  it('sets activeProviderId to null when no providers remain', async () => {
    seedProviders([makeProvider({ id: 'p1' })]);
    useAIStore.setState({ activeProviderId: 'p1' });

    await useAIStore.getState().deleteCustomProvider('p1');

    expect(useAIStore.getState().activeProviderId).toBeNull();
  });

  it('clears appManagementProviderId when it pointed to deleted provider', async () => {
    seedProviders([makeProvider({ id: 'p1' })]);
    useAIStore.setState({ activeProviderId: 'p1', appManagementProviderId: 'p1' });

    await useAIStore.getState().deleteCustomProvider('p1');

    expect(useAIStore.getState().appManagementProviderId).toBeNull();
  });

  it('deletes the API key from secure storage', async () => {
    seedProviders([makeProvider({ id: 'p1' })]);

    await useAIStore.getState().deleteCustomProvider('p1');

    expect(secureStorage.secureDelete).toHaveBeenCalledWith('providerApiKey_p1');
  });
});

// ---------------------------------------------------------------------------
// addModelToProvider / removeModelFromProvider
// ---------------------------------------------------------------------------

describe('custom model CRUD', () => {
  it('addModelToProvider adds a custom model to the provider', () => {
    seedProviders([makeProvider()]);
    useAIStore.getState().addModelToProvider('test-provider-1', 'my-custom-model');

    const provider = useAIStore.getState().providerConfigs.find((p) => p.id === 'test-provider-1')!;
    const added = provider.models!.find((m) => m.id === 'my-custom-model');
    expect(added).toBeDefined();
    expect(added!.custom).toBe(true);
    expect(provider.customModels).toContain('my-custom-model');
  });

  it('addModelToProvider ignores duplicates already in customModels', () => {
    const provider = makeProvider({ customModels: ['my-custom'] });
    seedProviders([provider]);

    // First add succeeds
    useAIStore.getState().addModelToProvider('test-provider-1', 'my-custom');
    // Second add is a no-op because it's already in customModels
    useAIStore.getState().addModelToProvider('test-provider-1', 'my-custom');

    const updated = useAIStore.getState().providerConfigs.find((p) => p.id === 'test-provider-1')!;
    expect(updated.customModels.filter((m) => m === 'my-custom')).toHaveLength(1);
  });

  it('addModelToProvider ignores blank slugs', () => {
    seedProviders([makeProvider()]);
    const modelsBefore = useAIStore.getState().providerConfigs[0].models!.length;

    useAIStore.getState().addModelToProvider('test-provider-1', '  ');

    expect(useAIStore.getState().providerConfigs[0].models!.length).toBe(modelsBefore);
  });

  it('removeModelFromProvider removes model and updates selectedModel', () => {
    const provider = makeProvider({ selectedModel: 'gpt-4o' });
    seedProviders([provider]);

    useAIStore.getState().removeModelFromProvider('test-provider-1', 'gpt-4o');

    const updated = useAIStore.getState().providerConfigs.find((p) => p.id === 'test-provider-1')!;
    expect(updated.models!.find((m) => m.id === 'gpt-4o')).toBeUndefined();
    // Should fall back to the next model
    expect(updated.selectedModel).toBe('gpt-4o-mini');
  });

  it('removeModelFromProvider clears selectedModel when last model is removed', () => {
    const provider = makeProvider({
      selectedModel: 'only-model',
      models: [{
        id: 'only-model',
        name: 'Only Model',
        enabled: true,
        custom: true,
        capabilities: { vision: false, toolCalling: true, contextLength: 'Unknown', speed: 'Unknown', cost: 'Unknown', reasoning: 'Unknown', endpointType: 'Custom', lastSynced: 'Unknown' },
      }],
    });
    seedProviders([provider]);

    useAIStore.getState().removeModelFromProvider('test-provider-1', 'only-model');

    const updated = useAIStore.getState().providerConfigs.find((p) => p.id === 'test-provider-1')!;
    expect(updated.selectedModel).toBe('');
  });

  it('removeModelFromProvider clears the hiddenModels key for the removed model', () => {
    const provider = makeProvider({
      customModels: ['custom-a'],
      models: [
        ...(makeProvider().models ?? []),
        {
          id: 'custom-a',
          name: 'custom-a',
          enabled: true,
          custom: true,
          capabilities: { vision: false, toolCalling: true, contextLength: 'Unknown', speed: 'Unknown', cost: 'Unknown', reasoning: 'Unknown', endpointType: 'Custom', lastSynced: 'Unknown' },
        },
      ],
    });
    seedProviders([provider]);
    seedHiddenModels(['test-provider-1:custom-a', 'other:model']);

    useAIStore.getState().removeModelFromProvider('test-provider-1', 'custom-a');

    expect(useAIStore.getState().hiddenModels).toEqual(['other:model']);
  });
});

describe('setProviderModelsHidden', () => {
  it('hides all models for a provider without touching other providers', () => {
    seedProviders([makeProvider()]);
    seedHiddenModels(['other:model']);

    useAIStore.getState().setProviderModelsHidden('test-provider-1', true);

    const hidden = useAIStore.getState().hiddenModels;
    expect(hidden).toContain('other:model');
    expect(hidden).toContain('test-provider-1:gpt-4o');
    expect(hidden).toContain('test-provider-1:gpt-4o-mini');
  });

  it('shows all models for a provider', () => {
    seedProviders([makeProvider()]);
    seedHiddenModels([
      'test-provider-1:gpt-4o',
      'test-provider-1:gpt-4o-mini',
      'other:model',
    ]);

    useAIStore.getState().setProviderModelsHidden('test-provider-1', false);

    expect(useAIStore.getState().hiddenModels).toEqual(['other:model']);
  });
});

// ---------------------------------------------------------------------------
// setModelSupportsTools / setModelReasoning
// ---------------------------------------------------------------------------

describe('model metadata mutations', () => {
  it('setModelSupportsTools toggles the supportsTools flag', () => {
    seedProviders([makeProvider()]);
    useAIStore.getState().setModelSupportsTools('test-provider-1', 'gpt-4o', false);

    const updated = useAIStore.getState().providerConfigs.find((p) => p.id === 'test-provider-1')!;
    const model = updated.models!.find((m) => m.id === 'gpt-4o')!;
    expect(model.supportsTools).toBe(false);
  });

  it('setModelReasoning sets selectedReasoning on the model', () => {
    seedProviders([makeProvider()]);
    useAIStore.getState().setModelReasoning('test-provider-1', 'gpt-4o', 'high');

    const updated = useAIStore.getState().providerConfigs.find((p) => p.id === 'test-provider-1')!;
    const model = updated.models!.find((m) => m.id === 'gpt-4o')!;
    expect(model.selectedReasoning).toBe('high');
  });

  it('setModelReasoningDescriptor sets the reasoning descriptor', () => {
    seedProviders([makeProvider()]);

    const descriptor = {
      param: 'reasoning_effort' as const,
      source: 'manual' as const,
      options: [
        { label: 'Low', value: 'low' },
        { label: 'High', value: 'high' },
      ],
    };

    useAIStore.getState().setModelReasoningDescriptor('test-provider-1', 'gpt-4o', descriptor);

    const updated = useAIStore.getState().providerConfigs.find((p) => p.id === 'test-provider-1')!;
    const model = updated.models!.find((m) => m.id === 'gpt-4o')!;
    expect(model.reasoning).toEqual(descriptor);
  });
});

// ---------------------------------------------------------------------------
// setActiveModel
// ---------------------------------------------------------------------------

describe('setActiveModel', () => {
  it('updates selectedModel on the provider', () => {
    seedProviders([makeProvider()]);
    useAIStore.getState().setActiveModel('test-provider-1', 'gpt-4o-mini');

    const updated = useAIStore.getState().providerConfigs.find((p) => p.id === 'test-provider-1')!;
    expect(updated.selectedModel).toBe('gpt-4o-mini');
  });

  it('persists the change to Dexie', () => {
    seedProviders([makeProvider()]);
    useAIStore.getState().setActiveModel('test-provider-1', 'gpt-4o-mini');

    expect(db.providerConfigs.update).toHaveBeenCalledWith('test-provider-1', { selectedModel: 'gpt-4o-mini' });
  });
});

// ---------------------------------------------------------------------------
// getEnabledModels / getAllEnabledModels
// ---------------------------------------------------------------------------

describe('getEnabledModels', () => {
  it('returns non-hidden models for a connected provider', () => {
    const provider = makeProvider({ status: 'connected' });
    seedProviders([provider]);
    seedHiddenModels(['test-provider-1:gpt-4o-mini']);

    const enabled = useAIStore.getState().getEnabledModels('test-provider-1');
    expect(enabled).toHaveLength(1);
    expect(enabled[0].id).toBe('gpt-4o');
  });

  it('returns empty array for non-connected provider', () => {
    const provider = makeProvider({ status: 'needs_key' });
    seedProviders([provider]);

    const enabled = useAIStore.getState().getEnabledModels('test-provider-1');
    expect(enabled).toHaveLength(0);
  });
});

describe('refreshProviderStatus', () => {
  it('recovers from connection_failed when key and models exist', async () => {
    seedProviders([makeProvider({ status: 'connection_failed' })]);
    await secureStorage.secureSet('providerApiKey_test-provider-1', 'sk-test-123');

    await useAIStore.getState().refreshProviderStatus('test-provider-1');

    const updated = useAIStore.getState().providerConfigs.find((p) => p.id === 'test-provider-1')!;
    expect(updated.status).toBe('connected');
  });

  it('keeps connection_failed when models are still missing', async () => {
    seedProviders([
      makeProvider({
        status: 'connection_failed',
        models: [],
        selectedModel: '',
      }),
    ]);
    await secureStorage.secureSet('providerApiKey_test-provider-1', 'sk-test-123');

    await useAIStore.getState().refreshProviderStatus('test-provider-1');

    const updated = useAIStore.getState().providerConfigs.find((p) => p.id === 'test-provider-1')!;
    expect(updated.status).toBe('connection_failed');
  });
});

describe('getAllEnabledModels', () => {
  it('returns enabled models from all connected providers', () => {
    const p1 = makeProvider({ id: 'p1', status: 'connected' });
    const p2 = makeProvider({ id: 'p2', status: 'connected' });
    seedProviders([p1, p2]);
    seedHiddenModels(['p1:gpt-4o-mini']);

    const all = useAIStore.getState().getAllEnabledModels();
    // p1: gpt-4o only (mini hidden), p2: both
    expect(all).toHaveLength(3);
  });
});
