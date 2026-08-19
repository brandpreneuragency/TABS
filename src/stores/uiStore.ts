import { create } from 'zustand';
import { nanoid } from 'nanoid';
import { db } from '../services/db';
import i18n from '../i18n';
import type { FileViewerItem } from '../types';
import {
  applyAssistantWrapperOpen,
  applyPrimaryWrapperOpen,
  clampAssistantWrapperWidth,
  clampContextPanelWidth,
  migrateLayoutStateFromStored,
  selectActiveWorkspaceMode as selectActiveWorkspaceModeImpl,
  selectCanSwapWrappers as selectCanSwapWrappersImpl,
  selectIsAssistantWrapperOpen as selectIsAssistantWrapperOpenImpl,
  selectIsContextPanelAvailable as selectIsContextPanelAvailableImpl,
  selectIsContextPanelOpen as selectIsContextPanelOpenImpl,
  selectIsPrimaryWrapperOpen as selectIsPrimaryWrapperOpenImpl,
  ASSISTANT_WRAPPER_WIDTH_DEFAULT_VW,
  CONTEXT_PANEL_WIDTH_DEFAULT_VW,
  DEFAULT_CONTEXT_PANEL_OPEN_BY_MODE,
  type ContextPanelOpenByMode,
  type WorkspaceMode,
} from './uiLayoutState';

export type { ContextPanelOpenByMode, WorkspaceMode } from './uiLayoutState';

export interface Toast {
  id: string;
  message: string;
  type: 'error' | 'info';
  actionLabel?: string;
  onAction?: () => void;
}

interface SelectionState {
  text: string;
  from: number;
  to: number;
}

export type SidebarTab = 'chat' | 'actions' | 'characters' | 'models';

/** Active sub-page within the CRM module (owned by uiStore so the shell can switch panels).
 *  'forms' hosts the merged Forms sub-module (list/builder/submissions/templates/settings),
 *  whose exact page is tracked by `activeFormsPage`. */
export type CRMPage = 'dashboard' | 'leads' | 'contacts' | 'companies' | 'pipeline' | 'activities' | 'forms' | 'settings';
/** Active sub-page within the Forms module (owned by uiStore so the shell can switch panels). */
export type FormsPage = 'dashboard' | 'list' | 'builder' | 'submissions' | 'templates' | 'settings';
/** Active view within the Task module list panel (owned by uiStore so the shell header can switch views). */
export type TaskPage = 'list' | 'calendar' | 'projects';

/** Sub-tabs rendered inside the Settings document. Fixed and non-closable. */
export type SettingsSubTab = 'tools' | 'actions' | 'appearance' | 'agents';
/** Legacy Settings sub-tab id kept for deep-link compatibility (maps to `tools`). */
export type LegacySettingsSubTab = SettingsSubTab | 'models';
/** Which doc-mode tab is active: a normal document or the special Settings doc. */
export type DocActiveView = 'document' | 'settings';

interface UIStore {
  // ── Logical two-wrapper layout ─────────────────────────────────────
  primaryWrapperOpen: boolean;
  assistantWrapperOpen: boolean;
  wrappersSwapped: boolean;
  /** Assistant/detail wrapper width in vw (shared across modes). */
  assistantWrapperWidth: number;
  /** Contextual panel width in vw (shared across modes). */
  contextPanelWidth: number;
  contextPanelOpenByMode: ContextPanelOpenByMode;

  sidebarTab: SidebarTab;
  selectedText: SelectionState | null;
  activeModal:
    | 'settings'
    | 'agentEditor'
    | 'quickPrompts'
    | 'editAgent'
    | 'modelManagement'
    | 'fontSettings'
    | 'writersManager'
    | 'taskProfilesManager'
    | 'actionsManager'
    | 'agentsManager'
    | 'actionsManagerModal'
    | 'appearanceSettings'
    | null;
  actionsManagerScope: 'writer' | 'task' | 'crm';
  editingAgentId: string | null;
  findReplaceOpen: boolean;
  htmlViewOpen: boolean;
  /** When true, document headings use accent color in the TipTap editor. */
  rainbowMode: boolean;

  settingsPanelOpen: boolean;
  expandedPaths: string[];
  selectedTreePath: string | null;
  editorFontFamily: string;
  editorFontSize: 12 | 14 | 16;
  language: 'en' | 'tr';

  taskMode: boolean;
  activeTaskId: string | null;
  subtasksOpen: boolean;

