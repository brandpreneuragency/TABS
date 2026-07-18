import { useEffect, useState, useCallback } from 'react';
import type { Editor } from '@tiptap/react';
import { AppLayout } from './components/layout/AppLayout';
import { AppTitlebar } from './components/header/AppTitlebar';
import { Header } from './components/header/Header';
import { SubtasksToggleBar } from './components/header/SubtasksToggleBar';
import { EditorWorkspace } from './components/editor/EditorWorkspace';
import { TaskDetailPanel } from './components/taskManager/TaskDetailPanel';
import { TaskProjectsKanban } from './components/taskManager/TaskProjectsKanban';
import { AISidebar } from './components/sidebar/AISidebar';
import { FileExplorerPanel } from './components/fileExplorer/FileExplorerPanel';
import { TaskListPanel } from './components/taskManager/TaskListPanel';
import { AgentEditor } from './components/modals/AgentEditor';
import { QuickPrompts } from './components/modals/QuickPrompts';
import { TrashModal } from './components/modals/TrashModal';
import { ModelSwitcher } from './components/ui/ModelSwitcher';
import { ToastContainer } from './components/ui/Toast';
import { CRMWorkspace } from './components/layout/CRMWorkspace';
import { ChatWorkspace } from './components/chatMode/ChatWorkspace';
import { SessionListColumn } from './components/chatMode/SessionListColumn';
import { CRMListPanel } from './components/crm/CRMListPanel';
import { FormsListPanel } from './components/forms/FormsListPanel';
import { CRMAISidebar } from './components/sidebar/CRMAISidebar';
import { useWorkspaceStore } from './stores/workspaceStore';
import { useUIStore } from './stores/uiStore';
import type { CRMPage, FormsPage } from './stores/uiStore';
import { useAIStore } from './stores/aiStore';
import { useTaskStore } from './stores/taskStore';
import { useProjectStore } from './stores/projectStore';
import { useCrmStore } from './stores/crmStore';
import { useFormsStore } from './stores/formsStore';
import { useThemeStore } from './stores/themeStore';
import { runStartupUpdateCheck } from './services/updater';
import { loadReasoningOverlay } from './services/ai/reasoning';

