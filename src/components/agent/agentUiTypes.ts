import type {
  AgentApproval,
  AgentArtifact,
  AgentContextRef,
  AgentEvent,
  AgentRun,
  AgentToolCall,
} from '../../types/agent';
import type { AgentRunPlan } from '../../services/agent/policyEngine';
import type { AgentUiCreateInput } from '../../services/agent/buildQueuedAgentRun';

export type { AgentUiCreateInput };

export interface AgentUiActions {
  create: (input: AgentUiCreateInput) => Promise<void> | void;
  submitInput: (runId: string, content: string) => Promise<void> | void;
  pause: (runId: string) => Promise<void> | void;
  resume: (runId: string) => Promise<void> | void;
  cancel: (runId: string) => Promise<void> | void;
  retry: (runId: string) => Promise<void> | void;
  archive: (runId: string) => Promise<void> | void;
  queue: (runId: string) => Promise<void> | void;
  prioritizeQueue: (runId: string) => Promise<void> | void;
  answerApproval: (
    approval: AgentApproval,
    decision: 'approved' | 'rejected',
    rejectedPlanAction?: 'pause' | 'cancel',
  ) => Promise<void> | void;
  resolveReview: (runId: string, outcome: 'queue' | 'cancel') => Promise<void> | void;
  switchToGuided: (runId: string) => Promise<void> | void;
  openResource: (ref: AgentContextRef) => void;
  captureCurrentContext: () => AgentContextRef[];
}

export interface AgentSidebarProps {
  runs: AgentRun[];
  events: AgentEvent[];
  approvals: AgentApproval[];
  artifacts: AgentArtifact[];
  toolCalls: AgentToolCall[];
  plan: AgentRunPlan | null;
  error?: string | null;
  profiles?: Array<{ name: string; labelKey: string }>;
  providers?: Array<{ id: string; name: string; models: string[] }>;
  actions: AgentUiActions;
}