  /** CRM module active — mutually exclusive with task mode. Hosts the merged Forms sub-module via `activeCRMPage === 'forms'`. */
  crmMode: boolean;
  /** Active sub-page within the CRM module. */
  activeCRMPage: CRMPage;
  /** Active sub-page within the Forms module. */
  activeFormsPage: FormsPage;
  /** Active view within the Task module list panel. */
  activeTaskPage: TaskPage;

  /** Which doc-mode tab is active (normal document vs the special Settings doc). */
  activeView: DocActiveView;
  /** Active sub-tab inside the Settings document. */
  activeSettingsSubTab: SettingsSubTab;

  /** File viewer panel state (assistant-wrapper content selection). */
  fileViewerOpen: boolean;
  fileViewerFile: FileViewerItem | null;

  contextWindowOpen: boolean;
  contextWindowCollapsed: boolean;

  /** Terminal panel (bottom, VS Code-style) visibility + height. */
  terminalPanelOpen: boolean;
  terminalPanelHeight: number;

  toasts: Toast[];
  showToast: (message: string, type?: Toast['type']) => void;
  showToastWithAction: (message: string, actionLabel: string, onAction: () => void, type?: Toast['type']) => void;
  dismissToast: (id: string) => void;

  // Logical wrapper actions
  setPrimaryWrapperOpen: (v: boolean) => void;
  togglePrimaryWrapper: () => void;
  setAssistantWrapperOpen: (v: boolean) => void;
  toggleAssistantWrapper: () => void;
  setWrappersSwapped: (v: boolean) => void;
  toggleWrappersSwapped: () => void;
  setContextPanelOpen: (mode: WorkspaceMode, open: boolean) => void;
  toggleContextPanel: (mode?: WorkspaceMode) => void;
  /**
   * Set assistant width in memory. Pass `{ persist: true }` (default) to write Dexie,
   * or `{ persist: false }` during drag and call again with persist at pointerup.
   */
  setAssistantWrapperWidth: (w: number, options?: { persist?: boolean }) => void;
  setContextPanelWidth: (w: number, options?: { persist?: boolean }) => void;

  setSidebarTab: (tab: SidebarTab) => void;
  setSelectedText: (sel: SelectionState | null) => void;
  setActiveModal: (m: UIStore['activeModal']) => void;
  setActionsManagerScope: (scope: 'writer' | 'task' | 'crm') => void;
  setEditingAgentId: (id: string | null) => void;
  setFindReplaceOpen: (v: boolean) => void;
  setHtmlViewOpen: (v: boolean) => void;
  setRainbowMode: (v: boolean) => void;
  toggleRainbowMode: () => void;
  setSettingsPanelOpen: (v: boolean) => void;
  setEditorFontFamily: (font: string) => void;
  setEditorFontSize: (size: 12 | 14 | 16) => void;
  setLanguage: (lang: 'en' | 'tr') => void;
  toggleExpandedPath: (path: string) => void;
  setExpandedPaths: (paths: string[]) => void;
  setSelectedTreePath: (path: string | null) => void;
  setTaskMode: (v: boolean) => void;
  setCrmMode: (v: boolean) => void;
  setActiveCRMPage: (p: CRMPage) => void;
  setActiveFormsPage: (p: FormsPage) => void;
  setActiveTaskPage: (p: TaskPage) => void;
  setActiveView: (v: DocActiveView) => void;
  setActiveSettingsSubTab: (tab: SettingsSubTab | LegacySettingsSubTab) => void;
  /** Switch to the Settings document tab, optionally targeting a sub-tab. */
  openSettings: (subTab?: SettingsSubTab | LegacySettingsSubTab) => void;
  setActiveTaskId: (id: string | null) => void;
  setSubtasksOpen: (v: boolean) => void;
  openFileViewer: (file: FileViewerItem) => void;
  closeFileViewer: () => void;
  setFileViewerFile: (file: FileViewerItem | null) => void;
  setContextWindowOpen: (v: boolean) => void;
  setContextWindowCollapsed: (v: boolean) => void;
  setTerminalPanelOpen: (v: boolean) => void;
  setTerminalPanelHeight: (h: number) => void;
  loadUISettings: () => Promise<void>;
}

