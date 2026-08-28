import { describe, expect, it } from 'vitest';
import {
  generateId,
  buildOperationId,
  parseOperationId,
  ToolVersionRegistry,
  MAX_TOOL_RESULT_BYTES,
  MAX_SHELL_RESULT_BYTES,
  DEFAULT_MAX_TURNS,
  DEFAULT_MAX_DURATION_MS,
  UNKNOWN_CONTEXT_WINDOW_TOKENS,
  MAX_LIST_PAGE_SIZE,
  MIN_LIST_PAGE_SIZE,
} from './helpers';
import { HARNESS_ENABLED_SETTING_KEY } from '../../types/agent';
import type { AgentToolDefinition, AgentToolCall } from '../../types/agent';

// ── Identifier generation ────────────────────────────────────────────────────

describe('generateId', () => {
  it('returns a non-empty string', () => {
    const id = generateId();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('generates unique values', () => {
    const ids = new Set(Array.from({ length: 200 }, () => generateId()));
    expect(ids.size).toBe(200);
  });
});

// ── Operation ID ─────────────────────────────────────────────────────────────

describe('buildOperationId', () => {
  it('produces a deterministic ID from runId, turn, and toolIndex', () => {
    const opId = buildOperationId('run-abc', 3, 7);
    expect(opId).toBe('run-abc:t3:tc7');
  });

  it('is stable across repeated calls', () => {
    const a = buildOperationId('r', 0, 0);
    const b = buildOperationId('r', 0, 0);
    expect(a).toBe(b);
  });

  it('differs when turn changes', () => {
    const a = buildOperationId('r', 1, 0);
    const b = buildOperationId('r', 2, 0);
    expect(a).not.toBe(b);
  });

  it('differs when toolIndex changes', () => {
    const a = buildOperationId('r', 0, 1);
    const b = buildOperationId('r', 0, 2);
    expect(a).not.toBe(b);
  });

  it('uses only run ID, turn, and toolIndex (no random component)', () => {
    const opId = buildOperationId('run-x', 5, 2);
    // Should contain exactly the run ID, turn, and tool index
    expect(opId).toBe('run-x:t5:tc2');
    // Parse it back and verify no extra data
    const parsed = parseOperationId(opId);
    expect(parsed).toEqual({ runId: 'run-x', turn: 5, toolIndex: 2 });
  });
});

describe('parseOperationId', () => {
  it('round-trips a valid operation ID', () => {
    const opId = buildOperationId('my-run', 10, 3);
    const parsed = parseOperationId(opId);
    expect(parsed).toEqual({ runId: 'my-run', turn: 10, toolIndex: 3 });
  });

  it('returns undefined for invalid format', () => {
    expect(parseOperationId('garbage')).toBeUndefined();
    expect(parseOperationId('')).toBeUndefined();
    expect(parseOperationId('run:tNaN:tc0')).toBeUndefined();
    expect(parseOperationId('run:t0:tcNaN')).toBeUndefined();
  });

  it('returns undefined for negative indices', () => {
    // buildOperationId won't produce these, but parse should reject them
    expect(parseOperationId('run:t-1:tc0')).toBeUndefined();
  });

  it('handles run IDs containing colons', () => {
    const opId = buildOperationId('org:project:run', 0, 0);
    const parsed = parseOperationId(opId);
    expect(parsed).toEqual({ runId: 'org:project:run', turn: 0, toolIndex: 0 });
  });
});

// ── Tool version registry ────────────────────────────────────────────────────

function makeTool(name: string, version: string): AgentToolDefinition {
  return {
    name,
    version,
    description: `Tool ${name}`,
    inputSchema: { type: 'object' },
    risk: 'local_read',
    sideEffect: 'none',
    supportsRetry: false,
    timeoutMs: 5000,
    maxResultBytes: MAX_TOOL_RESULT_BYTES,
    normalizeArgs: (args: unknown) => args,
    resolveResourceKeys: () => [],
    buildEffectPayload: () => null,
    validateGrant: () => true,
    execute: async () => ({ ok: true, summary: 'ok' }),
  };
}

describe('ToolVersionRegistry', () => {
  it('registers and retrieves tools', () => {
    const reg = new ToolVersionRegistry();
    const tool = makeTool('task_list', '1.0.0');
    reg.register(tool);
    expect(reg.get('task_list')).toBe(tool);
  });

  it('returns undefined for unknown tools', () => {
    const reg = new ToolVersionRegistry();
    expect(reg.get('nonexistent')).toBeUndefined();
  });

  it('lists names in insertion order', () => {
    const reg = new ToolVersionRegistry();
    reg.register(makeTool('b_tool', '1.0.0'));
    reg.register(makeTool('a_tool', '1.0.0'));
    expect(reg.names()).toEqual(['b_tool', 'a_tool']);
  });

  it('reports size', () => {
    const reg = new ToolVersionRegistry();
    expect(reg.size).toBe(0);
    reg.register(makeTool('x', '1.0.0'));
    expect(reg.size).toBe(1);
  });

  it('produces a sorted version string', () => {
    const reg = new ToolVersionRegistry();
    reg.register(makeTool('z_tool', '2.0.0'));
    reg.register(makeTool('a_tool', '1.0.0'));
    expect(reg.versionString()).toBe('a_tool@1.0.0;z_tool@2.0.0');
  });

  it('produces a stable hash', () => {
    const reg1 = new ToolVersionRegistry();
    reg1.register(makeTool('a', '1.0.0'));
    reg1.register(makeTool('b', '2.0.0'));

    const reg2 = new ToolVersionRegistry();
    reg2.register(makeTool('b', '2.0.0'));
    reg2.register(makeTool('a', '1.0.0'));

    // Same tools, same versions → same hash regardless of insertion order
    expect(reg1.hash()).toBe(reg2.hash());
  });

  it('produces different hashes for different versions', () => {
    const reg1 = new ToolVersionRegistry();
    reg1.register(makeTool('a', '1.0.0'));

    const reg2 = new ToolVersionRegistry();
    reg2.register(makeTool('a', '1.0.1'));

    expect(reg1.hash()).not.toBe(reg2.hash());
  });
});

// ── Limits ───────────────────────────────────────────────────────────────────

describe('limits', () => {
  it('MAX_TOOL_RESULT_BYTES is positive', () => {
    expect(MAX_TOOL_RESULT_BYTES).toBeGreaterThan(0);
  });

  it('MAX_SHELL_RESULT_BYTES is positive', () => {
    expect(MAX_SHELL_RESULT_BYTES).toBeGreaterThan(0);
  });

  it('DEFAULT_MAX_TURNS is positive', () => {
    expect(DEFAULT_MAX_TURNS).toBeGreaterThan(0);
  });

  it('DEFAULT_MAX_DURATION_MS is positive', () => {
    expect(DEFAULT_MAX_DURATION_MS).toBeGreaterThan(0);
  });

  it('UNKNOWN_CONTEXT_WINDOW_TOKENS is positive', () => {
    expect(UNKNOWN_CONTEXT_WINDOW_TOKENS).toBeGreaterThan(0);
  });

  it('MAX_LIST_PAGE_SIZE >= MIN_LIST_PAGE_SIZE', () => {
    expect(MAX_LIST_PAGE_SIZE).toBeGreaterThanOrEqual(MIN_LIST_PAGE_SIZE);
  });
});

// ── Harness feature setting ──────────────────────────────────────────────────

describe('HARNESS_ENABLED_SETTING_KEY', () => {
  it('is a non-empty string', () => {
    expect(typeof HARNESS_ENABLED_SETTING_KEY).toBe('string');
    expect(HARNESS_ENABLED_SETTING_KEY.length).toBeGreaterThan(0);
  });

  it('uses the agent.harness namespace', () => {
    expect(HARNESS_ENABLED_SETTING_KEY).toBe('agent.harness.enabled');
  });
});

// ── Contract shape smoke tests ───────────────────────────────────────────────

describe('contract shape smoke tests', () => {
  it('AgentToolCall uses operationId built from runId, turn, and toolIndex', () => {
    const runId = 'run-1';
    const turn = 2;
    const toolIndex = 3;
    const call: AgentToolCall = {
      id: generateId(),
      runId,
      turn,
      toolIndex,
      providerToolCallId: 'ptc-1',
      operationId: buildOperationId(runId, turn, toolIndex),
      effectFingerprint: 'fp',
      toolName: 'task_create',
      toolVersion: '1.0.0',
      normalizedArgs: { title: 'Test' },
      resourceKeys: ['task:new'],
      status: 'requested',
      resultArtifactIds: [],
      createdAt: Date.now(),
    };
    expect(call.operationId).toBe('run-1:t2:tc3');
  });
});
