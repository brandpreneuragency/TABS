// ModelManagementContent extracted from the (now removed) ModelManagementModal
// so it can be reused inline inside Settings → Tools (LLM) and by PageTemplatePage.
// Uses `selectedProviderId` to show a specific provider's detail panel.
//
// Zustand is the canonical source of truth for provider configs and hidden
// models.  Local state is kept only for the selected provider's editable
// credentials (API key, base URL) and transient connection/test/sync UI.

import { useState, useEffect, useRef, useCallback } from 'react';

import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useUIStore } from '../../stores/uiStore';
import { useAIStore } from '../../stores/aiStore';
import { secureStorage } from '../../services/secureStorage';
import type { ModelReasoning } from '../../types';
import { ProviderDetailPanel } from './modelProviders/ProviderDetailPanel';
import { connectProviderFromDraft } from './modelProviders/connectProviderDraft';


function providerApiKeyName(providerId: string): string {
  return `providerApiKey_${providerId}`;
}

interface ModelManagementContentProps {
  isInline?: boolean;
  onClose?: () => void;
  /** Provider id to show in the detail panel. */
  selectedProviderId?: string | null;
  /** Callback when a provider should be deleted. */
  onDeleteProvider?: (id: string) => void;
}

export function ModelManagementContent({ isInline = false, onClose, selectedProviderId, onDeleteProvider }: ModelManagementContentProps) {
  const { t } = useTranslation();
  const { activeModal, setActiveModal } = useUIStore();
  const providerConfigs = useAIStore((s) => s.providerConfigs);
  const hiddenModels = useAIStore((s) => s.hiddenModels);

  const isOpen = isInline || activeModal === 'modelManagement';
  const modalRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const initialFocusDone = useRef(false);

  // ── Local draft state for the selected provider's credentials ──────────
  const [draftKey, setDraftKey] = useState('');
  const [draftBaseUrl, setDraftBaseUrl] = useState('');

  // ── Transient UI state for test / sync operations ─────────────────────
  const [testConnectionState, setTestConnectionState] = useState<Record<string, { phase: 'idle' | 'testing' | 'success' | 'error'; message?: string }>>({});

  // ── Load API key for the selected provider (cancellation-safe) ────────
  useEffect(() => {
    if (!selectedProviderId || !isOpen) return;
    let cancelled = false;
    const load = async () => {
      try {
        const value = await secureStorage.secureGet(providerApiKeyName(selectedProviderId));
        if (!cancelled) setDraftKey(value ?? '');
      } catch {
        if (!cancelled) setDraftKey('');
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [selectedProviderId, isOpen]);

  // ── Initialise base-URL draft when selection changes ───────────────────
  useEffect(() => {
    if (!selectedProviderId) return;
    const provider = useAIStore.getState().providerConfigs.find((p) => p.id === selectedProviderId);
    setDraftBaseUrl(provider?.baseUrl ?? ''); // eslint-disable-line react-hooks/set-state-in-effect -- seed draft from selected provider
  }, [selectedProviderId]);

  // ── Refresh all provider statuses when settings open ───────────────────
  useEffect(() => {
    if (!isOpen) return;
    void useAIStore.getState().refreshAllProviderStatuses();
  }, [isOpen]);

  // ── Focus management (modal) ──────────────────────────────────────────
  useEffect(() => {
    if (!isOpen) {
      initialFocusDone.current = false;
      return;
    }
    if (!initialFocusDone.current && closeBtnRef.current) {
      initialFocusDone.current = true;
      closeBtnRef.current.focus();
    }
  }, [isOpen]);

  // ── Keyboard trap (modal) ─────────────────────────────────────────────
  useEffect(() => {
    if (!isOpen || isInline) return;

    const modal = modalRef.current;
    if (!modal) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;

      const focusable = modal.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      const elements = Array.from(focusable).filter((el) => {
        const disabled = (el as HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).disabled;
        return !disabled && el.offsetParent !== null;
      });
      if (elements.length === 0) return;

      const first = elements[0];
      const last = elements[elements.length - 1];

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    modal.addEventListener('keydown', handleKeyDown);
    return () => modal.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isInline]);

  // ── Close handler (no save needed — store actions persist immediately) ─
  const handleClose = useCallback(() => {
    if (onClose) onClose();
    else setActiveModal(null);
  }, [onClose, setActiveModal]);

  // ── Escape key ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isOpen || isInline) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleClose();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isOpen, isInline, handleClose]);

  if (!isOpen) return null;

  // ── Model mutation callbacks (delegate to store) ──────────────────────

  const toggleModel = (providerId: string, modelId: string, enabled: boolean) => {
    useAIStore.getState().setModelHidden(providerId, modelId, !enabled);
  };

  const toggleAllModels = (providerId: string, enabled: boolean) => {
    useAIStore.getState().setProviderModelsHidden(providerId, !enabled);
  };

  const toggleModelTools = (providerId: string, modelId: string, supportsTools: boolean) => {
    useAIStore.getState().setModelSupportsTools(providerId, modelId, supportsTools);
  };

  const addCustomModel = (providerId: string, slug: string) => {
    useAIStore.getState().addModelToProvider(providerId, slug);
  };

  const removeCustomModel = (providerId: string, modelId: string) => {
    useAIStore.getState().removeModelFromProvider(providerId, modelId);
  };

  const setModelReasoningDescriptor = (
    providerId: string,
    modelId: string,
    reasoning: ModelReasoning | undefined,
  ) => {
    useAIStore.getState().setModelReasoningDescriptor(providerId, modelId, reasoning);
  };

  // ── Credential draft handlers (local state only) ──────────────────────

  const handleDraftKeyChange = (key: string) => {
    setDraftKey(key);
  };

  const handleDraftBaseUrlChange = (baseUrl: string) => {
    setDraftBaseUrl(baseUrl);
  };

  // ── Connection / sync operations ──────────────────────────────────────

  const handleTestConnection = async (providerId: string) => {
    setTestConnectionState((prev) => ({ ...prev, [providerId]: { phase: 'testing' } }));

    try {
      // Persist key + import models + mark connected (not a read-only test).
      const store = useAIStore.getState();
      const result = await connectProviderFromDraft(
        {
          importProviderModels: store.importProviderModels,
          setActiveProvider: store.setActiveProvider,
        },
        providerId,
        draftBaseUrl,
        draftKey,
      );

      if (result.ok) {
        setTestConnectionState((prev) => ({ ...prev, [providerId]: { phase: 'success' } }));
        // Sync local draft with the normalised URL.
        const updated = useAIStore
          .getState()
          .providerConfigs.find((p) => p.id === providerId);
        if (updated) {
          setDraftBaseUrl(updated.baseUrl);
        }
        setTimeout(() => {
          setTestConnectionState((prev) => {
            const current = prev[providerId];
            if (current?.phase === 'success') {
              return { ...prev, [providerId]: { phase: 'idle' } };
            }
            return prev;
          });
        }, 2000);
      } else {
        setTestConnectionState((prev) => ({
          ...prev,
          [providerId]: { phase: 'error', message: result.error },
        }));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : t('models.testFailed');
      setTestConnectionState((prev) => ({
        ...prev,
        [providerId]: { phase: 'error', message },
      }));
    }
  };

  const handleSyncModels = async (providerId: string) => {
    try {
      const result = await useAIStore
        .getState()
        .syncProviderModels(providerId);

      if (result.ok) {
        const updated = useAIStore
          .getState()
          .providerConfigs.find((p) => p.id === providerId);
        if (updated) {
          setDraftBaseUrl(updated.baseUrl);
        }
      }
    } catch {
      // Error is surfaced by the store via toast.
    }
  };

  // ── Derived state ─────────────────────────────────────────────────────

  const selectedProvider =
    selectedProviderId
      ? providerConfigs.find((p) => p.id === selectedProviderId) ?? null
      : null;

  const providerDetailPanel = selectedProvider ? (
    <ProviderDetailPanel
      provider={selectedProvider}
      hiddenModels={hiddenModels}
      draftKey={draftKey}
      draftBaseUrl={draftBaseUrl}
      testConnectionState={testConnectionState[selectedProvider.id] ?? { phase: 'idle' }}
      onDraftKeyChange={handleDraftKeyChange}
      onDraftBaseUrlChange={handleDraftBaseUrlChange}
      onTestConnection={() => handleTestConnection(selectedProvider.id)}
      onSyncModels={() => handleSyncModels(selectedProvider.id)}
      onToggleModel={toggleModel}
      onToggleAllModels={toggleAllModels}
      onToggleModelTools={toggleModelTools}
      onSetModelReasoningDescriptor={setModelReasoningDescriptor}
      onAddCustomModel={addCustomModel}
      onRemoveCustomModel={removeCustomModel}
      onDeleteProvider={(id) => {
        if (onDeleteProvider) {
          onDeleteProvider(id);
        } else {
          void useAIStore.getState().deleteCustomProvider(id);
        }
      }}
    />
  ) : (
    <div className="col settings-empty-provider">
      <p className="med" style={{ fontSize: 'var(--fs-base)', color: 'var(--c-text-1)', marginBottom: 4 }}>
        {t('models.noCustomProviders')}
      </p>
      <p className="subtle" style={{ fontSize: 'var(--fs-base)', marginBottom: 16 }}>
        {t('models.noCustomProvidersHint')}
      </p>
    </div>
  );

  if (isInline) {
    return (
      <div
        ref={modalRef}
        className="flex-col h-full w-full settings-models-inline"
        id="model-management-inline"
      >
        <div className="settings-models-toolbar row gap-2 settings-models-inline-toolbar">
          <span className="subtle" style={{ fontSize: 'var(--fs-base)' }}>{t('models.subtitle')}</span>
        </div>
        <div className="model-provider-body flex-1 col gap-2 settings-models-inline-body">
          {providerDetailPanel}
        </div>
      </div>
    );
  }

  return (
    <div
      className="overlay"
      id="model-management-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="model-management-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) handleClose();
      }}
    >
      <div
        ref={modalRef}
        className="modal model-provider-modal flex-col"
        id="model-management-modal"
        tabIndex={-1}
      >
        <div className="modal-head shrink-0" style={{ padding: '16px 20px' }}>
          <div>
            <h2 id="model-management-title" style={{ margin: 0, fontSize: 'var(--fs-base)', fontWeight: 600 }}>
              {t('models.title')}
            </h2>
            <p className="subtle" style={{ fontSize: 'var(--fs-base)', marginTop: 2, marginBottom: 0 }}>
              {t('models.subtitle')}
            </p>
          </div>
          <div className="row gap-1">
            <button
              ref={closeBtnRef}
              type="button"
              onClick={handleClose}
              aria-label={t('models.close')}
              className="modal-close settings-modal-icon-btn"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="model-provider-body flex-1 col gap-2 settings-models-inline-body--modal">
          {providerDetailPanel}
        </div>
      </div>
    </div>
  );
}
