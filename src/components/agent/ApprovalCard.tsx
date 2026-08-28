import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentApproval } from '../../types/agent';

interface ApprovalCardProps {
  approval: AgentApproval;
  autoFocus?: boolean;
  onApprove: () => void;
  onReject: () => void;
}

export function ApprovalCard({
  approval,
  autoFocus = false,
  onApprove,
  onReject,
}: ApprovalCardProps) {
  const { t } = useTranslation();
  const approveRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (autoFocus) approveRef.current?.focus();
  }, [autoFocus, approval.id]);

  return (
    <section
      className="agent-card"
      aria-labelledby={`agent-approval-${approval.id}`}
      data-approval-id={approval.id}
    >
      <h2 id={`agent-approval-${approval.id}`} className="agent-card-title">
        {t('agent.approvalTitle')}
      </h2>
      <p>
        <span className="agent-status" data-status={approval.status}>
          {approval.status}
        </span>
        {approval.toolName ? ` · ${approval.toolName}` : ''}
        {` · ${approval.risk}`}
      </p>
      {approval.resourceKeys.length > 0 && (
        <p>{approval.resourceKeys.join(', ')}</p>
      )}
      {approval.status === 'pending' && (
        <div className="agent-btn-row">
          <button
            ref={approveRef}
            type="button"
            className="agent-btn agent-btn--primary"
            onClick={onApprove}
          >
            {t('agent.approve')}
          </button>
          <button type="button" className="agent-btn" onClick={onReject}>
            {t('agent.reject')}
          </button>
        </div>
      )}
    </section>
  );
}
