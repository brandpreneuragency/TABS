import type {
  AgentContextKind,
  AgentContextRef,
  AgentEvent,
  AgentEventType,
  AgentRun,
  AgentRunStatus,
} from '../../types/agent';
import type { AgentRunPlan } from '../../services/agent/policyEngine';

export const RUN_CENTER_GROUPS = [
  { id: 'active', statuses: ['planning', 'running', 'cancelling', 'paused', 'interrupted'] as const },
  { id: 'waiting_approval', statuses: ['awaiting_approval'] as const },
  { id: 'needs_review', statuses: ['needs_review'] as const },
  { id: 'queued', statuses: ['queued'] as const },
  { id: 'completed', statuses: ['completed'] as const },
  { id: 'failed', statuses: ['failed'] as const },
  { id: 'cancelled', statuses: ['cancelled'] as const },
] as const;

export type RunCenterGroupId = (typeof RUN_CENTER_GROUPS)[number]['id'];

export type TimelineKind =
  | 'model'
  | 'read'
  | 'proposed'
  | 'approved'
  | 'rejected'
  | 'error'
  | 'recovery'
  | 'artifact';

export const STATUS_I18N: Record<AgentRunStatus, string> = {
  queued: 'agent.statusQueued',
  planning: 'agent.statusPlanning',
  awaiting_approval: 'agent.statusAwaitingApproval',
  running: 'agent.statusRunning',
  cancelling: 'agent.statusCancelling',
  paused: 'agent.statusPaused',
  interrupted: 'agent.statusInterrupted',
  needs_review: 'agent.statusNeedsReview',
  completed: 'agent.statusCompleted',
  failed: 'agent.statusFailed',
  cancelled: 'agent.statusCancelled',
};

export const GROUP_I18N: Record<RunCenterGroupId, string> = {
  active: 'agent.groupActive',
  waiting_approval: 'agent.groupWaitingApproval',
  needs_review: 'agent.groupNeedsReview',
  queued: 'agent.groupQueued',
  completed: 'agent.groupCompleted',
  failed: 'agent.groupFailed',
  cancelled: 'agent.groupCancelled',
};

export function formatDuration(run: AgentRun, now = Date.now()): string {
  const start = run.startedAt ?? run.createdAt;
  const end = run.finishedAt ?? now;
  const ms = Math.max(0, end - start);
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function formatTimestamp(value?: number): string {
  if (!value) return '—';
  return new Date(value).toLocaleString();
}

export function classifyEvent(type: AgentEventType): TimelineKind {
  if (type.startsWith('model.')) return 'model';
  if (type === 'artifact.created') return 'artifact';
  if (type === 'run.interrupted' || type === 'context.compacted') return 'recovery';
  if (type === 'tool.failed' || type === 'model.failed' || type === 'run.failed') return 'error';
  if (type === 'approval.answered') return 'approved';
  if (type === 'approval.invalidated') return 'rejected';
  if (type === 'approval.requested' || type === 'tool.requested') return 'proposed';
  if (type === 'tool.completed') return 'approved';
  if (type.startsWith('tool.')) return 'read';
  return 'model';
}

export function latestStepLabel(events: AgentEvent[]): string {
  const last = events[events.length - 1];
  return last?.type ?? 'run.created';
}

export function planFromEvents(events: AgentEvent[]): AgentRunPlan | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type !== 'plan.created' && event.type !== 'plan.updated') continue;
    const data = event.data;
    if (!data || typeof data !== 'object') continue;
    const record = data as Record<string, unknown>;
    const candidate = (record.plan && typeof record.plan === 'object'
      ? record.plan
      : record) as Partial<AgentRunPlan>;
    if (typeof candidate.goal === 'string' && Array.isArray(candidate.steps)) {
      return candidate as AgentRunPlan;
    }
  }
  return null;
}

export function groupRuns(runs: AgentRun[]): Record<RunCenterGroupId, AgentRun[]> {
  const grouped = {
    active: [] as AgentRun[],
    waiting_approval: [] as AgentRun[],
    needs_review: [] as AgentRun[],
    queued: [] as AgentRun[],
    completed: [] as AgentRun[],
    failed: [] as AgentRun[],
    cancelled: [] as AgentRun[],
  };
  for (const run of runs) {
    const group = RUN_CENTER_GROUPS.find((entry) => entry.statuses.includes(run.status as never));
    if (group) grouped[group.id].push(run);
  }
  return grouped;
}

export function parseResourceKey(resourceKey: string): { kind: string; id: string } | null {
  const separator = resourceKey.indexOf(':');
  if (separator <= 0) return null;
  return {
    kind: resourceKey.slice(0, separator),
    id: resourceKey.slice(separator + 1),
  };
}

export function contextRefFromResourceKey(resourceKey: string, label = resourceKey): AgentContextRef | null {
  const parsed = parseResourceKey(resourceKey);
  if (!parsed) return null;
  const kind = asContextKind(parsed.kind);
  if (!kind) return null;
  return { kind, id: parsed.id, label };
}

const CONTEXT_KINDS: AgentContextKind[] = [
  'workspace',
  'document',
  'task',
  'crm',
  'form',
  'submission',
  'file',
];

function asContextKind(value: string): AgentContextKind | null {
  return CONTEXT_KINDS.includes(value as AgentContextKind) ? value as AgentContextKind : null;
}
