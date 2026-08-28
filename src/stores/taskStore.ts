// Task store. Local-first using Dexie (Tauri desktop).
// Includes Tauri file system sync for markdown-on-disk.

import { create } from 'zustand';
import { nanoid } from 'nanoid';
import type { Task, TaskStatus } from '../types';
import { db } from '../services/db';
import { localTaskOperation, taskService } from '../services/tasks/taskService';
import { useUIStore } from './uiStore';

function showError(err: unknown, fallback: string): void {
  const msg = err instanceof Error ? err.message : fallback;
  useUIStore.getState().showToast(msg, 'error');
}

interface TaskTab {
  tabId: string;
  taskId: string | null;
  colorIndex: number; // 0-5 for rainbow colors
}

interface TaskStore {
  tasks: Task[];
  activeTaskId: string | null; // derived from active tab
  openTaskIds: string[]; // derived
  openTabs: TaskTab[];
  activeTabId: string | null;
  isLoaded: boolean;

  loadTasks: () => Promise<void>;
  createTask: (title: string, opts?: Partial<Task>) => Promise<Task | null>;
  updateTask: (id: string, updates: Partial<Pick<Task, 
    'title' | 'content' | 'status' | 'importance' | 'date' | 
    'projectId' | 'assignees' | 'sourcePath' | 'parentId' | 
    'sourceChatMessageId'>>) => Promise<void>;
  deleteTask: (id: string) => Promise<void>;
  restoreTask: (id: string) => Promise<void>;
  permanentlyDeleteTask: (id: string) => Promise<void>;
  setActiveTask: (id: string | null) => void; // legacy: opens in new tab or replaces active
  openTaskInActiveTab: (taskId: string) => void; // task-list click: focus existing tab or open a new one
  createEmptyTab: () => void;
  closeTaskTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  getActiveTask: () => Task | null;
  getActiveTabColorIndex: () => number;
  getTabColorIndexByTaskId: (taskId: string) => number;
  getTasksByProject: (projectId: string | null) => Task[];
  getTasksByStatus: (status: TaskStatus) => Task[];
  getSubtasks: (parentId: string) => Task[];
  reorderSubtasks: (parentId: string, orderedIds: string[]) => Promise<void>;
  getDeletedTasks: () => Task[];
  fetchDeletedTasks: () => Promise<Task[]>;
  getLastSubtaskDate: (parentId: string) => number | null;
  createSubtask: (parentId: string, title: string, sourceChatMessageId?: string, date?: string) => Promise<Task | null>;
  /**
   * Regenerate INDEX.md on disk for the Tauri desktop bundle.
   * Kept for compatibility; actual implementation in fs-adapter.
   */
  regenerateIndex: () => Promise<void>;
}

