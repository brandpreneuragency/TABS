// ---------------------------------------------------------------------------
// TABS Work-OS Harness — System run plan and artifact tools
// Plan tools change run metadata only. They do not mutate user domain data.
// ---------------------------------------------------------------------------

import type {
  AgentToolDefinition,
  AgentToolResult,
  JsonSchema,
  ToolExecutionContext,
} from '../../../types/agent';
import { generateId, MAX_ARTIFACT_READ_LIMIT, MAX_TOOL_RESULT_BYTES, MIN_LIST_PAGE_SIZE } from '../helpers';
import {
  planRevisionHash,
  type AgentRunPlan,
  type AgentRunPlanStep,
} from '../policyEngine';

export const SYSTEM_TOOL_NAMES = ['run_plan_set', 'run_plan_step_update', 'artifact_read'] as const;
export const SYSTEM_TOOL_VERSION = '1.0.0';

export type SystemToolName = (typeof SYSTEM_TOOL_NAMES)[number];

export interface ArtifactReadRequest {
  runId: string;
  id: string;
  revision?: string;
  section?: string;
  cursor?: string | number;
  limit: number;
}

export type ArtifactSectionReader = (request: ArtifactReadRequest) => Promise<AgentToolResult>;

export interface SystemToolDependencies {
  plans?: Map<string, AgentRunPlan>;
  readArtifact?: ArtifactSectionReader;
}

const STEP_STATUSES = ['pending', 'in_progress', 'completed', 'blocked'] as const;

const PLAN_STEP_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'title'],
  properties: {
    id: { type: 'string', minLength: 1 },
    title: { type: 'string', minLength: 1 },
    status: { type: 'string', enum: [...STEP_STATUSES] },
    toolGroups: { type: 'array', items: { type: 'string', minLength: 1 } },
    resourceScope: { type: 'array', items: { type: 'string', minLength: 1 } },
    expectedChanges: { type: 'array', items: { type: 'string' } },
    estimatedOperations: { type: 'integer', minimum: 0 },
    note: { type: 'string' },
  },
};

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function toStep(raw: Record<string, unknown>): AgentRunPlanStep {
  const status = STEP_STATUSES.includes(raw.status as AgentRunPlanStep['status'])
    ? raw.status as AgentRunPlanStep['status']
    : 'pending';
  return {
    id: String(raw.id),
    title: String(raw.title),
    status,
    toolGroups: stringList(raw.toolGroups),
    resourceScope: stringList(raw.resourceScope),
    expectedChanges: stringList(raw.expectedChanges),
    estimatedOperations: typeof raw.estimatedOperations === 'number' ? raw.estimatedOperations : undefined,
    note: typeof raw.note === 'string' ? raw.note : undefined,
  };
}

function notFound(message: string): AgentToolResult {
  return {
    ok: false,
    summary: message,
    error: { code: 'not_found', message, retryable: false },
  };
}

