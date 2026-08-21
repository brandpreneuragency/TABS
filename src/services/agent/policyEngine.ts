// ---------------------------------------------------------------------------
// TABS Work-OS Harness — Policy engine
// Every tool call is classified with this exact ten-step order. React, hooks,
// and Zustand stay outside this module. The model cannot supply resource
// patterns or grant constraints.
// ---------------------------------------------------------------------------

import type {
  AgentApproval,
  AgentApprovalStatus,
  AgentContextRef,
  AgentPolicyGrant,
  AgentToolDefinition,
  AgentToolErrorCode,
  ToolExecutionContext,
  ToolRiskClass,
  WorkspaceScopeSnapshot,
} from '../../types/agent';
import { generateId } from './helpers';
import { redactStructuredValue } from './redaction';

export const POLICY_ORDER = [
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
] as const;

export type PolicyOrderStep = (typeof POLICY_ORDER)[number];

export const GRANT_CONSTRAINT_NAMES = [
  'allowedFields',
  'parentResourceKeys',
  'pathPrefixes',
  'maxItems',
  'commandDigest',
  'workingDirectoryKey',
] as const;

export type GrantConstraintName = (typeof GRANT_CONSTRAINT_NAMES)[number];

export const NETWORK_ASK_ONCE_MAX_USES = 5;
export const DEFAULT_APPROVAL_TTL_MS = 60 * 60 * 1000;

const FORBIDDEN_MODEL_FIELDS = [
  'resourcePatterns',
  'argumentConstraints',
  'resourceRevisions',
  'maxUses',
  'grantConstraints',
  'commandDigest',
] as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type PolicyMode = 'read_only' | 'guided' | 'delegated';
export type PolicyOutcome = 'allow' | 'ask' | 'deny';

export interface GrantArgumentConstraints {
  allowedFields?: string[];
  parentResourceKeys?: string[];
  pathPrefixes?: string[];
  maxItems?: number;
  commandDigest?: string;
  workingDirectoryKey?: string;
}

export interface PolicyRunState {
  runId: string;
  mode: PolicyMode;
  policyRevision: number;
  workspaceScope?: WorkspaceScopeSnapshot;
  contextRefs: AgentContextRef[];
}

export interface AgentRunPlanStep {
  id: string;
  title: string;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked';
  toolGroups?: string[];
  resourceScope?: string[];
  expectedChanges?: string[];
  estimatedOperations?: number;
  note?: string;
}

export interface AgentRunPlan {
  id: string;
  runId: string;
  goal: string;
  steps: AgentRunPlanStep[];
  expectedChanges: string[];
  toolGroups: string[];
  resourceScope: string[];
  estimatedOperationCount: number;
  risks: string[];
  revision: string;
}

export interface PolicyDecision {
  outcome: PolicyOutcome;
  reason: string;
  step: PolicyOrderStep;
  errorCode?: AgentToolErrorCode;
  normalizedArgs?: Record<string, unknown>;
  resourceKeys?: string[];
  effectPayload?: unknown;
  approval?: AgentApproval;
  grant?: AgentPolicyGrant;
}

export type ResourceRevisionReader = (
  resourceKeys: string[],
) => Promise<Record<string, string>>;

export interface PolicyStore {
  addApproval(approval: AgentApproval): Promise<AgentApproval>;
  putApproval(approval: AgentApproval): Promise<AgentApproval>;
  getApproval(id: string): Promise<AgentApproval | undefined>;
  listApprovals(runId: string): Promise<AgentApproval[]>;
  addGrant(grant: AgentPolicyGrant): Promise<AgentPolicyGrant>;
  putGrant(grant: AgentPolicyGrant): Promise<AgentPolicyGrant>;
  getGrant(id: string): Promise<AgentPolicyGrant | undefined>;
  listGrants(runId: string): Promise<AgentPolicyGrant[]>;
  consumeGrant(grantId: string, currentTime: number): Promise<AgentPolicyGrant | undefined>;
  consumeGrantAndApproveTool(
    grantId: string,
    approvalId: string | undefined,
    currentTime: number,
  ): Promise<AgentPolicyGrant | undefined>;
}

type ModeAction = 'allow' | 'deny' | 'ask' | 'ask_once' | 'always_ask' | 'plan_scope' | 'run_scope' | 'command_grant';

