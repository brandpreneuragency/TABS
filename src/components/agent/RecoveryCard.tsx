import { useTranslation } from 'react-i18next';
import type { AgentRun } from '../../types/agent';

interface RecoveryCardProps {
  run: AgentRun;
  onQueue: () => void;
  onCancel: () => void;
}

export function RecoveryCard({ run, onQueue, onCancel }: RecoveryCardProps) {
  const { t } = useTranslation();

  if (run.status !== 'needs_review') return null;

  return (
    <section className="agent-card" aria-labelledby="agent-recovery-title">
      <h2 id="agent-recovery-title" className="agent-card-title">{t('agent.recoveryTitle')}</h2>
      <p className="agent-status" data-status={run.status}>
        {run.interruptionReason ?? t('agent.recoveryHint')}
      </p>
      <div className="agent-btn-row">
        <button type="button" className="agent-btn agent-btn--primary" onClick={onQueue}>
          {t('agent.recoveryQueue')}
        </button>
        <button type="button" className="agent-btn" onClick={onCancel}>
          {t('agent.recoveryCancel')}
        </button>
      </div>
    </section>
  );
}
