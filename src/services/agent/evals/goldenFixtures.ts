// ---------------------------------------------------------------------------
// TABS Work-OS Harness — Deterministic golden-workflow fixtures
// Scripted fake provider, isolated domain world, and restart-fault injection.
// Fake data only. Never send production records to a provider.
// ---------------------------------------------------------------------------

import type {
  AgentMessage,
  AgentRun,
  AgentToolCall,
  AgentToolDefinition,
  WorkspaceScopeSnapshot,
} from '../../../types/agent';
import type { Task, TaskComment } from '../../../types';
import type {
  CRMActivity,
  CRMCompany,
  CRMContact,
  CRMLead,
  CRMNote,
  CRMTaskLink,
} from '../../../types/crm';
import type { LeadForm, LeadFormSubmission } from '../../../types/forms';
import type {
  AddTaskCommentInput,
  CreateSubtaskInput,
  CreateTaskInput,
  SoftDeleteTaskInput,
  TaskCommandResult,
  UpdateTaskInput,
} from '../../tasks/taskService';
import type {
  DocumentCreateArgs,
  DocumentMutationResult,
} from '../../documents/documentCommands';
import { AgentRuntime } from '../agentRuntime';
import {
  MemoryPolicyStore,
  PolicyEngine,
  type AgentRunPlan,
  type PolicyRunState,
} from '../policyEngine';
import {
  PROVIDER_ADAPTER_KIND,
  PROVIDER_ADAPTER_VERSION,
  ProviderError,
  completeWithRetries,
  estimateInputTokens,
  freezeProviderSnapshot,
  type OpenAIProtocolToolCall,
  type ProviderAdapter,
  type ProviderAttemptFn,
  type ProviderCompletionRequest,
  type ProviderCompletionResult,
  type ProviderRetryHooks,
} from '../providers/providerAdapter';
import { containsSecret, redactSecrets, redactStructuredValue } from '../redaction';
import {
  createMemoryExecutorStore,
  type ExecutorPersistence,
  type MemoryExecutorStore,
} from '../runExecutor';
import { ToolRegistry } from '../toolRegistry';
import type { CRMEntityBundle, CRMMutationPort, CRMReadPort, CRMSearchHit } from '../tools/crmTools';
import type { DocumentMutationPort } from '../tools/documentTools';
import type { FormReadPort } from '../tools/formTools';
import { MemoryReceiptStore } from '../tools/mutationSupport';
import type { TaskMutationPort } from '../tools/taskTools';

export const FAKE_SECRET = 'sk-testevalfixturekeynotreal0000001';

export const EXPECTED_MUTATIONS = [
  'crm_entity_update',
  'crm_note_add',
  'task_create',
  'crm_task_link_create',
  'document_create',
] as const;

export type ExpectedMutation = (typeof EXPECTED_MUTATIONS)[number];

export const FAULT_POINTS = [
  'before_provider_request',
  'during_provider_stream',
  'after_tool_request_persistence',
  'before_tool_execution',
  'after_mutation_commit',
  'before_tool_result_persistence',
  'after_tool_result_persistence',
  'before_next_provider_request',
  'after_crm_update',
  'after_task_create',
] as const;

export type FaultPoint = (typeof FAULT_POINTS)[number];

export const WORKSPACE: WorkspaceScopeSnapshot = {
  workspaceId: 'workspace-1',
  rootPath: '/eval/workspace',
  rootRevision: 'rev-1',
  nativeScopeId: 'native-scope-eval',
};

export class RestartSignal extends Error {
  readonly point: FaultPoint;

  constructor(point: FaultPoint) {
    super(`Injected restart at ${point}`);
    this.name = 'RestartSignal';
    this.point = point;
  }
}

export interface MutationCounts {
  crm_entity_update: number;
  crm_note_add: number;
  task_create: number;
  crm_task_link_create: number;
  document_create: number;
}

export interface RedactionSinks {
  providerBodies: unknown[];
  events: unknown[];
  messages: unknown[];
  toolResults: unknown[];
  artifacts: unknown[];
  logger: unknown[];
  uiErrors: unknown[];
}

export interface GoldenWorld {
  form: LeadForm;
  submission: LeadFormSubmission;
  contact: CRMContact;
  company: CRMCompany;
  lead: CRMLead;
  notes: CRMNote[];
  tasks: Task[];
  taskLinks: CRMTaskLink[];
  documents: Array<{ id: string; title: string; content: string }>;
  counts: MutationCounts;
  gotSubmission: boolean;
  gotForm: boolean;
  gotCrm: boolean;
  duplicateDelivered: boolean;
  issuedMutations: boolean;
  faultPoint?: FaultPoint;
  faultFired: boolean;
  providerRequests: number;
  receipts: MemoryReceiptStore;
}

