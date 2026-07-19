/**
 * Pure helpers for the universal two-wrapper layout state model.
 * Used by uiStore and unit-tested without mounting React.
 *
 * Phase 1: state model only — layout components still use legacy fields
 * via temporary compatibility mirrors in uiStore.
 */

export type WorkspaceMode = 'documents' | 'tasks' | 'crm' | 'forms' | 'settings';

export type ContextPanelOpenByMode = {
  documents: boolean;
  tasks: boolean;
  crm: boolean;
  forms: boolean;
  settings: boolean;
};

export const DEFAULT_CONTEXT_PANEL_OPEN_BY_MODE: ContextPanelOpenByMode = {
  documents: false,
  tasks: true,
  crm: true,
  forms: true,
  settings: true,
};

export const ASSISTANT_WRAPPER_WIDTH_MIN_VW = 15;
export const ASSISTANT_WRAPPER_WIDTH_MAX_VW = 75;
export const ASSISTANT_WRAPPER_WIDTH_DEFAULT_VW = 33;

export const CONTEXT_PANEL_WIDTH_MIN_VW = 15;
export const CONTEXT_PANEL_WIDTH_MAX_VW = 40;
export const CONTEXT_PANEL_WIDTH_DEFAULT_VW = 22;

export function clampAssistantWrapperWidth(vw: number): number {
  if (!Number.isFinite(vw)) return ASSISTANT_WRAPPER_WIDTH_DEFAULT_VW;
  return Math.min(ASSISTANT_WRAPPER_WIDTH_MAX_VW, Math.max(ASSISTANT_WRAPPER_WIDTH_MIN_VW, vw));
}

export function clampContextPanelWidth(vw: number): number {
  if (!Number.isFinite(vw)) return CONTEXT_PANEL_WIDTH_DEFAULT_VW;
  return Math.min(CONTEXT_PANEL_WIDTH_MAX_VW, Math.max(CONTEXT_PANEL_WIDTH_MIN_VW, vw));
}

export type WrapperVisibility = {
  primaryWrapperOpen: boolean;
  assistantWrapperOpen: boolean;
};

/**
 * Apply a primary-wrapper open change while enforcing:
 * never leave both wrappers closed (atomic open-other when closing the last).
 */
export function applyPrimaryWrapperOpen(
  state: WrapperVisibility,
  nextPrimary: boolean,
): WrapperVisibility {
  if (nextPrimary) {
    return { primaryWrapperOpen: true, assistantWrapperOpen: state.assistantWrapperOpen };
  }
  // Closing primary: ensure assistant is open.
  return { primaryWrapperOpen: false, assistantWrapperOpen: true };
}

/**
 * Apply an assistant-wrapper open change with the same at-least-one invariant.
 */
export function applyAssistantWrapperOpen(
  state: WrapperVisibility,
  nextAssistant: boolean,
): WrapperVisibility {
  if (nextAssistant) {
    return { primaryWrapperOpen: state.primaryWrapperOpen, assistantWrapperOpen: true };
  }
  // Closing assistant: ensure primary is open.
  return { primaryWrapperOpen: true, assistantWrapperOpen: false };
}

export function selectCanSwapWrappers(state: WrapperVisibility): boolean {
  return state.primaryWrapperOpen && state.assistantWrapperOpen;
}

export type ModeRoutingState = {
  taskMode: boolean;
  crmMode: boolean;
  activeCRMPage: string;
  activeView: string;
};

export function selectActiveWorkspaceMode(state: ModeRoutingState): WorkspaceMode {
  if (state.taskMode) return 'tasks';
  if (state.crmMode && state.activeCRMPage === 'forms') return 'forms';
  if (state.crmMode) return 'crm';
  if (state.activeView === 'settings') return 'settings';
  return 'documents';
}

export function selectIsPrimaryWrapperOpen(state: Pick<WrapperVisibility, 'primaryWrapperOpen'>): boolean {
  return state.primaryWrapperOpen;
}

export function selectIsAssistantWrapperOpen(state: Pick<WrapperVisibility, 'assistantWrapperOpen'>): boolean {
  return state.assistantWrapperOpen;
}

export function selectIsContextPanelOpen(
  state: { contextPanelOpenByMode: ContextPanelOpenByMode } & ModeRoutingState,
): boolean {
  const mode = selectActiveWorkspaceMode(state);
  return state.contextPanelOpenByMode[mode];
}

