import { describe, expect, it } from 'vitest';
import type {
  AgentToolDefinition,
  AgentToolResult,
  ToolExecutionContext,
  ToolRiskClass,
} from '../../types/agent';
import { MAX_TOOL_RESULT_BYTES } from './helpers';
import {
  GRANT_CONSTRAINT_NAMES,
  MemoryPolicyStore,
  POLICY_ORDER,
  PolicyEngine,
  assertResourceRevisionsMatch,
  digestCommand,
  matchResourcePattern,
  type AgentRunPlan,
  type PolicyRunState,
} from './policyEngine';
import { ToolRegistrationError, ToolRegistry, createDefaultToolRegistry } from './toolRegistry';
import { CRM_READ_TOOL_NAMES } from './tools/crmTools';
import { DOCUMENT_READ_TOOL_NAMES } from './tools/documentTools';
import { FORM_READ_TOOL_NAMES } from './tools/formTools';
import { SYSTEM_TOOL_NAMES } from './tools/planTools';
import { TASK_READ_TOOL_NAMES } from './tools/taskTools';

const controller = () => new AbortController();

function context(mode: PolicyRunState['mode'] = 'guided', abort?: AbortSignal): ToolExecutionContext {
  return {
    runId: 'run-1',
    turn: 1,
    executionEpoch: 0,
    mode,
    contextRefs: [],
    abortSignal: abort ?? controller().signal,
  };
}

function runState(mode: PolicyRunState['mode'] = 'guided', policyRevision = 1): PolicyRunState {
  return {
    runId: 'run-1',
    mode,
    policyRevision,
    contextRefs: [],
  };
}

function makeTool(input: {
  name: string;
  risk: ToolRiskClass;
  execute?: AgentToolDefinition['execute'];
  schema?: Record<string, unknown>;
  timeoutMs?: number;
  maxResultBytes?: number;
  version?: string;
  resolveResourceKeys?: AgentToolDefinition['resolveResourceKeys'];
  validateGrant?: AgentToolDefinition['validateGrant'];
}): AgentToolDefinition {
  return {
    name: input.name,
    version: input.version ?? '1.0.0',
    description: input.name,
    inputSchema: input.schema ?? {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string' },
        id: { type: 'string' },
        path: { type: 'string' },
        updates: { type: 'object', additionalProperties: false, properties: {
          title: { type: 'string' },
          status: { type: 'string' },
        } },
        command: { type: 'string' },
        workingDirectoryKey: { type: 'string' },
        timeoutMs: { type: 'integer', minimum: 1 },
        provider: { type: 'string' },
        query: { type: 'string' },
        items: { type: 'array', items: { type: 'string' } },
      },
    },
    risk: input.risk,
    sideEffect: input.risk === 'local_read' || input.risk === 'network_read' ? 'none' : 'reversible',
    supportsRetry: true,
    timeoutMs: input.timeoutMs ?? 5_000,
    maxResultBytes: input.maxResultBytes ?? MAX_TOOL_RESULT_BYTES,
    normalizeArgs: (args) => args,
    resolveResourceKeys: input.resolveResourceKeys ?? ((_ctx, args) => {
      const record = args as Record<string, unknown>;
      if (typeof record.id === 'string') return [`${input.name}:${record.id}`];
      if (typeof record.path === 'string') return [`file:${record.path}`];
      if (typeof record.provider === 'string') return [`web:${record.provider}`];
      return [`${input.name}:default`];
    }),
    buildEffectPayload: (args) => args,
    validateGrant: input.validateGrant ?? (() => true),
    execute: input.execute ?? (async () => ({ ok: true, summary: input.name })),
  };
}

function planFixture(): AgentRunPlan {
  return {
    id: 'plan-1',
    runId: 'run-1',
    goal: 'Create a follow-up task',
    steps: [{ id: 'step-1', title: 'Create task', status: 'pending' }],
    expectedChanges: ['task'],
    toolGroups: ['task_create'],
    resourceScope: ['task/**'],
    estimatedOperationCount: 2,
    risks: ['local_create'],
    revision: 'rev-plan',
  };
}