const MODE_POLICY: Record<ToolRiskClass, Record<PolicyMode, ModeAction>> = {
  local_read: { read_only: 'allow', guided: 'allow', delegated: 'allow' },
  network_read: { read_only: 'ask_once', guided: 'ask_once', delegated: 'run_scope' },
  local_create: { read_only: 'deny', guided: 'ask', delegated: 'plan_scope' },
  local_update: { read_only: 'deny', guided: 'ask', delegated: 'plan_scope' },
  local_delete: { read_only: 'deny', guided: 'always_ask', delegated: 'always_ask' },
  process_execute: { read_only: 'deny', guided: 'always_ask', delegated: 'command_grant' },
  external_write: { read_only: 'deny', guided: 'always_ask', delegated: 'always_ask' },
  secret_access: { read_only: 'deny', guided: 'deny', delegated: 'deny' },
};

export interface JsonSchemaNode {
  type?: string | string[];
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  additionalProperties?: boolean | JsonSchemaNode;
  items?: JsonSchemaNode;
  enum?: unknown[];
  const?: unknown;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  minProperties?: number;
  oneOf?: JsonSchemaNode[];
  anyOf?: JsonSchemaNode[];
}

export function validateJsonSchema(
  schema: JsonSchemaNode | Record<string, unknown>,
  value: unknown,
  path = '$',
): string | undefined {
  const node = schema as JsonSchemaNode;
  if (node.oneOf && node.oneOf.length > 0) {
    const matches = node.oneOf.filter((option) => !validateJsonSchema(option, value, path));
    if (matches.length !== 1) return `${path} must match exactly one schema`;
    return undefined;
  }
  if (node.anyOf && node.anyOf.length > 0) {
    if (!node.anyOf.some((option) => !validateJsonSchema(option, value, path))) {
      return `${path} must match one of the allowed schemas`;
    }
    return undefined;
  }
  if (node.const !== undefined && value !== node.const) {
    return `${path} must equal the required constant`;
  }
  if (node.enum && !node.enum.some((entry) => Object.is(entry, value))) {
    return `${path} must be one of the allowed values`;
  }
  if (node.type) {
    const types = Array.isArray(node.type) ? node.type : [node.type];
    if (!types.some((type) => valueMatchesType(type, value))) {
      return `${path} must be of type ${types.join('|')}`;
    }
  }
  if (typeof value === 'string') {
    if (node.minLength !== undefined && value.length < node.minLength) {
      return `${path} is shorter than ${node.minLength}`;
    }
    if (node.maxLength !== undefined && value.length > node.maxLength) {
      return `${path} is longer than ${node.maxLength}`;
    }
  }
  if (typeof value === 'number') {
    if (node.minimum !== undefined && value < node.minimum) return `${path} is below ${node.minimum}`;
    if (node.maximum !== undefined && value > node.maximum) return `${path} is above ${node.maximum}`;
  }
  if (Array.isArray(value)) {
    if (node.minItems !== undefined && value.length < node.minItems) {
      return `${path} has fewer than ${node.minItems} items`;
    }
    if (node.maxItems !== undefined && value.length > node.maxItems) {
      return `${path} has more than ${node.maxItems} items`;
    }
    if (node.items) {
      for (let index = 0; index < value.length; index++) {
        const nested = validateJsonSchema(node.items, value[index], `${path}[${index}]`);
        if (nested) return nested;
      }
    }
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (node.minProperties !== undefined && keys.length < node.minProperties) {
      return `${path} must include at least ${node.minProperties} properties`;
    }
    for (const required of node.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(record, required)) {
        return `${path}.${required} is required`;
      }
    }
    const properties = node.properties ?? {};
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
        const nested = validateJsonSchema(properties[key], record[key], `${path}.${key}`);
        if (nested) return nested;
        continue;
      }
      if (node.additionalProperties === false) {
        return `${path}.${key} is not an allowed field`;
      }
      if (node.additionalProperties && typeof node.additionalProperties === 'object') {
        const nested = validateJsonSchema(node.additionalProperties, record[key], `${path}.${key}`);
        if (nested) return nested;
      }
    }
  }
  return undefined;
}

function valueMatchesType(type: string, value: unknown): boolean {
  switch (type) {
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return true;
  }
}

export function normalizeIdentifier(value: string): string {
  return value.trim();
}

export function normalizeDate(value: string): string {
  const trimmed = value.trim();
  if (!DATE_RE.test(trimmed)) {
    throw new Error(`Invalid date ${trimmed}`);
  }
  return trimmed;
}

