import {
  CheckCircle,
  FileText,
  Minus,
  Plus,
  TerminalSquare,
  Users,
  Settings as SettingsIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useUIStore } from '../../stores/uiStore';
import {
  canStepEditorFontSize,
  stepEditorFontSize,
} from '../../stores/editorFontSize';

export function LeftNarrowSidebar() {
  const { t } = useTranslation();
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
  const editorFontSize = useUIStore((s) => s.editorFontSize);
  const setEditorFontSize = useUIStore((s) => s.setEditorFontSize);

  const docModeOn = !taskMode && !crmMode && activeView !== 'settings';
  const settingsOn = !taskMode && !crmMode && activeView === 'settings';
  const canDecreaseFont = canStepEditorFontSize(editorFontSize, -1);
  const canIncreaseFont = canStepEditorFontSize(editorFontSize, 1);

  return (
    <div id="nav-bar" className="nav-bar">
      <div className="nav-section" style={{ width: 'fit-content', gap: 6, paddingTop: 0, paddingBottom: 0, borderTop: 'none' }}>
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
          id="nav-btn-font-increase"
          type="button"
          disabled={!canIncreaseFont}
          onClick={() => setEditorFontSize(stepEditorFontSize(editorFontSize, 1))}
          title={t('settings.increaseTextSize')}
          aria-label={t('settings.increaseTextSize')}
          className="nav-btn"
        >
          <Plus size={15} />
        </button>
        <button
          id="nav-btn-font-decrease"
          type="button"
          disabled={!canDecreaseFont}
          onClick={() => setEditorFontSize(stepEditorFontSize(editorFontSize, -1))}
          title={t('settings.decreaseTextSize')}
          aria-label={t('settings.decreaseTextSize')}
          className="nav-btn"
        >
          <Minus size={15} />
        </button>
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