describe('policy order and grant constraints', () => {
  it('exports the exact ten-step policy order', () => {
    expect(POLICY_ORDER).toEqual([
      'validate_args',
      'normalize',
      'resolve_resource_keys',
      'apply_mode_deny_rules',
      'find_grant_exact_tool_version',
      'match_resource_patterns',
      'apply_argument_constraints',
      'check_revision_expiration_uses',
      'consume_use_with_approval',
      'return_allow_ask_or_deny',
    ]);
  });

  it('exports the fixed grant constraint names', () => {
    expect(GRANT_CONSTRAINT_NAMES).toEqual([
      'allowedFields',
      'parentResourceKeys',
      'pathPrefixes',
      'maxItems',
      'commandDigest',
      'workingDirectoryKey',
    ]);
  });

  it('matches exact keys and a single trailing /** prefix', () => {
    expect(matchResourcePattern('task:1', 'task:1')).toBe(true);
    expect(matchResourcePattern('task:2', 'task:1')).toBe(false);
    expect(matchResourcePattern('task:1', 'task/**')).toBe(true);
    expect(matchResourcePattern('workspace:ws:path:src/a.ts', 'workspace:ws:path:src/**')).toBe(true);
    expect(matchResourcePattern('workspace:ws:path:lib/a.ts', 'workspace:ws:path:src/**')).toBe(false);
    expect(matchResourcePattern('task:1', 'task/**/nope')).toBe(false);
  });
});

describe('tool registry', () => {
  it('registers versioned system tools and rejects conflicts', () => {
    const registry = createDefaultToolRegistry();
    expect(registry.names()).toEqual([
      ...SYSTEM_TOOL_NAMES,
      ...DOCUMENT_READ_TOOL_NAMES,
      ...TASK_READ_TOOL_NAMES,
      ...CRM_READ_TOOL_NAMES,
      ...FORM_READ_TOOL_NAMES,
    ]);
    expect(registry.versionString()).toContain('run_plan_set@1.0.0');
    expect(() => registry.register(makeTool({ name: 'run_plan_set', risk: 'local_read' }))).toThrow(
      ToolRegistrationError,
    );
  });

  it('never registers a tool that exposes stored provider values', () => {
    const registry = new ToolRegistry();
    expect(() => makeTool({ name: 'read_api_key', risk: 'local_read' }) && registry.register(
      makeTool({ name: 'read_api_key', risk: 'local_read' }),
    )).toThrow(/stored provider values/);
    expect(() => registry.register(makeTool({ name: 'vault', risk: 'secret_access' }))).toThrow(
      /stored provider values/,
    );
  });
});

describe('deny and unknown fields', () => {
  it('denies mutations in read-only mode without executing the tool', async () => {
    let executed = false;
    const tool = makeTool({
      name: 'task_create',
      risk: 'local_create',
      execute: async () => {
        executed = true;
        return { ok: true, summary: 'created' };
      },
    });
    const engine = new PolicyEngine();
    const registry = new ToolRegistry({ policy: engine, tools: [tool] });
    const { result, decision } = await registry.invoke(context('read_only'), 'task_create', { title: 'Hi' }, {
      run: runState('read_only'),
    });
    expect(decision.outcome).toBe('deny');
    expect(result.error?.code).toBe('permission_denied');
    expect(executed).toBe(false);
  });

  it('rejects unknown fields before any other policy step', async () => {
    let executed = false;
    const tool = makeTool({
      name: 'task_create',
      risk: 'local_create',
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['title'],
        properties: { title: { type: 'string', minLength: 1 } },
      },
      execute: async () => {
        executed = true;
        return { ok: true, summary: 'created' };
      },
    });
    const engine = new PolicyEngine();
    const decision = await engine.evaluate({
      run: runState('guided'),
      tool,
      rawArgs: { title: 'Hi', extra: true, resourcePatterns: ['task/**'] },
      context: context('guided'),
    });
    expect(decision.outcome).toBe('deny');
    expect(decision.errorCode).toBe('validation_failed');
    expect(decision.step).toBe('validate_args');
    expect(executed).toBe(false);
  });

  it('rejects invalid arguments', async () => {
    const tool = makeTool({
      name: 'task_create',
      risk: 'local_create',
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['title'],
        properties: { title: { type: 'string', minLength: 1 } },
      },
    });
    const engine = new PolicyEngine();
    const decision = await engine.evaluate({
      run: runState('guided'),
      tool,
      rawArgs: {},
      context: context('guided'),
    });
    expect(decision.outcome).toBe('deny');
    expect(decision.errorCode).toBe('validation_failed');
  });
});

