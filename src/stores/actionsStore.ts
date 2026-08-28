// Actions store: manages QuickPrompts (actions) and their folder/grouping
// (ActionGroup) for the Settings → Actions sub-tab. Existing call sites that
// use `db.quickPrompts` directly are intentionally left untouched to avoid
// broad refactors; this store is the single source of truth for the new
// grouped Actions UI.

import { create } from 'zustand';
import { db } from '../services/db';
import type { QuickPrompt, ActionGroup, ActionScope } from '../types';

function shortId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function sortActions(list: QuickPrompt[]): QuickPrompt[] {
  return [...list].sort((a, b) => {
    const ao = a.order ?? a.createdAt ?? 0;
    const bo = b.order ?? b.createdAt ?? 0;
    return ao - bo;
  });
}

function sortGroups(list: ActionGroup[]): ActionGroup[] {
  return [...list].sort((a, b) => a.order - b.order);
}

interface ActionsStore {
  scope: ActionScope;
  actions: QuickPrompt[];
  groups: ActionGroup[];
  /** Actions without a groupId (top-level). */
  rootActions: () => QuickPrompt[];
  /** Actions belonging to a given group id. */
  actionsInGroup: (groupId: string) => QuickPrompt[];
  setScope: (scope: ActionScope) => void;
  reload: () => Promise<void>;
  saveAction: (action: Partial<QuickPrompt> & { id?: string }) => Promise<QuickPrompt>;
  deleteAction: (id: string) => Promise<void>;
  createGroup: (name: string) => Promise<ActionGroup>;
  renameGroup: (id: string, name: string) => Promise<void>;
  deleteGroup: (id: string, deleteActions: boolean) => Promise<void>;
  /** Move an action into a group (groupId = null for root) at a given order. */
  moveAction: (actionId: string, groupId: string | null, order: number) => Promise<void>;
  /** Persist a full ordering of action ids for a group (or root). */
  reorderActions: (groupId: string | null, orderedIds: string[]) => Promise<void>;
  reorderGroups: (orderedIds: string[]) => Promise<void>;
}

export const useActionsStore = create<ActionsStore>((set, get) => ({
  scope: 'general',
  actions: [],
  groups: [],

  rootActions: () => sortActions(get().actions.filter((a) => !a.groupId)),
  actionsInGroup: (groupId) => sortActions(get().actions.filter((a) => a.groupId === groupId)),

  setScope: (scope) => {
    set({ scope });
    void get().reload();
  },

  reload: async () => {
    const scope = get().scope;
    const [actions, groups] = await Promise.all([
      db.quickPrompts.where('scope').equals(scope).toArray(),
      db.actionGroups.where('scope').equals(scope).toArray(),
    ]);
    set({ actions: sortActions(actions), groups: sortGroups(groups) });
  },

  saveAction: async (input) => {
    const scope = get().scope;
    const existing = input.id ? get().actions.find((a) => a.id === input.id) : undefined;
    const now = Date.now();
    const action: QuickPrompt = {
      id: input.id ?? shortId(),
      title: (input.title ?? existing?.title ?? '').trim() || 'Untitled action',
      prompt: input.prompt ?? existing?.prompt ?? '',
      scope,
      createdAt: existing?.createdAt ?? now,
      groupId: input.groupId !== undefined ? input.groupId : existing?.groupId,
      order: input.order !== undefined ? input.order : existing?.order,
      icon: input.icon !== undefined ? input.icon : existing?.icon,
    };
    await db.quickPrompts.put(action);
    set({ actions: sortActions([...get().actions.filter((a) => a.id !== action.id), action]) });
    return action;
  },

  deleteAction: async (id) => {
    await db.quickPrompts.delete(id);
    set({ actions: get().actions.filter((a) => a.id !== id) });
  },

  createGroup: async (name) => {
    const scope = get().scope;
    const now = Date.now();
    const order = get().groups.length;
    const group: ActionGroup = { id: shortId(), name: name.trim() || 'New group', scope, order, createdAt: now };
    await db.actionGroups.put(group);
    set({ groups: sortGroups([...get().groups, group]) });
    return group;
  },

  renameGroup: async (id, name) => {
    await db.actionGroups.update(id, { name: name.trim() || 'New group' });
    set({ groups: get().groups.map((g) => (g.id === id ? { ...g, name: name.trim() || 'New group' } : g)) });
  },

  deleteGroup: async (id, deleteActions) => {
    const scope = get().scope;
    if (deleteActions) {
      const inGroup = get().actions.filter((a) => a.groupId === id);
      await Promise.all(inGroup.map((a) => db.quickPrompts.delete(a.id)));
      set({ actions: get().actions.filter((a) => a.groupId !== id) });
    } else {
      // Reassign the group's actions to root (no groupId) keeping relative order.
      await db.quickPrompts.where('groupId').equals(id).modify({ groupId: undefined as unknown as string });
      set({ actions: get().actions.map((a) => (a.groupId === id ? { ...a, groupId: undefined } : a)) });
    }
    await db.actionGroups.delete(id);
    void get().reload();
    // reference scope to satisfy linter about unused var pattern
    void scope;
  },

  moveAction: async (actionId, groupId, order) => {
    await db.quickPrompts.update(actionId, { groupId: groupId ?? undefined, order });
    set({
      actions: sortActions(
        get().actions.map((a) => (a.id === actionId ? { ...a, groupId: groupId ?? undefined, order } : a))
      ),
    });
  },

  reorderActions: async (groupId, orderedIds) => {
    const order = orderedIds.length;
    await Promise.all(
      orderedIds.map((id, idx) => db.quickPrompts.update(id, { groupId: groupId ?? undefined, order: idx }))
    );
    set({
      actions: sortActions(
        get().actions.map((a) => {
          const idx = orderedIds.indexOf(a.id);
          if (idx === -1) return a;
          return { ...a, groupId: groupId ?? undefined, order: idx };
        })
      ),
    });
    void order;
  },

  reorderGroups: async (orderedIds) => {
    await Promise.all(orderedIds.map((id, idx) => db.actionGroups.update(id, { order: idx })));
    set({ groups: sortGroups(get().groups.map((g) => ({ ...g, order: orderedIds.indexOf(g.id) }))) });
  },
}));
