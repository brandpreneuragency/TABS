import { useEffect, type ReactNode } from 'react';
import {
  useUIStore,
  selectActiveWorkspaceMode,
  type WorkspaceMode,
} from '../../stores/uiStore';
import { LeftNarrowSidebar } from './LeftNarrowSidebar';
import { FileViewerPanel } from '../fileViewer/FileViewerPanel';
import { RightPanelSubheader } from '../sidebar/RightPanelSubheader';
import { TerminalPanel } from '../terminal/TerminalPanel';
import { SettingsDocument } from '../settings/SettingsDocument';
import {
  WorkspaceShell,
  PrimaryWorkspaceContent,
  ContextPanelToggle,
} from './workspace';

interface AppLayoutProps {
  editor: ReactNode;
  sidebar: ReactNode;
  leftPanel: ReactNode;
  taskListPanel: ReactNode;
  modals: ReactNode;
  subtasksBar?: ReactNode;
}

/**
 * Universal two-wrapper shell for Documents, Tasks, CRM, Forms, and Settings.
 */
export function AppLayout({
  editor,
  sidebar,
  leftPanel,
  taskListPanel,
  modals,
  subtasksBar,
}: AppLayoutProps) {
  const editorFontSize = useUIStore((s) => s.editorFontSize);

  useEffect(() => {
    if (editorFontSize === 14) {
      document.documentElement.setAttribute('data-text-size', '14');
    } else if (editorFontSize === 16) {
      document.documentElement.setAttribute('data-text-size', '16');
    } else {
      document.documentElement.removeAttribute('data-text-size');
    }
  }, [editorFontSize]);

  return (
    <div className="workspace">
      <div className="sidebar-panel">
        <LeftNarrowSidebar />
      </div>

      <div id="workspace-panels" className="workspace-panels flex flex-1 min-w-0 min-h-0 overflow-h">
        <div id="workspace-content" className="workspace-content flex flex-1 min-w-0 min-h-0 overflow-h">
          <UniversalWorkspaceShell
            editor={editor}
            sidebar={sidebar}
            leftPanel={leftPanel}
            taskListPanel={taskListPanel}
            subtasksBar={subtasksBar}
          />
        </div>
        {modals}
      </div>

      <TerminalPanel />
    </div>
  );
}

function UniversalWorkspaceShell({
  editor,
  sidebar,
  leftPanel,
  taskListPanel,
  subtasksBar,
}: {
  editor: ReactNode;
  sidebar: ReactNode;
  leftPanel: ReactNode;
  taskListPanel: ReactNode;
  subtasksBar?: ReactNode;
}) {
  const primaryWrapperOpen = useUIStore((s) => s.primaryWrapperOpen);
  const assistantWrapperOpen = useUIStore((s) => s.assistantWrapperOpen);
  const wrappersSwapped = useUIStore((s) => s.wrappersSwapped);
  const assistantWrapperWidth = useUIStore((s) => s.assistantWrapperWidth);
  const contextPanelWidth = useUIStore((s) => s.contextPanelWidth);
  const contextPanelOpenByMode = useUIStore((s) => s.contextPanelOpenByMode);
  const fileViewerOpen = useUIStore((s) => s.fileViewerOpen);
  const activeTaskPage = useUIStore((s) => s.activeTaskPage);
  const activeCRMPage = useUIStore((s) => s.activeCRMPage);
  const activeSettingsSubTab = useUIStore((s) => s.activeSettingsSubTab);
  const mode = useUIStore(selectActiveWorkspaceMode);

  const layout = resolveModeLayout({
    mode,
    editor,
    leftPanel,
    taskListPanel,
    subtasksBar,
    contextPanelOpenByMode,
    contextPanelWidth,
    activeTaskPage,
    activeCRMPage,
  });

  const assistantBody = fileViewerOpen ? (
    <div className="flex-1 min-h-0 overflow-hidden flex flex-col h-full">
      <FileViewerPanel />
    </div>
  ) : (
    <>
      {mode === 'settings' ? (
        <RightPanelSubheader
          mode="writer"
          workspaceId={null}
          taskId={null}
          settingsTab={activeSettingsSubTab}
        />
      ) : mode === 'tasks' ? (
        <RightPanelSubheader mode="task" />
      ) : (
        <RightPanelSubheader />
      )}
      <div className="flex-1 min-h-0 overflow-hidden">{sidebar}</div>
    </>
  );

  return (
    <WorkspaceShell
      primaryWrapperOpen={primaryWrapperOpen}
      assistantWrapperOpen={assistantWrapperOpen}
      wrappersSwapped={wrappersSwapped}
      assistantWrapperWidthVw={assistantWrapperWidth}
      assistantContentId={fileViewerOpen ? 'file-viewer-panel' : 'ai-sidebar-panel'}
      primary={layout.primary}
      // Always pass body so CSS-hidden assistant keeps chat/file-viewer mounted.
      assistant={assistantBody}
    />
  );
}