export const useTaskStore = create<TaskStore>((set, get) => ({
  tasks: [],
  activeTaskId: null,
  openTaskIds: [],
  openTabs: [],
  activeTabId: null,
  isLoaded: false,

  loadTasks: async () => {
    try {
      // Load non-deleted tasks by default
      const tasks = await db.tasks.filter(t => !t.deletedAt).toArray();
      
      // Initialize with a single empty tab if none exist
      let tabs = get().openTabs.length > 0 ? get().openTabs : [{ tabId: nanoid(8), taskId: null, colorIndex: 0 }];
      const activeTabId = get().activeTabId ?? tabs[0].tabId;

      // Filter out tabs whose tasks no longer exist, and ensure colorIndex exists
      tabs = tabs.map((t) => {
        const taskMissing = t.taskId && !tasks.some((tsk: Task) => tsk.id === t.taskId);
        return { ...t, taskId: taskMissing ? null : t.taskId, colorIndex: t.colorIndex ?? 0 };
      });

      const activeTab = tabs.find((t) => t.tabId === activeTabId) ?? tabs[0];
      const derivedActiveTaskId = activeTab.taskId;
      const derivedOpenTaskIds = tabs.map((t) => t.taskId).filter(Boolean) as string[];

      set({
        tasks,
        openTabs: tabs,
        activeTabId: activeTab.tabId,
        activeTaskId: derivedActiveTaskId,
        openTaskIds: derivedOpenTaskIds,
        isLoaded: true,
      });
    } catch (err) {
      set({ isLoaded: true });
      showError(err, 'Failed to load tasks.');
    }
  },

  createTask: async (title, opts = {}) => {
    try {
      const command = {
        ...localTaskOperation('create'),
        title,
        content: opts.content,
        status: opts.status,
        importance: opts.importance,
        date: opts.date,
        projectId: opts.projectId,
        assignees: opts.assignees,
        sourcePath: opts.sourcePath,
        sourceChatMessageId: opts.sourceChatMessageId,
        order: get().tasks.length,
      };
      const result = opts.parentId
        ? await taskService.createSubtask({ ...command, parentId: opts.parentId })
        : await taskService.createTask(command);
      const task = result.task;
      
      set((s) => {
        // Open new task in active tab if possible, else append new tab
        let tabs = [...s.openTabs];
        let activeTabId = s.activeTabId;
        // Cycle colors based on tab count (modulo 6)
        const nextColor = tabs.length % 6;

        if (activeTabId) {
          tabs = tabs.map((t) => (t.tabId === activeTabId ? { ...t, taskId: task.id } : t));
        } else {
          const newTab = { tabId: nanoid(8), taskId: task.id, colorIndex: nextColor };
          tabs = [...tabs, newTab];
          activeTabId = newTab.tabId;
        }
        const derivedOpen = tabs.map((t) => t.taskId).filter(Boolean) as string[];
        return {
          tasks: [...s.tasks, task],
          openTabs: tabs,
          activeTabId,
          activeTaskId: task.id,
          openTaskIds: derivedOpen,
        };
      });
      return task;
    } catch (err) {
      showError(err, 'Failed to create task.');
      return null;
    }
  },

  updateTask: async (id, updates) => {
    const previous = get().tasks.find((t) => t.id === id);
    if (!previous) return;
    // Optimistic local update with an `updatedAt` tick so the UI shows the
    // new "last modified" immediately.
    const optimisticPatch = { ...updates, updatedAt: Date.now() } as Task;
    set((s) => ({
      tasks: s.tasks.map((t) => (t.id === id ? { ...t, ...optimisticPatch } : t)),
    }));
    try {
      const result = await taskService.updateTask({
        ...localTaskOperation('update'),
        taskId: id,
        expectedUpdatedAt: previous.updatedAt,
        updates,
      });
      set((s) => ({ tasks: s.tasks.map((task) => task.id === id ? result.task : task) }));
    } catch (err) {
      if (previous) {
        set((s) => ({
          tasks: s.tasks.map((t) => (t.id === id ? previous : t)),
        }));
      }
      showError(err, 'Failed to update task.');
    }
  },

  deleteTask: async (id) => {
    const previous = get().tasks;
    const taskToDelete = previous.find((task) => task.id === id);
    if (!taskToDelete) return;
    // Soft-delete locally: drop from the active list, pick a neighbour as
    // the new active task if necessary, close the tab. Matches the
    // previous Dexie behaviour.
    set((s) => {
      const remaining = s.tasks.filter((t) => t.id !== id);
      const stillOpen = s.openTaskIds.filter((tid) => tid !== id);
      let nextActive = s.activeTaskId;
      if (nextActive === id) {
        nextActive = stillOpen[stillOpen.length - 1] ?? null;
      }
      return {
        tasks: remaining,
        openTaskIds: stillOpen,
        activeTaskId: nextActive,
      };
    });
    useUIStore.getState().setActiveTaskId(get().activeTaskId);
    try {
      await taskService.softDeleteTask({
        ...localTaskOperation('soft-delete'),
        taskId: id,
        expectedUpdatedAt: taskToDelete.updatedAt,
        reason: 'Deleted from task store',
      });
    } catch (err) {
      set({ tasks: previous });
      showError(err, 'Failed to delete task.');
    }
  },

  restoreTask: async (id) => {
    try {
      await taskService.restoreTask(id);
      // Re-fetch the active list so the restored task reappears with
      // the canonical server `order` and `updatedAt`.
      const tasks = await db.tasks.filter(t => !t.deletedAt).toArray();
      set((s) => {
        // Restore into active tab if empty, else append new tab
        let tabs = [...s.openTabs];
        let act = s.activeTabId;
        const activeTab = tabs.find((t) => t.tabId === act);
        if (activeTab && activeTab.taskId === null) {
          tabs = tabs.map((t) => (t.tabId === act ? { ...t, taskId: id } : t));
        } else {
          const nt = { tabId: nanoid(8), taskId: id, colorIndex: 0 };
          tabs = [...tabs, nt];
          act = nt.tabId;
        }
        const derived = tabs.map((t) => t.taskId).filter(Boolean) as string[];
        return { tasks, openTabs: tabs, activeTabId: act, activeTaskId: id, openTaskIds: derived };
      });
      useUIStore.getState().setActiveTaskId(id);
    } catch (err) {
      showError(err, 'Failed to restore task.');
    }
  },

  permanentlyDeleteTask: async (id) => {
    const previous = get().tasks;
    set((s) => {
      const remaining = s.tasks.filter((t) => t.id !== id);
      const tabs = s.openTabs.map((t) => (t.taskId === id ? { ...t, taskId: null } : t));
      const nextActiveTab = s.activeTabId;
      let nextActiveTask: string | null = null;
      if (s.activeTaskId === id) {
        const actTab = tabs.find((t) => t.tabId === nextActiveTab);
        nextActiveTask = actTab?.taskId ?? null;
      }
      const derivedOpen = tabs.map((t) => t.taskId).filter(Boolean) as string[];
      return {
        tasks: remaining,
        openTabs: tabs,
        openTaskIds: derivedOpen,
        activeTaskId: nextActiveTask,
      };
    });
    try {
      await taskService.permanentlyDeleteTask(id);
    } catch (err) {
      set({ tasks: previous });
      showError(err, 'Failed to permanently delete task.');
    }
  },

  setActiveTask: (id) => {
    // Legacy: treat as "open in new tab" for backward compat with some call sites
    if (!id) {
      set({ activeTaskId: null });
      return;
    }
    const { openTabs, activeTabId } = get();
    // If already open somewhere, just activate that tab
    const existing = openTabs.find((t) => t.taskId === id);
    if (existing) {
      const derivedOpen = openTabs.map((t) => t.taskId).filter(Boolean) as string[];
      set({ activeTabId: existing.tabId, activeTaskId: id, openTaskIds: derivedOpen });
      useUIStore.getState().setActiveTaskId(id);
      return;
    }
    // Replace active tab or append
    let tabs = [...openTabs];
    let newActive = activeTabId;
    if (activeTabId) {
      tabs = tabs.map((t) => (t.tabId === activeTabId ? { ...t, taskId: id } : t));
    } else {
      const nt = { tabId: nanoid(8), taskId: id, colorIndex: 0 };
      tabs.push(nt);
      newActive = nt.tabId;
    }
    const derivedOpen = tabs.map((t) => t.taskId).filter(Boolean) as string[];
    set({ openTabs: tabs, activeTabId: newActive, activeTaskId: id, openTaskIds: derivedOpen });
    useUIStore.getState().setActiveTaskId(id);
  },

  openTaskInActiveTab: (taskId) => {
    const { openTabs, activeTabId } = get();
    const existing = openTabs.find((t) => t.taskId === taskId);
    if (existing) {
      const derivedOpen = openTabs.map((t) => t.taskId).filter(Boolean) as string[];
      set({ activeTabId: existing.tabId, activeTaskId: taskId, openTaskIds: derivedOpen });
      useUIStore.getState().setActiveTaskId(taskId);
      return;
    }

    const activeTab = openTabs.find((t) => t.tabId === activeTabId) ?? null;
    let tabs = [...openTabs];
    let nextActiveTabId = activeTabId;

    if (activeTab && activeTab.taskId === null) {
      tabs = tabs.map((t) => (t.tabId === activeTabId ? { ...t, taskId } : t));
    } else if (!activeTabId) {
      // No tab at all - create one
      const nt = { tabId: nanoid(8), taskId, colorIndex: 0 };
      tabs = [nt];
      nextActiveTabId = nt.tabId;
    } else {
      // Replace the task in the active tab instead of creating a new tab
      tabs = tabs.map((t) => (t.tabId === activeTabId ? { ...t, taskId } : t));
    }

    const derivedOpen = tabs.map((t) => t.taskId).filter(Boolean) as string[];
    set({ openTabs: tabs, activeTabId: nextActiveTabId, activeTaskId: taskId, openTaskIds: derivedOpen });
    useUIStore.getState().setActiveTaskId(taskId);
  },

  createEmptyTab: () => {
    set((s) => {
      // Cycle colors based on tab count (modulo 6)
      const nextColor = s.openTabs.length % 6;
      const nt = { tabId: nanoid(8), taskId: null, colorIndex: nextColor };
      const tabs = [...s.openTabs, nt];
      return {
        openTabs: tabs,
        activeTabId: nt.tabId,
        activeTaskId: null,
        openTaskIds: s.openTaskIds,
      };
    });
  },

  closeTaskTab: (tabId) => {
    const { openTabs, activeTabId, activeTaskId } = get();
    const remaining = openTabs.filter((t) => t.tabId !== tabId);
    let nextActiveTabId = activeTabId;
    let nextActiveTask: string | null = activeTaskId;
    if (activeTabId === tabId) {
      const nextTab = remaining[remaining.length - 1] ?? null;
      nextActiveTabId = nextTab?.tabId ?? null;
      nextActiveTask = nextTab?.taskId ?? null;
      useUIStore.getState().setActiveTaskId(nextActiveTask);
    }
    const replacementTabs = remaining.length > 0 ? remaining : [{ tabId: nanoid(8), taskId: null, colorIndex: 0 }];
    const derivedOpen = replacementTabs.map((t) => t.taskId).filter(Boolean) as string[];
    set({
      openTabs: replacementTabs,
      activeTabId: nextActiveTabId ?? replacementTabs[0].tabId,
      activeTaskId: nextActiveTask,
      openTaskIds: derivedOpen,
    });
  },

  setActiveTab: (tabId: string) => {
    const { openTabs } = get();
    const tab = openTabs.find((t) => t.tabId === tabId);
    if (!tab) return;
    const derivedOpen = openTabs.map((t) => t.taskId).filter(Boolean) as string[];
    set({ activeTabId: tabId, activeTaskId: tab.taskId, openTaskIds: derivedOpen });
    useUIStore.getState().setActiveTaskId(tab.taskId);
  },

  getActiveTask: () => {
    const { tasks, activeTaskId } = get();
    return tasks.find((t) => t.id === activeTaskId) ?? null;
  },

  getActiveTabColorIndex: () => {
    const { openTabs, activeTabId } = get();
    const tab = openTabs.find((t) => t.tabId === activeTabId);
    return tab?.colorIndex ?? 0;
  },

  getTabColorIndexByTaskId: (taskId: string) => {
    const { openTabs } = get();
    const tab = openTabs.find((t) => t.taskId === taskId);
    return tab?.colorIndex ?? 0;
  },

  getTasksByProject: (projectId) => {
    return get().tasks.filter((t) => t.projectId === projectId && !t.deletedAt);
  },

  getTasksByStatus: (status) => {
    return get().tasks.filter((t) => t.status === status && !t.deletedAt);
  },

  getSubtasks: (parentId) => get().tasks.filter((t) => t.parentId === parentId && !t.deletedAt),

  reorderSubtasks: async (_parentId, orderedIds) => {
    try {
      const changed = await taskService.reorderSubtasks(orderedIds);
      const changedById = new Map(changed.map((task) => [task.id, task]));
      set((s) => ({ tasks: s.tasks.map((task) => changedById.get(task.id) ?? task) }));
    } catch (err) {
      showError(err, 'Failed to reorder subtasks.');
    }
  },

  getDeletedTasks: () => {
    return [] as Task[]; // Sync placeholder — use fetchDeletedTasks() instead
  },

  fetchDeletedTasks: async (): Promise<Task[]> => {
    try {
      const tasks = await db.tasks.filter((t: Task) => Boolean(t.deletedAt)).toArray();
      return tasks.filter((t) => Boolean(t.deletedAt));
    } catch (err) {
      showError(err, 'Failed to load deleted tasks.');
      return [];
    }
  },

  getLastSubtaskDate: (parentId) => {
    const subs = get().getSubtasks(parentId);
    if (subs.length === 0) return null;
    return Math.max(...subs.map((s) => s.createdAt));
  },

  createSubtask: async (parentId, title, sourceChatMessageId, date) => {
    const parent = get().tasks.find((t) => t.id === parentId);
    if (!parent) {
      showError(new Error('Parent task not found'), 'Parent task not found');
      return null;
    }
    try {
      const { task } = await taskService.createSubtask({
        ...localTaskOperation('create-subtask'),
        parentId,
        title,
        date: date ?? parent.date,
        projectId: parent.projectId,
        sourceChatMessageId,
      });
      set((s) => ({ tasks: [...s.tasks, task] }));
      return task;
    } catch (err) {
      showError(err, 'Failed to add subtask.');
      return null;
    }
  },

  regenerateIndex: async () => {
    // Durable Markdown projection is introduced by the next harness phase.
  },
}));
