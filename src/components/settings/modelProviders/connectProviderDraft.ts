/**
 * Connect an existing provider from draft credentials.
 * Persists the API key, imports models, and activates the provider.
 * Unlike testProviderConnection, this is not read-only.
 */

export type ConnectProviderDraftResult =
  | { ok: true }
  | { ok: false; error: string };

export interface ConnectProviderDraftDeps {
  importProviderModels: (
    id: string,
    baseUrl: string,
    apiKey: string,
  ) => Promise<{ ok: true } | { ok: false; error: string; code?: string }>;
  setActiveProvider: (id: string) => void;
}

export async function connectProviderFromDraft(
  deps: ConnectProviderDraftDeps,
  providerId: string,
  baseUrl: string,
  apiKey: string,
): Promise<ConnectProviderDraftResult> {
  const result = await deps.importProviderModels(providerId, baseUrl, apiKey);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  deps.setActiveProvider(providerId);
  return { ok: true };
}
