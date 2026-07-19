import {
  CheckCircle,
  FileText,
  TerminalSquare,
  Users,
  Settings as SettingsIcon,
} from 'lucide-react';
import { useUIStore } from '../../stores/uiStore';

export function LeftNarrowSidebar() {
  const taskMode = useUIStore((s) => s.taskMode);
  const setTaskMode = useUIStore((s) => s.setTaskMode);
  const contextPanelOpenByMode = useUIStore((s) => s.contextPanelOpenByMode);
  const setContextPanelOpen = useUIStore((s) => s.setContextPanelOpen);
  const crmMode = useUIStore((s) => s.crmMode);
  const setCrmMode = useUIStore((s) => s.setCrmMode);
  const setActiveCRMPage = useUIStore((s) => s.setActiveCRMPage);
  const activeView = useUIStore((s) => s.activeView);
  const openSettings = useUIStore((s) => s.openSettings);
  const setActiveView = useUIStore((s) => s.setActiveView);
  const terminalPanelOpen = useUIStore((s) => s.terminalPanelOpen);
  const setTerminalPanelOpen = useUIStore((s) => s.setTerminalPanelOpen);

  const docModeOn = !taskMode && !crmMode && activeView !== 'settings';
  const settingsOn = !taskMode && !crmMode && activeView === 'settings';

  return (
    <div id="nav-bar" className="nav-bar">
      <div className="nav-section" style={{ width: 'fit-content', gap: 6, paddingTop: 6, paddingBottom: 6, borderTop: 'none' }}>
        <button
          id="nav-btn-documents"
          type="button"
          onClick={() => {
            setTaskMode(false);
            setCrmMode(false);
            setActiveView('document');
            // Mode entry: primary is ensured by setActiveView; open file tree if closed (UX).
            if (!contextPanelOpenByMode.documents) {
              setContextPanelOpen('documents', true);
            }
          }}
          title="Documents"
          className={`mode-btn${docModeOn ? ' mode-btn--on' : ''}`}
        >
          <FileText size={15} />
        </button>

        <button
          id="nav-btn-tasks"
          type="button"
          onClick={() => {
            // setTaskMode ensures primaryWrapperOpen; open task list if closed (UX).
            setTaskMode(true);
            if (!contextPanelOpenByMode.tasks) {
              setContextPanelOpen('tasks', true);
            }
          }}
          title="Tasks"
          className={`mode-btn${taskMode ? ' mode-btn--on' : ''}`}
        >
          <CheckCircle size={15} />
        </button>

        <button
          id="nav-btn-crm"
          type="button"
          onClick={() => {
            setActiveCRMPage('leads');
            // setCrmMode ensures primaryWrapperOpen; preserves assistant/swap/widths.
            setCrmMode(true);
          }}
          title="CRM"
          className={`mode-btn${crmMode ? ' mode-btn--on' : ''}`}
        >
          <Users size={15} />
        </button>

        <button
          id="nav-btn-settings"
          type="button"
          onClick={() => {
            setTaskMode(false);
            setCrmMode(false);
            if (!taskMode && !crmMode && activeView === 'settings') {
              setActiveView('document');
            } else {
              // openSettings ensures primaryWrapperOpen.
              openSettings();
            }
          }}
          title="Settings"
          className={`mode-btn${settingsOn ? ' mode-btn--on' : ''}`}
        >
          <SettingsIcon size={15} />
        </button>
      </div>

      <div className="nav-section nav-section-bottom">
        <button
          id="nav-btn-terminal"
          type="button"
          onClick={() => setTerminalPanelOpen(!terminalPanelOpen)}
          title={terminalPanelOpen ? 'Hide terminal (Ctrl+J)' : 'Show terminal (Ctrl+J)'}
          aria-label={terminalPanelOpen ? 'Hide terminal' : 'Show terminal'}
          aria-pressed={terminalPanelOpen}
          className={`nav-btn${terminalPanelOpen ? ' nav-btn--on' : ''}`}
        >
          <TerminalSquare size={15} />
        </button>
      </div>
    </div>
  );
}
