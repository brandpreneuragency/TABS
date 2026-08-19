import type { AgentRun, AgentRunStatus } from '../../types/agent';

/** Events accepted by the durable run state machine. */
export type RunTransitionEvent =
  | 'queue'
  | 'claim_for_planning'
  | 'claim_for_running'
  | 'plan_needs_approval'
  | 'read_only_plan_accepted'
  | 'approval_approved'
  | 'plan_rejected_pause'
  | 'plan_rejected_cancel'
  | 'tool_rejected'
  | 'tool_needs_approval'
  | 'input_submitted'
  | 'pause'
  | 'pause_at_safe_boundary'
  | 'resume'
  | 'cancel_safe_work'
  | 'cancel_mutation'
  | 'mutation_outcome_known'
  | 'mutation_outcome_unknown'
  | 'provider_interrupted'
  | 'safe_recovery'
  | 'cancel_interrupted_safe_work'
  | 'review_resolved_queue'
  | 'review_resolved_cancel'
  | 'goal_finished'
  | 'terminal_error';

export class InvalidRunTransitionError extends Error {
  readonly name = 'InvalidRunTransitionError';
  readonly from: AgentRunStatus | 'new';
  readonly event: RunTransitionEvent;

  constructor(from: AgentRunStatus | 'new', event: RunTransitionEvent) {
    super(`Cannot apply ${event} while run is ${from}.`);
    this.from = from;
    this.event = event;
  }
}

const TRANSITIONS: Readonly<Record<AgentRunStatus | 'new', Partial<Record<RunTransitionEvent, AgentRunStatus>>>> = {
  new: { queue: 'queued' },
  queued: {
    claim_for_planning: 'planning',
    claim_for_running: 'running',
    pause: 'paused',
    cancel_safe_work: 'cancelled',
  },
  planning: {
    plan_needs_approval: 'awaiting_approval',
    read_only_plan_accepted: 'running',
    input_submitted: 'queued',
    pause: 'paused',
    cancel_safe_work: 'cancelled',
    provider_interrupted: 'interrupted',
    terminal_error: 'failed',
  },
  awaiting_approval: {
    approval_approved: 'running',
    plan_rejected_pause: 'paused',
    plan_rejected_cancel: 'cancelled',
    tool_rejected: 'running',
    input_submitted: 'queued',
    pause: 'paused',
    cancel_safe_work: 'cancelled',
  },
  running: {
    tool_needs_approval: 'awaiting_approval',
    input_submitted: 'running',
    pause_at_safe_boundary: 'paused',
    cancel_safe_work: 'cancelled',
    cancel_mutation: 'cancelling',
    provider_interrupted: 'interrupted',
    goal_finished: 'completed',
    terminal_error: 'failed',
  },
  cancelling: {
    mutation_outcome_known: 'cancelled',
    mutation_outcome_unknown: 'needs_review',
  },
  paused: {
    resume: 'queued',
    input_submitted: 'queued',
    cancel_safe_work: 'cancelled',
  },
  interrupted: {
    safe_recovery: 'queued',
    mutation_outcome_unknown: 'needs_review',
    cancel_interrupted_safe_work: 'cancelled',
  },
  needs_review: {
    review_resolved_queue: 'queued',
    review_resolved_cancel: 'cancelled',
  },
  completed: {},
  failed: {},
  cancelled: {},
};

export const TERMINAL_RUN_STATUSES: ReadonlySet<AgentRunStatus> = new Set<AgentRunStatus>([
  'completed',
  'failed',
  'cancelled',
]);

/** A safe boundary is between provider calls and tool executions. */
export function isSafeBoundary(status: AgentRunStatus): boolean {
  return status === 'planning'
    || status === 'awaiting_approval'
    || status === 'paused'
    || status === 'interrupted'
    || status === 'queued';
}

export function isTerminalRunStatus(status: AgentRunStatus): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

/** Returns the target state or rejects an event not represented in the plan table. */
export function transitionRun(
  from: AgentRunStatus | 'new',
  event: RunTransitionEvent,
): AgentRunStatus {
  const target = TRANSITIONS[from][event];
  if (!target) throw new InvalidRunTransitionError(from, event);
  return target;
}

/** Archive state is orthogonal to lifecycle state and changes no lifecycle field. */
export function withArchivedAt(run: AgentRun, archivedAt: number | undefined): AgentRun {
  return { ...run, archivedAt };
}

/** Safe recovery remains on the same run; retries and terminal steering create children. */
export function shouldCreateChildRun(status: AgentRunStatus): boolean {
  return isTerminalRunStatus(status);
}