function iso(stamp = '2026-08-20T12:00:00.000Z'): string {
  return stamp;
}

function emptyCounts(): MutationCounts {
  return {
    crm_entity_update: 0,
    crm_note_add: 0,
    task_create: 0,
    crm_task_link_create: 0,
    document_create: 0,
  };
}

export function resetGoldenFixture(status: LeadFormSubmission['status'] = 'new'): GoldenWorld {
  const form: LeadForm = {
    id: 'form-follow-up',
    name: 'Contact us',
    status: 'published',
    fields: [
      { id: 'field-name', type: 'text', label: 'Name', name: 'name', order: 0, required: true },
      { id: 'field-email', type: 'email', label: 'Email', name: 'email', order: 1, required: true },
      { id: 'field-company', type: 'text', label: 'Company', name: 'company', order: 2 },
    ],
    steps: [{ id: 'step-1', title: 'Details', order: 0 }],
    logicRules: [],
    style: {},
    embed: { allowedDomains: ['example.test'], defaultMode: 'iframe' },
    successMessage: 'Thanks',
    createdAt: iso(),
    updatedAt: iso(),
  };
  const contact: CRMContact = {
    id: 'contact-ada',
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'ada@example.test',
    companyId: 'company-ae',
    tags: ['inbound'],
    createdAt: iso(),
    updatedAt: iso(),
  };
  const company: CRMCompany = {
    id: 'company-ae',
    name: 'Analytical Engines',
    tags: [],
    createdAt: iso(),
    updatedAt: iso(),
  };
  const lead: CRMLead = {
    id: 'lead-inquiry',
    title: 'Website inquiry',
    contactId: contact.id,
    companyId: company.id,
    status: 'new',
    stage: 'new',
    tags: [],
    sourceFormId: form.id,
    sourceSubmissionId: 'sub-follow-up',
    createdAt: iso(),
    updatedAt: iso(),
  };
  const submission: LeadFormSubmission = {
    id: 'sub-follow-up',
    formId: form.id,
    status,
    fields: {
      name: 'Ada Lovelace',
      email: 'ada@example.test',
      company: 'Analytical Engines',
    },
    hiddenFields: {},
    spamScore: status === 'spam' ? 95 : 4,
    allowedDomainMatched: true,
    leadId: lead.id,
    contactId: contact.id,
    companyId: company.id,
    createdAt: iso(),
  };
  return {
    form,
    submission,
    contact,
    company,
    lead,
    notes: [],
    tasks: [],
    taskLinks: [],
    documents: [],
    counts: emptyCounts(),
    gotSubmission: false,
    gotForm: false,
    gotCrm: false,
    duplicateDelivered: false,
    issuedMutations: false,
    faultFired: false,
    providerRequests: 0,
    receipts: new MemoryReceiptStore(),
  };
}

export function emptySinks(): RedactionSinks {
  return {
    providerBodies: [],
    events: [],
    messages: [],
    toolResults: [],
    artifacts: [],
    logger: [],
    uiErrors: [],
  };
}

export function evalLogger(sinks: RedactionSinks, message: string): void {
  sinks.logger.push(redactSecrets(message));
}

export function formatUiError(sinks: RedactionSinks, error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const redacted = redactSecrets(raw);
  sinks.uiErrors.push(redacted);
  return redacted;
}

export function putEvalArtifact(sinks: RedactionSinks, content: string, label = 'eval-artifact'): void {
  sinks.artifacts.push({
    label,
    content: redactSecrets(content),
  });
}

export function assertNoSecret(value: unknown): void {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  if (serialized.includes(FAKE_SECRET) || containsSecret(serialized) && serialized.includes('sk-testeval')) {
    throw new Error(`Secret fixture leaked into a sink: ${serialized.slice(0, 180)}`);
  }
}

function fireFault(world: GoldenWorld, point: FaultPoint): void {
  if (world.faultPoint !== point || world.faultFired) return;
  world.faultFired = true;
  throw new RestartSignal(point);
}

function bumpStamp(value: string): string {
  const time = Date.parse(value);
  return new Date((Number.isFinite(time) ? time : Date.parse(iso())) + 1_000).toISOString();
}

