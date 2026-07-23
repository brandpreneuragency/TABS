import { useState, useRef } from 'react';
import { Search, Download, RefreshCw, ChevronDown, ChevronRight, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AIProviderConfig, ModelItem, ModelReasoning } from '../../../types';
import { ModelSwitch } from '../../modals/modelProvider/ModelSwitch';
import { ModelHoverCard } from '../../modals/modelProvider/ModelHoverCard';
import { AddCustomModelInput } from '../../modals/modelProvider/AddCustomModelInput';
import { refreshReasoningCatalog, resolveReasoning } from '../../../services/ai/reasoning';
import { useUIStore } from '../../../stores/uiStore';

type FilterType = 'all' | 'enabled' | 'disabled' | 'custom' | 'vision' | 'tool_use' | 'reasoning';

interface ProviderModelsTabProps {
  provider: AIProviderConfig;
  hiddenModels: string[];
  onToggleModel: (providerId: string, modelId: string, enabled: boolean) => void;
  onToggleModelTools: (providerId: string, modelId: string, supportsTools: boolean) => void;
  onSetModelReasoningDescriptor: (providerId: string, modelId: string, reasoning: ModelReasoning | undefined) => void;
  onAddCustomModel: (providerId: string, slug: string) => void;
  onRemoveCustomModel: (providerId: string, modelId: string) => void;
  onSyncModels?: () => void;
}