describe('guided approvals', () => {
  it('asks, then allows exactly once after approval', async () => {
    let executed = 0;
    const tool = makeTool({
      name: 'task_create',
      risk: 'local_create',
      execute: async () => {
        executed += 1;
        return { ok: true, summary: 'created' };
      },
      resolveResourceKeys: () => ['task:new'],
    });
    const engine = new PolicyEngine({
      readRevisions: async (keys) => Object.fromEntries(keys.map((key) => [key, 'absent'])),
    });
    const registry = new ToolRegistry({ policy: engine, tools: [tool] });
    const first = await registry.invoke(context('guided'), 'task_create', { title: 'Follow up' }, {
      run: runState('guided'),
      toolCallId: 'call-1',
    });
    expect(first.decision.outcome).toBe('ask');
    expect(first.result.error?.code).toBe('permission_denied');
    expect(executed).toBe(0);
    expect(first.decision.approval?.status).toBe('pending');

    const answered = await engine.answerApproval(first.decision.approval!.id, 'approved', [tool]);
    expect(answered.status).toBe('approved');

    const second = await registry.invoke(context('guided'), 'task_create', { title: 'Follow up' }, {
      run: runState('guided'),
      toolCallId: 'call-1',
    });
    expect(second.decision.outcome).toBe('allow');
    expect(second.result.ok).toBe(true);
    expect(executed).toBe(1);
    expect(second.decision.grant?.usedCount).toBe(1);
    expect(second.decision.grant?.maxUses).toBe(1);

    const third = await registry.invoke(context('guided'), 'task_create', { title: 'Follow up' }, {
      run: runState('guided'),
      toolCallId: 'call-2',
    });
    expect(third.decision.outcome).toBe('ask');
    expect(executed).toBe(1);
  });

  it('returns a structured rejection and never executes', async () => {
    let executed = false;
    const tool = makeTool({
      name: 'task_create',
      risk: 'local_create',
      execute: async () => {
        executed = true;
        return { ok: true, summary: 'created' };
      },
    });
    const engine = new PolicyEngine();
    const registry = new ToolRegistry({ policy: engine, tools: [tool] });
    const asked = await registry.invoke(context('guided'), 'task_create', { title: 'Nope' }, {
      run: runState('guided'),
      toolCallId: 'call-reject',
    });
    await engine.answerApproval(asked.decision.approval!.id, 'rejected', [tool]);
    const again = await registry.invoke(context('guided'), 'task_create', { title: 'Nope' }, {
      run: runState('guided'),
      toolCallId: 'call-reject',
    });
    expect(again.decision.outcome).toBe('deny');
    expect(again.result.error?.code).toBe('approval_rejected');
    expect(executed).toBe(false);
  });
});

