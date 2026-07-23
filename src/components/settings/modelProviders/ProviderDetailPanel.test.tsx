import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProviderDetailPanel } from './ProviderDetailPanel';
import type { AIProviderConfig } from '../../../types';

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

// Mock child components to isolate ProviderDetailPanel behavior
vi.mock('../../modals/modelProvider/ProviderStatusBadge', () => ({
  ProviderStatusBadge: ({ status }: { status: string }) => (
    <span data-testid="status-badge">{status}</span>
  ),
}));

vi.mock('./ProviderConnectionTab', () => ({
  ProviderConnectionTab: () => <div data-testid="connection-tab">Connection Tab</div>,
}));

vi.mock('./ProviderModelsTab', () => ({
  ProviderModelsTab: () => <div data-testid="models-tab">Models Tab</div>,
}));

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
      {
        id: 'gpt-4o',
        name: 'GPT-4o',
        enabled: true,
        capabilities: { vision: true, toolCalling: true, contextLength: '128k', speed: 'Fast', cost: 'Paid', reasoning: 'High', endpointType: 'Native', lastSynced: 'Just now' },
      },
    ],
    ...overrides,
  };
}

describe('ProviderDetailPanel', () => {
  const defaultProps = {
    provider: makeProvider(),
    hiddenModels: [],
    draftKey: '',
    draftBaseUrl: '',
    testConnectionState: { phase: 'idle' as const },
    onDraftKeyChange: vi.fn(),
    onDraftBaseUrlChange: vi.fn(),
    onTestConnection: vi.fn(),
    onSyncModels: vi.fn(),
    onToggleModel: vi.fn(),
    onToggleAllModels: vi.fn(),
    onToggleModelTools: vi.fn(),
    onSetModelReasoningDescriptor: vi.fn(),
    onAddCustomModel: vi.fn(),
    onRemoveCustomModel: vi.fn(),
    onDeleteProvider: vi.fn(),
  };

  it('renders provider name in the header', () => {
    render(<ProviderDetailPanel {...defaultProps} />);

    expect(screen.getByText('Test Provider')).toBeInTheDocument();
  });

  it('renders the status badge', () => {
    render(<ProviderDetailPanel {...defaultProps} />);

    expect(screen.getByTestId('status-badge')).toHaveTextContent('connected');
  });

  it('renders enabled/total model count', () => {
    render(<ProviderDetailPanel {...defaultProps} />);

    expect(screen.getByText('1/1 models.tabModels')).toBeInTheDocument();
  });

  it('renders connection and models tabs', () => {
    render(<ProviderDetailPanel {...defaultProps} />);

    expect(screen.getByText('models.tabConnection')).toBeInTheDocument();
    expect(screen.getByText('models.tabModels')).toBeInTheDocument();
  });

  it('shows connection tab by default', () => {
    render(<ProviderDetailPanel {...defaultProps} />);

    expect(screen.getByTestId('connection-tab')).toBeInTheDocument();
    expect(screen.queryByTestId('models-tab')).not.toBeInTheDocument();
  });

  it('switches to models tab when clicked', async () => {
    render(<ProviderDetailPanel {...defaultProps} />);

    await userEvent.click(screen.getByText('models.tabModels'));

    expect(screen.getByTestId('models-tab')).toBeInTheDocument();
    expect(screen.queryByTestId('connection-tab')).not.toBeInTheDocument();
  });

  it('switches back to connection tab when clicked', async () => {
    render(<ProviderDetailPanel {...defaultProps} />);

    await userEvent.click(screen.getByText('models.tabModels'));
    await userEvent.click(screen.getByText('models.tabConnection'));

    expect(screen.getByTestId('connection-tab')).toBeInTheDocument();
    expect(screen.queryByTestId('models-tab')).not.toBeInTheDocument();
  });

  it('renders delete button', () => {
    render(<ProviderDetailPanel {...defaultProps} />);

    expect(screen.getByLabelText('models.deleteProvider')).toBeInTheDocument();
  });

  it('shows delete confirmation popover when delete button is clicked', async () => {
    render(<ProviderDetailPanel {...defaultProps} />);

    await userEvent.click(screen.getByLabelText('models.deleteProvider'));

    expect(screen.getByText('models.confirmDelete')).toBeInTheDocument();
  });

  it('calls onDeleteProvider when delete is confirmed', async () => {
    const onDeleteProvider = vi.fn();
    render(<ProviderDetailPanel {...defaultProps} onDeleteProvider={onDeleteProvider} />);

    // Open delete confirmation
    await userEvent.click(screen.getByLabelText('models.deleteProvider'));
    // Click confirm
    await userEvent.click(screen.getByText('models.deleteProvider'));

    expect(onDeleteProvider).toHaveBeenCalledWith('p1');
  });

  it('closes delete popover when cancel is clicked', async () => {
    render(<ProviderDetailPanel {...defaultProps} />);

    await userEvent.click(screen.getByLabelText('models.deleteProvider'));
    expect(screen.getByText('models.confirmDelete')).toBeInTheDocument();

    await userEvent.click(screen.getByText('models.cancel'));
    expect(screen.queryByText('models.confirmDelete')).not.toBeInTheDocument();
  });

  it('closes delete popover when Escape is pressed', async () => {
    render(<ProviderDetailPanel {...defaultProps} />);

    await userEvent.click(screen.getByLabelText('models.deleteProvider'));
    expect(screen.getByText('models.confirmDelete')).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByText('models.confirmDelete')).not.toBeInTheDocument();
  });

  it('shows enabled count correctly when some models are hidden', () => {
    render(
      <ProviderDetailPanel
        {...defaultProps}
        provider={makeProvider({
          models: [
            { id: 'm1', name: 'M1', enabled: true, capabilities: { vision: false, toolCalling: true, contextLength: 'Unknown', speed: 'Unknown', cost: 'Unknown', reasoning: 'Unknown', endpointType: 'Native', lastSynced: 'Just now' } },
            { id: 'm2', name: 'M2', enabled: true, capabilities: { vision: false, toolCalling: true, contextLength: 'Unknown', speed: 'Unknown', cost: 'Unknown', reasoning: 'Unknown', endpointType: 'Native', lastSynced: 'Just now' } },
          ],
        })}
        hiddenModels={['p1:m2']}
      />
    );

    // 1 enabled out of 2 total
    expect(screen.getByText('1/2 models.tabModels')).toBeInTheDocument();
  });

  it('shows last imported timestamp when available', () => {
    const ts = new Date('2025-01-15T10:30:00Z').getTime();
    render(
      <ProviderDetailPanel
        {...defaultProps}
        provider={makeProvider({ lastImportedAt: ts })}
      />
    );

    // The component passes the date string through the t() mock, which appends :<time>
    // Just verify the timestamp label key is rendered (it's only rendered when lastImportedAt exists)
    expect(screen.getByText(/models\.lastImportedAt/)).toBeInTheDocument();
  });

  it('renders master switch checked when all models are enabled', () => {
    render(<ProviderDetailPanel {...defaultProps} />);

    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  });

  it('renders master switch unchecked when any model is hidden', () => {
    render(
      <ProviderDetailPanel
        {...defaultProps}
        provider={makeProvider({
          models: [
            { id: 'm1', name: 'M1', enabled: true, capabilities: { vision: false, toolCalling: true, contextLength: 'Unknown', speed: 'Unknown', cost: 'Unknown', reasoning: 'Unknown', endpointType: 'Native', lastSynced: 'Just now' } },
            { id: 'm2', name: 'M2', enabled: true, capabilities: { vision: false, toolCalling: true, contextLength: 'Unknown', speed: 'Unknown', cost: 'Unknown', reasoning: 'Unknown', endpointType: 'Native', lastSynced: 'Just now' } },
          ],
        })}
        hiddenModels={['p1:m2']}
      />
    );

    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  });

  it('calls onToggleAllModels when master switch is clicked', async () => {
    const onToggleAllModels = vi.fn();
    render(<ProviderDetailPanel {...defaultProps} onToggleAllModels={onToggleAllModels} />);

    await userEvent.click(screen.getByRole('switch'));

    expect(onToggleAllModels).toHaveBeenCalledWith('p1', false);
  });

  it('disables master switch when provider has no models', () => {
    render(
      <ProviderDetailPanel
        {...defaultProps}
        provider={makeProvider({ models: [] })}
      />
    );

    expect(screen.getByRole('switch')).toBeDisabled();
  });
});
