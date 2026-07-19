import { describe, it, expect } from 'vitest';
import {
  applyAssistantWrapperOpen,
  applyPrimaryWrapperOpen,
  clampAssistantWrapperWidth,
  clampContextPanelWidth,
  migrateLayoutStateFromStored,
  selectActiveWorkspaceMode,
  selectCanSwapWrappers,
  selectIsContextPanelOpen,
  DEFAULT_CONTEXT_PANEL_OPEN_BY_MODE,
} from './uiLayoutState';

describe('applyPrimaryWrapperOpen / applyAssistantWrapperOpen', () => {
  it('opens primary without forcing assistant closed', () => {
    expect(
      applyPrimaryWrapperOpen({ primaryWrapperOpen: false, assistantWrapperOpen: true }, true),
    ).toEqual({ primaryWrapperOpen: true, assistantWrapperOpen: true });
  });

  it('closing the only open primary opens assistant atomically', () => {
    expect(
      applyPrimaryWrapperOpen({ primaryWrapperOpen: true, assistantWrapperOpen: false }, false),
    ).toEqual({ primaryWrapperOpen: false, assistantWrapperOpen: true });
  });

  it('closing primary when both open leaves assistant open', () => {
    expect(
      applyPrimaryWrapperOpen({ primaryWrapperOpen: true, assistantWrapperOpen: true }, false),
    ).toEqual({ primaryWrapperOpen: false, assistantWrapperOpen: true });
  });

  it('closing the only open assistant opens primary atomically', () => {
    expect(
      applyAssistantWrapperOpen({ primaryWrapperOpen: false, assistantWrapperOpen: true }, false),
    ).toEqual({ primaryWrapperOpen: true, assistantWrapperOpen: false });
  });

  it('never yields both closed from either direction', () => {
    const a = applyPrimaryWrapperOpen(
      { primaryWrapperOpen: true, assistantWrapperOpen: false },
      false,
    );
    const b = applyAssistantWrapperOpen(
      { primaryWrapperOpen: false, assistantWrapperOpen: true },
      false,
    );
    expect(a.primaryWrapperOpen || a.assistantWrapperOpen).toBe(true);
    expect(b.primaryWrapperOpen || b.assistantWrapperOpen).toBe(true);
    expect(a.primaryWrapperOpen && a.assistantWrapperOpen).toBe(false);
    expect(b.primaryWrapperOpen && b.assistantWrapperOpen).toBe(false);
  });
});

describe('selectCanSwapWrappers', () => {
  it('requires both wrappers open', () => {
    expect(selectCanSwapWrappers({ primaryWrapperOpen: true, assistantWrapperOpen: true })).toBe(
      true,
    );
    expect(selectCanSwapWrappers({ primaryWrapperOpen: true, assistantWrapperOpen: false })).toBe(
      false,
    );
    expect(selectCanSwapWrappers({ primaryWrapperOpen: false, assistantWrapperOpen: true })).toBe(
      false,
    );
  });
});

describe('selectActiveWorkspaceMode', () => {
  it('resolves tasks over documents', () => {
    expect(
      selectActiveWorkspaceMode({
        taskMode: true,
        crmMode: false,
        activeCRMPage: 'leads',
        activeView: 'document',
      }),
    ).toBe('tasks');
  });

  it('resolves forms when CRM hosts forms page', () => {
    expect(
      selectActiveWorkspaceMode({
        taskMode: false,
        crmMode: true,
        activeCRMPage: 'forms',
        activeView: 'document',
      }),
    ).toBe('forms');
  });

  it('resolves crm for non-forms CRM pages', () => {
    expect(
      selectActiveWorkspaceMode({
        taskMode: false,
        crmMode: true,
        activeCRMPage: 'leads',
        activeView: 'settings',
      }),
    ).toBe('crm');
  });

  it('resolves settings only in pure doc mode', () => {
    expect(
      selectActiveWorkspaceMode({
        taskMode: false,
        crmMode: false,
        activeCRMPage: 'leads',
        activeView: 'settings',
      }),
    ).toBe('settings');
  });

  it('defaults to documents', () => {
    expect(
      selectActiveWorkspaceMode({
        taskMode: false,
        crmMode: false,
        activeCRMPage: 'leads',
        activeView: 'document',
      }),
    ).toBe('documents');
  });
});