describe('delegated envelope and scope expansion', () => {
  it('allows in-scope plan grants and asks for expansion', async () => {
    const tool = makeTool({
      name: 'task_create',
      risk: 'local_create',
      resolveResourceKeys: (_ctx, args) => {
        const id = String((args as { id?: string }).id ?? '1');
        return [`task:${id}`];
      },
    });
    const engine = new PolicyEngine({
      readRevisions: async (keys) => Object.fromEntries(keys.map((key) => [key, 'rev-1'])),
    });
    const { grants } = await engine.approvePlan({
      run: runState('delegated'),
      plan: planFixture(),
      tools: [tool],
    });
    expect(grants).toHaveLength(1);
    expect(grants[0]?.resourcePatterns).toEqual(['task/**']);
    expect(grants[0]?.maxUses).toBe(2);

    const allowed = await engine.evaluate({
      run: runState('delegated'),
      tool,
      rawArgs: { id: '99', title: 'In scope' },
      context: context('delegated'),
    });
    expect(allowed.outcome).toBe('allow');
    expect(allowed.grant?.usedCount).toBe(1);

    const expansion = await engine.evaluate({
      run: runState('delegated'),
      tool: makeTool({
        name: 'task_create',
        risk: 'local_create',
        version: '1.0.0',
        resolveResourceKeys: () => ['crm:lead:1'],
      }),
      rawArgs: { title: 'Out of scope' },
      context: context('delegated'),
    });
    expect(expansion.outcome).toBe('ask');
    expect(expansion.reason).toMatch(/outside the approved plan envelope|requires approval/);
  });
});

describe('expiry, revisions, restart, and counts', () => {
  it('expires a pending approval after its ttl', async () => {
    let now = 1_000;
    const tool = makeTool({ name: 'task_create', risk: 'local_create' });
    const engine = new PolicyEngine({
      now: () => now,
      approvalTtlMs: 50,
    });
    const asked = await engine.evaluate({
      run: runState('guided'),
      tool,
      rawArgs: { title: 'Soon' },
      context: context('guided'),
    });
    now = 2_000;
    const expired = await engine.answerApproval(asked.approval!.id, 'approved', [tool]);
    expect(expired.status).toBe('expired');
  });

  it('expires grants and approvals when resource revisions change', async () => {
    const revisions: Record<string, string> = { 'task:1': 'rev-a', task: 'rev-parent' };
    const tool = makeTool({
      name: 'task_update',
      risk: 'local_update',
      resolveResourceKeys: () => ['task:1'],
    });
    const engine = new PolicyEngine({
      readRevisions: async (keys) => Object.fromEntries(keys.map((key) => [key, revisions[key] ?? 'absent'])),
    });
    const asked = await engine.evaluate({
      run: runState('guided'),
      tool,
      rawArgs: { id: '1', updates: { title: 'A' } },
      context: context('guided'),
      toolCallId: 'call-rev',
    });
    await engine.answerApproval(asked.approval!.id, 'approved', [tool]);
    revisions['task:1'] = 'rev-b';
    const again = await engine.evaluate({
      run: runState('guided'),
      tool,
      rawArgs: { id: '1', updates: { title: 'B' } },
      context: context('guided'),
      toolCallId: 'call-rev-2',
    });
    expect(again.outcome).toBe('ask');
    expect(again.errorCode).toBe('stale_revision');
    expect(() => assertResourceRevisionsMatch({ 'task:1': 'rev-a' }, revisions)).toThrow(/revision/);
  });

  it('restores pending approvals after restart from the durable store snapshot', async () => {
    const store = new MemoryPolicyStore();
    const tool = makeTool({ name: 'task_create', risk: 'local_create' });
    const engine = new PolicyEngine({ store });
    const asked = await engine.evaluate({
      run: runState('guided'),
      tool,
      rawArgs: { title: 'Persist me' },
      context: context('guided'),
      toolCallId: 'call-restart',
    });
    expect(asked.approval?.status).toBe('pending');

    const restored = new PolicyEngine({ store: MemoryPolicyStore.fromSnapshot(store.snapshot()) });
    const approvals = await restored.store.listApprovals('run-1');
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.id).toBe(asked.approval?.id);
    expect(approvals[0]?.status).toBe('pending');
    expect(approvals[0]?.toolCallId).toBe('call-restart');
  });

  it('consumes network ask-once uses and then asks again', async () => {
    const tool = makeTool({
      name: 'web_search',
      risk: 'network_read',
      resolveResourceKeys: () => ['web:brave'],
    });
    const engine = new PolicyEngine();
    const first = await engine.evaluate({
      run: runState('guided'),
      tool,
      rawArgs: { provider: 'brave', query: 'tabs' },
      context: context('guided'),
      toolCallId: 'net-1',
    });
    expect(first.outcome).toBe('ask');
    await engine.answerApproval(first.approval!.id, 'approved', [tool]);

    for (let index = 0; index < 5; index++) {
      const allowed = await engine.evaluate({
        run: runState('guided'),
        tool,
        rawArgs: { provider: 'brave', query: `q${index}` },
        context: context('guided'),
        toolCallId: `net-use-${index}`,
      });
      expect(allowed.outcome).toBe('allow');
    }
    const depleted = await engine.evaluate({
      run: runState('guided'),
      tool,
      rawArgs: { provider: 'brave', query: 'after' },
      context: context('guided'),
      toolCallId: 'net-6',
    });
    expect(depleted.outcome).toBe('ask');
  });
});

