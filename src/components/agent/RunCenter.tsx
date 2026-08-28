import { useTranslation } from 'react-i18next';
import type { AgentEvent, AgentRun, AgentRunStatus } from '../../types/agent';
import { useAgentUiStore } from '../../stores/agentUiStore';
import {
  formatDuration,
  formatTimestamp,
  GROUP_I18N,
  groupRuns,
  latestStepLabel,
  STATUS_I18N,
} from './runPresentation';

interface RunCenterProps {
  runs: AgentRun[];
  eventsByRunId?: Record<string, AgentEvent[]>;
  selectedRunId: string | null;
  onSelect: (runId: string) => void;
  onArchive: (runId: string) => void;
  onQueue: (runId: string) => void;
  onPrioritize: (runId: string) => void;
}

function visibleRuns(runs: AgentRun[], includeArchived: boolean, statusFilter: 'all' | AgentRunStatus): AgentRun[] {
  return runs.filter((run) => {
    if (!includeArchived && run.archivedAt) return false;
    if (statusFilter !== 'all' && run.status !== statusFilter) return false;
    return true;
  });
}

export function RunCenter({
  runs,
  eventsByRunId = {},
  selectedRunId,
  onSelect,
  onArchive,
  onQueue,
  onPrioritize,
}: RunCenterProps) {
  const { t } = useTranslation();
  const statusFilter = useAgentUiStore((state) => state.statusFilter);
  const includeArchived = useAgentUiStore((state) => state.includeArchived);
  const setStatusFilter = useAgentUiStore((state) => state.setStatusFilter);
  const setIncludeArchived = useAgentUiStore((state) => state.setIncludeArchived);
  const filtered = visibleRuns(runs, includeArchived, statusFilter);
  const grouped = groupRuns(filtered);

  return (
    <div id="agent-run-center" className="agent-scroll">
      <div className="agent-center-filters">
        <label className="agent-field" style={{ flex: '0 1 10rem' }}>
          <span>{t('agent.filterStatus')}</span>
          <select
            className="agent-filter-select"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}
          >
            <option value="all">{t('agent.filterAll')}</option>
            {Object.entries(STATUS_I18N).map(([status, key]) => (
              <option key={status} value={status}>{t(key)}</option>
            ))}
          </select>
        </label>
        <label className="agent-field" style={{ flex: '0 0 auto', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(event) => setIncludeArchived(event.target.checked)}
          />
          <span>{t('agent.includeArchived')}</span>
        </label>
      </div>

      {filtered.length === 0 && (
        <div className="agent-empty">
          <p>{t('agent.noRuns')}</p>
        </div>
      )}

      {Object.entries(grouped).map(([groupId, groupRunsList]) => (
        <section key={groupId} className="agent-group" aria-labelledby={`agent-group-${groupId}`}>
          <h2 id={`agent-group-${groupId}`} className="agent-group-title">
            {t(GROUP_I18N[groupId as keyof typeof GROUP_I18N])}
          </h2>
          {groupRunsList.length === 0 ? (
            <p className="subtle" style={{ fontSize: 'var(--fs-xs)' }}>{t('agent.noRunsInGroup')}</p>
          ) : groupRunsList.map((run) => (
            <article key={run.id} className="agent-card" style={{ padding: 0 }}>
              <button
                type="button"
                className="agent-run-row"
                aria-current={selectedRunId === run.id}
                onClick={() => onSelect(run.id)}
              >
                <div>
                  <div className="agent-status" data-status={run.status}>
                    {t(STATUS_I18N[run.status])}
                  </div>
                  <strong>{run.goal}</strong>
                  <div className="agent-run-meta subtle">
                    <span>{run.contextRefs.map((ref) => ref.label).join(', ') || t('agent.noContext')}</span>
                    <span>{t('agent.started')}: {formatTimestamp(run.startedAt ?? run.createdAt)}</span>
                    <span>{t('agent.duration')}: {formatDuration(run)}</span>
                    <span>{t('agent.latestStep')}: {latestStepLabel(eventsByRunId[run.id] ?? [])}</span>
                  </div>
                </div>
              </button>
              <div className="agent-btn-row" style={{ padding: '0 8px 8px' }}>
                {run.status === 'queued' && (
                  <button type="button" className="agent-btn" onClick={() => onPrioritize(run.id)}>
                    {t('agent.prioritize')}
                  </button>
                )}
                {(run.status === 'paused' || run.status === 'interrupted' || run.status === 'needs_review') && (
                  <button type="button" className="agent-btn" onClick={() => onQueue(run.id)}>
                    {t('agent.queue')}
                  </button>
                )}
                <button type="button" className="agent-btn" onClick={() => onArchive(run.id)}>
                  {t('agent.archive')}
                </button>
              </div>
            </article>
          ))}
        </section>
      ))}
    </div>
  );
}
