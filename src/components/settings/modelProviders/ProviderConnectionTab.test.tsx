import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProviderConnectionTab } from './ProviderConnectionTab';
import type { AIProviderConfig } from '../../../types';

// Mock react-i18next to return translation keys
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts?.time) return `${key}:${opts.time}`;
      if (opts?.model) return `${key}:${opts.model}`;
      if (opts?.count !== undefined) return `${key}:${opts.count}`;
      return key;
    },
    i18n: { language: 'en' },
  }),
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
    lastImportedAt: 1700000000000,
    ...overrides,
  };
}

describe('ProviderConnectionTab', () => {
  const defaultProps = {
    provider: makeProvider(),
    draftKey: 'sk-test',
    draftBaseUrl: 'https://api.example.com/v1',
    testConnectionState: { phase: 'idle' as const },
    onDraftKeyChange: vi.fn(),
    onDraftBaseUrlChange: vi.fn(),
    onTestConnection: vi.fn(),
  };

  it('renders connected summary when provider is connected', () => {
    render(<ProviderConnectionTab {...defaultProps} />);

    expect(screen.getByText('models.connected')).toBeInTheDocument();
    expect(screen.getByText('models.baseUrl')).toBeInTheDocument();
    expect(screen.getByText('models.tabModels')).toBeInTheDocument();
  });

  it('renders edit connection button when connected', () => {
    render(<ProviderConnectionTab {...defaultProps} />);

    expect(screen.getByText('models.editConnection')).toBeInTheDocument();
  });

  it('switches to edit form when edit connection is clicked', async () => {
    const user = userEvent.setup();
    render(<ProviderConnectionTab {...defaultProps} />);

    await user.click(screen.getByText('models.editConnection'));

    // Should now show the API key input and test connection button
    expect(screen.getByText('models.reconnect')).toBeInTheDocument();
  });

  it('renders edit form when provider is not connected', () => {
    const props = {
      ...defaultProps,
      provider: makeProvider({ status: 'needs_key' as const }),
    };
    render(<ProviderConnectionTab {...props} />);

    expect(screen.getByText('models.connect')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('https://api.example.com/v1')).toBeInTheDocument();
  });

  it('disables test button when credentials are empty', () => {
    const props = {
      ...defaultProps,
      provider: makeProvider({ status: 'needs_key' as const }),
      draftKey: '',
      draftBaseUrl: '',
    };
    render(<ProviderConnectionTab {...props} />);

    const button = screen.getByText('models.connect').closest('button')!;
    expect(button).toBeDisabled();
  });

  it('enables test button when credentials are provided', () => {
    const props = {
      ...defaultProps,
      provider: makeProvider({ status: 'needs_key' as const }),
      draftKey: 'sk-test',
      draftBaseUrl: 'https://api.example.com/v1',
    };
    render(<ProviderConnectionTab {...props} />);

    const button = screen.getByText('models.connect').closest('button')!;
    expect(button).not.toBeDisabled();
  });

  it('shows testing state while connection is in progress', () => {
    const props = {
      ...defaultProps,
      provider: makeProvider({ status: 'needs_key' as const }),
      testConnectionState: { phase: 'testing' as const },
    };
    render(<ProviderConnectionTab {...props} />);

    expect(screen.getByText('models.connecting')).toBeInTheDocument();
  });

  it('shows success feedback after successful test for non-connected provider', () => {
    const props = {
      ...defaultProps,
      provider: makeProvider({ status: 'needs_key' as const }),
      testConnectionState: { phase: 'success' as const },
    };
    render(<ProviderConnectionTab {...props} />);

    expect(screen.getByText('models.providerConnected')).toBeInTheDocument();
  });

  it('shows error feedback after failed test', () => {
    const props = {
      ...defaultProps,
      provider: makeProvider({ status: 'needs_key' as const }),
      testConnectionState: { phase: 'error' as const, message: 'Connection refused' },
    };
    render(<ProviderConnectionTab {...props} />);

    expect(screen.getByText('Connection refused')).toBeInTheDocument();
  });

  it('calls onTestConnection when test button is clicked', async () => {
    const onTestConnection = vi.fn();
    const props = {
      ...defaultProps,
      provider: makeProvider({ status: 'needs_key' as const }),
      onTestConnection,
    };
    render(<ProviderConnectionTab {...props} />);

    const button = screen.getByText('models.connect').closest('button')!;
    await userEvent.click(button);

    expect(onTestConnection).toHaveBeenCalledTimes(1);
  });

  it('shows base URL input with current draft value', () => {
    const props = {
      ...defaultProps,
      provider: makeProvider({ status: 'needs_key' as const }),
      draftBaseUrl: 'https://custom.api.com/v1',
    };
    render(<ProviderConnectionTab {...props} />);

    const input = screen.getByPlaceholderText('https://api.example.com/v1');
    expect(input).toHaveValue('https://custom.api.com/v1');
  });

  it('calls onDraftBaseUrlChange when URL input changes', async () => {
    const onDraftBaseUrlChange = vi.fn();
    const props = {
      ...defaultProps,
      provider: makeProvider({ status: 'needs_key' as const }),
      onDraftBaseUrlChange,
    };
    render(<ProviderConnectionTab {...props} />);

    const input = screen.getByPlaceholderText('https://api.example.com/v1');
    await userEvent.clear(input);
    await userEvent.type(input, 'https://new.api.com');

    expect(onDraftBaseUrlChange).toHaveBeenCalled();
  });
});
