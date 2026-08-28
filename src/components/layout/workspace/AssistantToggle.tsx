import { PanelRight } from 'lucide-react';
import { useUIStore } from '../../../stores/uiStore';

interface AssistantToggleProps {
  /** Icon size in px. Defaults to 12 for toolbars, 16 for the header. */
  iconSize?: number;
  variant?: 'toolbar' | 'header';
  /** Override the default header id when the control is duplicated. */
  id?: string;
}

/**
 * Shows or hides the assistant wrapper.
 */
export function AssistantToggle({
  iconSize,
  variant = 'toolbar',
  id = 'header-btn-assistant',
}: AssistantToggleProps) {
  const assistantOpen = useUIStore((s) => s.assistantWrapperOpen);
  const toggleAssistantWrapper = useUIStore((s) => s.toggleAssistantWrapper);

  const label = assistantOpen ? 'Hide assistant' : 'Show assistant';
  const resolvedIconSize = iconSize ?? (variant === 'header' ? 16 : 12);
  const className =
    variant === 'header'
      ? `ai-toggle-btn${assistantOpen ? ' ai-toggle-btn--on' : ''}`
      : `assistant-toggle tbar-btn${assistantOpen ? ' tbar-btn--on' : ''}`;

  const handleToggle = () => {
    const assistantEl = document.getElementById('assistant-wrapper');
    const focusInside = Boolean(
      assistantOpen && assistantEl?.contains(document.activeElement),
    );
    toggleAssistantWrapper();
    if (focusInside) {
      requestAnimationFrame(() => {
        document.getElementById(id)?.focus();
      });
    }
  };

  return (
    <button
      id={id}
      type="button"
      title={label}
      aria-label={label}
      onMouseDown={variant === 'header' ? (event) => event.stopPropagation() : undefined}
      onClick={handleToggle}
      aria-pressed={assistantOpen}
      className={className}
    >
      <PanelRight size={resolvedIconSize} />
    </button>
  );
}
