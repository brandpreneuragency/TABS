import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProviderModelsTab } from './ProviderModelsTab';
import type { AIProviderConfig, ModelItem } from '../../../types';

// Mock react-i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts?.count !== undefined) return `${key}:${opts.count}`;
      if (opts?.model) return `${key}:${opts.model}`;
      if (opts?.provider) return `${key}:${opts.provider}`;
      return key;
    },
    i18n: { language: 'en' },
  }),
}));

// Mock the uiStore used by the component
vi.mock('../../../stores/uiStore', () => ({
  useUIStore: {
    getState: vi.fn().mockReturnValue({ showToast: vi.fn() }),
  },
}));

// Mock the reasoning service
vi.mock('../../../services/ai/reasoning', () => ({
  resolveReasoning: vi.fn().mockReturnValue(null),
  refreshReasoningCatalog: vi.fn().mockResolvedValue(undefined),
}));

// Mock child components that have complex dependencies
vi.mock('../../modals/modelProvider/ModelSwitch', () => ({
  ModelSwitch: ({ checked, onChange, ariaLabel }: { checked: boolean; onChange: (v: boolean) => void; ariaLabel: string }) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={() => onChange(!checked)}
      data-testid="model-switch"
    >
      {checked ? 'on' : 'off'}
    </button>
  ),
}));

vi.mock('../../modals/modelProvider/ModelHoverCard', () => ({
  ModelHoverCard: () => null,
}));

vi.mock('../../modals/modelProvider/AddCustomModelInput', () => ({
  AddCustomModelInput: ({ onAdd, existingIds }: { onAdd: (slug: string) => void; existingIds: string[] }) => (
    <div data-testid="add-custom-model">
      <button onClick={() => onAdd('new-model')}>Add</button>
      <span data-testid="existing-ids">{existingIds.join(',')}</span>
    </div>
  ),
}));

function makeModel(id: string, overrides: Partial<ModelItem> = {}): ModelItem {
  return {
    id,
    name: id,
    enabled: true,
    capabilities: {
      vision: false,
      toolCalling: true,
      contextLength: 'Unknown',
      speed: 'Unknown',
      cost: 'Unknown',
      reasoning: 'Unknown',
      endpointType: 'Native',
      lastSynced: 'Just now',
    },
    ...overrides,
  };
}

function makeProvider(overrides: Partial<AIProviderConfig> = {}): AIProviderConfig {
  return {
    id: 'p1',
    name: 'Test Provider',
    provider: 'custom',
    apiKey: '',
    selectedModel: 'gpt-4o',
    isActive: true,
    baseUrl: 'https://api.example.com/v1',
    customModels: [],
    status: 'connected',
    models: [
      makeModel('gpt-4o', { name: 'GPT-4o', capabilities: { vision: true, toolCalling: true, contextLength: '128k', speed: 'Fast', cost: 'Paid', reasoning: 'High', endpointType: 'Native', lastSynced: 'Just now' } }),
      makeModel('gpt-4o-mini', { name: 'GPT-4o Mini' }),
      makeModel('dall-e-3', { name: 'DALL-E 3', capabilities: { vision: true, toolCalling: false, contextLength: 'Unknown', speed: 'Slow', cost: 'Paid', reasoning: 'Unknown', endpointType: 'Native', lastSynced: 'Just now' } }),
    ],
    ...overrides,
  };
}

