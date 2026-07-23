import { describe, it, expect, vi } from 'vitest';
import { connectProviderFromDraft } from './connectProviderDraft';

describe('connectProviderFromDraft', () => {
  it('persists credentials and imports models via importProviderModels', async () => {
    const importProviderModels = vi.fn().mockResolvedValue({ ok: true });
    const setActiveProvider = vi.fn();

    const result = await connectProviderFromDraft(
      { importProviderModels, setActiveProvider },
      'openai',
      'https://api.openai.com/v1',
      'sk-test-123',
    );

    expect(result).toEqual({ ok: true });
    expect(importProviderModels).toHaveBeenCalledWith(
      'openai',
      'https://api.openai.com/v1',
      'sk-test-123',
    );
    expect(setActiveProvider).toHaveBeenCalledWith('openai');
  });

  it('returns the import error without activating the provider', async () => {
    const importProviderModels = vi.fn().mockResolvedValue({
      ok: false,
      error: 'Invalid API key',
      code: 'auth',
    });
    const setActiveProvider = vi.fn();

    const result = await connectProviderFromDraft(
      { importProviderModels, setActiveProvider },
      'openai',
      'https://api.openai.com/v1',
      'bad-key',
    );

    expect(result).toEqual({ ok: false, error: 'Invalid API key' });
    expect(setActiveProvider).not.toHaveBeenCalled();
  });

  it('does not call the read-only test path', async () => {
    const importProviderModels = vi.fn().mockResolvedValue({ ok: true });
    const testProviderConnection = vi.fn();

    await connectProviderFromDraft(
      { importProviderModels, setActiveProvider: vi.fn() },
      'openai',
      'https://api.openai.com/v1',
      'sk-test-123',
    );

    expect(testProviderConnection).not.toHaveBeenCalled();
  });
});
