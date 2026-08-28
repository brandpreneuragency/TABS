import { useTranslation } from 'react-i18next';
import type { AgentEvent } from '../../types/agent';
import { classifyEvent } from './runPresentation';

interface ToolEventCardProps {
  event: AgentEvent;
}

const KIND_I18N = {
  model: 'agent.eventModel',
  read: 'agent.eventRead',
  proposed: 'agent.eventProposed',
  approved: 'agent.eventApproved',
  rejected: 'agent.eventRejected',
  error: 'agent.eventError',
  recovery: 'agent.eventRecovery',
  artifact: 'agent.eventArtifact',
} as const;

export function ToolEventCard({ event }: ToolEventCardProps) {
  const { t } = useTranslation();
  const kind = classifyEvent(event.type);
  const data = event.data && typeof event.data === 'object'
    ? event.data as Record<string, unknown>
    : {};
  const summary = typeof data.summary === 'string'
    ? data.summary
    : typeof data.toolName === 'string'
      ? data.toolName
      : event.type;

  return (
    <article className="agent-card" data-event-type={event.type} data-event-kind={kind}>
      <h3 className="agent-card-title">{t(KIND_I18N[kind])}</h3>
      <p className="agent-status" data-status={kind}>{summary}</p>
    </article>
  );
}
