import { Columns2 } from 'lucide-react';
import type { WorkspaceMode } from '../../../stores/uiLayoutState';
import { useUIStore } from '../../../stores/uiStore';

const CONTEXT_PANEL_NOUN: Record<WorkspaceMode, string> = {
  documents: 'file tree',
  tasks: 'task list',
  crm: 'CRM list',
  forms: 'Forms list',
  settings: 'Settings list',
};

interface ContextPanelToggleProps {
  mode: WorkspaceMode;
  /** When false (e.g. Task Projects, CRM Pipeline), control is hidden. */
  available: boolean;
}

/**
 * Inner primary-wrapper control: collapses the mode contextual panel only.
 * Distinct from header-btn-workspace (whole primary wrapper).
 */
export function ContextPanelToggle({ mode, available }: ContextPanelToggleProps) {
  const open = useUIStore((s) => s.contextPanelOpenByMode[mode]);
  const toggleContextPanel = useUIStore((s) => s.toggleContextPanel);

  if (!available) return null;

  const noun = CONTEXT_PANEL_NOUN[mode];
  const label = open ? `Hide ${noun}` : `Show ${noun}`;

  return (
    <button
      id={`context-panel-toggle-${mode}`}
      type="button"
      className={`context-panel-toggle tbar-btn${open ? ' tbar-btn--on context-panel-toggle--on' : ''}`}
      onClick={() => toggleContextPanel(mode)}
      title={label}
      aria-label={label}
      aria-pressed={open}
    >
      <Columns2 size={12} />
    </button>
  );
}
