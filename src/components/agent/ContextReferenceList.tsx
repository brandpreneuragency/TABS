import { useTranslation } from 'react-i18next';
import type { AgentContextRef } from '../../types/agent';

interface ContextReferenceListProps {
  refs: AgentContextRef[];
  frozen?: boolean;
  onRemove?: (id: string) => void;
  onOpen?: (ref: AgentContextRef) => void;
}

export function ContextReferenceList({
  refs,
  frozen = false,
  onRemove,
  onOpen,
}: ContextReferenceListProps) {
  const { t } = useTranslation();

  if (refs.length === 0) {
    return (
      <p className="subtle" style={{ fontSize: 'var(--fs-xs)', margin: 0 }}>
        {t('agent.noContext')}
      </p>
    );
  }

  return (
    <ul className="agent-context-list" aria-label={t('agent.context')}>
      {refs.map((ref) => (
        <li key={`${ref.kind}:${ref.id}`} className="agent-context-chip">
          <button
            type="button"
            className="agent-resource-link"
            onClick={() => onOpen?.(ref)}
          >
            {ref.kind}: {ref.label}
          </button>
          {!frozen && onRemove && (
            <button
              type="button"
              aria-label={t('agent.removeContext')}
              onClick={() => onRemove(ref.id)}
            >
              ×
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