export default function App() {
  const [editor, setEditor] = useState<Editor | null>(null);
  const [trashOpen, setTrashOpen] = useState(false);
  const { loadWorkspaces, activeWorkspaceId, isLoaded: docsLoaded, setActiveWorkspace } = useWorkspaceStore();
  const {
    loadUISettings,
    taskMode,
    activeTaskId,
    activeTaskPage,
    setTaskMode,
    chatMode,
    crmMode,
    activeCRMPage,
    activeFormsPage,
    activeView,
    activeSettingsSubTab,
  } = useUIStore();
  const { loadAISettings } = useAIStore();
  const { loadThemeTokens } = useThemeStore();
  const { loadTasks, isLoaded: tasksLoaded, activeTaskId: storeActiveTaskId, setActiveTask, tasks } = useTaskStore();
  const { loadProjects, isLoaded: projectsLoaded } = useProjectStore();

  // CRM/Forms active selections drive the Panel 3 CRM AI sidebar context.
  const activeLeadId = useCrmStore((s) => s.activeLeadId);
  const activePipelineView = useCrmStore((s) => s.activePipelineView);
  const activeFormId = useFormsStore((s) => s.activeFormId);
  const activeSubmissionId = useFormsStore((s) => s.activeSubmissionId);
  const activeFormStatus = useFormsStore((s) => s.forms.find((f) => f.id === s.activeFormId)?.status ?? null);

  const isLoaded = docsLoaded && tasksLoaded && projectsLoaded;

  useEffect(() => {
    void Promise.all([
      loadWorkspaces(),
      loadUISettings(),
      loadAISettings(),
      loadTasks(),
      loadProjects(),
      useCrmStore.getState().loadCrm(),
      useFormsStore.getState().loadForms(),
      loadThemeTokens(),
    ]);
    // Check for app updates in the background (no-op in the browser).
    void runStartupUpdateCheck();
    // Load any runtime-refreshed reasoning catalog override from Dexie.
    void loadReasoningOverlay();
  }, [
    loadWorkspaces,
    loadUISettings,
    loadAISettings,
    loadTasks,
    loadProjects,
    loadThemeTokens,
  ]);

  // Listen for "Open with TABS" / argv file events from the Tauri shell.
  // Wait until workspaces are loaded so cold-start open does not race Dexie
  // restore. Also pull any pending path stored at setup (event may fire before
  // this listener is registered). No-op in the browser.
  useEffect(() => {
    if (!docsLoaded) return;

    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      try {
        if (!('__TAURI_INTERNALS__' in window)) return;

        const openPath = (payload: string) => {
          const path = payload.trim();
          if (!path) return;
          void useWorkspaceStore.getState().openFileByPath(path);
        };

        const [{ listen }, { invoke }] = await Promise.all([
          import('@tauri-apps/api/event'),
          import('@tauri-apps/api/core'),
        ]);
        if (cancelled) return;

        unlisten = await listen<string>('tabs://open-file', (e) => {
          const payload = typeof e.payload === 'string' ? e.payload : '';
          openPath(payload);
        });

        // Recover cold-start path if the setup emit raced the listener.
        try {
          const pending = await invoke<string | null>('take_pending_open_file');
          if (!cancelled && typeof pending === 'string' && pending) {
            openPath(pending);
          }
        } catch {
          // Older desktop builds without the command — ignore.
        }
      } catch {
        // Not running in Tauri — ignore.
      }
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [docsLoaded]);

  // Keyboard shortcut: Ctrl/Cmd + Shift + T toggles task mode
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'T') {
        e.preventDefault();
        const newMode = !taskMode;
        setTaskMode(newMode);
        if (newMode) {
          const lastTaskId = tasks[0]?.id ?? null;
          if (lastTaskId) setActiveTask(lastTaskId);
        } else {
          if (activeWorkspaceId) setActiveWorkspace(activeWorkspaceId);
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [taskMode, setTaskMode, tasks, activeWorkspaceId, setActiveWorkspace, setActiveTask]);

  // Keyboard shortcut: Ctrl/Cmd + J toggles the terminal panel.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'j') {
        e.preventDefault();
        useUIStore.getState().setTerminalPanelOpen(!useUIStore.getState().terminalPanelOpen);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const handleEditorReady = useCallback((e: Editor) => {
    setEditor(e);
  }, []);

  const handleQuickPromptSelect = useCallback((prompt: string) => {
    sessionStorage.setItem('pendingPrompt', prompt);
    window.dispatchEvent(new CustomEvent('quickPromptSelected', { detail: prompt }));
  }, []);

  if (!isLoaded) {
    return (
      <div className="h-dvh" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#fff' }}>
        <div className="flex-col gap-3" style={{ display: 'flex', alignItems: 'center' }}>
          <div style={{
            width: 32, height: 32,
            border: '2px solid var(--c-accent-center-panel)', borderTopColor: 'transparent',
            borderRadius: '50%',
          }} />
          <span className="subtle" style={{ fontSize: 'var(--fs-sm)' }}>Loading...</span>
        </div>
      </div>
    );
  }

  const effectiveTaskId = activeTaskId ?? storeActiveTaskId;

  // The Settings doc only lives in doc mode (not task/crm/chat).
  const settingsActive = !taskMode && !crmMode && !chatMode && activeView === 'settings';

  // Panel 2 (editor) — CHAT > CRM > task > doc. Settings primary content is
  // owned by AppLayout (SettingsDocument → section slots).
  const activeWorkspace = chatMode
    ? <ChatWorkspace />
    : crmMode
    ? <CRMWorkspace />
    : taskMode
    ? activeTaskPage === 'projects'
      ? <TaskProjectsKanban />
      : <TaskDetailPanel />
    : settingsActive
    ? null
    : <EditorWorkspace onEditorReady={handleEditorReady} />;

  // Panel 1 (leftPanel) — session list / CRM / Forms / file explorer.
  // Settings supplies its own list via SettingsPanels inside SettingsDocument.
  const formsPageActive = crmMode && activeCRMPage === 'forms';
  const leftPanel = chatMode
    ? <SessionListColumn />
    : crmMode
    ? formsPageActive
      ? <FormsListPanel />
      : <CRMListPanel />
    : settingsActive
    ? null
    : <FileExplorerPanel />;

  // Assistant content — CRM AI, Settings AI (scoped by sub-tab), or doc/task AI.
  const crmContext = {
    module: (formsPageActive ? 'forms' : 'crm') as 'crm' | 'forms',
    page: (formsPageActive ? activeFormsPage : activeCRMPage) as CRMPage | FormsPage,
    leadId: crmMode && activeCRMPage === 'leads' ? activeLeadId : null,
    contactId: null,
    companyId: null,
    pipelineView: crmMode && activeCRMPage === 'pipeline' ? (activePipelineView as string) : null,
    formId: formsPageActive && (activeFormsPage === 'builder' || activeFormsPage === 'list') ? activeFormId : null,
    submissionId: formsPageActive && activeFormsPage === 'submissions' ? activeSubmissionId : null,
    embedState: formsPageActive && (activeFormsPage === 'builder' || activeFormsPage === 'list') ? activeFormStatus : null,
  };

  const sidebar = chatMode
    ? (
      <AISidebar
        workspaceId={null}
        taskId={null}
        editor={null}
      />
    )
    : crmMode
    ? <CRMAISidebar crmContext={crmContext} />
    : settingsActive
    ? (
      <AISidebar
        workspaceId={null}
        taskId={null}
        settingsTab={activeSettingsSubTab}
        editor={null}
      />
    )
    : (
      <AISidebar
        workspaceId={taskMode ? '' : activeWorkspaceId}
        taskId={taskMode ? effectiveTaskId ?? '' : ''}
        editor={editor}
      />
    );

  return (
    <>
      {/* Shell — `app-shell` is the Agent 2 foundation (100dvh +
          grid, see src/styles/layout.css). The `#app-content` rule
          in index.css keeps `margin-top: 0` and a stable overflow
          anchor. The direct child `.app-shell-main` guarantees
          `min-height: 0; min-width: 0; overflow: hidden` so the
          workspace can shrink and internal panels can scroll. */}
      <div id="app-content" className="app-shell">
        <AppTitlebar>
          <Header />
        </AppTitlebar>
        <div className="app-shell-main">
          <AppLayout
            subtasksBar={<SubtasksToggleBar />}
            editor={activeWorkspace}
            sidebar={sidebar}
            leftPanel={leftPanel}
            taskListPanel={<TaskListPanel />}
            modals={
              <>
                <AgentEditor />
                <QuickPrompts onSelectPrompt={handleQuickPromptSelect} />
                {trashOpen && <TrashModal onClose={() => setTrashOpen(false)} />}
                <ModelSwitcher />
              </>
            }
          />
        </div>
      </div>
      <ToastContainer />
    </>
  );
}
