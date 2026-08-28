// ---------------------------------------------------------------------------
// TABS Work-OS Harness — Versioned tool registry
// Strict schemas, frozen run context, timeouts, and result limits. No tool
// executes until the policy engine returns an explicit allow decision.
// Stored provider values are never exposed through a registered tool.
// ---------------------------------------------------------------------------

import type {
  AgentToolDefinition,
  AgentToolResult,
  ToolExecutionContext,
} from '../../types/agent';
import { MAX_TOOL_RESULT_BYTES } from './helpers';
import {
  PolicyEngine,
  decisionError,
  type PolicyDecision,
  type PolicyRunState,
} from './policyEngine';
import { createCrmMutationTools, createCrmReadTools, type CRMMutationToolDependencies, type CRMReadToolDependencies } from './tools/crmTools';
import { createDocumentMutationTools, createDocumentReadTools, type DocumentMutationToolDependencies, type DocumentReadToolDependencies } from './tools/documentTools';
import { createFileTools, type FileToolDependencies } from './tools/fileTools';
import { createFormReadTools, type FormReadToolDependencies } from './tools/formTools';
import { createSystemTools, SYSTEM_TOOL_NAMES, type SystemToolDependencies } from './tools/planTools';
import { createShellTools, type ShellToolDependencies } from './tools/shellTools';
import { createTaskMutationTools, createTaskReadTools, type TaskMutationToolDependencies, type TaskReadToolDependencies } from './tools/taskTools';
import { createWebTools, type WebToolDependencies } from './tools/webTools';

export { SYSTEM_TOOL_NAMES };

export interface ReadToolDependencies {
  documents?: DocumentReadToolDependencies;
  tasks?: TaskReadToolDependencies;
  crm?: CRMReadToolDependencies;
  forms?: FormReadToolDependencies;
}

export interface MutationToolDependencies {
  documents?: DocumentMutationToolDependencies;
  tasks?: TaskMutationToolDependencies;
  crm?: CRMMutationToolDependencies;
}

export interface CodingToolDependencies {
  files?: FileToolDependencies;
  shell?: ShellToolDependencies;
  web?: WebToolDependencies;
}

const SECRET_NAME_RE = /(secret|credential|api[_-]?key|provider[_-]?value|stored[_-]?key)/i;
const STORED_PROVIDER_RE = /stored (provider|credential|api key)/i;

export class ToolRegistrationError extends Error {
  readonly name = 'ToolRegistrationError';
}

export interface ToolRegistryOptions {
  policy?: PolicyEngine;
  tools?: AgentToolDefinition[];
  system?: SystemToolDependencies;
  read?: ReadToolDependencies;
  mutations?: MutationToolDependencies;
  coding?: CodingToolDependencies;
}

function freezeContext(context: ToolExecutionContext): ToolExecutionContext {
  const frozen: ToolExecutionContext = {
    runId: context.runId,
    turn: context.turn,
    executionEpoch: context.executionEpoch,
    mode: context.mode,
    workspaceScope: context.workspaceScope ? { ...context.workspaceScope } : undefined,
    contextRefs: context.contextRefs.map((ref) => ({ ...ref })),
    abortSignal: context.abortSignal,
    operationId: context.operationId,
    toolIndex: context.toolIndex,
    effectFingerprint: context.effectFingerprint,
  };
  return Object.freeze(frozen);
}

function exposesStoredProviderValues(tool: AgentToolDefinition): boolean {
  if (tool.risk === 'secret_access') return true;
  if (SECRET_NAME_RE.test(tool.name)) return true;
  if (STORED_PROVIDER_RE.test(tool.description)) return true;
  return false;
}

function resultBytes(result: AgentToolResult): number {
  return new TextEncoder().encode(JSON.stringify(result.data ?? result.summary)).byteLength;
}

function limitResult(result: AgentToolResult, maxResultBytes: number): AgentToolResult {
  if (resultBytes(result) <= maxResultBytes) return result;
  return {
    ok: result.ok,
    summary: result.summary,
    data: {
      truncated: true,
      maxResultBytes,
    },
    error: result.error,
    observedRevision: result.observedRevision,
    artifacts: result.artifacts,
    changes: result.changes,
  };
}

function timeoutResult(name: string): AgentToolResult {
  return {
    ok: false,
    summary: `Tool ${name} timed out`,
    error: { code: 'timeout', message: `Tool ${name} exceeded its timeout`, retryable: false },
  };
}

function cancelledResult(name: string): AgentToolResult {
  return {
    ok: false,
    summary: `Tool ${name} was cancelled`,
    error: { code: 'cancelled', message: `Tool ${name} was cancelled`, retryable: false },
  };
}