function persistLayoutKeys(partial: {
  primaryWrapperOpen?: boolean;
  assistantWrapperOpen?: boolean;
  wrappersSwapped?: boolean;
  assistantWrapperWidth?: number;
  contextPanelWidth?: number;
  contextPanelOpenByMode?: ContextPanelOpenByMode;
}): void {
  if (partial.primaryWrapperOpen !== undefined) {
    void db.settings.put({ key: 'primaryWrapperOpen', value: partial.primaryWrapperOpen });
  }
  if (partial.assistantWrapperOpen !== undefined) {
    void db.settings.put({ key: 'assistantWrapperOpen', value: partial.assistantWrapperOpen });
  }
  if (partial.wrappersSwapped !== undefined) {
    void db.settings.put({ key: 'wrappersSwapped', value: partial.wrappersSwapped });
  }
  if (partial.assistantWrapperWidth !== undefined) {
    void db.settings.put({ key: 'assistantWrapperWidth', value: partial.assistantWrapperWidth });
  }
  if (partial.contextPanelWidth !== undefined) {
    void db.settings.put({ key: 'contextPanelWidth', value: partial.contextPanelWidth });
  }
  if (partial.contextPanelOpenByMode !== undefined) {
    void db.settings.put({
      key: 'contextPanelOpenByMode',
      value: JSON.stringify(partial.contextPanelOpenByMode),
    });
  }
}

/** Logical: swap only when both wrappers are open. */
export function selectCanSwapWrappers(
  state: Pick<UIStore, 'primaryWrapperOpen' | 'assistantWrapperOpen'>,
): boolean {
  return selectCanSwapWrappersImpl(state);
}

export function selectActiveWorkspaceMode(
  state: Pick<UIStore, 'taskMode' | 'crmMode' | 'activeCRMPage' | 'activeView'>,
): WorkspaceMode {
  return selectActiveWorkspaceModeImpl(state);
}

export function selectIsPrimaryWrapperOpen(
  state: Pick<UIStore, 'primaryWrapperOpen'>,
): boolean {
  return selectIsPrimaryWrapperOpenImpl(state);
}

export function selectIsAssistantWrapperOpen(
  state: Pick<UIStore, 'assistantWrapperOpen'>,
): boolean {
  return selectIsAssistantWrapperOpenImpl(state);
}

export function selectIsContextPanelOpen(
  state: Pick<
    UIStore,
    | 'contextPanelOpenByMode'
    | 'taskMode'
    | 'crmMode'
    | 'activeCRMPage'
    | 'activeView'
  >,
): boolean {
  return selectIsContextPanelOpenImpl(state);
}

export function selectIsContextPanelAvailable(
  state: Pick<
    UIStore,
    'taskMode' | 'crmMode' | 'activeCRMPage' | 'activeView' | 'activeTaskPage'
  >,
): boolean {
  return selectIsContextPanelAvailableImpl(state);
}

