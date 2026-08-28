import { useTranslation } from 'react-i18next';
import type { AgentRunPlan } from '../../services/agent/policyEngine';

interface PlanCardProps {
  plan: AgentRunPlan;
  canDecide?: boolean;
  onApprove?: () => void;
  onRejectPause?: () => void;
  onRejectCancel?: () => void;
  onSwitchGuided?: () => void;
}

export function PlanCard({
  plan,
  canDecide = false,
  onApprove,
  onRejectPause,
  onRejectCancel,
  onSwitchGuided,
}: PlanCardProps) {
  const { t } = useTranslation();

  return (
    <section className="agent-card" aria-labelledby="agent-plan-title">
      <h2 id="agent-plan-title" className="agent-card-title">{t('agent.planTitle')}</h2>
      <p><strong>{t('agent.planGoal')}:</strong> {plan.goal}</p>
      <div>
        <strong>{t('agent.planSteps')}</strong>
        <ol>
          {plan.steps.map((step) => (
            <li key={step.id}>{step.title} ({step.status})</li>
          ))}
        </ol>
      </div>
      <p><strong>{t('agent.planExpectedChanges')}:</strong> {plan.expectedChanges.join(', ') || '—'}</p>
      <p><strong>{t('agent.planToolGroups')}:</strong> {plan.toolGroups.join(', ') || '—'}</p>
      <p><strong>{t('agent.planResourceScope')}:</strong> {plan.resourceScope.join(', ') || '—'}</p>
      <p><strong>{t('agent.planEstimatedOps')}:</strong> {plan.estimatedOperationCount}</p>
      <p><strong>{t('agent.planRisks')}:</strong> {plan.risks.join(', ') || '—'}</p>
      {canDecide && (
        <div className="agent-btn-row">
          <button type="button" className="agent-btn agent-btn--primary" onClick={onApprove}>
            {t('agent.approve')}
          </button>
          <button type="button" className="agent-btn" onClick={onRejectPause}>
            {t('agent.rejectPause')}
          </button>
          <button type="button" className="agent-btn" onClick={onRejectCancel}>
            {t('agent.rejectCancel')}
          </button>
          <button type="button" className="agent-btn" onClick={onSwitchGuided}>
            {t('agent.switchGuided')}
          </button>
        </div>
      )}
    </section>
  );
}