describe('grant constraints, shell digest, timeout, truncation', () => {
  it('applies field allowlists, path prefixes, and maxItems', async () => {
    const tool = makeTool({
      name: 'task_update',
      risk: 'local_update',
      resolveResourceKeys: () => ['task:1'],
    });
    const engine = new PolicyEngine({
      readRevisions: async (keys) => Object.fromEntries(keys.map((key) => [key, 'rev-1'])),
    });
    await engine.store.addGrant({
      id: 'grant-fields',
      runId: 'run-1',
      policyRevision: 1,
      toolName: 'task_update',
      toolVersion: '1.0.0',
      resourcePatterns: ['task:1'],
      argumentConstraints: { allowedFields: ['title'], pathPrefixes: ['src'], maxItems: 2 },
      resourceRevisions: { 'task:1': 'rev-1' },
      maxUses: 3,
      usedCount: 0,
      expiresAt: Date.now() + 60_000,
    });

    const allowed = await engine.evaluate({
      run: runState('guided'),
      tool,
      rawArgs: { id: '1', updates: { title: 'ok' }, path: 'src/a.ts', items: ['a'] },
      context: context('guided'),
    });
    expect(allowed.outcome).toBe('allow');

    const extraField = await engine.evaluate({
      run: runState('guided'),
      tool,
      rawArgs: { id: '1', updates: { title: 'ok', status: 'done' }, path: 'src/a.ts' },
      context: context('guided'),
    });
    expect(extraField.outcome).toBe('ask');

    const badPath = await engine.evaluate({
      run: runState('guided'),
      tool,
      rawArgs: { id: '1', updates: { title: 'ok' }, path: 'lib/a.ts' },
      context: context('guided'),
    });
    expect(badPath.outcome).toBe('ask');

    const tooMany = await engine.evaluate({
      run: runState('guided'),
      tool,
      rawArgs: { id: '1', updates: { title: 'ok' }, path: 'src/a.ts', items: ['a', 'b', 'c'] },
      context: context('guided'),
    });
    expect(tooMany.outcome).toBe('ask');
  });

  it('matches one-use shell command digests and working directories', async () => {
    const command = 'git status --short';
    const workingDirectoryKey = 'workspace:ws1';
    const tool = makeTool({
      name: 'shell_exec',
      risk: 'process_execute',
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['command', 'workingDirectoryKey', 'timeoutMs'],
        properties: {
          command: { type: 'string', minLength: 1 },
          workingDirectoryKey: { type: 'string', minLength: 1 },
          timeoutMs: { type: 'integer', minimum: 1 },
        },
      },
      resolveResourceKeys: () => [`shell:${workingDirectoryKey}`],
    });
    const engine = new PolicyEngine({
      readRevisions: async (keys) => Object.fromEntries(keys.map((key) => [key, 'rev-1'])),
    });
    const asked = await engine.evaluate({
      run: runState('guided'),
      tool,
      rawArgs: { command, workingDirectoryKey, timeoutMs: 1000 },
      context: context('guided'),
      toolCallId: 'shell-1',
    });
    expect(asked.outcome).toBe('ask');
    await engine.answerApproval(asked.approval!.id, 'approved', [tool]);

    const allowed = await engine.evaluate({
      run: runState('guided'),
      tool,
      rawArgs: { command: `  ${command}  `, workingDirectoryKey, timeoutMs: 1000 },
      context: context('guided'),
      toolCallId: 'shell-1',
    });
    expect(allowed.outcome).toBe('allow');
    expect(allowed.grant?.commandDigest).toBe(digestCommand(command, workingDirectoryKey));
    expect(allowed.grant?.usedCount).toBe(1);

    const other = await engine.evaluate({
      run: runState('guided'),
      tool,
      rawArgs: { command: 'rm -rf /', workingDirectoryKey, timeoutMs: 1000 },
      context: context('guided'),
      toolCallId: 'shell-2',
    });
    expect(other.outcome).toBe('ask');
  });

  it('times out a slow tool after policy allow', async () => {
    const tool = makeTool({
      name: 'artifact_slow',
      risk: 'local_read',
      timeoutMs: 25,
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return { ok: true, summary: 'late' };
      },
    });
    const registry = new ToolRegistry({ tools: [tool] });
    const { result, decision } = await registry.invoke(context('read_only'), 'artifact_slow', {}, {
      run: runState('read_only'),
    });
    expect(decision.outcome).toBe('allow');
    expect(result.error?.code).toBe('timeout');
  });

  it('truncates oversized tool results', async () => {
    const tool = makeTool({
      name: 'artifact_big',
      risk: 'local_read',
      maxResultBytes: 32,
      execute: async () => ({
        ok: true,
        summary: 'big',
        data: { blob: 'x'.repeat(200) },
      } satisfies AgentToolResult),
    });
    const registry = new ToolRegistry({ tools: [tool] });
    const { result, decision } = await registry.invoke(context('read_only'), 'artifact_big', {}, {
      run: runState('read_only'),
    });
    expect(decision.outcome).toBe('allow');
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ truncated: true, maxResultBytes: 32 });
  });
});