export const useUIStore = create<UIStore>((set, get) => ({
  toasts: [],

  showToast: (message, type = 'error') => {
    const id = nanoid(6);
    set((s) => ({ toasts: [...s.toasts, { id, message, type }] }));
    setTimeout(() => get().dismissToast(id), 4000);
  },

  showToastWithAction: (message, actionLabel, onAction, type = 'info') => {
    const id = nanoid(6);
    set((s) => ({ toasts: [...s.toasts, { id, message, type, actionLabel, onAction }] }));
    setTimeout(() => get().dismissToast(id), 8000);
  },

  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  // Logical layout defaults
  primaryWrapperOpen: true,
  assistantWrapperOpen: true,
  wrappersSwapped: false,
  assistantWrapperWidth: ASSISTANT_WRAPPER_WIDTH_DEFAULT_VW,
  contextPanelWidth: CONTEXT_PANEL_WIDTH_DEFAULT_VW,
  contextPanelOpenByMode: { ...DEFAULT_CONTEXT_PANEL_OPEN_BY_MODE },

  sidebarTab: 'chat',
  selectedText: null,
  activeModal: null,
  actionsManagerScope: 'writer',
  editingAgentId: null,
  findReplaceOpen: false,
  htmlViewOpen: false,
  rainbowMode: false,

  settingsPanelOpen: false,
  expandedPaths: [],
  selectedTreePath: null,
  editorFontFamily: 'Inter',
  editorFontSize: 12,
  language: 'en',
  taskMode: false,
  activeTaskId: null,
  subtasksOpen: true,
  crmMode: false,
  activeCRMPage: 'leads',
  activeFormsPage: 'list',
  activeTaskPage: 'list',
  activeView: 'document',
  activeSettingsSubTab: 'tools',

  fileViewerOpen: false,
  fileViewerFile: null,
  contextWindowOpen: false,
  contextWindowCollapsed: true,

  terminalPanelOpen: false,
  terminalPanelHeight: 240,

  // ── Logical wrapper actions ────────────────────────────────────────

  setPrimaryWrapperOpen: (v) => {
    const next = applyPrimaryWrapperOpen(get(), v);
    set({
      primaryWrapperOpen: next.primaryWrapperOpen,
      assistantWrapperOpen: next.assistantWrapperOpen,
    });
    persistLayoutKeys(next);
  },

  togglePrimaryWrapper: () => {
    get().setPrimaryWrapperOpen(!get().primaryWrapperOpen);
  },

  setAssistantWrapperOpen: (v) => {
    const next = applyAssistantWrapperOpen(get(), v);
    set({
      primaryWrapperOpen: next.primaryWrapperOpen,
      assistantWrapperOpen: next.assistantWrapperOpen,
    });
    persistLayoutKeys(next);
  },

  toggleAssistantWrapper: () => {
    get().setAssistantWrapperOpen(!get().assistantWrapperOpen);
  },

  setWrappersSwapped: (v) => {
    // Swap is only available when both wrappers are open (PRD 6.2 / 12.x).
    if (!selectCanSwapWrappersImpl(get())) return;
    set({ wrappersSwapped: v });
    persistLayoutKeys({ wrappersSwapped: v });
  },

  toggleWrappersSwapped: () => {
    const { wrappersSwapped } = get();
    get().setWrappersSwapped(!wrappersSwapped);
  },

  setContextPanelOpen: (mode, open) => {
    const next = { ...get().contextPanelOpenByMode, [mode]: open };
    set({ contextPanelOpenByMode: next });
    persistLayoutKeys({ contextPanelOpenByMode: next });
  },

  toggleContextPanel: (mode) => {
    const resolved = mode ?? selectActiveWorkspaceModeImpl(get());
    const current = get().contextPanelOpenByMode[resolved];
    get().setContextPanelOpen(resolved, !current);
  },

  setAssistantWrapperWidth: (w, options) => {
    const persist = options?.persist ?? true;
    const clamped = clampAssistantWrapperWidth(w);
    set({ assistantWrapperWidth: clamped });
    if (persist) {
      persistLayoutKeys({ assistantWrapperWidth: clamped });
    }
  },

  setContextPanelWidth: (w, options) => {
    const persist = options?.persist ?? true;
    const clamped = clampContextPanelWidth(w);
    set({ contextPanelWidth: clamped });
    if (persist) {
      persistLayoutKeys({ contextPanelWidth: clamped });
    }
  },

  // ── Remaining store ────────────────────────────────────────────────

  setSidebarTab: (tab) => set({ sidebarTab: tab }),
  setSelectedText: (sel) => set({ selectedText: sel }),
  setActiveModal: (m) => set({ activeModal: m }),
  setActionsManagerScope: (scope) => set({ actionsManagerScope: scope }),
  setEditingAgentId: (id) => set({ editingAgentId: id }),
  setFindReplaceOpen: (v) => set({ findReplaceOpen: v }),
  setHtmlViewOpen: (v) => set({ htmlViewOpen: v }),
  setRainbowMode: (v) => set({ rainbowMode: v }),
  toggleRainbowMode: () => set((s) => ({ rainbowMode: !s.rainbowMode })),

  setEditorFontFamily: (font) => {
    set({ editorFontFamily: font });
    void db.settings.put({ key: 'editorFontFamily', value: font });
  },

  setEditorFontSize: (size) => {
    set({ editorFontSize: size });
    void db.settings.put({ key: 'editorFontSize', value: size });
  },

  setLanguage: (lang) => {
    set({ language: lang });
    void i18n.changeLanguage(lang);
    document.documentElement.lang = lang;
    void db.settings.put({ key: 'language', value: lang });
  },

  setSettingsPanelOpen: (v) => {
    set({ settingsPanelOpen: v });
  },

  toggleExpandedPath: (path) => {
    const current = get().expandedPaths;
    const isExpanded = current.includes(path);
    if (isExpanded) {
      const next = current.filter((p) => p !== path);
      set({ expandedPaths: next });
      void db.settings.put({ key: 'fileExplorerExpandedPaths', value: JSON.stringify(next) });
    } else {
      const parentPath = path.substring(0, path.lastIndexOf('/'));
      const next = [...current.filter((p) => {
        const pParent = p.substring(0, p.lastIndexOf('/'));
        return pParent !== parentPath;
      }), path];
      set({ expandedPaths: next });
      void db.settings.put({ key: 'fileExplorerExpandedPaths', value: JSON.stringify(next) });
    }
  },

  setExpandedPaths: (paths) => {
    set({ expandedPaths: paths });
    void db.settings.put({ key: 'fileExplorerExpandedPaths', value: JSON.stringify(paths) });
  },

  setSelectedTreePath: (path) => set({ selectedTreePath: path }),

  setTaskMode: (v) => {
    // Mode entry ensures primary is open (PRD 6.6).
    set({
      taskMode: v,
      crmMode: false,
      activeView: 'document',
      primaryWrapperOpen: true,
    });
    persistLayoutKeys({ primaryWrapperOpen: true });
    void db.settings.put({ key: 'taskMode', value: v });
    void db.settings.put({ key: 'crmMode', value: false });
  },

  setCrmMode: (v) => {
    set({
      crmMode: v,
      taskMode: false,
      activeView: 'document',
      primaryWrapperOpen: true,
    });
    persistLayoutKeys({ primaryWrapperOpen: true });
    void db.settings.put({ key: 'crmMode', value: v });
    void db.settings.put({ key: 'taskMode', value: false });
  },

  setActiveCRMPage: (p) => {
    const legacyPages = new Set<CRMPage>(['contacts', 'companies', 'activities']);
    const resolved: CRMPage = legacyPages.has(p) ? 'leads' : p;
    void import('./crmStore').then(({ useCrmStore }) => {
      useCrmStore.getState().setLeadsCenterView('lead');
    });
    set({ activeCRMPage: resolved });
    void db.settings.put({ key: 'activeCRMPage', value: resolved });
  },

  setActiveFormsPage: (p) => {
    const resolved = p === 'templates' ? 'list' : p;
    set({ activeFormsPage: resolved });
    void db.settings.put({ key: 'activeFormsPage', value: resolved });
  },

  setActiveTaskPage: (p) => {
    set({ activeTaskPage: p });
    void db.settings.put({ key: 'activeTaskPage', value: p });
  },

  setActiveView: (v) => {
    // Entering documents or settings in doc mode ensures primary open.
    set({ activeView: v, primaryWrapperOpen: true });
    persistLayoutKeys({ primaryWrapperOpen: true });
  },

  setActiveSettingsSubTab: (tab) =>
    set({ activeSettingsSubTab: tab === 'models' ? 'tools' : tab }),

  openSettings: (subTab) => {
    // Settings is a first-class shell mode (PRD 6.9). Deep links from Tasks/CRM
    // AI (models/agents/actions) must leave those modes or Settings never renders.
    // Legacy `models` sub-tab is mapped to merged `tools` (LLM + search tools).
    const resolved =
      subTab === 'models' ? 'tools' : (subTab ?? undefined);
    set((s) => ({
      activeView: 'settings',
      activeSettingsSubTab: resolved ?? s.activeSettingsSubTab,
      primaryWrapperOpen: true,
      taskMode: false,
      crmMode: false,
    }));
    persistLayoutKeys({ primaryWrapperOpen: true });
    void db.settings.put({ key: 'taskMode', value: false });
    void db.settings.put({ key: 'crmMode', value: false });
  },

  setActiveTaskId: (id) => {
    set({ activeTaskId: id });
    if (id) void db.settings.put({ key: 'lastActiveTaskId', value: id });
  },

  setSubtasksOpen: (v) => set({ subtasksOpen: v }),

  openFileViewer: (file) => {
    // File Viewer is assistant-wrapper content (PRD 6.10).
    // Opening ensures assistant is open; does not change swap or close primary.
    const nextAssistant = applyAssistantWrapperOpen(get(), true);
    set({
      fileViewerOpen: true,
      fileViewerFile: file,
      primaryWrapperOpen: nextAssistant.primaryWrapperOpen,
      assistantWrapperOpen: true,
    });
    persistLayoutKeys({
      primaryWrapperOpen: nextAssistant.primaryWrapperOpen,
      assistantWrapperOpen: true,
    });
  },

  closeFileViewer: () => {
    // Explicit close returns assistant content to mode AI.
    // Does not hide the assistant wrapper or clear wrapper widths/swap.
    set({
      fileViewerOpen: false,
      fileViewerFile: null,
    });
  },

  setFileViewerFile: (file) => {
    set({ fileViewerFile: file });
  },

  setContextWindowOpen: (v) => {
    set({ contextWindowOpen: v });
  },

  setContextWindowCollapsed: (v) => {
    set({ contextWindowCollapsed: v });
    void db.settings.put({ key: 'contextWindowCollapsed', value: v });
  },

  setTerminalPanelOpen: (v) => {
    set({ terminalPanelOpen: v });
    void db.settings.put({ key: 'terminalPanelOpen', value: v });
  },
  setTerminalPanelHeight: (h) => {
    const clamped = Math.min(window.innerHeight * 0.7, Math.max(120, h));
    set({ terminalPanelHeight: clamped });
    void db.settings.put({ key: 'terminalPanelHeight', value: clamped });
  },

  loadUISettings: async () => {
    // Read new layout keys + legacy fallbacks (aiSidebarOpen, panelsSwapped, …).
    // After migrate we only write the new key set (do not delete legacy keys).
    const [
      sidebarTab,
      fileExplorerOpen,
      fileExplorerWidth,
      fileExplorerExpandedPaths,
      editorFontFamily,
      editorFontSize,
      language,
      taskMode,
      lastActiveTaskId,
      taskListOpen,
      panelsSwapped,
      aiSidebarOpen,
      sidebarWidth,
      themeSetting,
      contextWindowCollapsed,
      terminalPanelOpen,
      terminalPanelHeight,
      crmModeSetting,
      formsModeSetting,
      activeCRMPageSetting,
      activeFormsPageSetting,
      activeTaskPageSetting,
      primaryWrapperOpenSetting,
      assistantWrapperOpenSetting,
      wrappersSwappedSetting,
      assistantWrapperWidthSetting,
      contextPanelWidthSetting,
      contextPanelOpenByModeSetting,
    ] = await Promise.all([
      db.settings.get('sidebarTab'),
      db.settings.get('fileExplorerOpen'),
      db.settings.get('fileExplorerWidth'),
      db.settings.get('fileExplorerExpandedPaths'),
      db.settings.get('editorFontFamily'),
      db.settings.get('editorFontSize'),
      db.settings.get('language'),
      db.settings.get('taskMode'),
      db.settings.get('lastActiveTaskId'),
      db.settings.get('taskListOpen'),
      db.settings.get('panelsSwapped'),
      db.settings.get('aiSidebarOpen'),
      db.settings.get('sidebarWidth'),
      db.settings.get('theme'),
      db.settings.get('contextWindowCollapsed'),
      db.settings.get('terminalPanelOpen'),
      db.settings.get('terminalPanelHeight'),
      db.settings.get('crmMode'),
      db.settings.get('formsMode'),
      db.settings.get('activeCRMPage'),
      db.settings.get('activeFormsPage'),
      db.settings.get('activeTaskPage'),
      db.settings.get('primaryWrapperOpen'),
      db.settings.get('assistantWrapperOpen'),
      db.settings.get('wrappersSwapped'),
      db.settings.get('assistantWrapperWidth'),
      db.settings.get('contextPanelWidth'),
      db.settings.get('contextPanelOpenByMode'),
    ]);

    const lang = (language?.value === 'tr' ? 'tr' : 'en') as 'en' | 'tr';
    void i18n.changeLanguage(lang);
    document.documentElement.lang = lang;

    // Legacy named themes (e.g. cyberpunk) are no longer supported — force default.
    if (themeSetting?.value != null && themeSetting.value !== 'default') {
      void db.settings.put({ key: 'theme', value: 'default' });
    }
    document.documentElement.removeAttribute('data-theme');

    const crmModeStored = crmModeSetting ? Boolean(crmModeSetting.value) : false;
    const formsModeStored = formsModeSetting ? Boolean(formsModeSetting.value) : false;
    // Forms module was merged into CRM. Migrate a persisted standalone formsMode
    // into CRM mode (activeCRMPage falls back to 'forms' below when migrated).
    const crmMode = crmModeStored || formsModeStored;
    const taskModeValue = !crmMode && (taskMode ? Boolean(taskMode.value) : false);
    // Drop obsolete workspace-mode key from older installs (ignored if absent).
    void db.settings.delete('chatMode');

    const CRM_PAGES: CRMPage[] = ['dashboard', 'leads', 'contacts', 'companies', 'pipeline', 'activities', 'forms', 'settings'];
    const FORMS_PAGES: FormsPage[] = ['dashboard', 'list', 'builder', 'submissions', 'templates', 'settings'];
    const storedCRMPage = activeCRMPageSetting?.value as CRMPage | undefined;
    const migratedFromForms = formsModeStored && !crmModeStored;
    const rawCRMPage: CRMPage = migratedFromForms
      ? 'forms'
      : storedCRMPage && CRM_PAGES.includes(storedCRMPage) && storedCRMPage !== 'dashboard'
        ? storedCRMPage
        : 'leads';
    const legacyCRMPage = new Set<CRMPage>(['contacts', 'companies', 'activities']);
    const activeCRMPage: CRMPage = legacyCRMPage.has(rawCRMPage) ? 'leads' : rawCRMPage;
    if (legacyCRMPage.has(rawCRMPage)) {
      void import('./crmStore').then(({ useCrmStore }) => {
        useCrmStore.getState().setLeadsCenterView('lead');
      });
    }
    const storedFormsPage = activeFormsPageSetting?.value as FormsPage | undefined;
    const migratedFormsPage =
      storedFormsPage === 'templates' ? 'list' : storedFormsPage;
    const activeFormsPage: FormsPage =
      migratedFormsPage && FORMS_PAGES.includes(migratedFormsPage) && migratedFormsPage !== 'dashboard'
        ? migratedFormsPage
        : 'list';

    const TASK_PAGES: TaskPage[] = ['list', 'calendar', 'projects'];
    const storedTaskPage = activeTaskPageSetting?.value as TaskPage | undefined;
    const activeTaskPage: TaskPage =
      storedTaskPage && TASK_PAGES.includes(storedTaskPage) ? storedTaskPage : 'list';

    const layout = migrateLayoutStateFromStored({
      primaryWrapperOpen: primaryWrapperOpenSetting?.value,
      assistantWrapperOpen: assistantWrapperOpenSetting?.value,
      aiSidebarOpen: aiSidebarOpen?.value,
      wrappersSwapped: wrappersSwappedSetting?.value,
      panelsSwapped: panelsSwapped?.value,
      assistantWrapperWidth: assistantWrapperWidthSetting?.value,
      sidebarWidth: sidebarWidth?.value,
      contextPanelWidth: contextPanelWidthSetting?.value,
      fileExplorerWidth: fileExplorerWidth?.value,
      contextPanelOpenByMode: contextPanelOpenByModeSetting?.value,
      fileExplorerOpen: fileExplorerOpen?.value,
      taskListOpen: taskListOpen?.value,
    });

    // Write migrated new keys (do not delete legacy keys).
    persistLayoutKeys(layout);

    set({
      primaryWrapperOpen: layout.primaryWrapperOpen,
      assistantWrapperOpen: layout.assistantWrapperOpen,
      wrappersSwapped: layout.wrappersSwapped,
      assistantWrapperWidth: layout.assistantWrapperWidth,
      contextPanelWidth: layout.contextPanelWidth,
      contextPanelOpenByMode: layout.contextPanelOpenByMode,

      sidebarTab: (sidebarTab ? String(sidebarTab.value) : 'chat') as SidebarTab,
      expandedPaths: fileExplorerExpandedPaths ? JSON.parse(String(fileExplorerExpandedPaths.value)) : [],
      editorFontFamily: editorFontFamily ? String(editorFontFamily.value) : 'Inter',
      editorFontSize: editorFontSize ? (Number(editorFontSize.value) as 12 | 14 | 16) : 12,
      language: lang,
      taskMode: taskModeValue,
      activeTaskId: lastActiveTaskId ? String(lastActiveTaskId.value) : null,
      contextWindowOpen: false,
      contextWindowCollapsed: contextWindowCollapsed ? Boolean(contextWindowCollapsed.value) : true,
      terminalPanelOpen: terminalPanelOpen ? Boolean(terminalPanelOpen.value) : false,
      terminalPanelHeight: terminalPanelHeight ? Number(terminalPanelHeight.value) : 240,
      crmMode,
      activeCRMPage,
      activeFormsPage,
      activeTaskPage,
    });
  },
}));