function replayByOperation<T>(
  byOperation: Map<string, T>,
  byEffect: Map<string, T>,
  operationId: string,
  effectFingerprint: string,
): T | undefined {
  const prior = byOperation.get(operationId);
  if (prior) return prior;
  return byEffect.get(effectFingerprint);
}

function remember<T>(
  byOperation: Map<string, T>,
  byEffect: Map<string, T>,
  operationId: string,
  effectFingerprint: string,
  value: T,
): T {
  byOperation.set(operationId, value);
  if (!byEffect.has(effectFingerprint)) byEffect.set(effectFingerprint, value);
  return value;
}

export function createCrmPorts(world: GoldenWorld): { read: CRMReadPort; mutations: CRMMutationPort } {
  const byOperation = new Map<string, CRMContact | CRMCompany | CRMLead | CRMNote | CRMTaskLink>();
  const byEffect = new Map<string, CRMContact | CRMCompany | CRMLead | CRMNote | CRMTaskLink>();

  const read: CRMReadPort = {
    async search(query, entityTypes) {
      const types = entityTypes && entityTypes.length > 0 ? entityTypes : ['lead', 'contact', 'company', 'deal'] as const;
      const needle = query.trim().toLowerCase();
      const hits: CRMSearchHit[] = [];
      if (types.includes('contact') && `${world.contact.firstName} ${world.contact.lastName} ${world.contact.email}`.toLowerCase().includes(needle)) {
        hits.push({ entityType: 'contact', id: world.contact.id, title: `${world.contact.firstName} ${world.contact.lastName}`, revision: world.contact.updatedAt });
      }
      if (types.includes('company') && world.company.name.toLowerCase().includes(needle)) {
        hits.push({ entityType: 'company', id: world.company.id, title: world.company.name, revision: world.company.updatedAt });
      }
      if (types.includes('lead') && world.lead.title.toLowerCase().includes(needle)) {
        hits.push({ entityType: 'lead', id: world.lead.id, title: world.lead.title, revision: world.lead.updatedAt });
      }
      return hits;
    },
    async getEntity(entityType, entityId) {
      world.gotCrm = true;
      if (entityType === 'contact' && entityId === world.contact.id) {
        return { entityType, entity: world.contact, timeline: [] as CRMActivity[], notes: world.notes } satisfies CRMEntityBundle;
      }
      if (entityType === 'company' && entityId === world.company.id) {
        return { entityType, entity: world.company, timeline: [], notes: world.notes };
      }
      if (entityType === 'lead' && entityId === world.lead.id) {
        return { entityType, entity: world.lead, timeline: [], notes: world.notes };
      }
      return undefined;
    },
  };

  const mutations: CRMMutationPort = {
    async createContact() {
      throw new Error('Golden fixture already has an authoritative contact.');
    },
    async createCompany() {
      throw new Error('Golden fixture already has an authoritative company.');
    },
    async createLead() {
      throw new Error('Golden fixture already has an authoritative lead.');
    },
    async updateEntity(operation, entityType, entityId, expectedUpdatedAt, updates) {
      const replayed = replayByOperation(byOperation, byEffect, operation.operationId, operation.effectFingerprint);
      if (replayed) return replayed as CRMContact | CRMCompany | CRMLead;
      if (entityType !== 'contact' || entityId !== world.contact.id) {
        throw new Error(`Unexpected CRM update ${entityType}:${entityId}`);
      }
      if (world.contact.updatedAt !== expectedUpdatedAt) {
        throw new Error(`contact ${entityId} changed since ${expectedUpdatedAt}; current revision is ${world.contact.updatedAt}.`);
      }
      world.contact = {
        ...world.contact,
        ...updates,
        tags: Array.isArray(updates.tags) ? updates.tags as string[] : world.contact.tags,
        updatedAt: bumpStamp(world.contact.updatedAt),
      };
      world.counts.crm_entity_update += 1;
      remember(byOperation, byEffect, operation.operationId, operation.effectFingerprint, world.contact);
      fireFault(world, 'after_mutation_commit');
      fireFault(world, 'after_crm_update');
      return world.contact;
    },
    async setDealStage() {
      throw new Error('Golden fixture does not mutate deals.');
    },
    async addNote(operation, entityType, entityId, expectedUpdatedAt, text) {
      const replayed = replayByOperation(byOperation, byEffect, operation.operationId, operation.effectFingerprint);
      if (replayed) return replayed as CRMNote;
      const entity = entityType === 'contact' ? world.contact : entityType === 'lead' ? world.lead : world.company;
      if (entity.id !== entityId) throw new Error(`Unknown ${entityType} ${entityId}`);
      if (entity.updatedAt !== expectedUpdatedAt) {
        throw new Error(`${entityType} ${entityId} changed since ${expectedUpdatedAt}; current revision is ${entity.updatedAt}.`);
      }
      const note: CRMNote = {
        id: `note-${world.notes.length + 1}`,
        body: text,
        contactId: entityType === 'contact' ? entityId : world.contact.id,
        leadId: entityType === 'lead' ? entityId : world.lead.id,
        createdAt: iso('2026-08-20T12:01:00.000Z'),
        updatedAt: iso('2026-08-20T12:01:00.000Z'),
      };
      world.notes.push(note);
      world.counts.crm_note_add += 1;
      remember(byOperation, byEffect, operation.operationId, operation.effectFingerprint, note);
      fireFault(world, 'after_mutation_commit');
      return note;
    },
    async createTaskLink(operation, taskId, entityType, entityId) {
      const replayed = replayByOperation(byOperation, byEffect, operation.operationId, operation.effectFingerprint);
      if (replayed) return replayed as CRMTaskLink;
      const link: CRMTaskLink = {
        id: `link-${world.taskLinks.length + 1}`,
        taskId,
        leadId: entityType === 'lead' ? entityId : world.lead.id,
        contactId: entityType === 'contact' ? entityId : world.contact.id,
        createdAt: iso('2026-08-20T12:02:00.000Z'),
      };
      world.taskLinks.push(link);
      world.counts.crm_task_link_create += 1;
      remember(byOperation, byEffect, operation.operationId, operation.effectFingerprint, link);
      fireFault(world, 'after_mutation_commit');
      return link;
    },
  };

  return { read, mutations };
}

