import { useState, useRef, useEffect } from 'react';
import { Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AIProviderConfig, ModelReasoning } from '../../../types';
import { ProviderStatusBadge } from '../../modals/modelProvider/ProviderStatusBadge';
import { ModelSwitch } from '../../modals/modelProvider/ModelSwitch';
import { ProviderTabs, type ProviderTabId } from './ProviderTabs';
import { ProviderConnectionTab } from './ProviderConnectionTab';
import { ProviderModelsTab } from './ProviderModelsTab';
import { isPresetProviderId } from './providerPresets';

interface ProviderDetailPanelProps {
  provider: AIProviderConfig;
  hiddenModels: string[];
  draftKey: string;
  draftBaseUrl: string;
  testConnectionState: { phase: 'idle' | 'testing' | 'success' | 'error'; message?: string };
  onDraftKeyChange: (value: string) => void;
  onDraftBaseUrlChange: (value: string) => void;
  onTestConnection: () => void;
  onSyncModels: () => void;
  onToggleModel: (providerId: string, modelId: string, enabled: boolean) => void;
  onToggleAllModels: (providerId: string, enabled: boolean) => void;
  onToggleModelTools: (providerId: string, modelId: string, supportsTools: boolean) => void;
  onSetModelReasoningDescriptor: (providerId: string, modelId: string, reasoning: ModelReasoning | undefined) => void;
  onAddCustomModel: (providerId: string, slug: string) => void;
  onRemoveCustomModel: (providerId: string, modelId: string) => void;
  onDeleteProvider: (id: string) => void;
}

const DEFAULT_TABS: { id: ProviderTabId; labelKey: string }[] = [
  { id: 'connection', labelKey: 'models.tabConnection' },
  { id: 'models', labelKey: 'models.tabModels' },
];

export function ProviderDetailPanel({
  provider,
  hiddenModels,
  draftKey,
  draftBaseUrl,
  testConnectionState,
  onDraftKeyChange,
  onDraftBaseUrlChange,
  onTestConnection,
  onSyncModels,
  onToggleModel,
  onToggleAllModels,
  onToggleModelTools,
  onSetModelReasoningDescriptor,
  onAddCustomModel,
  onRemoveCustomModel,
  onDeleteProvider,
}: ProviderDetailPanelProps) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<ProviderTabId>('connection');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const deleteWrapRef = useRef<HTMLDivElement>(null);

  // Reset delete confirmation on outside click or Escape key.
  useEffect(() => {
    if (!confirmDelete) return;
    const handlePointerDown = (e: PointerEvent) => {
      if (deleteWrapRef.current && !deleteWrapRef.current.contains(e.target as Node)) {
        setConfirmDelete(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setConfirmDelete(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [confirmDelete]);

  const status = provider.status ?? 'not_connected';
  const isPreset = isPresetProviderId(provider.id);
  const deleteLabel = isPreset ? t('models.resetProvider') : t('models.deleteProvider');
  const modelCount = (provider.models ?? []).length;
  const enabledCount = (provider.models ?? []).filter(
    (m) => !hiddenModels.includes(`${provider.id}:${m.id}`),
  ).length;
  const allModelsEnabled = modelCount > 0 && enabledCount === modelCount;
  const lastImportedAt = provider.lastImportedAt;
  const lastImportedLabel = lastImportedAt
    ? new Date(lastImportedAt).toLocaleString()
    : null;

  const tabs = DEFAULT_TABS.map((tab) => ({
    id: tab.id,
    label: t(tab.labelKey),
  }));

  return (
    <div className="provider-detail-panel col gap-0" style={{ height: '100%' }}>
      {/* Header */}
      <div className="provider-detail-header settings-provider-detail-head">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <div className="row gap-3 min-w-0">
            <div className="row gap-2 min-w-0" style={{ alignItems: 'center' }}>
              <span className="semibold" style={{ fontSize: 'var(--fs-base)', color: 'var(--c-text-1)' }}>
                {provider.name}
              </span>
              <ModelSwitch
                checked={allModelsEnabled}
                disabled={modelCount === 0}
                onChange={(checked) => onToggleAllModels(provider.id, checked)}
                ariaLabel={
                  allModelsEnabled
                    ? t('models.disableAllModels', { provider: provider.name })
                    : t('models.enableAllModels', { provider: provider.name })
                }
              />
            </div>
            <ProviderStatusBadge status={status} />
            <span className="subtle settings-provider-detail-head-meta">
              {enabledCount}/{modelCount} {t('models.tabModels')}
            </span>
            {lastImportedLabel && (
              <span className="subtle settings-provider-detail-head-meta">
                · {t('models.lastImportedAt', { time: lastImportedLabel })}
              </span>
            )}
          </div>
          <div ref={deleteWrapRef} className="row gap-2 shrink-0" style={{ position: 'relative' }}>
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="btn-icon"
              title={deleteLabel}
              aria-label={deleteLabel}
            >
              <Trash2 size={14} />
            </button>
            {confirmDelete && (
              <div
                className="settings-delete-popover"
                role="dialog"
                aria-label={t('models.confirmDelete')}
              >
                <span className="settings-delete-popover-text">
                  {t('models.confirmDelete')}
                </span>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  className="btn-xs"
                >
                  {t('models.cancel')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onDeleteProvider(provider.id);
                    setConfirmDelete(false);
                  }}
                  className="btn-xs settings-delete-confirm-btn"
                >
                  {deleteLabel}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Tabs */}
      <ProviderTabs tabs={tabs} activeTab={activeTab} onTabChange={setActiveTab} />

      {/* Tab content */}
      <div className="provider-detail-content flex-1" style={{ overflowY: 'auto', padding: '0 16px' }}>
        {activeTab === 'connection' && (
          <ProviderConnectionTab
            provider={provider}
            draftKey={draftKey}
            draftBaseUrl={draftBaseUrl}
            testConnectionState={testConnectionState}
            onDraftKeyChange={onDraftKeyChange}
            onDraftBaseUrlChange={onDraftBaseUrlChange}
            onTestConnection={onTestConnection}
          />
        )}
        {activeTab === 'models' && (
          <ProviderModelsTab
            provider={provider}
            hiddenModels={hiddenModels}
            onToggleModel={onToggleModel}
            onToggleModelTools={onToggleModelTools}
            onSetModelReasoningDescriptor={onSetModelReasoningDescriptor}
            onAddCustomModel={onAddCustomModel}
            onRemoveCustomModel={onRemoveCustomModel}
            onSyncModels={onSyncModels}
          />
        )}

      </div>
    </div>
  );
}
