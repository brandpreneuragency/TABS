import { useState } from 'react';
import { Eye, EyeOff, Loader2, Download, Check, AlertCircle, Pencil } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AIProviderConfig } from '../../../types';
import { ProviderStatusBadge } from '../../modals/modelProvider/ProviderStatusBadge';

interface ProviderConnectionTabProps {
  provider: AIProviderConfig;
  draftKey: string;
  draftBaseUrl: string;
  testConnectionState: { phase: 'idle' | 'testing' | 'success' | 'error'; message?: string };
  onDraftKeyChange: (value: string) => void;
  onDraftBaseUrlChange: (value: string) => void;
  onTestConnection: () => void;
}

export function ProviderConnectionTab({
  provider,
  draftKey,
  draftBaseUrl,
  testConnectionState,
  onDraftKeyChange,
  onDraftBaseUrlChange,
  onTestConnection,
}: ProviderConnectionTabProps) {
  const { t } = useTranslation();
  const [showKey, setShowKey] = useState(false);
  const [editing, setEditing] = useState(false);

  const status = provider.status ?? 'not_connected';
  const isConnected = status === 'connected';

  // After a successful connect/reconnect, drop out of edit mode so the
  // connected summary appears. Act only on the success *transition* (compare
  // against the previous phase) — not on every render while phase is 'success'
  // — so re-entering edit mode during the 2s success window still works.
  const [prevPhase, setPrevPhase] = useState(testConnectionState.phase);
  if (testConnectionState.phase !== prevPhase) {
    setPrevPhase(testConnectionState.phase);
    if (isConnected && testConnectionState.phase === 'success') {
      setEditing(false);
    }
  }

  const lastImportedAt = provider.lastImportedAt;
  const lastImportedLabel = lastImportedAt
    ? new Date(lastImportedAt).toLocaleString()
    : null;

  const isTesting = testConnectionState.phase === 'testing';
  const hasCredentials = Boolean(draftBaseUrl.trim()) && Boolean(draftKey.trim());
  const canTestOrReconnect = hasCredentials && !isTesting;

  // Extract host from baseUrl for display
  let endpointHost = provider.baseUrl;
  try {
    endpointHost = new URL(provider.baseUrl).host;
  } catch {
    // keep raw baseUrl
  }

  // Connected summary view (quiet)
  if (isConnected && !editing) {
    return (
      <div className="col gap-3" style={{ padding: '16px 0' }}>
        <div className="row gap-2" style={{ alignItems: 'center' }}>
          <ProviderStatusBadge status={status} />
          <span className="med" style={{ fontSize: 'var(--fs-base)' }}>{t('models.connected')}</span>
        </div>

        <div className="col gap-1">
          <div className="row gap-2" style={{ justifyContent: 'space-between' }}>
            <span className="subtle" style={{ fontSize: 'var(--fs-base)' }}>{t('models.baseUrl')}</span>
            <span className="ctrl--mono" style={{ fontSize: 'var(--fs-base)' }}>{endpointHost}</span>
          </div>
          {lastImportedLabel && (
            <div className="row gap-2" style={{ justifyContent: 'space-between' }}>
              <span className="subtle" style={{ fontSize: 'var(--fs-base)' }}>{t('models.lastImportedAt', { time: '' })}</span>
              <span style={{ fontSize: 'var(--fs-base)' }}>{lastImportedLabel}</span>
            </div>
          )}
          <div className="row gap-2" style={{ justifyContent: 'space-between' }}>
            <span className="subtle" style={{ fontSize: 'var(--fs-base)' }}>{t('models.tabModels')}</span>
            <span style={{ fontSize: 'var(--fs-base)' }}>{(provider.models ?? []).length}</span>
          </div>
        </div>

        {/* Actions */}
        <div className="row gap-2" style={{ justifyContent: 'flex-end', marginTop: 4 }}>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="btn-send settings-action-btn"
            title={t('models.editConnection')}
            aria-label={t('models.editConnection')}
          >
            <Pencil size={14} />
            <span>{t('models.editConnection')}</span>
          </button>
        </div>
      </div>
    );
  }

  // Editing / not-connected form view
  return (
    <div className="col gap-3" style={{ padding: '16px 0' }}>
      <div className="row gap-2" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <ProviderStatusBadge status={status} />
        {editing && (
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="btn-xs"
            style={{ border: '1px solid var(--c-border-1)' }}
          >
            {t('models.cancel')}
          </button>
        )}
      </div>

      {/* Base URL */}
      <div className="col gap-1">
        <div className="label-sm">{t('models.baseUrl')}</div>
        <input
          type="text"
          value={draftBaseUrl}
          onChange={(e) => onDraftBaseUrlChange(e.target.value)}
          placeholder="https://api.example.com/v1"
          className="ctrl ctrl--mono ctrl--flat w-full"
          style={{ fontSize: 'var(--fs-base)' }}
        />
      </div>

      {/* API Key */}
      <div className="col gap-1">
        <div className="label-sm">{t('models.apiKeyLabel')}</div>
        <div className="row gap-2">
          <input
            type={showKey ? 'text' : 'password'}
            value={draftKey}
            onChange={(e) => onDraftKeyChange(e.target.value)}
            placeholder={t('models.pasteKey')}
            className="ctrl ctrl--mono ctrl--flat flex-1"
            style={{ fontSize: 'var(--fs-base)' }}
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="button"
            onClick={() => setShowKey((s) => !s)}
            className="btn-icon"
            aria-label={showKey ? t('models.hideKey') : t('models.showKey')}
          >
            {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
      </div>

      {/* Connect / reconnect feedback */}
      {testConnectionState.phase === 'success' && (
        <div className="row-xs settings-feedback-success">
          <Check size={12} />
          <span>{editing ? t('models.reconnectSuccess') : t('models.providerConnected')}</span>
        </div>
      )}
      {testConnectionState.phase === 'error' && (
        <div className="row-xs settings-feedback-error" role="alert">
          <AlertCircle size={12} />
          <span>{testConnectionState.message}</span>
        </div>
      )}

      {/* Actions */}
      <div className="row gap-2" style={{ justifyContent: 'flex-end', marginTop: 4 }}>
        <button
          type="button"
          onClick={onTestConnection}
          disabled={!canTestOrReconnect}
          className={`btn-send settings-action-btn${canTestOrReconnect ? '' : ' settings-action-btn--disabled'}`}
          title={editing ? t('models.reconnect') : t('models.connect')}
          aria-label={editing ? t('models.reconnect') : t('models.connect')}
        >
          {isTesting ? <Loader2 size={14} className="spin" /> : <Download size={14} />}
          <span>{isTesting ? t('models.connecting') : editing ? t('models.reconnect') : t('models.connect')}</span>
        </button>
      </div>
    </div>
  );
}