export function createSystemTools(deps: SystemToolDependencies = {}): AgentToolDefinition[] {
  const plans = deps.plans ?? new Map<string, AgentRunPlan>();
  const readArtifact = deps.readArtifact ?? (async () => notFound('Artifact was not found'));

  const runPlanSet: AgentToolDefinition = {
    name: 'run_plan_set',
    version: SYSTEM_TOOL_VERSION,
    description: 'Store or replace the run plan. Changes run metadata only.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['goal', 'steps'],
      properties: {
        goal: { type: 'string', minLength: 1 },
        steps: { type: 'array', minItems: 1, items: PLAN_STEP_SCHEMA },
        expectedChanges: { type: 'array', items: { type: 'string' } },
        toolGroups: { type: 'array', items: { type: 'string', minLength: 1 } },
        resourceScope: { type: 'array', items: { type: 'string', minLength: 1 } },
        estimatedOperationCount: { type: 'integer', minimum: 0 },
        risks: { type: 'array', items: { type: 'string' } },
      },
    },
    risk: 'local_read',
    sideEffect: 'none',
    supportsRetry: true,
    timeoutMs: 5_000,
    maxResultBytes: MAX_TOOL_RESULT_BYTES,
    normalizeArgs: (args) => args,
    resolveResourceKeys: (context) => [`run:${context.runId}:plan`],
    buildEffectPayload: (args) => ({ kind: 'run_plan_set', goal: asRecord(args).goal }),
    validateGrant: () => true,
    async execute(context: ToolExecutionContext, args: unknown): Promise<AgentToolResult> {
      const record = asRecord(args);
      const steps = Array.isArray(record.steps)
        ? record.steps.map((step) => toStep(asRecord(step)))
        : [];
      const draft = {
        runId: context.runId,
        goal: String(record.goal ?? ''),
        steps,
        expectedChanges: stringList(record.expectedChanges),
        toolGroups: stringList(record.toolGroups),
        resourceScope: stringList(record.resourceScope),
        estimatedOperationCount: typeof record.estimatedOperationCount === 'number'
          ? record.estimatedOperationCount
          : steps.reduce((sum, step) => sum + (step.estimatedOperations ?? 0), 0),
        risks: stringList(record.risks),
      };
      const previous = plans.get(context.runId);
      const plan: AgentRunPlan = {
        ...draft,
        id: previous?.id ?? generateId(),
        revision: planRevisionHash(draft),
      };
      plans.set(context.runId, plan);
      return {
        ok: true,
        summary: `Stored run plan with ${plan.steps.length} steps`,
        data: plan,
        observedRevision: plan.revision,
      };
    },
  };

  const runPlanStepUpdate: AgentToolDefinition = {
    name: 'run_plan_step_update',
    version: SYSTEM_TOOL_VERSION,
    description: 'Update one run plan step. Changes run metadata only.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['stepId'],
      minProperties: 2,
      properties: {
        stepId: { type: 'string', minLength: 1 },
        status: { type: 'string', enum: [...STEP_STATUSES] },
        title: { type: 'string', minLength: 1 },
        note: { type: 'string' },
      },
    },
    risk: 'local_read',
    sideEffect: 'none',
    supportsRetry: true,
    timeoutMs: 5_000,
    maxResultBytes: MAX_TOOL_RESULT_BYTES,
    normalizeArgs: (args) => args,
    resolveResourceKeys: (context, args) => {
      const stepId = String(asRecord(args).stepId ?? '');
      return [`run:${context.runId}:plan:step:${stepId}`];
    },
    buildEffectPayload: (args) => ({ kind: 'run_plan_step_update', stepId: asRecord(args).stepId }),
    validateGrant: () => true,
    async execute(context: ToolExecutionContext, args: unknown): Promise<AgentToolResult> {
      const record = asRecord(args);
      const plan = plans.get(context.runId);
      if (!plan) return notFound('Run plan was not found');
      const stepId = String(record.stepId);
      const index = plan.steps.findIndex((step) => step.id === stepId);
      if (index < 0) return notFound(`Plan step ${stepId} was not found`);
      const current = plan.steps[index];
      const nextStep: AgentRunPlanStep = {
        ...current,
        status: typeof record.status === 'string' ? record.status as AgentRunPlanStep['status'] : current.status,
        title: typeof record.title === 'string' ? record.title : current.title,
        note: typeof record.note === 'string' ? record.note : current.note,
      };
      const steps = plan.steps.map((step, stepIndex) => (stepIndex === index ? nextStep : step));
      const draft = { ...plan, steps };
      const nextPlan: AgentRunPlan = { ...draft, revision: planRevisionHash(draft) };
      plans.set(context.runId, nextPlan);
      return {
        ok: true,
        summary: `Updated plan step ${stepId}`,
        data: nextPlan,
        observedRevision: nextPlan.revision,
      };
    },
  };

  const artifactRead: AgentToolDefinition = {
    name: 'artifact_read',
    version: SYSTEM_TOOL_VERSION,
    description: 'Read a bounded artifact section by identifier.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string', minLength: 1 },
        revision: { type: 'string' },
        section: { type: 'string' },
        cursor: { type: ['string', 'number'] },
        limit: { type: 'integer', minimum: MIN_LIST_PAGE_SIZE, maximum: MAX_ARTIFACT_READ_LIMIT },
      },
    },
    risk: 'local_read',
    sideEffect: 'none',
    supportsRetry: true,
    timeoutMs: 5_000,
    maxResultBytes: MAX_TOOL_RESULT_BYTES,
    normalizeArgs: (args) => {
      const record = asRecord(args);
      const limit = typeof record.limit === 'number' ? record.limit : MAX_ARTIFACT_READ_LIMIT;
      return { ...record, limit };
    },
    resolveResourceKeys: (_context, args) => [`artifact:${asRecord(args).id}`],
    buildEffectPayload: (args) => ({ kind: 'artifact_read', id: asRecord(args).id }),
    validateGrant: () => true,
    async execute(context: ToolExecutionContext, args: unknown): Promise<AgentToolResult> {
      const record = asRecord(args);
      return readArtifact({
        runId: context.runId,
        id: String(record.id),
        revision: typeof record.revision === 'string' ? record.revision : undefined,
        section: typeof record.section === 'string' ? record.section : undefined,
        cursor: typeof record.cursor === 'string' || typeof record.cursor === 'number' ? record.cursor : undefined,
        limit: typeof record.limit === 'number' ? record.limit : MAX_ARTIFACT_READ_LIMIT,
      });
    },
  };

  return [runPlanSet, runPlanStepUpdate, artifactRead];
}