export function mergeContextPanelOpenByMode(
  partial: Partial<ContextPanelOpenByMode> | null | undefined,
  fallbacks: Partial<ContextPanelOpenByMode> = {},
): ContextPanelOpenByMode {
  return {
    documents:
      partial?.documents ??
      fallbacks.documents ??
      DEFAULT_CONTEXT_PANEL_OPEN_BY_MODE.documents,
    tasks:
      partial?.tasks ??
      fallbacks.tasks ??
      DEFAULT_CONTEXT_PANEL_OPEN_BY_MODE.tasks,
    crm:
      partial?.crm ??
      fallbacks.crm ??
      DEFAULT_CONTEXT_PANEL_OPEN_BY_MODE.crm,
    forms:
      partial?.forms ??
      fallbacks.forms ??
      DEFAULT_CONTEXT_PANEL_OPEN_BY_MODE.forms,
    settings:
      partial?.settings ??
      fallbacks.settings ??
      DEFAULT_CONTEXT_PANEL_OPEN_BY_MODE.settings,
  };
}

/** Raw values read from Dexie (already unwrapped `.value` or missing). */
export type StoredLayoutRaw = {
  primaryWrapperOpen?: unknown;
  assistantWrapperOpen?: unknown;
  aiSidebarOpen?: unknown;
  wrappersSwapped?: unknown;
  panelsSwapped?: unknown;
  assistantWrapperWidth?: unknown;
  sidebarWidth?: unknown;
  contextPanelWidth?: unknown;
  fileExplorerWidth?: unknown;
  contextPanelOpenByMode?: unknown;
  fileExplorerOpen?: unknown;
  taskListOpen?: unknown;
};

export type MigratedLayoutState = {
  primaryWrapperOpen: boolean;
  assistantWrapperOpen: boolean;
  wrappersSwapped: boolean;
  assistantWrapperWidth: number;
  contextPanelWidth: number;
  contextPanelOpenByMode: ContextPanelOpenByMode;
};

function asOptionalBoolean(v: unknown): boolean | undefined {
  if (v === undefined || v === null) return undefined;
  return Boolean(v);
}

function asOptionalNumber(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function parseContextPanelOpenByMode(raw: unknown): Partial<ContextPanelOpenByMode> | undefined {
  if (raw == null) return undefined;
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  if (typeof obj !== 'object' || obj === null) return undefined;
  const rec = obj as Record<string, unknown>;
  const out: Partial<ContextPanelOpenByMode> = {};
  for (const key of ['documents', 'tasks', 'crm', 'forms', 'settings'] as const) {
    if (key in rec) out[key] = Boolean(rec[key]);
  }
  return out;
}

/**
 * Deterministic migration from new keys with fallback to legacy keys.
 * Does not delete legacy keys; callers may stop writing them after migration.
 */
export function migrateLayoutStateFromStored(stored: StoredLayoutRaw): MigratedLayoutState {
  const primaryWrapperOpen = asOptionalBoolean(stored.primaryWrapperOpen) ?? true;

  const assistantWrapperOpen =
    asOptionalBoolean(stored.assistantWrapperOpen) ??
    asOptionalBoolean(stored.aiSidebarOpen) ??
    true;

  // Enforce invariant after migration (corrupt storage could have both false).
  const visibility =
    !primaryWrapperOpen && !assistantWrapperOpen
      ? { primaryWrapperOpen: true, assistantWrapperOpen: false }
      : { primaryWrapperOpen, assistantWrapperOpen };

  const wrappersSwapped =
    asOptionalBoolean(stored.wrappersSwapped) ??
    asOptionalBoolean(stored.panelsSwapped) ??
    false;

  const assistantWrapperWidth = clampAssistantWrapperWidth(
    asOptionalNumber(stored.assistantWrapperWidth) ??
      asOptionalNumber(stored.sidebarWidth) ??
      ASSISTANT_WRAPPER_WIDTH_DEFAULT_VW,
  );

  const contextPanelWidth = clampContextPanelWidth(
    asOptionalNumber(stored.contextPanelWidth) ??
      asOptionalNumber(stored.fileExplorerWidth) ??
      CONTEXT_PANEL_WIDTH_DEFAULT_VW,
  );

  const contextPanelOpenByMode = mergeContextPanelOpenByMode(
    parseContextPanelOpenByMode(stored.contextPanelOpenByMode),
    {
      documents: asOptionalBoolean(stored.fileExplorerOpen),
      tasks: asOptionalBoolean(stored.taskListOpen),
    },
  );

  return {
    ...visibility,
    wrappersSwapped,
    assistantWrapperWidth,
    contextPanelWidth,
    contextPanelOpenByMode,
  };
}