describe('ProviderModelsTab', () => {
  const defaultProps = {
    provider: makeProvider(),
    hiddenModels: [],
    onToggleModel: vi.fn(),
    onToggleModelTools: vi.fn(),
    onSetModelReasoningDescriptor: vi.fn(),
    onAddCustomModel: vi.fn(),
    onRemoveCustomModel: vi.fn(),
    onSyncModels: vi.fn(),
  };

  it('renders all models in the table', () => {
    render(<ProviderModelsTab {...defaultProps} />);

    expect(screen.getByText('GPT-4o')).toBeInTheDocument();
    expect(screen.getByText('GPT-4o Mini')).toBeInTheDocument();
    expect(screen.getByText('DALL-E 3')).toBeInTheDocument();
  });

  it('renders model count', () => {
    render(<ProviderModelsTab {...defaultProps} />);

    expect(screen.getByText('models.modelCount:3')).toBeInTheDocument();
  });

  it('renders search input', () => {
    render(<ProviderModelsTab {...defaultProps} />);

    expect(screen.getByPlaceholderText('models.searchModels')).toBeInTheDocument();
  });

  it('renders sync button when onSyncModels is provided', () => {
    render(<ProviderModelsTab {...defaultProps} />);

    expect(screen.getByText('models.syncModels')).toBeInTheDocument();
  });

  it('does not render sync button when onSyncModels is not provided', () => {
    const { onSyncModels: _onSyncModels, ...rest } = defaultProps; // eslint-disable-line @typescript-eslint/no-unused-vars
    render(<ProviderModelsTab {...rest} />);

    expect(screen.queryByText('models.syncModels')).not.toBeInTheDocument();
  });

  it('calls onSyncModels when sync button is clicked', async () => {
    const onSyncModels = vi.fn();
    render(<ProviderModelsTab {...defaultProps} onSyncModels={onSyncModels} />);

    await userEvent.click(screen.getByText('models.syncModels'));

    expect(onSyncModels).toHaveBeenCalledTimes(1);
  });

  it('filters models by search text', async () => {
    render(<ProviderModelsTab {...defaultProps} />);

    const search = screen.getByPlaceholderText('models.searchModels');
    await userEvent.type(search, 'mini');

    expect(screen.getByText('GPT-4o Mini')).toBeInTheDocument();
    expect(screen.queryByText('GPT-4o')).not.toBeInTheDocument();
    expect(screen.queryByText('DALL-E 3')).not.toBeInTheDocument();
  });

  it('filters models by enabled filter', async () => {
    const provider = makeProvider();
    render(
      <ProviderModelsTab
        {...defaultProps}
        provider={provider}
        hiddenModels={['p1:dall-e-3']}
      />
    );

    // Click the "Enabled" filter
    await userEvent.click(screen.getByText('models.filterEnabled'));

    // DALL-E 3 is hidden, so it shouldn't appear
    expect(screen.getByText('GPT-4o')).toBeInTheDocument();
    expect(screen.getByText('GPT-4o Mini')).toBeInTheDocument();
    expect(screen.queryByText('DALL-E 3')).not.toBeInTheDocument();
  });

  it('calls onToggleModel when a model switch is toggled', async () => {
    const onToggleModel = vi.fn();
    render(<ProviderModelsTab {...defaultProps} onToggleModel={onToggleModel} />);

    // Find the switch for GPT-4o (it should be the first switch)
    const switches = screen.getAllByRole('switch');
    await userEvent.click(switches[0]);

    expect(onToggleModel).toHaveBeenCalledWith('p1', 'gpt-4o', false);
  });

  it('renders model switches in correct checked state', () => {
    render(
      <ProviderModelsTab
        {...defaultProps}
        hiddenModels={['p1:gpt-4o-mini']}
      />
    );

    const switches = screen.getAllByRole('switch');
    // GPT-4o is enabled (not hidden), GPT-4o-mini is hidden, DALL-E 3 is enabled
    expect(switches[0]).toHaveAttribute('aria-checked', 'true');  // gpt-4o
    expect(switches[1]).toHaveAttribute('aria-checked', 'false'); // gpt-4o-mini
    expect(switches[2]).toHaveAttribute('aria-checked', 'true');  // dall-e-3
  });

  it('renders add custom model input', () => {
    render(<ProviderModelsTab {...defaultProps} />);

    expect(screen.getByTestId('add-custom-model')).toBeInTheDocument();
  });

  it('shows empty state when no models exist', () => {
    const provider = makeProvider({ models: [] });
    render(<ProviderModelsTab {...defaultProps} provider={provider} />);

    expect(screen.getByText('models.noModelsAvailable')).toBeInTheDocument();
  });

  it('shows no results message when search yields nothing', async () => {
    render(<ProviderModelsTab {...defaultProps} />);

    const search = screen.getByPlaceholderText('models.searchModels');
    await userEvent.type(search, 'nonexistent-model-xyz');

    expect(screen.getByText('models.noSearchResults')).toBeInTheDocument();
  });

  it('renders filter buttons', () => {
    render(<ProviderModelsTab {...defaultProps} />);

    expect(screen.getByText('models.filterAll')).toBeInTheDocument();
    expect(screen.getByText('models.filterEnabled')).toBeInTheDocument();
  });

  it('shows custom badge for custom models', () => {
    const provider = makeProvider({
      models: [
        makeModel('gpt-4o', { name: 'GPT-4o' }),
        makeModel('my-custom', { name: 'My Custom Model', custom: true }),
      ],
    });
    render(<ProviderModelsTab {...defaultProps} provider={provider} />);

    expect(screen.getByText('models.sourceCustom')).toBeInTheDocument();
  });

  it('shows remove button only for custom models', () => {
    const provider = makeProvider({
      models: [
        makeModel('gpt-4o', { name: 'GPT-4o' }),
        makeModel('my-custom', { name: 'My Custom Model', custom: true }),
      ],
    });
    render(<ProviderModelsTab {...defaultProps} provider={provider} />);

    expect(screen.getByLabelText('models.removeCustomModel:My Custom Model')).toBeInTheDocument();
    expect(screen.queryByLabelText('models.removeCustomModel:GPT-4o')).not.toBeInTheDocument();
  });

  it('calls onRemoveCustomModel when remove button is clicked', async () => {
    const onRemoveCustomModel = vi.fn();
    const provider = makeProvider({
      models: [
        makeModel('my-custom', { name: 'My Custom Model', custom: true }),
      ],
    });
    render(
      <ProviderModelsTab
        {...defaultProps}
        provider={provider}
        onRemoveCustomModel={onRemoveCustomModel}
      />
    );

    await userEvent.click(screen.getByLabelText('models.removeCustomModel:My Custom Model'));

    expect(onRemoveCustomModel).toHaveBeenCalledWith('p1', 'my-custom');
  });

  it('expands model row to show tools and thinking controls', async () => {
    const provider = makeProvider({
      models: [makeModel('gpt-4o', { name: 'GPT-4o' })],
    });
    render(<ProviderModelsTab {...defaultProps} provider={provider} />);

    // Click the expand button
    const expandButton = screen.getByLabelText('models.expand:GPT-4o');
    await userEvent.click(expandButton);

    // "models.capToolUse" appears both in the capability badge and in the expanded panel
    expect(screen.getAllByText('models.capToolUse').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('models.supportsThinking')).toBeInTheDocument();
  });
});