describe('selectIsContextPanelOpen', () => {
  it('reads the active mode key', () => {
    const open = selectIsContextPanelOpen({
      taskMode: false,
      crmMode: false,
      activeCRMPage: 'leads',
      activeView: 'document',
      contextPanelOpenByMode: { ...DEFAULT_CONTEXT_PANEL_OPEN_BY_MODE, documents: true },
    });
    expect(open).toBe(true);
  });
});

describe('clamp widths', () => {
  it('clamps assistant width', () => {
    expect(clampAssistantWrapperWidth(10)).toBe(15);
    expect(clampAssistantWrapperWidth(90)).toBe(75);
    expect(clampAssistantWrapperWidth(40)).toBe(40);
  });

  it('clamps context width', () => {
    expect(clampContextPanelWidth(5)).toBe(15);
    expect(clampContextPanelWidth(50)).toBe(40);
  });
});

describe('migrateLayoutStateFromStored', () => {
  it('uses new keys when present', () => {
    const m = migrateLayoutStateFromStored({
      primaryWrapperOpen: false,
      assistantWrapperOpen: true,
      wrappersSwapped: true,
      assistantWrapperWidth: 40,
      contextPanelWidth: 18,
      contextPanelOpenByMode: JSON.stringify({
        documents: true,
        tasks: false,
        crm: true,
        forms: true,
        settings: false,
      }),
    });
    expect(m.primaryWrapperOpen).toBe(false);
    expect(m.assistantWrapperOpen).toBe(true);
    expect(m.wrappersSwapped).toBe(true);
    expect(m.assistantWrapperWidth).toBe(40);
    expect(m.contextPanelWidth).toBe(18);
    expect(m.contextPanelOpenByMode.documents).toBe(true);
    expect(m.contextPanelOpenByMode.tasks).toBe(false);
    expect(m.contextPanelOpenByMode.settings).toBe(false);
  });

  it('falls back to legacy keys', () => {
    const m = migrateLayoutStateFromStored({
      aiSidebarOpen: false,
      panelsSwapped: true,
      sidebarWidth: 50,
      fileExplorerWidth: 25,
      fileExplorerOpen: true,
      taskListOpen: false,
    });
    expect(m.assistantWrapperOpen).toBe(false);
    expect(m.primaryWrapperOpen).toBe(true);
    expect(m.wrappersSwapped).toBe(true);
    expect(m.assistantWrapperWidth).toBe(50);
    expect(m.contextPanelWidth).toBe(25);
    expect(m.contextPanelOpenByMode.documents).toBe(true);
    expect(m.contextPanelOpenByMode.tasks).toBe(false);
    expect(m.contextPanelOpenByMode.crm).toBe(true);
  });

  it('repairs both-closed storage', () => {
    const m = migrateLayoutStateFromStored({
      primaryWrapperOpen: false,
      assistantWrapperOpen: false,
    });
    expect(m.primaryWrapperOpen || m.assistantWrapperOpen).toBe(true);
  });

  it('prefers new keys over legacy when both exist', () => {
    const m = migrateLayoutStateFromStored({
      assistantWrapperOpen: true,
      aiSidebarOpen: false,
      wrappersSwapped: false,
      panelsSwapped: true,
      assistantWrapperWidth: 30,
      sidebarWidth: 60,
    });
    expect(m.assistantWrapperOpen).toBe(true);
    expect(m.wrappersSwapped).toBe(false);
    expect(m.assistantWrapperWidth).toBe(30);
  });
});
