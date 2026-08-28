// Project store. Local-first using Dexie (Tauri desktop).
// No server backend - all data lives in the local IndexedDB.

import { create } from 'zustand';
import { nanoid } from 'nanoid';
import type { Project } from '../types';
import { db } from '../services/db';
import { localTaskOperation, taskService } from '../services/tasks/taskService';
import { useUIStore } from './uiStore';

const PROJECT_COLORS = [
  'text-blue-500',
  'text-emerald-500',
  'text-amber-500',
  'text-rose-500',
  'text-violet-500',
  'text-cyan-500',
  'text-orange-500',
  'text-pink-500',
];

function showError(err: unknown, fallback: string): void {
  const msg = err instanceof Error ? err.message : fallback;
  useUIStore.getState().showToast(msg, 'error');
}

interface ProjectStore {
  projects: Project[];
  isLoaded: boolean;

  loadProjects: () => Promise<void>;
  createProject: (name: string) => Promise<Project | null>;
  updateProject: (id: string, updates: Partial<Pick<Project, 'name' | 'color'>>) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  getProjectById: (id: string | null) => Project | undefined;
}

export const useProjectStore = create<ProjectStore>((set, get) => ({
  projects: [],
  isLoaded: false,

  loadProjects: async () => {
    try {
      const projects = await db.projects.toArray();
      // Auto-seed "General" project if user has none (original behavior)
      if (projects.length === 0) {
        const generalProject: Project = {
          id: nanoid(8),
          name: 'General',
          color: PROJECT_COLORS[0],
          createdAt: Date.now(),
        };
        await taskService.createProjectProjection(generalProject, localTaskOperation('create-project'));
        set({ projects: [generalProject], isLoaded: true });
        return;
      }
      set({ projects, isLoaded: true });
    } catch (err) {
      set({ isLoaded: true });
      showError(err, 'Failed to load projects.');
    }
  },

  createProject: async (name) => {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const id = nanoid(8);
    const color = PROJECT_COLORS[get().projects.length % PROJECT_COLORS.length];
    const now = Date.now();
    const project: Project = { id, name: trimmed, color, createdAt: now };
    try {
      await taskService.createProjectProjection(project, localTaskOperation('create-project'));
      set((s) => ({ projects: [...s.projects, project] }));
      return project;
    } catch (err) {
      showError(err, 'Failed to create project.');
      return null;
    }
  },

  updateProject: async (id, updates) => {
    const previous = get().projects.find((p) => p.id === id);
    set((s) => ({
      projects: s.projects.map((p) => (p.id === id ? { ...p, ...updates } : p)),
    }));
    try {
      await taskService.updateProjectProjection({
        ...localTaskOperation('update-project'),
        projectId: id,
        ...updates,
      });
    } catch (err) {
      if (previous) {
        set((s) => ({
          projects: s.projects.map((p) => (p.id === id ? previous : p)),
        }));
      }
      showError(err, 'Failed to update project.');
    }
  },

  deleteProject: async (id) => {
    const previous = get().projects;
    set((s) => ({ projects: s.projects.filter((p) => p.id !== id) }));
    try {
      await db.projects.delete(id);
      // Tasks referencing this project will have projectId set to null by the task store
    } catch (err) {
      set({ projects: previous });
      showError(err, 'Failed to delete project.');
    }
  },

  getProjectById: (id) => {
    if (!id) return undefined;
    return get().projects.find((p) => p.id === id);
  },
}));