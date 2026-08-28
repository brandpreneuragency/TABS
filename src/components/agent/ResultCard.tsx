import { useTranslation } from 'react-i18next';
import type { AgentArtifact, AgentContextRef, AgentRun } from '../../types/agent';
import { contextRefFromResourceKey } from './runPresentation';

interface ResultCardProps {
  run: AgentRun;
  artifacts: AgentArtifact[];
  resourceKeys?: string[];
  onOpenResource: (ref: AgentContextRef) => void;
}

export function ResultCard({
  run,
  artifacts,
  resourceKeys = [],
  onOpenResource,
}: ResultCardProps) {
  const { t } = useTranslation();

  return (
    <section className="agent-card" aria-labelledby="agent-result-title">
      <h2 id="agent-result-title" className="agent-card-title">{t('agent.resultTitle')}</h2>
      <p>{run.finalSummary ?? t('agent.emptyResult')}</p>
      {resourceKeys.length > 0 && (
        <div>
          <strong>{t('agent.changedResources')}</strong>
          <ul>
            {resourceKeys.map((key) => {
              const ref = contextRefFromResourceKey(key);
              return (
                <li key={key}>
                  {ref ? (
                    <button
                      type="button"
                      className="agent-resource-link"
                      onClick={() => onOpenResource(ref)}
                    >
                      {t('agent.resourceLink')}: {key}
                    </button>
                  ) : key}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <div>
        <strong>{t('agent.artifacts')}</strong>
        {artifacts.length === 0 ? (
          <p className="subtle">{t('agent.noArtifacts')}</p>
        ) : (
          <ul>
            {artifacts.map((artifact) => (
              <li key={artifact.id}>{artifact.label} ({artifact.kind})</li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