function resolveModeLayout(args: {
  mode: WorkspaceMode;
  editor: ReactNode;
  leftPanel: ReactNode;
  taskListPanel: ReactNode;
  subtasksBar?: ReactNode;
  contextPanelOpenByMode: {
    documents: boolean;
    tasks: boolean;
    crm: boolean;
    forms: boolean;
    settings: boolean;
  };
  contextPanelWidth: number;
  activeTaskPage: string;
  activeCRMPage: string;
}): { primary: ReactNode } {
  const {
    mode,
    editor,
    leftPanel,
    taskListPanel,
    subtasksBar,
    contextPanelOpenByMode,
    contextPanelWidth,
    activeTaskPage,
    activeCRMPage,
  } = args;

  // Settings: section components own PrimaryWorkspaceContent via SettingsPanels.
  if (mode === 'settings') {
    return { primary: <SettingsDocument /> };
  }

  if (mode === 'documents') {
    return {
      primary: (
        <PrimaryWorkspaceContent
          mode="documents"
          contextPanel={leftPanel}
          centerPanel={editor}
          contextPanelAvailable
          contextPanelOpen={contextPanelOpenByMode.documents}
          contextPanelWidthVw={contextPanelWidth}
          contextPanelId="file-tree-panel"
          contextPanelStyle={{ paddingLeft: 12, paddingRight: 0 }}
        />
      ),
    };
  }

  if (mode === 'tasks') {
    const projectsOnly = activeTaskPage === 'projects';
    const showSubtasks = !projectsOnly && Boolean(subtasksBar);
    const contextAvailable = !projectsOnly;
    return {
      primary: (
        <PrimaryWorkspaceContent
          mode="tasks"
          contextPanel={taskListPanel}
          centerPanel={editor}
          contextPanelAvailable={contextAvailable}
          contextPanelOpen={contextPanelOpenByMode.tasks}
          contextPanelWidthVw={contextPanelWidth}
          contextPanelId="task-list-column"
          contextPanelStyle={{
            paddingTop: 0,
            paddingBottom: 0,
            backgroundColor: 'var(--c-background-2)',
          }}
          subtasksBar={subtasksBar}
          showSubtasksBar={showSubtasks}
        />
      ),
    };
  }

  if (mode === 'crm') {
    const pipelineOnly = activeCRMPage === 'pipeline';
    const contextAvailable = !pipelineOnly;
    return {
      primary: (
        <PrimaryWorkspaceContent
          mode="crm"
          contextPanel={leftPanel}
          centerPanel={editor}
          contextPanelAvailable={contextAvailable}
          contextPanelOpen={contextPanelOpenByMode.crm}
          contextPanelWidthVw={contextPanelWidth}
          contextPanelId="crm-forms-list-column"
          contextPanelStyle={{
            paddingTop: 0,
            paddingBottom: 0,
            backgroundColor: 'var(--c-background-1)',
          }}
          leadingControls={
            contextAvailable ? (
              <ContextPanelToggle mode="crm" available />
            ) : undefined
          }
        />
      ),
    };
  }

  // forms (hosted under CRM with activeCRMPage === 'forms')
  return {
    primary: (
      <PrimaryWorkspaceContent
        mode="forms"
        contextPanel={leftPanel}
        centerPanel={editor}
        contextPanelAvailable
        contextPanelOpen={contextPanelOpenByMode.forms}
        contextPanelWidthVw={contextPanelWidth}
        contextPanelId="crm-forms-list-column"
        contextPanelStyle={{
          paddingTop: 0,
          paddingBottom: 0,
          backgroundColor: 'var(--c-background-1)',
        }}
        leadingControls={<ContextPanelToggle mode="forms" available />}
      />
    ),
  };
}