describe('run plan tools', () => {
  it('stores and updates a plan through the policy-gated registry', async () => {
    const registry = createDefaultToolRegistry();
    const setResult = await registry.invoke(context('read_only'), 'run_plan_set', {
      goal: 'Ship the golden workflow',
      steps: [{ id: 's1', title: 'Inspect submission' }],
      toolGroups: ['task'],
      resourceScope: ['task/**'],
      estimatedOperationCount: 3,
    }, { run: runState('read_only') });
    expect(setResult.decision.outcome).toBe('allow');
    expect(setResult.result.ok).toBe(true);
    const plan = setResult.result.data as AgentRunPlan;
    expect(plan.steps).toHaveLength(1);

    const updated = await registry.invoke(context('read_only'), 'run_plan_step_update', {
      stepId: 's1',
      status: 'completed',
    }, { run: runState('read_only') });
    expect(updated.result.ok).toBe(true);
    expect((updated.result.data as AgentRunPlan).steps[0]?.status).toBe('completed');
  });

  it('rejects unknown fields on plan tools', async () => {
    const registry = createDefaultToolRegistry();
    const { decision, result } = await registry.invoke(context('read_only'), 'run_plan_set', {
      goal: 'x',
      steps: [{ id: 's1', title: 'one' }],
      extra: true,
    }, { run: runState('read_only') });
    expect(decision.outcome).toBe('deny');
    expect(result.error?.code).toBe('validation_failed');
  });
});
