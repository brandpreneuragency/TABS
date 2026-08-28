import { describe, expect, it } from 'vitest';
import type { AgentRun, AgentRunStatus } from '../../types/agent';
import {
  InvalidRunTransitionError,
  isSafeBoundary,
  isTerminalRunStatus,
  shouldCreateChildRun,
  transitionRun,
  withArchivedAt,
  type RunTransitionEvent,
} from './runStateMachine';

type ValidCase = readonly [AgentRunStatus | 'new', RunTransitionEvent, AgentRunStatus];

const validTransitions: ValidCase[] = [
  ['new', 'queue', 'queued'],
  ['queued', 'claim_for_planning', 'planning'],
  ['queued', 'claim_for_running', 'running'],
  ['queued', 'pause', 'paused'],
  ['queued', 'cancel_safe_work', 'cancelled'],
  ['planning', 'plan_needs_approval', 'awaiting_approval'],
  ['planning', 'read_only_plan_accepted', 'running'],
  ['planning', 'input_submitted', 'queued'],
  ['planning', 'pause', 'paused'],
  ['planning', 'cancel_safe_work', 'cancelled'],
  ['planning', 'provider_interrupted', 'interrupted'],
  ['awaiting_approval', 'approval_approved', 'running'],
  ['awaiting_approval', 'plan_rejected_pause', 'paused'],
  ['awaiting_approval', 'plan_rejected_cancel', 'cancelled'],
  ['awaiting_approval', 'tool_rejected', 'running'],
  ['awaiting_approval', 'input_submitted', 'queued'],
  ['awaiting_approval', 'pause', 'paused'],
  ['awaiting_approval', 'cancel_safe_work', 'cancelled'],
  ['running', 'tool_needs_approval', 'awaiting_approval'],
  ['running', 'input_submitted', 'running'],
  ['running', 'pause_at_safe_boundary', 'paused'],
  ['running', 'cancel_safe_work', 'cancelled'],
  ['running', 'cancel_mutation', 'cancelling'],
  ['running', 'provider_interrupted', 'interrupted'],
  ['running', 'goal_finished', 'completed'],
  ['running', 'terminal_error', 'failed'],
  ['cancelling', 'mutation_outcome_known', 'cancelled'],
  ['cancelling', 'mutation_outcome_unknown', 'needs_review'],
  ['paused', 'resume', 'queued'],
  ['paused', 'input_submitted', 'queued'],
  ['paused', 'cancel_safe_work', 'cancelled'],
  ['interrupted', 'safe_recovery', 'queued'],
  ['interrupted', 'mutation_outcome_unknown', 'needs_review'],
  ['interrupted', 'cancel_interrupted_safe_work', 'cancelled'],
  ['needs_review', 'review_resolved_queue', 'queued'],
  ['needs_review', 'review_resolved_cancel', 'cancelled'],
  ['planning', 'terminal_error', 'failed'],
];

function runFixture(): AgentRun {
  return {
    id: 'run-1',
    title: 'Fixture',
    goal: 'Prove archival isolation',
    status: 'completed',
    mode: 'guided',
    contextRefs: [],
    providerSnapshot: {
      providerId: 'provider', adapter: 'openai_compatible', adapterVersion: '1',
      baseUrl: 'https://provider.invalid', modelId: 'model', credentialAccount: 'account',
      reasoning: 'standard', capabilities: {
        streaming: true, toolCalling: true, vision: false, reasoning: false,
        contextWindow: 1, maxOutputTokens: 1,
      }, contextWindow: 1, maxOutputTokens: 1,
    },
    profileSnapshot: {
      name: 'fixture', description: 'fixture', systemInstructions: '', defaultMode: 'guided',
      allowedToolGroups: [], defaultSkills: [],
    },
    instructionSnapshot: {
      safetyInstructionsHash: 'safe', policyHash: 'policy', skillHashes: [],
      compiledContent: '', compiledContentHash: 'hash',
    },
    policySnapshot: { revision: 1, mode: 'guided', rulesHash: 'rules' },
    policyRevision: 1, toolRegistryVersion: '1', toolRegistryHash: 'registry', appVersion: 'test',
    nextSequence: 2, activeTurn: 1, executionEpoch: 4, queuePriority: 9, pendingInputCount: 0,
    maxTurns: 25, maxDurationMs: 1_000, createdAt: 10, updatedAt: 20, finishedAt: 30,
  };
}

describe('run state machine', () => {
  it.each(validTransitions)('%s + %s becomes %s', (from, event, target) => {
    expect(transitionRun(from, event)).toBe(target);
  });

  it.each([
    ['queued', 'goal_finished'],
    ['planning', 'cancel_mutation'],
    ['awaiting_approval', 'resume'],
    ['running', 'pause'],
    ['cancelling', 'safe_recovery'],
    ['paused', 'approval_approved'],
    ['interrupted', 'goal_finished'],
    ['needs_review', 'cancel_safe_work'],
    ['completed', 'input_submitted'],
    ['failed', 'queue'],
    ['cancelled', 'resume'],
  ] as const)('rejects %s + %s', (from, event) => {
    expect(() => transitionRun(from, event)).toThrow(InvalidRunTransitionError);
  });

  it('steers planning, running, approval, and paused runs only at their documented boundaries', () => {
    expect(transitionRun('planning', 'input_submitted')).toBe('queued');
    expect(transitionRun('running', 'input_submitted')).toBe('running');
    expect(transitionRun('awaiting_approval', 'input_submitted')).toBe('queued');
    expect(transitionRun('paused', 'input_submitted')).toBe('queued');
  });

  it('keeps terminal runs closed and routes terminal steering to a child run', () => {
    for (const status of ['completed', 'failed', 'cancelled'] as const) {
      expect(isTerminalRunStatus(status)).toBe(true);
      expect(shouldCreateChildRun(status)).toBe(true);
      expect(() => transitionRun(status, 'input_submitted')).toThrow(InvalidRunTransitionError);
    }
  });

  it('identifies safe boundaries without treating active mutation cancellation as safe', () => {
    expect(isSafeBoundary('planning')).toBe(true);
    expect(isSafeBoundary('awaiting_approval')).toBe(true);
    expect(isSafeBoundary('running')).toBe(false);
    expect(transitionRun('running', 'cancel_mutation')).toBe('cancelling');
    expect(transitionRun('cancelling', 'mutation_outcome_unknown')).toBe('needs_review');
  });

  it('archives by changing only archivedAt', () => {
    const original = runFixture();
    const archived = withArchivedAt(original, 99);
    const unarchived = withArchivedAt(archived, undefined);

    expect(archived).toEqual({ ...original, archivedAt: 99 });
    expect(unarchived).toEqual(original);
    expect(archived.status).toBe('completed');
  });
});
