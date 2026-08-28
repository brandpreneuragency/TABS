import { Bot } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { captureCurrentContext, openAgentComposer } from './captureCurrentContext';
import { useHarnessEnabled } from './useHarnessEnabled';

interface AgentLaunchButtonProps {
  source: 'documents' | 'tasks' | 'crm' | 'forms';
}

const LABEL_KEY = {
  documents: 'agent.launchFromDocuments',
  tasks: 'agent.launchFromTasks',
  crm: 'agent.launchFromCrm',
  forms: 'agent.launchFromForms',
} as const;

export function AgentLaunchButton({ source }: AgentLaunchButtonProps) {
  const { t } = useTranslation();
  const enabled = useHarnessEnabled();
  if (!enabled) return null;

  const label = t(LABEL_KEY[source]);
  return (
    <button
      type="button"
      className="agent-btn agent-launch-btn"
      data-agent-launch={source}
      title={label}
      aria-label={label}
      onClick={() => openAgentComposer(captureCurrentContext())}
    >
      <Bot size={14} />
      <span>{label}</span>
    </button>
  );
}