export function createTaskPort(world: GoldenWorld): TaskMutationPort {
  const byOperation = new Map<string, TaskCommandResult>();
  const byEffect = new Map<string, TaskCommandResult>();

  const replay = (operationId: string, fingerprint: string): TaskCommandResult | undefined => (
    replayByOperation(byOperation, byEffect, operationId, fingerprint)
  );

  const receiptFor = (operationId: string, fingerprint: string, task: Task, comment?: TaskComment) => ({
    id: `receipt:${operationId}`,
    operationId,
    effectFingerprint: fingerprint,
    domain: 'tasks' as const,
    resourceKeys: [`task:${task.id}`],
    status: 'committed' as const,
    resultSummary: 'ok',
    resultData: { task, comment },
    committedAt: 1,
  });

  return {
    async createTask(input: CreateTaskInput): Promise<TaskCommandResult> {
      const prior = replay(input.operationId, input.effectFingerprint);
      if (prior) return { ...prior, replayed: true };
      const task: Task = {
        id: `task-${world.tasks.length + 1}`,
        title: input.title,
        content: input.content ?? '',
        status: 'pending',
        importance: input.importance ?? 'medium',
        date: input.date ?? '2026-08-21',
        projectId: input.projectId ?? null,
        assignees: input.assignees ?? [],
        createdAt: 20,
        updatedAt: 20,
        order: world.tasks.length,
      };
      world.tasks.push(task);
      world.counts.task_create += 1;
      const result = { task, receipt: receiptFor(input.operationId, input.effectFingerprint, task), replayed: false };
      remember(byOperation, byEffect, input.operationId, input.effectFingerprint, result);
      fireFault(world, 'after_mutation_commit');
      fireFault(world, 'after_task_create');
      return result;
    },
    async createSubtask(input: CreateSubtaskInput): Promise<TaskCommandResult> {
      return this.createTask(input);
    },
    async updateTask(input: UpdateTaskInput): Promise<TaskCommandResult> {
      const prior = replay(input.operationId, input.effectFingerprint);
      if (prior) return { ...prior, replayed: true };
      throw new Error(`Unexpected task update ${input.taskId}`);
    },
    async addComment(input: AddTaskCommentInput): Promise<TaskCommandResult> {
      const prior = replay(input.operationId, input.effectFingerprint);
      if (prior) return { ...prior, replayed: true };
      throw new Error(`Unexpected task comment ${input.taskId}`);
    },
    async softDeleteTask(input: SoftDeleteTaskInput): Promise<TaskCommandResult> {
      const prior = replay(input.operationId, input.effectFingerprint);
      if (prior) return { ...prior, replayed: true };
      throw new Error(`Unexpected task delete ${input.taskId}`);
    },
  };
}

