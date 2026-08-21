import { useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { AGENT_UI_PROFILES, useAgentUiStore } from '../../stores/agentUiStore';
import type { AgentRun, AgentToolCall } from '../../types/agent';
import { ApprovalCard } from './ApprovalCard';
import type { AgentSidebarProps } from './agentUiTypes';
import { ContextReferenceList } from './ContextReferenceList';
import { PlanCard } from './PlanCard';
import { RecoveryCard } from './RecoveryCard';
import { ResultCard } from './ResultCard';
import { RunCenter } from './RunCenter';
import { RunComposer } from './RunComposer';
import { RunTimeline } from './RunTimeline';
import { STATUS_I18N } from './runPresentation';
import './agent.css';

const DEFAULT_PROFILES = AGENT_UI_PROFILES.map((name) => ({
  name,
  labelKey: `agent.profile_${name}`,
}));

const MODE_OPTIONS: Array<{ value: AgentRun['mode']; labelKey: string }> = [
  { value: 'read_only', labelKey: 'agent.modeReadOnly' },
  { value: 'guided', labelKey: 'agent.modeGuided' },
  { value: 'delegated', labelKey: 'agent.modeDelegated' },
];

function canSteer(status: AgentRun['status']): boolean {
  return status === 'running' || status === 'paused' || status === 'awaiting_approval';
}

function canPause(status: AgentRun['status']): boolean {
  return status === 'running' || status === 'planning' || status === 'awaiting_approval';
}

function canResume(status: AgentRun['status']): boolean {
  return status === 'paused';
}

function canCancel(status: AgentRun['status']): boolean {
  return status !== 'completed' && status !== 'failed' && status !== 'cancelled';
}

function canRetry(status: AgentRun['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function resourceKeysFromRun(run: AgentRun, toolCalls: AgentToolCall[]): string[] {
  const keys: string[] = [];
  const seen = new Map<string, true>();
  for (const key of [
    ...run.contextRefs.map((ref) => `${ref.kind}:${ref.id}`),
    ...toolCalls.flatMap((call) => call.resourceKeys),
  ]) {
    if (seen.has(key)) continue;
    seen.set(key, true);
    keys.push(key);
  }
  return keys;
}

export function AgentSidebar({
  runs,
  events,
  approvals,
  artifacts,
  toolCalls,
  plan,
  error,
  profiles = DEFAULT_PROFILES,
  providers = [],
  actions,
}: AgentSidebarProps) {
  const { t } = useTranslation();
  const panelRef = useRef<HTMLElement>(null);
  const viewMode = useAgentUiStore((state) => state.viewMode);
  const selectedRunId = useAgentUiStore((state) => state.selectedRunId);
  const profileName = useAgentUiStore((state) => state.profileName);
  const mode = useAgentUiStore((state) => state.mode);
  const providerId = useAgentUiStore((state) => state.providerId);
  const modelId = useAgentUiStore((state) => state.modelId);
  const composerGoal = useAgentUiStore((state) => state.composerGoal);
  const steeringDraft = useAgentUiStore((state) => state.steeringDraft);
  const pendingContextRefs = useAgentUiStore((state) => state.pendingContextRefs);
  const lastFocusedRunId = useAgentUiStore((state) => state.lastFocusedRunId);
  const setViewMode = useAgentUiStore((state) => state.setViewMode);
  const setSelectedRunId = useAgentUiStore((state) => state.setSelectedRunId);
  const setProfileName = useAgentUiStore((state) => state.setProfileName);
  const setMode = useAgentUiStore((state) => state.setMode);
  const setProviderId = useAgentUiStore((state) => state.setProviderId);
  const setModelId = useAgentUiStore((state) => state.setModelId);
  const setComposerGoal = useAgentUiStore((state) => state.setComposerGoal);
  const setSteeringDraft = useAgentUiStore((state) => state.setSteeringDraft);
  const setPendingContextRefs = useAgentUiStore((state) => state.setPendingContextRefs);
  const removePendingContextRef = useAgentUiStore((state) => state.removePendingContextRef);
  const setLastFocusedRunId = useAgentUiStore((state) => state.setLastFocusedRunId);

  const selectedRun = useMemo(
    () => runs.find((run) => run.id === selectedRunId) ?? null,
    [runs, selectedRunId],
  );
  const pendingApprovals = approvals.filter((item) => item.status === 'pending');
  const provider = providers.find((item) => item.id === providerId);
  const models = provider?.models ?? [];

  useEffect(() => {
    if (providers.length > 0 && !providerId) {
      setProviderId(providers[0].id);
      setModelId(providers[0].models[0] ?? '');
    }
  }, [providers, providerId, setProviderId, setModelId]);

  useEffect(() => {
    if (!selectedRunId) return;
    if (lastFocusedRunId === selectedRunId) {
      panelRef.current?.focus();
    }
  }, [selectedRunId, lastFocusedRunId, pendingApprovals.length]);

  const handleSelectRun = (runId: string) => {
    setSelectedRunId(runId);
    setLastFocusedRunId(runId);
    setViewMode('run');
  };

  const handleStart = () => {
    void actions.create({
      goal: composerGoal.trim(),
      mode,
      profileName,
      providerId,
      modelId,
      contextRefs: pendingContextRefs,
    });
    setComposerGoal('');
  };

  const handleSteer = () => {
    if (!selectedRun) return;
    void actions.submitInput(selectedRun.id, steeringDraft.trim());
    setSteeringDraft('');
  };

  return (
    <div
      id="agent-sidebar"
      className="agent-sidebar panel flex flex-col h-full w-full"
      role="region"
      aria-label={t('agent.sidebarTitle')}
    >
      <header className="agent-sidebar-header">
        <h1 className="agent-sidebar-title">{t('agent.sidebarTitle')}</h1>
        <div className="agent-view-toggle">
          <button
            type="button"
            className="agent-btn"
            aria-pressed={viewMode === 'run'}
            onClick={() => setViewMode('run')}
          >
            {t('agent.runView')}
          </button>
          <button
            type="button"
            className="agent-btn"
            aria-pressed={viewMode === 'center'}
            onClick={() => setViewMode('center')}
          >
            {t('agent.runCenter')}
          </button>
        </div>
      </header>

      <div className="agent-toolbar">
        <label className="agent-field">
          <span>{t('agent.profile')}</span>
          <select
            value={profileName}
            onChange={(event) => setProfileName(event.target.value)}
          >
            {profiles.map((profile) => (
              <option key={profile.name} value={profile.name}>{t(profile.labelKey)}</option>
            ))}
          </select>
        </label>
        <label className="agent-field">
          <span>{t('agent.mode')}</span>
          <select
            value={mode}
            onChange={(event) => setMode(event.target.value as AgentRun['mode'])}
          >
            {MODE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{t(option.labelKey)}</option>
            ))}
          </select>
        </label>
        <label className="agent-field">
          <span>{t('agent.provider')}</span>
          <select
            value={providerId}
            onChange={(event) => {
              const next = event.target.value;
              setProviderId(next);
              const nextProvider = providers.find((item) => item.id === next);
              setModelId(nextProvider?.models[0] ?? '');
            }}
          >
            {providers.length === 0 && <option value="">{t('agent.unknownProvider')}</option>}
            {providers.map((item) => (
              <option key={item.id} value={item.id}>{item.name}</option>
            ))}
          </select>
        </label>
        <label className="agent-field">
          <span>{t('agent.model')}</span>
          <select
            value={modelId}
            onChange={(event) => setModelId(event.target.value)}
          >
            {models.length === 0 && <option value="">{t('agent.unknownProvider')}</option>}
            {models.map((model) => (
              <option key={model} value={model}>{model}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="agent-toolbar" style={{ paddingTop: 0 }}>
        <div className="agent-field" style={{ flex: '1 1 100%' }}>
          <span>{t('agent.context')}</span>
          <ContextReferenceList
            refs={selectedRun?.contextRefs ?? pendingContextRefs}
            frozen={Boolean(selectedRun)}
            onRemove={removePendingContextRef}
            onOpen={actions.openResource}
          />
          {!selectedRun && (
            <button
              type="button"
              className="agent-btn"
              onClick={() => setPendingContextRefs(actions.captureCurrentContext())}
            >
              {t('agent.captureContext')}
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="agent-error" role="alert">
          <strong>{t('agent.errorTitle')}</strong>
          <p>{error}</p>
        </div>
      )}

      {viewMode === 'center' ? (
        <RunCenter
          runs={runs}
          selectedRunId={selectedRunId}
          onSelect={handleSelectRun}
          onArchive={(runId) => void actions.archive(runId)}
          onQueue={(runId) => void actions.queue(runId)}
          onPrioritize={(runId) => void actions.prioritizeQueue(runId)}
        />
      ) : (
        <div className="agent-scroll">
          {!selectedRun && (
            <div className="agent-empty">
              <p>{t('agent.emptyTitle')}</p>
              <p className="subtle">{t('agent.emptySubtitle')}</p>
              <p className="subtle">{t('agent.backgroundHint')}</p>
            </div>
          )}

          {selectedRun && (
            <section
              ref={panelRef}
              id={`agent-run-${selectedRun.id}`}
              className="agent-group"
              tabIndex={-1}
              aria-labelledby="agent-run-heading"
            >
              <h2 id="agent-run-heading" className="agent-group-title">{selectedRun.goal}</h2>
              <p className="agent-status" data-status={selectedRun.status}>
                {t('agent.status')}: {t(STATUS_I18N[selectedRun.status])}
              </p>
              {selectedRun.profileSnapshot.name && (
                <p className="subtle" style={{ fontSize: 'var(--fs-xs)' }}>
                  {t('agent.profile')}: {selectedRun.profileSnapshot.name}
                  {' · '}
                  {t('agent.mode')}: {selectedRun.mode}
                  {' · '}
                  {t('agent.provider')}: {selectedRun.providerSnapshot.providerId}
                </p>
              )}
              <div className="agent-run-controls">
                <button
                  type="button"
                  className="agent-btn"
                  disabled={!canPause(selectedRun.status)}
                  onClick={() => void actions.pause(selectedRun.id)}
                >
                  {t('agent.pause')}
                </button>
                <button
                  type="button"
                  className="agent-btn"
                  disabled={!canResume(selectedRun.status)}
                  onClick={() => void actions.resume(selectedRun.id)}
                >
                  {t('agent.resume')}
                </button>
                <button
                  type="button"
                  className="agent-btn"
                  disabled={!canCancel(selectedRun.status)}
                  onClick={() => void actions.cancel(selectedRun.id)}
                >
                  {t('agent.cancel')}
                </button>
                <button
                  type="button"
                  className="agent-btn"
                  disabled={!canRetry(selectedRun.status)}
                  onClick={() => void actions.retry(selectedRun.id)}
                >
                  {t('agent.retry')}
                </button>
                <button
                  type="button"
                  className="agent-btn"
                  onClick={() => void actions.archive(selectedRun.id)}
                >
                  {t('agent.archive')}
                </button>
                <button
                  type="button"
                  className="agent-btn"
                  onClick={() => void actions.queue(selectedRun.id)}
                >
                  {t('agent.queue')}
                </button>
              </div>

              {plan && (
                <PlanCard
                  plan={plan}
                  canDecide={selectedRun.status === 'awaiting_approval'}
                  onApprove={() => {
                    const approval = pendingApprovals.find((item) => item.planId) ?? pendingApprovals[0];
                    if (approval) void actions.answerApproval(approval, 'approved');
                  }}
                  onRejectPause={() => {
                    const approval = pendingApprovals.find((item) => item.planId) ?? pendingApprovals[0];
                    if (approval) void actions.answerApproval(approval, 'rejected', 'pause');
                  }}
                  onRejectCancel={() => {
                    const approval = pendingApprovals.find((item) => item.planId) ?? pendingApprovals[0];
                    if (approval) void actions.answerApproval(approval, 'rejected', 'cancel');
                  }}
                  onSwitchGuided={() => void actions.switchToGuided(selectedRun.id)}
                />
              )}

              {pendingApprovals.map((approval, index) => (
                <ApprovalCard
                  key={approval.id}
                  approval={approval}
                  autoFocus={index === 0}
                  onApprove={() => void actions.answerApproval(approval, 'approved')}
                  onReject={() => void actions.answerApproval(approval, 'rejected')}
                />
              ))}

              <RecoveryCard
                run={selectedRun}
                onQueue={() => void actions.resolveReview(selectedRun.id, 'queue')}
                onCancel={() => void actions.resolveReview(selectedRun.id, 'cancel')}
              />

              <RunTimeline events={events} />

              <ResultCard
                run={selectedRun}
                artifacts={artifacts}
                resourceKeys={resourceKeysFromRun(selectedRun, toolCalls)}
                onOpenResource={actions.openResource}
              />
            </section>
          )}
        </div>
      )}

      {viewMode === 'run' && (
        <RunComposer
          mode={selectedRun && canSteer(selectedRun.status) ? 'steer' : 'start'}
          value={selectedRun && canSteer(selectedRun.status) ? steeringDraft : composerGoal}
          disabled={selectedRun != null && !canSteer(selectedRun.status)}
          onChange={selectedRun && canSteer(selectedRun.status) ? setSteeringDraft : setComposerGoal}
          onSubmit={selectedRun && canSteer(selectedRun.status) ? handleSteer : handleStart}
        />
      )}
    </div>
  );
}
