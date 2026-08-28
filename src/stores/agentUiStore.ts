import { create } from 'zustand';
import type { AgentContextRef, AgentRunStatus } from '../types/agent';

export type AgentUiView = 'run' | 'center';
export type AgentUiMode = 'guided' | 'delegated' | 'read_only';
export type AgentUiStatusFilter = 'all' | AgentRunStatus;

export const AGENT_UI_PROFILES = ['general', 'operator', 'researcher'] as const;

export interface AgentUiState {
  viewMode: AgentUiView;
  selectedRunId: string | null;
  statusFilter: AgentUiStatusFilter;
  includeArchived: boolean;
  profileName: string;
  mode: AgentUiMode;
  providerId: string;
  modelId: string;
  composerGoal: string;
  steeringDraft: string;
  pendingContextRefs: AgentContextRef[];
  lastFocusedRunId: string | null;

  setViewMode: (view: AgentUiView) => void;
  setSelectedRunId: (id: string | null) => void;
  setStatusFilter: (filter: AgentUiStatusFilter) => void;
  setIncludeArchived: (value: boolean) => void;
  setProfileName: (name: string) => void;
  setMode: (mode: AgentUiMode) => void;
  setProviderId: (id: string) => void;
  setModelId: (id: string) => void;
  setComposerGoal: (goal: string) => void;
  setSteeringDraft: (value: string) => void;
  setPendingContextRefs: (refs: AgentContextRef[]) => void;
  removePendingContextRef: (id: string) => void;
  setLastFocusedRunId: (id: string | null) => void;
  reset: () => void;
}

const INITIAL_VIEW_STATE = {
  viewMode: 'run' as AgentUiView,
  selectedRunId: null as string | null,
  statusFilter: 'all' as AgentUiStatusFilter,
  includeArchived: false,
  profileName: 'general',
  mode: 'guided' as AgentUiMode,
  providerId: '',
  modelId: '',
  composerGoal: '',
  steeringDraft: '',
  pendingContextRefs: [] as AgentContextRef[],
  lastFocusedRunId: null as string | null,
};

export const useAgentUiStore = create<AgentUiState>((set) => ({
  ...INITIAL_VIEW_STATE,

  setViewMode: (viewMode) => set({ viewMode }),
  setSelectedRunId: (selectedRunId) => set({ selectedRunId, viewMode: 'run' }),
  setStatusFilter: (statusFilter) => set({ statusFilter }),
  setIncludeArchived: (includeArchived) => set({ includeArchived }),
  setProfileName: (profileName) => set({ profileName }),
  setMode: (mode) => set({ mode }),
  setProviderId: (providerId) => set({ providerId }),
  setModelId: (modelId) => set({ modelId }),
  setComposerGoal: (composerGoal) => set({ composerGoal }),
  setSteeringDraft: (steeringDraft) => set({ steeringDraft }),
  setPendingContextRefs: (pendingContextRefs) => set({ pendingContextRefs }),
  removePendingContextRef: (id) => set((state) => ({
    pendingContextRefs: state.pendingContextRefs.filter((ref) => ref.id !== id),
  })),
  setLastFocusedRunId: (lastFocusedRunId) => set({ lastFocusedRunId }),
  reset: () => set({ ...INITIAL_VIEW_STATE, pendingContextRefs: [] }),
}));