export function ProviderModelsTab({
  provider,
  hiddenModels,
  onToggleModel,
  onToggleModelTools,
  onSetModelReasoningDescriptor,
  onAddCustomModel,
  onRemoveCustomModel,
  onSyncModels,
}: ProviderModelsTabProps) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [activeFilter, setActiveFilter] = useState<FilterType>('all');
  const [hoveredModel, setHoveredModel] = useState<{ model: ModelItem; rect: DOMRect } | null>(null);
  const [refreshingCapabilities, setRefreshingCapabilities] = useState(false);
  const [, setCatalogVersion] = useState(0);
  const rowRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const models = provider.models ?? [];

  const isHidden = (modelId: string) =>
    hiddenModels.includes(`${provider.id}:${modelId}`);

  const filteredModels = models.filter((m) => {
    const resolvedReasoning = resolveReasoning(m, provider.baseUrl);
    const matchesSearch = !search ||
      m.name.toLowerCase().includes(search.toLowerCase()) ||
      m.id.toLowerCase().includes(search.toLowerCase());

    if (!matchesSearch) return false;

    switch (activeFilter) {
      case 'enabled':
        return !isHidden(m.id);
      case 'disabled':
        return isHidden(m.id);
      case 'custom':
        return m.custom === true;
      case 'vision':
        return m.capabilities?.vision === true;
      case 'tool_use':
        return m.capabilities?.toolCalling === true;
      case 'reasoning':
        return Boolean(resolvedReasoning)
          || m.capabilities?.reasoning === 'High'
          || m.capabilities?.reasoning === 'Medium';
      default:
        return true;
    }
  });

  const handleMouseEnter = (model: ModelItem) => {
    const rect = rowRefs.current[model.id]?.getBoundingClientRect();
    if (rect) setHoveredModel({ model, rect });
  };

  const PRIMARY_FILTERS: { id: FilterType; labelKey: string }[] = [
    { id: 'all', labelKey: 'models.filterAll' },
    { id: 'enabled', labelKey: 'models.filterEnabled' },
  ];

  const ADVANCED_FILTERS: { id: FilterType; labelKey: string }[] = [
    { id: 'disabled', labelKey: 'models.filterDisabled' },
    { id: 'custom', labelKey: 'models.filterCustom' },
    { id: 'vision', labelKey: 'models.filterVision' },
    { id: 'tool_use', labelKey: 'models.filterToolUse' },
    { id: 'reasoning', labelKey: 'models.filterReasoning' },
  ];

  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  const [expandedModels, setExpandedModels] = useState<Set<string>>(new Set());

  const toggleModelExpanded = (modelId: string) => {
    setExpandedModels((prev) => {
      const next = new Set(prev);
      if (next.has(modelId)) next.delete(modelId);
      else next.add(modelId);
      return next;
    });
  };

  const handleRefreshCapabilities = async () => {
    setRefreshingCapabilities(true);
    try {
      await refreshReasoningCatalog();
      setCatalogVersion((v) => v + 1);
    } catch (err) {
      const message = err instanceof Error ? err.message : t('models.syncFailed');
      useUIStore.getState().showToast(message, 'error');
    } finally {
      setRefreshingCapabilities(false);
    }
  };

  return (
    <div className="col gap-2" style={{ padding: '16px 0' }}>
      {/* Search and sync */}
      <div className="row gap-2" style={{ alignItems: 'center' }}>
        <div className="row gap-2 flex-1 settings-search-input-wrap">
          <Search size={14} style={{ color: 'var(--c-text-3)', flexShrink: 0 }} />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('models.searchModels')}
            className="flex-1 settings-search-input"
          />
        </div>
        {onSyncModels && (
          <button
            type="button"
            onClick={onSyncModels}
            className="btn-send settings-action-btn"
            title={t('models.syncModels')}
            aria-label={t('models.syncModels')}
          >
            <Download size={12} />
            <span>{t('models.syncModels')}</span>
          </button>
        )}
        <button
          type="button"
          onClick={() => { void handleRefreshCapabilities(); }}
          className="btn-send settings-action-btn"
          title={t('models.refreshCapabilities')}
          aria-label={t('models.refreshCapabilities')}
          disabled={refreshingCapabilities}
        >
          <RefreshCw size={12} className={refreshingCapabilities ? 'settings-spin' : undefined} />
          <span>{t('models.refreshCapabilities')}</span>
        </button>
        <span className="subtle" style={{ fontSize: 'var(--fs-base)', whiteSpace: 'nowrap' }}>
          {t('models.modelCount', { count: models.length })}
        </span>
      </div>

      {/* Filters */}
      <div className="row gap-1 settings-filter-bar">
        {PRIMARY_FILTERS.map((filter) => (
          <button
            key={filter.id}
            type="button"
            onClick={() => setActiveFilter(filter.id)}
            className={activeFilter === filter.id ? 'btn-brand settings-filter-btn settings-filter-btn--active' : 'btn-xs settings-filter-btn settings-filter-btn--inactive'}
          >
            {t(filter.labelKey)}
          </button>
        ))}
        <div className="settings-advanced-filter-wrap">
          <button
            type="button"
            onClick={() => setShowAdvancedFilters((v) => !v)}
            className={`btn-xs settings-filter-btn ${showAdvancedFilters || !PRIMARY_FILTERS.some((f) => f.id === activeFilter) ? 'settings-filter-btn--active' : 'settings-filter-btn--inactive'}`}
          >
            {activeFilter !== 'all' && activeFilter !== 'enabled'
              ? t(ADVANCED_FILTERS.find((f) => f.id === activeFilter)?.labelKey ?? 'models.filterAll')
              : t('models.moreFilters')}
            <ChevronDown size={10} style={{ marginLeft: 2 }} />
          </button>
          {showAdvancedFilters && (
            <div className="settings-advanced-filter-menu">
              {ADVANCED_FILTERS.map((filter) => (
                <button
                  key={filter.id}
                  type="button"
                  onClick={() => {
                    setActiveFilter(filter.id);
                    setShowAdvancedFilters(false);
                  }}
                  className={activeFilter === filter.id ? 'settings-advanced-filter-item--active' : ''}
                >
                  {t(filter.labelKey)}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Model table */}
      <div className="col gap-1">
        {filteredModels.length === 0 ? (
          <div className="subtle settings-models-empty">
            {models.length === 0 ? t('models.noModelsAvailable') : t('models.noSearchResults')}
          </div>
        ) : (
          <>
            {/* Table header */}
            <div className="row settings-model-table-header">
              <span style={{ flex: 2 }}>{t('models.colModelName')}</span>
              <span style={{ flex: 2 }}>{t('models.colCapabilities')}</span>
              <span style={{ width: 48, textAlign: 'center' }}>{t('models.colEnabled')}</span>
              <span style={{ width: 32 }}></span>
              <span style={{ width: 32 }}></span>
            </div>

            {/* Table rows */}
            {filteredModels.map((model) => {
              const enabled = !isHidden(model.id);
              const capabilities = model.capabilities;
              const resolvedReasoning = resolveReasoning(model, provider.baseUrl);
              const capItems: string[] = [];
              if (capabilities?.vision) capItems.push(t('models.capVision'));
              if (capabilities?.toolCalling) capItems.push(t('models.capToolUse'));
              if (resolvedReasoning || capabilities?.reasoning === 'High' || capabilities?.reasoning === 'Medium') {
                capItems.push(t('models.capReasoning'));
              }
              const manualReasoning = model.reasoning?.source === 'manual' ? model.reasoning : undefined;
              const manualLevels = manualReasoning
                ? manualReasoning.options.map((opt) => opt.label).join(', ')
                : '';
              const manualParam = manualReasoning?.param ?? 'reasoning_effort';

              return (
                <div key={model.id} className="settings-model-row-group">
                  <div
                    ref={(el) => { rowRefs.current[model.id] = el; }}
                    className="row provider-model-row settings-model-table-row"
                    tabIndex={0}
                    onMouseEnter={() => handleMouseEnter(model)}
                    onMouseLeave={() => setHoveredModel(null)}
                    onFocus={() => handleMouseEnter(model)}
                    onBlur={() => setHoveredModel(null)}
                  >
                    <span className="settings-model-name" title={model.id}>
                      {model.name}
                      {model.custom && <span className="settings-model-custom-badge">{t('models.sourceCustom')}</span>}
                    </span>
                    <span className="settings-model-caps">
                      {capItems.map((cap) => (
                        <span key={cap} className="settings-cap-badge">{cap}</span>
                      ))}
                    </span>
                    <span className="settings-model-toggle-cell">
                      <ModelSwitch
                        checked={enabled}
                        onChange={(checked) => onToggleModel(provider.id, model.id, checked)}
                        ariaLabel={`${enabled ? t('models.hideFromSelector', { model: model.name }) : t('models.showInSelector', { model: model.name })}`}
                      />
                    </span>
                    <span className="settings-model-remove-cell">
                      {model.custom ? (
                        <button
                          type="button"
                          className="btn-icon settings-model-remove-btn"
                          onClick={() => onRemoveCustomModel(provider.id, model.id)}
                          title={t('models.removeCustomModel', { model: model.name })}
                          aria-label={t('models.removeCustomModel', { model: model.name })}
                        >
                          <Trash2 size={12} />
                        </button>
                      ) : null}
                    </span>
                    <button
                      type="button"
                      className="btn-icon settings-model-expand-btn"
                      onClick={() => toggleModelExpanded(model.id)}
                      aria-label={expandedModels.has(model.id) ? t('models.collapse') : t('models.expand', { provider: model.name })}
                      aria-expanded={expandedModels.has(model.id)}
                    >
                      {expandedModels.has(model.id) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    </button>
                  </div>

                  {/* Expanded: Tools and Thinking overrides */}
                  {expandedModels.has(model.id) && (
                    <div className="settings-model-reasoning-row settings-model-expanded-panel">
                      <label className="settings-model-reasoning-toggle">
                        <input
                          type="checkbox"
                          checked={model.supportsTools ?? true}
                          onChange={(e) => onToggleModelTools(provider.id, model.id, e.target.checked)}
                          aria-label={t('models.toggleTools', { model: model.name })}
                        />
                        <span>{t('models.capToolUse')}</span>
                      </label>

                      <label className="settings-model-reasoning-toggle">
                        <input
                          type="checkbox"
                          checked={Boolean(manualReasoning)}
                          onChange={(e) => {
                            if (!e.target.checked) {
                              onSetModelReasoningDescriptor(provider.id, model.id, undefined);
                              return;
                            }
                            onSetModelReasoningDescriptor(provider.id, model.id, {
                              param: resolvedReasoning?.param ?? 'reasoning_effort',
                              source: 'manual',
                              options: resolvedReasoning?.options ?? [
                                { label: 'Off', value: '' },
                                { label: 'Low', value: 'low' },
                                { label: 'Medium', value: 'medium' },
                                { label: 'High', value: 'high' },
                              ],
                            });
                          }}
                        />
                        <span>{t('models.supportsThinking')}</span>
                      </label>

                      {manualReasoning && (
                        <>
                          <select
                            className="settings-model-reasoning-select"
                            value={manualParam}
                            onChange={(e) => {
                              const nextParam = e.target.value as ModelReasoning['param'];
                              const options = nextParam === 'thinking'
                                ? [
                                    { label: 'Off', value: '', budgetTokens: 0 },
                                    { label: 'Low', value: 'low', budgetTokens: 4000 },
                                    { label: 'Medium', value: 'medium', budgetTokens: 12000 },
                                    { label: 'High', value: 'high', budgetTokens: 24000 },
                                  ]
                                : nextParam === 'reasoning_enabled'
                                  ? [
                                      { label: 'Off', value: '' },
                                      { label: 'On', value: 'on' },
                                    ]
                                  : manualReasoning.options;
                              onSetModelReasoningDescriptor(provider.id, model.id, {
                                ...manualReasoning,
                                param: nextParam,
                                options,
                              });
                            }}
                          >
                            <option value="reasoning_effort">reasoning_effort</option>
                            <option value="reasoning">reasoning.effort</option>
                            <option value="reasoning_enabled">reasoning.enabled</option>
                            <option value="thinking">thinking.budget</option>
                          </select>
                          <input
                            type="text"
                            className="settings-model-reasoning-input"
                            value={manualLevels}
                            title={t('models.thinkingLevelsHint')}
                            placeholder={t('models.thinkingLevelsHint')}
                            onChange={(e) => {
                              const parts = e.target.value
                                .split(',')
                                .map((value) => value.trim())
                                .filter(Boolean);
                              if (parts.length === 0) return;
                              const options = manualParam === 'thinking'
                                ? parts.map((label, index) => ({
                                    label,
                                    value: index === 0 ? '' : label.toLowerCase(),
                                    budgetTokens: index === 0 ? 0 : index === 1 ? 4000 : index === 2 ? 12000 : 24000,
                                  }))
                                : parts.map((label, index) => ({
                                    label,
                                    value: index === 0 ? '' : label.toLowerCase(),
                                  }));
                              onSetModelReasoningDescriptor(provider.id, model.id, {
                                ...manualReasoning,
                                options,
                              });
                            }}
                          />
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </>
        )}
      </div>

      {/* Add custom model */}
      <div style={{ borderTop: '1px solid var(--c-border-1)', paddingTop: 8 }}>
        <AddCustomModelInput
          onAdd={(slug) => onAddCustomModel(provider.id, slug)}
          existingIds={models.map((m) => m.id)}
        />
      </div>

      {hoveredModel && (
        <ModelHoverCard
          targetRect={hoveredModel.rect}
          provider={provider}
          model={hoveredModel.model}
          enabled={!isHidden(hoveredModel.model.id)}
        />
      )}
    </div>
  );
}
