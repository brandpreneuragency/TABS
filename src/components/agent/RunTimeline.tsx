import { useTranslation } from 'react-i18next';
import type { AgentEvent } from '../../types/agent';
import { ToolEventCard } from './ToolEventCard';

interface RunTimelineProps {
  events: AgentEvent[];
}

export function RunTimeline({ events }: RunTimelineProps) {
  const { t } = useTranslation();

  if (events.length === 0) {
    return (
      <p className="subtle" style={{ fontSize: 'var(--fs-xs)' }}>
        {t('agent.timelineEmpty')}
      </p>
    );
  }

  return (
    <div className="agent-timeline" aria-label={t('agent.timeline')}>
      {events.map((event) => (
        <ToolEventCard key={event.id} event={event} />
      ))}
    </div>
  );
}