export function normalizeCommand(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

export function normalizePath(value: string): string {
  const trimmed = value.trim().replace(/\\/g, '/');
  if (!trimmed) throw new Error('Path must be a non-empty relative path');
  if (trimmed.startsWith('/') || trimmed.startsWith('~/')) {
    throw new Error('Path must be a relative path without a root prefix');
  }
  const parts = trimmed.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error('Path must not contain empty, current, or parent segments');
  }
  return parts.join('/');
}

export function digestCommand(command: string, workingDirectoryKey: string): string {
  const payload = `${normalizeCommand(command)}|${workingDirectoryKey}`;
  let hash = 5381;
  for (let index = 0; index < payload.length; index++) {
    hash = ((hash << 5) + hash + payload.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function matchResourcePattern(resourceKey: string, pattern: string): boolean {
  const wildcard = pattern.indexOf('/**');
  if (wildcard !== -1 && wildcard !== pattern.length - 3) return false;
  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -3);
    if (!prefix) return false;
    return resourceKey === prefix
      || resourceKey.startsWith(`${prefix}/`)
      || resourceKey.startsWith(`${prefix}:`);
  }
  return resourceKey === pattern;
}

export function revalidateResourceRevisions(
  expected: Record<string, string>,
  live: Record<string, string>,
): { ok: true } | { ok: false; mismatchedKeys: string[] } {
  const mismatchedKeys = Object.keys(expected).filter((key) => live[key] !== expected[key]);
  if (mismatchedKeys.length === 0) return { ok: true };
  return { ok: false, mismatchedKeys };
}

/** Domain commands call this inside their mutation transaction before applying effects. */
export function assertResourceRevisionsMatch(
  expected: Record<string, string>,
  live: Record<string, string>,
): void {
  const result = revalidateResourceRevisions(expected, live);
  if (result.ok === false) {
    const error = new Error(`Resource revision changed: ${result.mismatchedKeys.join(', ')}`);
    (error as Error & { code: AgentToolErrorCode }).code = 'stale_revision';
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function djb2(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index++) {
    hash = ((hash << 5) + hash + value.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function asConstraints(value: Record<string, unknown> | undefined): GrantArgumentConstraints {
  if (!value) return {};
  const constraints: GrantArgumentConstraints = {};
  if (Array.isArray(value.allowedFields)) {
    constraints.allowedFields = value.allowedFields.filter((entry): entry is string => typeof entry === 'string');
  }
  if (Array.isArray(value.parentResourceKeys)) {
    constraints.parentResourceKeys = value.parentResourceKeys.filter((entry): entry is string => typeof entry === 'string');
  }
  if (Array.isArray(value.pathPrefixes)) {
    constraints.pathPrefixes = value.pathPrefixes.filter((entry): entry is string => typeof entry === 'string');
  }
  if (typeof value.maxItems === 'number') constraints.maxItems = value.maxItems;
  if (typeof value.commandDigest === 'string') constraints.commandDigest = value.commandDigest;
  if (typeof value.workingDirectoryKey === 'string') {
    constraints.workingDirectoryKey = value.workingDirectoryKey;
  }
  return constraints;
}

function pathFromArgs(args: Record<string, unknown>): string | undefined {
  if (typeof args.path === 'string') return args.path;
  if (typeof args.relativePath === 'string') return args.relativePath;
  return undefined;
}

function itemCountFromArgs(args: Record<string, unknown>): number | undefined {
  if (Array.isArray(args.items)) return args.items.length;
  if (Array.isArray(args.values)) return args.values.length;
  if (typeof args.limit === 'number') return args.limit;
  if (typeof args.maxResults === 'number') return args.maxResults;
  return undefined;
}

export function grantConstraintsMatch(
  grant: AgentPolicyGrant,
  args: Record<string, unknown>,
  resourceKeys: string[],
): boolean {
  const constraints = asConstraints(grant.argumentConstraints);
  if (constraints.allowedFields) {
    const updates = isRecord(args.updates) ? args.updates : undefined;
    if (updates) {
      const allowed = new Set(constraints.allowedFields);
      if (Object.keys(updates).some((field) => !allowed.has(field))) return false;
    }
  }
  if (constraints.parentResourceKeys) {
    const ok = constraints.parentResourceKeys.every((parent) => (
      resourceKeys.includes(parent)
      || resourceKeys.some((key) => matchResourcePattern(key, `${parent}/**`))
    ));
    if (!ok) return false;
  }
  if (constraints.pathPrefixes && constraints.pathPrefixes.length > 0) {
    const path = pathFromArgs(args);
    if (typeof path !== 'string') return false;
    const matches = constraints.pathPrefixes.some((prefix) => (
      path === prefix || path.startsWith(`${prefix}/`)
    ));
    if (!matches) return false;
  }
  if (constraints.maxItems !== undefined) {
    const count = itemCountFromArgs(args);
    if (count !== undefined && count > constraints.maxItems) return false;
  }
  const expectedDigest = constraints.commandDigest ?? grant.commandDigest;
  if (expectedDigest) {
    if (typeof args.command !== 'string' || typeof args.workingDirectoryKey !== 'string') return false;
    if (digestCommand(args.command, args.workingDirectoryKey) !== expectedDigest) return false;
  }
  if (constraints.workingDirectoryKey) {
    if (args.workingDirectoryKey !== constraints.workingDirectoryKey) return false;
  }
  return true;
}

function resourcesMatchGrant(resourceKeys: string[], patterns: string[]): boolean {
  if (resourceKeys.length === 0) return patterns.length === 0;
  return resourceKeys.every((key) => patterns.some((pattern) => matchResourcePattern(key, pattern)));
}

export class MemoryPolicyStore implements PolicyStore {
  readonly approvals = new Map<string, AgentApproval>();
  readonly grants = new Map<string, AgentPolicyGrant>();

  async addApproval(approval: AgentApproval): Promise<AgentApproval> {
    const stored = clone(approval);
    this.approvals.set(stored.id, stored);
    return clone(stored);
  }

  async putApproval(approval: AgentApproval): Promise<AgentApproval> {
    return this.addApproval(approval);
  }

  async getApproval(id: string): Promise<AgentApproval | undefined> {
    const approval = this.approvals.get(id);
    return approval ? clone(approval) : undefined;
  }

  async listApprovals(runId: string): Promise<AgentApproval[]> {
    return Array.from(this.approvals.values())
      .filter((approval) => approval.runId === runId)
      .map((approval) => clone(approval));
  }

  async addGrant(grant: AgentPolicyGrant): Promise<AgentPolicyGrant> {
    const stored = clone(grant);
    this.grants.set(stored.id, stored);
    return clone(stored);
  }

  async putGrant(grant: AgentPolicyGrant): Promise<AgentPolicyGrant> {
    return this.addGrant(grant);
  }

  async getGrant(id: string): Promise<AgentPolicyGrant | undefined> {
    const grant = this.grants.get(id);
    return grant ? clone(grant) : undefined;
  }

  async listGrants(runId: string): Promise<AgentPolicyGrant[]> {
    return Array.from(this.grants.values())
      .filter((grant) => grant.runId === runId)
      .map((grant) => clone(grant));
  }

  async consumeGrant(grantId: string, currentTime: number): Promise<AgentPolicyGrant | undefined> {
    const grant = this.grants.get(grantId);
    if (!grant || grant.expiresAt <= currentTime || grant.usedCount >= grant.maxUses) return undefined;
    const updated = { ...grant, usedCount: grant.usedCount + 1 };
    this.grants.set(grantId, updated);
    return clone(updated);
  }

  async consumeGrantAndApproveTool(
    grantId: string,
    approvalId: string | undefined,
    currentTime: number,
  ): Promise<AgentPolicyGrant | undefined> {
    const consumed = await this.consumeGrant(grantId, currentTime);
    if (!consumed) return undefined;
    if (approvalId) {
      const approval = this.approvals.get(approvalId);
      if (approval && approval.status === 'pending') {
        this.approvals.set(approvalId, {
          ...approval,
          status: 'approved',
          decidedAt: currentTime,
        });
      }
    }
    return consumed;
  }

  snapshot(): { approvals: AgentApproval[]; grants: AgentPolicyGrant[] } {
    return {
      approvals: Array.from(this.approvals.values()).map((approval) => clone(approval)),
      grants: Array.from(this.grants.values()).map((grant) => clone(grant)),
    };
  }

  static fromSnapshot(snapshot: { approvals: AgentApproval[]; grants: AgentPolicyGrant[] }): MemoryPolicyStore {
    const store = new MemoryPolicyStore();
    for (const approval of snapshot.approvals) store.approvals.set(approval.id, clone(approval));
    for (const grant of snapshot.grants) store.grants.set(grant.id, clone(grant));
    return store;
  }
}

export interface PolicyEngineOptions {
  store?: PolicyStore;
  now?: () => number;
  createId?: () => string;
  readRevisions?: ResourceRevisionReader;
  approvalTtlMs?: number;
}

export interface EvaluateToolRequest {
  run: PolicyRunState;
  tool: AgentToolDefinition;
  rawArgs: unknown;
  context: ToolExecutionContext;
  toolCallId?: string;
}

function deny(
  reason: string,
  step: PolicyOrderStep,
  errorCode: AgentToolErrorCode = 'permission_denied',
): PolicyDecision {
  return { outcome: 'deny', reason, step, errorCode };
}

export class PolicyEngine {
  readonly store: PolicyStore;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly readRevisions: ResourceRevisionReader;
  private readonly approvalTtlMs: number;

  constructor(options: PolicyEngineOptions = {}) {
    this.store = options.store ?? new MemoryPolicyStore();
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? generateId;
    this.readRevisions = options.readRevisions ?? (async (keys) => (
      Object.fromEntries(keys.map((key) => [key, 'absent']))
    ));
    this.approvalTtlMs = options.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS;
  }

  async evaluate(request: EvaluateToolRequest): Promise<PolicyDecision> {
    const { run, tool, rawArgs, context, toolCallId } = request;

    const validated = this.validateArgs(tool, rawArgs);
    if (validated.ok === false) {
      return deny(validated.reason, 'validate_args', 'validation_failed');
    }

    let normalizedArgs: Record<string, unknown>;
    try {
      normalizedArgs = this.normalizeArgs(tool, validated.value);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Argument normalization failed';
      return deny(message, 'normalize', 'validation_failed');
    }

    const resourceKeys = tool.resolveResourceKeys(context, normalizedArgs);
    const effectPayload = tool.buildEffectPayload(normalizedArgs);
    const action = MODE_POLICY[tool.risk][run.mode];

    if (action === 'deny') {
      return deny(
        `${tool.risk} is denied in ${run.mode} mode`,
        'apply_mode_deny_rules',
        tool.risk === 'secret_access' ? 'permission_denied' : 'permission_denied',
      );
    }

    if (action === 'allow') {
      return {
        outcome: 'allow',
        reason: `${tool.risk} is allowed in ${run.mode} mode`,
        step: 'return_allow_ask_or_deny',
        normalizedArgs,
        resourceKeys,
        effectPayload,
      };
    }

    const rejected = await this.findResolvedApproval(run.runId, toolCallId, 'rejected');
    if (rejected) {
      return deny('Approval was rejected', 'return_allow_ask_or_deny', 'approval_rejected');
    }

    const grant = await this.findMatchingGrant(run, tool, normalizedArgs, resourceKeys);
    if (grant) {
      const live = await this.readRevisions(Object.keys(grant.resourceRevisions));
      const revisionCheck = revalidateResourceRevisions(grant.resourceRevisions, live);
      if (revisionCheck.ok === false) {
        await this.expireGrant(grant.id);
        await this.expireRelatedApprovals(run.runId, grant);
        return this.requestApproval({
          run,
          tool,
          toolCallId,
          args: normalizedArgs,
          resourceKeys,
          effectPayload,
          reason: `Resource revision changed: ${revisionCheck.mismatchedKeys.join(', ')}`,
          errorCode: 'stale_revision',
        });
      }
      if (!tool.validateGrant(grant, normalizedArgs)) {
        return this.requestApproval({
          run,
          tool,
          toolCallId,
          args: normalizedArgs,
          resourceKeys,
          effectPayload,
          reason: 'Tool-specific grant validation failed',
        });
      }
      const pending = await this.findPendingApproval(run.runId, toolCallId);
      const consumed = await this.store.consumeGrantAndApproveTool(
        grant.id,
        pending?.id,
        this.now(),
      );
      if (!consumed) {
        return deny('Grant could not be consumed', 'consume_use_with_approval');
      }
      return {
        outcome: 'allow',
        reason: 'Grant matched and one use was consumed',
        step: 'return_allow_ask_or_deny',
        normalizedArgs,
        resourceKeys,
        effectPayload,
        grant: consumed,
        approval: pending ? { ...pending, status: 'approved', decidedAt: this.now() } : undefined,
      };
    }

    return this.requestApproval({
      run,
      tool,
      toolCallId,
      args: normalizedArgs,
      resourceKeys,
      effectPayload,
      reason: this.askReason(action, tool),
    });
  }

  async answerApproval(
    approvalId: string,
    status: Extract<AgentApprovalStatus, 'approved' | 'rejected' | 'cancelled'>,
    catalog: AgentToolDefinition[] = [],
  ): Promise<AgentApproval> {
    const approval = await this.store.getApproval(approvalId);
    if (!approval) throw new Error(`Approval ${approvalId} was not found.`);
    if (approval.status !== 'pending') throw new Error(`Approval ${approvalId} is already resolved.`);
    const decidedAt = this.now();
    if (approval.expiresAt <= decidedAt) {
      const expired = { ...approval, status: 'expired' as const, decidedAt };
      await this.store.putApproval(expired);
      return expired;
    }
    if (status !== 'approved') {
      const updated = { ...approval, status, decidedAt };
      await this.store.putApproval(updated);
      return updated;
    }

    const live = await this.readRevisions(Object.keys(approval.resourceRevisions));
    const revisionCheck = revalidateResourceRevisions(approval.resourceRevisions, live);
    if (revisionCheck.ok === false) {
      const expired = { ...approval, status: 'expired' as const, decidedAt };
      await this.store.putApproval(expired);
      return expired;
    }

    const updated = { ...approval, status, decidedAt };
    await this.store.putApproval(updated);
    const tool = catalog.find((entry) => entry.name === approval.toolName);
    await this.createGrantFromApproval(updated, tool);
    return updated;
  }

  async approvePlan(input: {
    run: PolicyRunState;
    plan: AgentRunPlan;
    tools: AgentToolDefinition[];
  }): Promise<{ approval: AgentApproval; grants: AgentPolicyGrant[] }> {
    const { run, plan, tools } = input;
    const resourceKeys = [...plan.resourceScope];
    const resourceRevisions = await this.readRevisions(resourceKeys);
    const approval: AgentApproval = {
      id: this.createId(),
      runId: run.runId,
      planId: plan.id,
      policyRevision: run.policyRevision,
      risk: 'local_create',
      resourceKeys,
      resourceRevisions,
      redactedArgs: redactStructuredValue({
        goal: plan.goal,
        toolGroups: plan.toolGroups,
        resourceScope: plan.resourceScope,
        estimatedOperationCount: plan.estimatedOperationCount,
      }),
      status: 'pending',
      requestedAt: this.now(),
      expiresAt: this.now() + this.approvalTtlMs,
    };
    await this.store.addApproval(approval);
    const decided: AgentApproval = { ...approval, status: 'approved', decidedAt: this.now() };
    await this.store.putApproval(decided);
    const grants = compilePlanGrants({
      run,
      plan,
      tools,
      now: this.now(),
      createId: this.createId,
      expiresAt: this.now() + this.approvalTtlMs,
      resourceRevisions,
    });
    for (const grant of grants) await this.store.addGrant(grant);
    return { approval: decided, grants };
  }

  async cancelPendingApprovals(runId: string): Promise<number> {
    const pending = (await this.store.listApprovals(runId)).filter((approval) => approval.status === 'pending');
    const decidedAt = this.now();
    for (const approval of pending) {
      await this.store.putApproval({ ...approval, status: 'cancelled', decidedAt });
    }
    return pending.length;
  }

  private validateArgs(
    tool: AgentToolDefinition,
    rawArgs: unknown,
  ): { ok: true; value: Record<string, unknown> } | { ok: false; reason: string } {
    if (!isRecord(rawArgs)) {
      return { ok: false, reason: 'Tool arguments must be a JSON object' };
    }
    for (const field of FORBIDDEN_MODEL_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(rawArgs, field)) {
        return { ok: false, reason: `Model cannot supply ${field}` };
      }
    }
    const schemaError = validateJsonSchema(tool.inputSchema, rawArgs);
    if (schemaError) return { ok: false, reason: schemaError };
    return { ok: true, value: rawArgs };
  }

  private normalizeArgs(
    tool: AgentToolDefinition,
    rawArgs: Record<string, unknown>,
  ): Record<string, unknown> {
    const generic = normalizeValue(rawArgs, { pathKeys: new Set(['path', 'relativePath']) }) as Record<string, unknown>;
    const normalized = tool.normalizeArgs(generic);
    if (!isRecord(normalized)) {
      throw new Error('normalizeArgs must return an object');
    }
    return normalized;
  }

  private async findMatchingGrant(
    run: PolicyRunState,
    tool: AgentToolDefinition,
    args: Record<string, unknown>,
    resourceKeys: string[],
  ): Promise<AgentPolicyGrant | undefined> {
    const currentTime = this.now();
    const grants = await this.store.listGrants(run.runId);
    return grants.find((grant) => (
      grant.toolName === tool.name
      && grant.toolVersion === tool.version
      && grant.policyRevision === run.policyRevision
      && grant.expiresAt > currentTime
      && grant.usedCount < grant.maxUses
      && resourcesMatchGrant(resourceKeys, grant.resourcePatterns)
      && grantConstraintsMatch(grant, args, resourceKeys)
    ));
  }

  private async findPendingApproval(runId: string, toolCallId?: string): Promise<AgentApproval | undefined> {
    if (!toolCallId) return undefined;
    const approvals = await this.store.listApprovals(runId);
    return approvals.find((approval) => (
      approval.status === 'pending'
      && approval.toolCallId === toolCallId
      && approval.expiresAt > this.now()
    ));
  }

  private async findResolvedApproval(
    runId: string,
    toolCallId: string | undefined,
    status: AgentApprovalStatus,
  ): Promise<AgentApproval | undefined> {
    if (!toolCallId) return undefined;
    const approvals = await this.store.listApprovals(runId);
    return approvals.find((approval) => approval.toolCallId === toolCallId && approval.status === status);
  }

  private async requestApproval(input: {
    run: PolicyRunState;
    tool: AgentToolDefinition;
    toolCallId?: string;
    args: Record<string, unknown>;
    resourceKeys: string[];
    effectPayload: unknown;
    reason: string;
    errorCode?: AgentToolErrorCode;
  }): Promise<PolicyDecision> {
    const existing = await this.findPendingApproval(input.run.runId, input.toolCallId);
    if (existing) {
      return {
        outcome: 'ask',
        reason: input.reason,
        step: 'return_allow_ask_or_deny',
        errorCode: input.errorCode ?? 'permission_denied',
        normalizedArgs: input.args,
        resourceKeys: input.resourceKeys,
        effectPayload: input.effectPayload,
        approval: existing,
      };
    }
    const revisionKeys = [...input.resourceKeys];
    if (input.tool.risk === 'local_create') {
      for (const key of input.resourceKeys) {
        const parent = parentResourceKey(key);
        if (parent) revisionKeys.push(parent);
      }
    }
    const uniqueKeys = Array.from(new Set(revisionKeys));
    const resourceRevisions = await this.readRevisions(uniqueKeys);
    const approval: AgentApproval = {
      id: this.createId(),
      runId: input.run.runId,
      toolCallId: input.toolCallId,
      policyRevision: input.run.policyRevision,
      risk: input.tool.risk,
      toolName: input.tool.name,
      resourceKeys: input.resourceKeys,
      resourceRevisions,
      redactedArgs: redactStructuredValue(input.args),
      status: 'pending',
      requestedAt: this.now(),
      expiresAt: this.now() + this.approvalTtlMs,
    };
    await this.store.addApproval(approval);
    return {
      outcome: 'ask',
      reason: input.reason,
      step: 'return_allow_ask_or_deny',
      errorCode: input.errorCode ?? 'permission_denied',
      normalizedArgs: input.args,
      resourceKeys: input.resourceKeys,
      effectPayload: input.effectPayload,
      approval,
    };
  }

  private async createGrantFromApproval(
    approval: AgentApproval,
    tool: AgentToolDefinition | undefined,
  ): Promise<AgentPolicyGrant | undefined> {
    if (!tool || !approval.toolName) return undefined;
    const args = isRecord(approval.redactedArgs) ? approval.redactedArgs : {};
    const constraints: GrantArgumentConstraints = {};
    if (typeof args.workingDirectoryKey === 'string') {
      constraints.workingDirectoryKey = args.workingDirectoryKey;
    }
    if (typeof args.command === 'string' && typeof args.workingDirectoryKey === 'string') {
      constraints.commandDigest = digestCommand(args.command, args.workingDirectoryKey);
    }
    const path = pathFromArgs(args);
    if (path) constraints.pathPrefixes = [path.split('/').slice(0, -1).join('/') || path];
    const maxUses = grantMaxUses(tool.risk);
    const grant: AgentPolicyGrant = {
      id: this.createId(),
      runId: approval.runId,
      policyRevision: approval.policyRevision,
      toolName: tool.name,
      toolVersion: tool.version,
      resourcePatterns: toGrantPatterns(approval.resourceKeys),
      argumentConstraints: { ...constraints },
      resourceRevisions: approval.resourceRevisions,
      commandDigest: constraints.commandDigest,
      maxUses,
      usedCount: 0,
      expiresAt: approval.expiresAt,
    };
    await this.store.addGrant(grant);
    return grant;
  }

  private async expireGrant(grantId: string): Promise<void> {
    const grant = await this.store.getGrant(grantId);
    if (!grant) return;
    await this.store.putGrant({ ...grant, expiresAt: this.now(), usedCount: grant.maxUses });
  }

  private async expireRelatedApprovals(runId: string, grant: AgentPolicyGrant): Promise<void> {
    const approvals = await this.store.listApprovals(runId);
    const decidedAt = this.now();
    for (const approval of approvals) {
      if (approval.status !== 'pending') continue;
      if (approval.toolName !== grant.toolName) continue;
      await this.store.putApproval({ ...approval, status: 'expired', decidedAt });
    }
  }

  private askReason(action: ModeAction, tool: AgentToolDefinition): string {
    switch (action) {
      case 'always_ask':
        return `${tool.risk} always requires a fresh approval`;
      case 'ask_once':
        return `${tool.name} requires a one-time network grant`;
      case 'plan_scope':
        return `${tool.name} is outside the approved plan envelope`;
      case 'run_scope':
        return `${tool.name} requires an approved run-scoped network grant`;
      case 'command_grant':
        return `${tool.name} requires a one-use command digest grant`;
      default:
        return `${tool.name} requires approval`;
    }
  }
}

function grantMaxUses(risk: ToolRiskClass): number {
  if (risk === 'network_read') return NETWORK_ASK_ONCE_MAX_USES;
  return 1;
}

function toGrantPatterns(resourceKeys: string[]): string[] {
  return resourceKeys.map((key) => key);
}

function parentResourceKey(resourceKey: string): string | undefined {
  const slash = resourceKey.lastIndexOf('/');
  if (slash > 0) return resourceKey.slice(0, slash);
  const colon = resourceKey.lastIndexOf(':');
  if (colon > 0) return resourceKey.slice(0, colon);
  return undefined;
}

function normalizeValue(value: unknown, options: { pathKeys: Set<string>; key?: string }): unknown {
  if (typeof value === 'string') {
    if (options.key && options.pathKeys.has(options.key)) return normalizePath(value);
    if (options.key === 'command') return normalizeCommand(value);
    if (options.key && (options.key.endsWith('Id') || options.key === 'id' || options.key.endsWith('Key'))) {
      return normalizeIdentifier(value);
    }
    if (options.key && (options.key === 'date' || options.key.endsWith('Date'))) return normalizeDate(value);
    return value.trim();
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeValue(entry, { pathKeys: options.pathKeys, key: options.key }));
  }
  if (isRecord(value)) {
    const next: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      next[key] = normalizeValue(nested, { pathKeys: options.pathKeys, key });
    }
    return next;
  }
  return value;
}

export function compilePlanGrants(input: {
  run: PolicyRunState;
  plan: AgentRunPlan;
  tools: AgentToolDefinition[];
  now: number;
  createId: () => string;
  expiresAt: number;
  resourceRevisions: Record<string, string>;
}): AgentPolicyGrant[] {
  const names = new Set(input.plan.toolGroups);
  const selected = input.tools.filter((tool) => (
    names.has(tool.name) || input.plan.toolGroups.some((group) => tool.name === group || tool.name.startsWith(`${group}_`))
  ));
  const maxUses = Math.max(1, input.plan.estimatedOperationCount);
  return selected
    .filter((tool) => tool.risk !== 'local_read' && tool.risk !== 'secret_access')
    .map((tool) => ({
      id: input.createId(),
      runId: input.run.runId,
      policyRevision: input.run.policyRevision,
      toolName: tool.name,
      toolVersion: tool.version,
      resourcePatterns: [...input.plan.resourceScope],
      argumentConstraints: {},
      resourceRevisions: input.resourceRevisions,
      maxUses,
      usedCount: 0,
      expiresAt: input.expiresAt,
    }));
}

export function decisionError(decision: PolicyDecision): { code: AgentToolErrorCode; message: string; retryable: boolean } {
  return {
    code: decision.errorCode ?? 'permission_denied',
    message: decision.reason,
    retryable: false,
  };
}

export function planRevisionHash(plan: Omit<AgentRunPlan, 'revision' | 'id'> & { id?: string }): string {
  return djb2(JSON.stringify({
    goal: plan.goal,
    steps: plan.steps,
    expectedChanges: plan.expectedChanges,
    toolGroups: plan.toolGroups,
    resourceScope: plan.resourceScope,
    estimatedOperationCount: plan.estimatedOperationCount,
  }));
}
