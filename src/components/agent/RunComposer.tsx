import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

interface RunComposerProps {
  mode: 'start' | 'steer';
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
}

export function RunComposer({
  mode,
  value,
  disabled = false,
  onChange,
  onSubmit,
}: RunComposerProps) {
  const { t } = useTranslation();
  const placeholder = mode === 'steer'
    ? t('agent.steeringPlaceholder')
    : t('agent.composerPlaceholder');
  const submitLabel = mode === 'steer' ? t('agent.sendSteering') : t('agent.startRun');

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!disabled && value.trim()) onSubmit();
  };

  return (
    <form id="agent-run-composer" className="agent-composer" onSubmit={handleSubmit}>
      <label htmlFor="agent-composer-input" className="agent-card-title">
        {mode === 'steer' ? t('agent.steering') : t('agent.goal')}
      </label>
      <textarea
        id="agent-composer-input"
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
      {mode === 'steer' && (
        <p className="subtle" style={{ fontSize: 'var(--fs-xs)', margin: 0 }}>
          {t('agent.steeringHint')}
        </p>
      )}
      <button
        type="submit"
        className="agent-btn agent-btn--primary"
        disabled={disabled || !value.trim()}
      >
        {submitLabel}
      </button>
    </form>
  );
}