export function createDocumentPort(world: GoldenWorld): DocumentMutationPort {
  const byOperation = new Map<string, DocumentMutationResult>();
  const byEffect = new Map<string, DocumentMutationResult>();

  return {
    async createDocument(args: DocumentCreateArgs): Promise<DocumentMutationResult> {
      const operationId = args.operationId ?? `doc-${world.documents.length}`;
      const fingerprint = `doc:${args.title}:${args.content}`;
      const prior = replayByOperation(byOperation, byEffect, operationId, fingerprint);
      if (prior) return prior;
      const documentId = `doc-${world.documents.length + 1}`;
      world.documents.push({ id: documentId, title: args.title, content: args.content });
      world.counts.document_create += 1;
      const result: Extract<DocumentMutationResult, { ok: true }> = {
        ok: true,
        documentId,
        revision: 'sha256:eval',
        operation: 'created',
        snapshot: {
          documentId,
          workspaceId: args.workspaceId,
          title: args.title,
          content: args.content,
          revision: 'sha256:eval',
          path: `/eval/workspace/${args.title}`,
          relativePath: args.title,
          scopeId: WORKSPACE.nativeScopeId ?? 'native-scope-eval',
          kind: args.target.kind,
          isDirty: args.target.kind === 'draft',
        },
      };
      remember(byOperation, byEffect, operationId, fingerprint, result);
      fireFault(world, 'after_mutation_commit');
      return result;
    },
    async updateDocument(): Promise<DocumentMutationResult> {
      throw new Error('Golden fixture does not update documents.');
    },
  };
}

export function createFormPort(world: GoldenWorld): FormReadPort {
  return {
    async listForms() {
      return [world.form];
    },
    async getForm(id) {
      world.gotForm = true;
      return id === world.form.id ? world.form : undefined;
    },
    validateForm() {
      return { valid: true, issues: [] };
    },
    async listSubmissions(formId) {
      if (formId && formId !== world.form.id) return [];
      return [world.submission];
    },
    async getSubmission(id) {
      world.gotSubmission = true;
      return id === world.submission.id ? world.submission : undefined;
    },
  };
}

