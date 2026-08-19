import { PanelLeft } from 'lucide-react';
import type { WorkspaceMode } from '../../../stores/uiLayoutState';
import {
  selectActiveWorkspaceMode,
  selectIsContextPanelAvailable,
  useUIStore,
} from '../../../stores/uiStore';

const CONTEXT_PANEL_NOUN: Record<WorkspaceMode, string> = {
  documents: 'file tree',
  tasks: 'task list',
  crm: 'CRM list',
  forms: 'Forms list',
  settings: 'Settings list',
};

interface ContextPanelToggleProps {
  mode?: WorkspaceMode;
  /** When false (e.g. Task Projects, CRM Pipeline), control is hidden. */
  available?: boolean;
  /** Icon size in px. Defaults to 12 for toolbars, 16 for the header. */
  iconSize?: number;
  variant?: 'toolbar' | 'header';
}

/**
 * Collapses the mode contextual panel only.
 */
export function ContextPanelToggle({
  mode: modeProp,
  available: availableProp,
  iconSize,
  variant = 'toolbar',
}: ContextPanelToggleProps) {
  const activeMode = useUIStore(selectActiveWorkspaceMode);
  const availableFromStore = useUIStore(selectIsContextPanelAvailable);
  const mode = modeProp ?? activeMode;
  const available = availableProp ?? (modeProp == null ? availableFromStore : true);
  const open = useUIStore((s) => s.contextPanelOpenByMode[mode]);
  const toggleContextPanel = useUIStore((s) => s.toggleContextPanel);

  if (!available) {
    if (variant === 'header') {
      return <span className="ai-toggle-btn" aria-hidden="true" style={{ visibility: 'hidden' }} />;
    }
    return null;
  }

  const noun = CONTEXT_PANEL_NOUN[mode];
  const label = open ? `Hide ${noun}` : `Show ${noun}`;
  const resolvedIconSize = iconSize ?? (variant === 'header' ? 16 : 12);
  const className =
    variant === 'header'
      ? `ai-toggle-btn${open ? ' ai-toggle-btn--on' : ''}`
      : `context-panel-toggle tbar-btn${open ? ' tbar-btn--on context-panel-toggle--on' : ''}`;

  return (
    <button
      id={`context-panel-toggle-${mode}`}
      type="button"
      className={className}
      onMouseDown={variant === 'header' ? (event) => event.stopPropagation() : undefined}
      onClick={() => toggleContextPanel(mode)}
      title={label}
      aria-label={label}
      aria-pressed={open}
    >
      <PanelLeft size={resolvedIconSize} />
    </button>
  );
}