async function executeWithTimeout(
  tool: AgentToolDefinition,
  context: ToolExecutionContext,
  args: unknown,
): Promise<AgentToolResult> {
  if (context.abortSignal.aborted) return cancelledResult(tool.name);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<AgentToolResult>((resolve) => {
    timer = setTimeout(() => resolve(timeoutResult(tool.name)), tool.timeoutMs);
  });
  try {
    const executed = Promise.resolve(tool.execute(context, args)).then((result) => result as AgentToolResult);
    return await Promise.race([executed, timeout]);
  } catch (caught) {
    if (context.abortSignal.aborted) return cancelledResult(tool.name);
    const message = caught instanceof Error ? caught.message : 'Tool execution failed';
    return {
      ok: false,
      summary: message,
      error: { code: 'internal_error', message, retryable: false },
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class ToolRegistry {
  readonly policy: PolicyEngine;
  private readonly tools = new Map<string, AgentToolDefinition>();

  constructor(options: ToolRegistryOptions = {}) {
    this.policy = options.policy ?? new PolicyEngine();
    for (const tool of options.tools ?? []) this.register(tool);
  }

  static createDefault(options: ToolRegistryOptions = {}): ToolRegistry {
    const registry = new ToolRegistry({
      policy: options.policy,
      system: options.system,
    });
    for (const tool of createSystemTools(options.system)) registry.register(tool);
    for (const tool of createDocumentReadTools(options.read?.documents)) registry.register(tool);
    for (const tool of createTaskReadTools(options.read?.tasks)) registry.register(tool);
    for (const tool of createCrmReadTools(options.read?.crm)) registry.register(tool);
    for (const tool of createFormReadTools(options.read?.forms)) registry.register(tool);
    for (const tool of createDocumentMutationTools(options.mutations?.documents)) registry.register(tool);
    for (const tool of createTaskMutationTools(options.mutations?.tasks)) registry.register(tool);
    for (const tool of createCrmMutationTools(options.mutations?.crm)) registry.register(tool);
    for (const tool of createFileTools(options.coding?.files)) registry.register(tool);
    for (const tool of createShellTools(options.coding?.shell)) registry.register(tool);
    for (const tool of createWebTools(options.coding?.web)) registry.register(tool);
    for (const tool of options.tools ?? []) registry.register(tool);
    return registry;
  }

  register(tool: AgentToolDefinition): void {
    if (this.tools.has(tool.name)) {
      throw new ToolRegistrationError(`Tool ${tool.name} is already registered`);
    }
    if (exposesStoredProviderValues(tool)) {
      throw new ToolRegistrationError(
        `Refusing to register ${tool.name}: tools must not expose stored provider values`,
      );
    }
    if (!tool.version) {
      throw new ToolRegistrationError(`Tool ${tool.name} must declare a version`);
    }
    if (tool.timeoutMs <= 0) {
      throw new ToolRegistrationError(`Tool ${tool.name} must declare a positive timeout`);
    }
    if (tool.maxResultBytes <= 0 || tool.maxResultBytes > MAX_TOOL_RESULT_BYTES) {
      throw new ToolRegistrationError(`Tool ${tool.name} has an invalid result limit`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): AgentToolDefinition | undefined {
    return this.tools.get(name);
  }

  names(): string[] {
    return Array.from(this.tools.keys());
  }

  list(): AgentToolDefinition[] {
    return Array.from(this.tools.values());
  }

  get size(): number {
    return this.tools.size;
  }

  versionString(): string {
    return Array.from(this.tools.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, tool]) => `${name}@${tool.version}`)
      .join(';');
  }

  hash(): string {
    const value = this.versionString();
    let hash = 5381;
    for (let index = 0; index < value.length; index++) {
      hash = ((hash << 5) + hash + value.charCodeAt(index)) | 0;
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  /**
   * The only execution entry point. Policy must return allow before the
   * handler runs. Unknown fields, denials, and pending approvals never call
   * `execute`.
   */
  async invoke(
    context: ToolExecutionContext,
    name: string,
    rawArgs: unknown,
    options: { toolCallId?: string; run?: PolicyRunState } = {},
  ): Promise<{ result: AgentToolResult; decision: PolicyDecision }> {
    const tool = this.tools.get(name);
    if (!tool) {
      const missing: PolicyDecision = {
        outcome: 'deny',
        reason: `Unknown tool ${name}`,
        step: 'validate_args',
        errorCode: 'not_found',
      };
      return {
        decision: missing,
        result: {
          ok: false,
          summary: missing.reason,
          error: decisionError(missing),
        },
      };
    }

    const frozen = freezeContext(context);
    const run: PolicyRunState = options.run ?? {
      runId: frozen.runId,
      mode: frozen.mode,
      policyRevision: 1,
      workspaceScope: frozen.workspaceScope,
      contextRefs: frozen.contextRefs,
    };
    const decision = await this.policy.evaluate({
      run,
      tool,
      rawArgs,
      context: frozen,
      toolCallId: options.toolCallId,
    });

    if (decision.outcome !== 'allow') {
      return {
        decision,
        result: {
          ok: false,
          summary: decision.reason,
          error: decisionError(decision),
        },
      };
    }

    const result = await executeWithTimeout(tool, frozen, decision.normalizedArgs ?? rawArgs);
    return { decision, result: limitResult(result, tool.maxResultBytes) };
  }
}

export function createDefaultToolRegistry(options: ToolRegistryOptions = {}): ToolRegistry {
  return ToolRegistry.createDefault(options);
}