function toolCall(id: string, name: string, args: Record<string, unknown>): OpenAIProtocolToolCall {
  return {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
}

function completionRecord(
  request: ProviderCompletionRequest,
  finishReason: string,
) {
  return {
    providerId: request.snapshot.providerId,
    modelId: request.snapshot.modelId,
    adapterVersion: PROVIDER_ADAPTER_VERSION,
    toolRegistryVersion: request.toolRegistryVersion,
    messageCount: request.messages.length,
    estimatedInputTokens: estimateInputTokens(request.messages),
    durationMs: 0,
    finishReason,
  };
}

export class FollowUpFakeProvider implements ProviderAdapter {
  readonly kind = PROVIDER_ADAPTER_KIND;
  readonly version = PROVIDER_ADAPTER_VERSION;
  readonly capturedBodies: unknown[] = [];
  private readonly world: GoldenWorld;
  private readonly hooks: ProviderRetryHooks;
  private readonly sinks: RedactionSinks;
  private callSerial = 0;

  constructor(world: GoldenWorld, hooks: ProviderRetryHooks, sinks: RedactionSinks) {
    this.world = world;
    this.hooks = hooks;
    this.sinks = sinks;
  }

  complete(request: ProviderCompletionRequest): Promise<ProviderCompletionResult> {
    return completeWithRetries(this.attemptOnce, request, this.hooks);
  }

  private readonly attemptOnce: ProviderAttemptFn = async (request, attempt) => {
    const captured = redactStructuredValue({
      modelId: request.snapshot.modelId,
      messages: request.messages,
      tools: request.tools?.map((tool) => tool.function.name) ?? [],
    });
    this.capturedBodies.push(captured);
    this.sinks.providerBodies.push(captured);
    await this.hooks.attemptStore.updateProviderAttempt(attempt.id, { status: 'streaming' });

    if (this.world.faultPoint === 'before_provider_request' && !this.world.faultFired) {
      this.world.faultFired = true;
      throw new ProviderError('incomplete_stream', 'Injected restart before provider request', { retryable: false });
    }
    if (this.world.faultPoint === 'during_provider_stream' && !this.world.faultFired) {
      request.onDelta?.('partial follow-up stream');
      this.world.faultFired = true;
      throw new ProviderError('incomplete_stream', 'Injected stream interrupt', { retryable: false });
    }
    if (
      this.world.faultPoint === 'before_next_provider_request'
      && this.world.providerRequests >= 1
      && !this.world.faultFired
    ) {
      this.world.faultFired = true;
      throw new ProviderError('incomplete_stream', 'Injected restart before next provider request', { retryable: false });
    }
    this.world.providerRequests += 1;

    const finish = (content: string, tool_calls?: OpenAIProtocolToolCall[]): ProviderCompletionResult => ({
      role: 'assistant',
      content,
      tool_calls,
      finishReason: tool_calls && tool_calls.length > 0 ? 'tool_calls' : 'stop',
      attempt,
      request: completionRecord(request, tool_calls && tool_calls.length > 0 ? 'tool_calls' : 'stop'),
    });

    if (this.world.submission.status === 'spam') {
      if (!this.world.gotSubmission) {
        return finish('', [toolCall('spam-read', 'submission_get', { id: this.world.submission.id })]);
      }
      return finish('Spam submission. No CRM, task, or document mutations.');
    }

    const reads: OpenAIProtocolToolCall[] = [];
    if (!this.world.gotSubmission) {
      reads.push(toolCall('read-sub', 'submission_get', { id: this.world.submission.id }));
    }
    if (!this.world.gotForm) {
      reads.push(toolCall('read-form', 'form_get', { id: this.world.form.id }));
    }
    if (!this.world.gotCrm) {
      reads.push(toolCall('read-crm', 'crm_entity_get', { id: this.world.contact.id, entityType: 'contact' }));
    }
    if (reads.length > 0) return finish('', reads);

    const remaining: Array<{ name: ExpectedMutation; args: Record<string, unknown> }> = [];
    if (this.world.counts.crm_entity_update === 0) {
      remaining.push({
        name: 'crm_entity_update',
        args: {
          entityType: 'contact',
          entityId: this.world.contact.id,
          expectedUpdatedAt: this.world.contact.updatedAt,
          updates: { jobTitle: 'Analyst', lifecycleStatus: 'customer' },
        },
      });
    }
    if (this.world.counts.crm_note_add === 0) {
      remaining.push({
        name: 'crm_note_add',
        args: {
          entityType: 'contact',
          entityId: this.world.contact.id,
          expectedUpdatedAt: this.world.contact.updatedAt,
          text: `Follow-up note for submission ${this.world.submission.id} and lead ${this.world.lead.id}.`,
        },
      });
    }
    if (this.world.counts.task_create === 0) {
      remaining.push({
        name: 'task_create',
        args: {
          title: 'Follow up with Ada Lovelace',
          content: 'Call Analytical Engines about the website inquiry.',
          date: '2026-08-21',
          importance: 'high',
        },
      });
    }
    if (this.world.counts.crm_task_link_create === 0 && this.world.tasks[0]) {
      remaining.push({
        name: 'crm_task_link_create',
        args: {
          taskId: this.world.tasks[0].id,
          entityType: 'lead',
          entityId: this.world.lead.id,
          expectedUpdatedAt: this.world.lead.updatedAt,
        },
      });
    }
    if (this.world.counts.document_create === 0) {
      remaining.push({
        name: 'document_create',
        args: {
          workspaceId: WORKSPACE.workspaceId,
          title: 'Follow-up.md',
          target: { kind: 'draft' },
          content: 'Draft follow-up for Ada Lovelace at Analytical Engines.',
          expectedWorkspaceRevision: WORKSPACE.rootRevision,
        },
      });
    }

    if (remaining.length > 0) {
      if (this.world.issuedMutations && this.mutationTotal() === 0) {
        return finish('Mutation tools were denied. No domain changes.');
      }
      const next = remaining[0];
      const calls = [toolCall(`mut-${this.callSerial++}`, next.name, next.args)];
      if (!this.world.duplicateDelivered) {
        calls.push(toolCall(`mut-${this.callSerial++}`, next.name, next.args));
        this.world.duplicateDelivered = true;
      }
      this.world.issuedMutations = true;
      return finish('', calls);
    }

    return finish(
      `Follow-up complete. Updated CRM contact ${this.world.contact.id}, added note ${this.world.notes[0]?.id ?? 'none'}, created task ${this.world.tasks[0]?.id ?? 'none'}, linked ${this.world.taskLinks[0]?.id ?? 'none'}, drafted ${this.world.documents[0]?.id ?? 'none'}.`,
    );
  };

  private mutationTotal(): number {
    return EXPECTED_MUTATIONS.reduce((sum, name) => sum + this.world.counts[name], 0);
  }
}

function wrapStore(
  store: MemoryExecutorStore,
  world: GoldenWorld,
  sinks: RedactionSinks,
): MemoryExecutorStore {
  const wrapped: MemoryExecutorStore = {
    ...store,
    async persistAssistantTurn(message: AgentMessage, toolCalls: AgentToolCall[]) {
      sinks.messages.push(redactStructuredValue(message));
      await store.persistAssistantTurn(message, toolCalls);
      if (toolCalls.length > 0) fireFault(world, 'after_tool_request_persistence');
    },
    async startToolExecution(toolCallId: string, executionEpoch: number, startedAt?: number) {
      fireFault(world, 'before_tool_execution');
      return store.startToolExecution(toolCallId, executionEpoch, startedAt);
    },
    async addMessage(message: AgentMessage, eventType?: Parameters<ExecutorPersistence['addMessage']>[1]) {
      if (message.role === 'tool') fireFault(world, 'before_tool_result_persistence');
      const redacted: AgentMessage = {
        ...message,
        content: typeof message.content === 'string' ? redactSecrets(message.content) : redactStructuredValue(message.content),
      };
      sinks.messages.push(redactStructuredValue(redacted));
      if (message.role === 'tool') sinks.toolResults.push(redacted.content);
      const stored = await store.addMessage(redacted, eventType);
      if (message.role === 'tool') fireFault(world, 'after_tool_result_persistence');
      return stored;
    },
    async updateRunWithEvent(runId, projection, type, data) {
      sinks.events.push(redactStructuredValue({ type, data }));
      return store.updateRunWithEvent(runId, projection, type, data);
    },
  };
  return wrapped;
}

function wrapRegistryTools(registry: ToolRegistry, mode: PolicyRunState['mode']): AgentToolDefinition[] {
  return registry.list().map((tool) => ({
    ...tool,
    execute: async (context, args) => {
      const invoked = await registry.invoke(context, tool.name, args, {
        run: {
          runId: context.runId,
          mode: context.mode ?? mode,
          policyRevision: 1,
          workspaceScope: context.workspaceScope,
          contextRefs: context.contextRefs,
        },
        toolCallId: context.operationId,
      });
      return invoked.result;
    },
  }));
}

function followUpPlan(runId: string): AgentRunPlan {
  return {
    id: `plan-${runId}`,
    runId,
    goal: 'Prepare follow-up work for the linked submission',
    steps: [
      { id: 'update-crm', title: 'Update linked CRM records', status: 'pending' },
      { id: 'note', title: 'Add a CRM note', status: 'pending' },
      { id: 'task', title: 'Create a follow-up task', status: 'pending' },
      { id: 'link', title: 'Link the task to the lead', status: 'pending' },
      { id: 'doc', title: 'Draft a follow-up document', status: 'pending' },
    ],
    expectedChanges: [...EXPECTED_MUTATIONS],
    toolGroups: [...EXPECTED_MUTATIONS],
    resourceScope: ['crm/**', 'task/**', 'workspace/**', 'form/**', 'submission/**'],
    estimatedOperationCount: 30,
    risks: ['local_create', 'local_update'],
    revision: 'eval-plan',
  };
}

export interface GoldenHarness {
  runtime: AgentRuntime;
  store: MemoryExecutorStore;
  world: GoldenWorld;
  sinks: RedactionSinks;
  provider: FollowUpFakeProvider;
  run: AgentRun;
}

export async function createGoldenHarness(options: {
  world: GoldenWorld;
  mode?: PolicyRunState['mode'];
  faultPoint?: FaultPoint;
  goal?: string;
}): Promise<GoldenHarness> {
  const world = options.world;
  world.faultPoint = options.faultPoint;
  const sinks = emptySinks();
  const now = () => Date.now();
  const inner = createMemoryExecutorStore(now);
  const store = wrapStore(inner, world, sinks);
  const provider = new FollowUpFakeProvider(world, {
    attemptStore: store,
    now,
    sleep: async () => undefined,
  }, sinks);
  const policy = new PolicyEngine({
    store: new MemoryPolicyStore(),
    now,
    readRevisions: async (keys) => Object.fromEntries(keys.map((key) => [key, 'eval-rev'])),
  });
  const crm = createCrmPorts(world);
  const registry = ToolRegistry.createDefault({
    policy,
    read: {
      crm: { crm: crm.read },
      forms: { forms: createFormPort(world) },
      documents: {
        listWorkspaces: async () => [{ id: WORKSPACE.workspaceId, name: 'Eval', revision: WORKSPACE.rootRevision }],
        getWorkspace: async (id) => (
          id === WORKSPACE.workspaceId
            ? { id, name: 'Eval', revision: WORKSPACE.rootRevision }
            : undefined
        ),
      },
    },
    mutations: {
      crm: { crm: crm.mutations, receipts: world.receipts },
      tasks: { tasks: createTaskPort(world), receipts: world.receipts },
      documents: { commands: createDocumentPort(world), receipts: world.receipts },
    },
  });
  const mode = options.mode ?? 'delegated';
  const runtime = new AgentRuntime({
    store,
    provider,
    tools: wrapRegistryTools(registry, mode),
    resolveCredential: async () => 'eval-test-key',
    now,
  });
  const run = await runtime.createRun({
    goal: options.goal ?? `Review submission ${world.submission.id} and prepare follow-up work.`,
    mode,
    contextRefs: [
      { kind: 'submission', id: world.submission.id, label: 'Website inquiry', revision: world.submission.createdAt },
      { kind: 'form', id: world.form.id, label: world.form.name, revision: world.form.updatedAt },
      { kind: 'crm', id: world.contact.id, label: 'Ada Lovelace', revision: world.contact.updatedAt },
    ],
    providerSnapshot: freezeProviderSnapshot({
      providerId: 'eval-provider',
      baseUrl: 'https://provider.eval.test/v1',
      modelId: 'eval-model',
      credentialAccount: 'providerApiKey_eval-provider',
      reasoning: 'standard',
      capabilities: { streaming: true, toolCalling: true, vision: false, reasoning: false },
      contextWindow: 16_000,
      maxOutputTokens: 2_000,
    }),
    profileSnapshot: {
      name: 'Follow-up Operator',
      description: 'Eval profile',
      systemInstructions: 'Complete the submission follow-up workflow.',
      defaultMode: mode,
      allowedToolGroups: ['read', 'crm', 'task', 'document'],
      defaultSkills: [],
    },
    instructionSnapshot: {
      safetyInstructionsHash: 'eval-safe',
      policyHash: 'eval-policy',
      skillHashes: [],
      compiledContent: 'Use existing CRM links. Do not create duplicate CRM records.',
      compiledContentHash: 'eval-compiled',
    },
    policySnapshot: { revision: 1, mode, rulesHash: 'eval-rules' },
    workspaceScope: WORKSPACE,
    toolRegistryVersion: registry.versionString(),
    toolRegistryHash: registry.hash(),
  });
  if (mode === 'delegated') {
    await policy.approvePlan({
      run: {
        runId: run.id,
        mode,
        policyRevision: 1,
        workspaceScope: run.workspaceScope,
        contextRefs: run.contextRefs,
      },
      plan: followUpPlan(run.id),
      tools: registry.list(),
    });
  }
  return { runtime, store, world, sinks, provider, run };
}

export async function runWithRestart(harness: GoldenHarness): Promise<AgentRun> {
  const { runtime, store, run } = harness;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const finished = await runtime.start(run.id);
      if (finished.status === 'completed' || finished.status === 'failed' || finished.status === 'cancelled') {
        return finished;
      }
      if (finished.status === 'interrupted' || finished.status === 'paused' || finished.status === 'needs_review') {
        const recovered = finished.status === 'interrupted'
          ? await runtime.recover(run.id)
          : await queueFrom(store, run.id, finished.status);
        if (recovered.status !== 'queued' && recovered.status !== 'running') return recovered;
        continue;
      }
      return finished;
    } catch (caught) {
      if (!(caught instanceof Error) || caught.name !== 'RestartSignal') throw caught;
      const current = await store.getRun(run.id);
      if (current && current.status === 'running') {
        await store.updateRunWithEvent(
          run.id,
          { status: 'interrupted', interruptionReason: caught.message },
          'run.interrupted',
          { fault: caught.message },
        );
      }
      const after = await store.getRun(run.id);
      if (after?.status === 'interrupted') await runtime.recover(run.id);
      else await queueFrom(store, run.id, after?.status ?? 'running');
    }
  }
  const last = await store.getRun(run.id);
  if (!last) throw new Error('Golden run disappeared.');
  return last;
}

async function queueFrom(
  store: MemoryExecutorStore,
  runId: string,
  status: AgentRun['status'],
): Promise<AgentRun> {
  if (status === 'queued') return (await store.getRun(runId)) as AgentRun;
  await store.updateRunWithEvent(
    runId,
    { status: 'queued', pauseRequestedAt: undefined, interruptionReason: undefined },
    'run.queued',
    { recovered: true },
  );
  return (await store.getRun(runId)) as AgentRun;
}

export function expectedMutationSet(world: GoldenWorld): MutationCounts {
  return { ...world.counts };
}
