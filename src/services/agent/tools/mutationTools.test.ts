import { describe, expect, it } from 'vitest';
import type {
  AgentOperationReceipt,
  AgentToolResult,
  ToolExecutionContext,
} from '../../../types/agent';
import type { Task, TaskComment } from '../../../types';
import type { CRMCompany, CRMContact, CRMDeal, CRMLead, CRMNote, CRMTaskLink } from '../../../types/crm';
import type {
  AddTaskCommentInput,
  CreateSubtaskInput,
  CreateTaskInput,
  SoftDeleteTaskInput,
  TaskCommandResult,
  UpdateTaskInput,
} from '../../tasks/taskService';
import { TaskNotFoundError, TaskRevisionConflictError } from '../../tasks/taskService';
import type { DocumentCreateArgs, DocumentMutationResult } from '../../documents/documentCommands';
import { MemoryPolicyStore, PolicyEngine } from '../policyEngine';
import { ToolRegistry } from '../toolRegistry';
import { createCrmMutationTools, type CRMMutationPort } from './crmTools';
import { createDocumentMutationTools } from './documentTools';
import {
  EFFECT_EXCLUDED_FIELDS,
  EFFECT_INCLUDED_FIELDS,
  FilesystemUncertaintyError,
  MUTATION_TOOL_NAMES,
  MemoryReceiptStore,
  effectFingerprint,
  type MutationResultData,
} from './mutationSupport';
import { createTaskMutationTools, type TaskMutationPort } from './taskTools';

function context(extra: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    runId: 'run-1',
    turn: 2,
    executionEpoch: 0,
    mode: 'guided',
    contextRefs: [],
    abortSignal: extra.abortSignal ?? new AbortController().signal,
    workspaceScope: extra.workspaceScope ?? {
      workspaceId: 'ws-1',
      rootPath: '/workspace',
      rootRevision: 'ws-rev',
      nativeScopeId: 'scope-1',
    },
    operationId: extra.operationId ?? 'run-1:t2:tc0',
    toolIndex: extra.toolIndex ?? 0,
    effectFingerprint: extra.effectFingerprint,
  };
}

function dataOf(result: AgentToolResult): MutationResultData {
  return result.data as MutationResultData;
}

async function exec(
  tool: { execute: (context: ToolExecutionContext, args: unknown) => Promise<unknown> },
  ctx: ToolExecutionContext,
  args: unknown,
): Promise<AgentToolResult> {
  return await tool.execute(ctx, args) as AgentToolResult;
}

function makeTask(id: string, extra: Partial<Task> = {}): Task {
  return {
    id,
    title: extra.title ?? 'Follow up',
    content: extra.content ?? '',
    status: extra.status ?? 'pending',
    importance: extra.importance ?? 'medium',
    date: extra.date ?? '2026-08-20',
    projectId: extra.projectId ?? null,
    assignees: extra.assignees ?? [],
    createdAt: extra.createdAt ?? 10,
    updatedAt: extra.updatedAt ?? 10,
    order: extra.order ?? 0,
    parentId: extra.parentId,
    deletedAt: extra.deletedAt,
  };
}

function receiptFor(operationId: string, fingerprint: string, task: Task, comment?: TaskComment): AgentOperationReceipt {
  return {
    id: `receipt:${operationId}`,
    operationId,
    effectFingerprint: fingerprint,
    domain: 'tasks',
    resourceKeys: [`task:${task.id}`],
    status: 'committed',
    resultSummary: 'ok',
    resultData: { task, comment },
    committedAt: 1,
  };
}

class FakeTasks implements TaskMutationPort {
  readonly tasks = new Map<string, Task>();
  creates = 0;
  updates = 0;
  comments = 0;
  deletes = 0;
  private readonly byOperation = new Map<string, TaskCommandResult>();

  seed(task: Task): void {
    this.tasks.set(task.id, task);
  }

  private replay(operationId: string, fingerprint: string): TaskCommandResult | undefined {
    const prior = this.byOperation.get(operationId);
    if (!prior) return undefined;
    if (prior.receipt.effectFingerprint !== fingerprint) {
      throw new Error(`Operation ${operationId} was already committed with a different effect.`);
    }
    return { ...prior, replayed: true };
  }

  async createTask(input: CreateTaskInput): Promise<TaskCommandResult> {
    const replayed = this.replay(input.operationId, input.effectFingerprint);
    if (replayed) return replayed;
    this.creates += 1;
    const task = makeTask(`task-${this.creates}`, {
      title: input.title,
      content: input.content,
      date: input.date,
      importance: input.importance,
      projectId: input.projectId ?? null,
      assignees: input.assignees,
      updatedAt: 20,
    });
    this.tasks.set(task.id, task);
    const result = {
      task,
      receipt: receiptFor(input.operationId, input.effectFingerprint, task),
      replayed: false,
    };
    this.byOperation.set(input.operationId, result);
    return result;
  }

  async createSubtask(input: CreateSubtaskInput): Promise<TaskCommandResult> {
    return this.createTask({ ...input, title: input.title });
  }

  async updateTask(input: UpdateTaskInput): Promise<TaskCommandResult> {
    const replayed = this.replay(input.operationId, input.effectFingerprint);
    if (replayed) return replayed;
    const current = this.tasks.get(input.taskId);
    if (!current || current.deletedAt) throw new TaskNotFoundError(input.taskId);
    if (current.updatedAt !== input.expectedUpdatedAt) {
      throw new TaskRevisionConflictError(input.taskId, input.expectedUpdatedAt, current.updatedAt);
    }
    this.updates += 1;
    const task = { ...current, ...input.updates, updatedAt: current.updatedAt + 1 };
    this.tasks.set(task.id, task);
    const result = { task, receipt: receiptFor(input.operationId, input.effectFingerprint, task), replayed: false };
    this.byOperation.set(input.operationId, result);
    return result;
  }

  async addComment(input: AddTaskCommentInput): Promise<TaskCommandResult> {
    const replayed = this.replay(input.operationId, input.effectFingerprint);
    if (replayed) return replayed;
    const current = this.tasks.get(input.taskId);
    if (!current) throw new TaskNotFoundError(input.taskId);
    if (current.updatedAt !== input.expectedUpdatedAt) {
      throw new TaskRevisionConflictError(input.taskId, input.expectedUpdatedAt, current.updatedAt);
    }
    this.comments += 1;
    const comment: TaskComment = { id: `c-${this.comments}`, taskId: input.taskId, sender: 'You', text: input.text, createdAt: 1 };
    const task = { ...current, updatedAt: current.updatedAt + 1 };
    this.tasks.set(task.id, task);
    const result = { task, comment, receipt: receiptFor(input.operationId, input.effectFingerprint, task, comment), replayed: false };
    this.byOperation.set(input.operationId, result);
    return result;
  }

  async softDeleteTask(input: SoftDeleteTaskInput): Promise<TaskCommandResult> {
    const replayed = this.replay(input.operationId, input.effectFingerprint);
    if (replayed) return replayed;
    const current = this.tasks.get(input.taskId);
    if (!current) throw new TaskNotFoundError(input.taskId);
    if (current.updatedAt !== input.expectedUpdatedAt) {
      throw new TaskRevisionConflictError(input.taskId, input.expectedUpdatedAt, current.updatedAt);
    }
    this.deletes += 1;
    const task = { ...current, deletedAt: current.updatedAt + 1, updatedAt: current.updatedAt + 1 };
    this.tasks.set(task.id, task);
    const result = { task, receipt: receiptFor(input.operationId, input.effectFingerprint, task), replayed: false };
    this.byOperation.set(input.operationId, result);
    return result;
  }
}

function snapshot(documentId: string, title: string, content: string, revision: string): Extract<DocumentMutationResult, { ok: true }> {
  return {
    ok: true,
    documentId,
    revision,
    operation: 'created',
    snapshot: {
      documentId,
      workspaceId: 'ws-1',
      title,
      content,
      revision,
      path: `/workspace/${title}`,
      relativePath: title,
      scopeId: 'scope-1',
      kind: 'file',
      isDirty: false,
    },
  };
}

describe('mutation tool catalog', () => {
  it('registers the exact mutation tool names', () => {
    expect(MUTATION_TOOL_NAMES).toEqual([
      'document_create',
      'document_update',
      'task_create',
      'task_update',
      'task_comment_add',
      'task_soft_delete',
      'crm_contact_create',
      'crm_company_create',
      'crm_lead_create',
      'crm_entity_update',
      'crm_deal_stage_set',
      'crm_note_add',
      'crm_task_link_create',
    ]);
  });

  it('fingerprints include desired effects and exclude concurrency fields', () => {
    expect(EFFECT_INCLUDED_FIELDS).toEqual([
      'toolVersion',
      'resourceKeys',
      'desiredFields',
      'parentKeys',
      'targetPath',
      'contentHash',
    ]);
    expect(EFFECT_EXCLUDED_FIELDS).toEqual([
      'expectedRevision',
      'expectedUpdatedAt',
      'expectedWorkspaceRevision',
      'expectedHash',
      'timeoutMs',
      'cursor',
      'limit',
    ]);
    const tools = createTaskMutationTools({ tasks: new FakeTasks(), receipts: new MemoryReceiptStore() });
    const update = tools.find((tool) => tool.name === 'task_update');
    expect(update).toBeDefined();
    const left = update!.buildEffectPayload({
      taskId: 'task-1',
      expectedUpdatedAt: 10,
      updates: { title: 'Hello' },
    });
    const right = update!.buildEffectPayload({
      taskId: 'task-1',
      expectedUpdatedAt: 99,
      updates: { title: 'Hello' },
    });
    expect(left).toEqual(right);
    expect(JSON.stringify(left)).not.toContain('expectedUpdatedAt');
    expect(effectFingerprint({ toolVersion: '1.0.0', resourceKeys: ['task:task-1'], payload: left }))
      .toBe(effectFingerprint({ toolVersion: '1.0.0', resourceKeys: ['task:task-1'], payload: right }));
  });
});

describe('schema rejection', () => {
  it('rejects unknown nested fields before execution', async () => {
    const tasks = new FakeTasks();
    const registry = new ToolRegistry({
      tools: createTaskMutationTools({ tasks, receipts: new MemoryReceiptStore() }),
    });
    const { result, decision } = await registry.invoke(context(), 'task_update', {
      taskId: 'task-1',
      expectedUpdatedAt: 10,
      updates: { title: 'Hi', unknownField: true },
    }, { run: { runId: 'run-1', mode: 'guided', policyRevision: 1, contextRefs: [] } });
    expect(decision.outcome).toBe('deny');
    expect(result.error?.code).toBe('validation_failed');
    expect(tasks.updates).toBe(0);
  });

  it('rejects unknown document target fields and CRM update fields', async () => {
    const registry = new ToolRegistry({
      tools: [
        ...createDocumentMutationTools({ receipts: new MemoryReceiptStore() }),
        ...createCrmMutationTools({ receipts: new MemoryReceiptStore() }),
      ],
    });
    const draft = await registry.invoke(context(), 'document_create', {
      workspaceId: 'ws-1',
      title: 'Note',
      target: { kind: 'draft', extra: true },
      content: 'hi',
      expectedWorkspaceRevision: 'rev',
    }, { run: { runId: 'run-1', mode: 'guided', policyRevision: 1, contextRefs: [] } });
    expect(draft.result.error?.code).toBe('validation_failed');

    const crm = await registry.invoke(context(), 'crm_entity_update', {
      entityType: 'contact',
      entityId: 'c1',
      expectedUpdatedAt: '2026-08-20T00:00:00.000Z',
      updates: { firstName: 'Ada', website: 'https://example.com' },
    }, { run: { runId: 'run-1', mode: 'guided', policyRevision: 1, contextRefs: [] } });
    expect(crm.result.error?.code).toBe('validation_failed');
  });
});

describe('stale data, replay, and repeated effects', () => {
  it('rejects stale task updates', async () => {
    const tasks = new FakeTasks();
    tasks.seed(makeTask('task-1', { updatedAt: 50 }));
    const [update] = createTaskMutationTools({ tasks, receipts: new MemoryReceiptStore() }).filter((tool) => tool.name === 'task_update');
    const result = await exec(update, context({ operationId: 'op-stale' }), {
      taskId: 'task-1',
      expectedUpdatedAt: 10,
      updates: { title: 'New' },
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('stale_revision');
    expect(tasks.updates).toBe(0);
  });

  it('replays the stored receipt for the same operationId', async () => {
    const tasks = new FakeTasks();
    const receipts = new MemoryReceiptStore();
    const create = createTaskMutationTools({ tasks, receipts }).find((tool) => tool.name === 'task_create')!;
    const args = { title: 'Follow up', date: '2026-08-21' };
    const first = await exec(create, context({ operationId: 'op-replay' }), args);
    const second = await exec(create, context({ operationId: 'op-replay' }), args);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(tasks.creates).toBe(1);
    expect(dataOf(second).receipt.replayed).toBe(true);
    expect(dataOf(first).entity).toEqual(dataOf(second).entity);
  });

  it('returns the prior result for a later matching effect fingerprint', async () => {
    const tasks = new FakeTasks();
    const receipts = new MemoryReceiptStore();
    const create = createTaskMutationTools({ tasks, receipts }).find((tool) => tool.name === 'task_create')!;
    const args = { title: 'Follow up', date: '2026-08-21' };
    const first = await exec(create, context({ operationId: 'op-a' }), args);
    const second = await exec(create, context({ operationId: 'op-b' }), args);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(tasks.creates).toBe(1);
    expect(dataOf(second).receipt.repeatedEffect).toBe(true);
    expect(dataOf(second).resourceLinks[0].id).toBe(dataOf(first).resourceLinks[0].id);
  });
});

describe('approval rejection and cancellation', () => {
  it('does not mutate after an approval rejection', async () => {
    const tasks = new FakeTasks();
    const store = new MemoryPolicyStore();
    const policy = new PolicyEngine({ store });
    const tools = createTaskMutationTools({ tasks, receipts: new MemoryReceiptStore() });
    const registry = new ToolRegistry({ policy, tools });
    const run = { runId: 'run-1', mode: 'guided' as const, policyRevision: 1, contextRefs: [] };
    const first = await registry.invoke(context(), 'task_create', { title: 'Follow up' }, { toolCallId: 'tc-1', run });
    expect(first.decision.outcome).toBe('ask');
    expect(first.decision.approval?.id).toBeDefined();
    await policy.answerApproval(first.decision.approval!.id, 'rejected', tools);
    const second = await registry.invoke(context(), 'task_create', { title: 'Follow up' }, { toolCallId: 'tc-1', run });
    expect(second.result.error?.code).toBe('approval_rejected');
    expect(tasks.creates).toBe(0);
  });

  it('returns cancelled when the abort signal is already aborted', async () => {
    const tasks = new FakeTasks();
    const create = createTaskMutationTools({ tasks, receipts: new MemoryReceiptStore() }).find((tool) => tool.name === 'task_create')!;
    const controller = new AbortController();
    controller.abort();
    const result = await exec(create, context({ abortSignal: controller.signal }), { title: 'Follow up' });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('cancelled');
    expect(tasks.creates).toBe(0);
  });
});

describe('filesystem uncertainty and resource links', () => {
  it('moves unknown filesystem writes to review without inventing success', async () => {
    const commands = {
      async createDocument(): Promise<DocumentMutationResult> {
        throw new FilesystemUncertaintyError('Write finished without a durable hash', {
          expectedInputHash: 'absent',
          expectedOutputHash: 'sha256:desired',
        });
      },
      async updateDocument(): Promise<DocumentMutationResult> {
        throw new Error('unused');
      },
    };
    const create = createDocumentMutationTools({ commands, receipts: new MemoryReceiptStore() }).find((tool) => tool.name === 'document_create')!;
    const result = await exec(create, context({ operationId: 'op-fs' }), {
      workspaceId: 'ws-1',
      title: 'Follow-up.md',
      target: { kind: 'file', relativePath: 'Follow-up.md', expectedState: 'absent' },
      content: 'Hello',
      expectedWorkspaceRevision: 'ws-rev',
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('interrupted');
    expect((result.data as { needsReview?: boolean }).needsReview).toBe(true);
    expect((result.data as { filesystem?: { outcome: string } }).filesystem?.outcome).toBe('unknown');
  });

  it('returns structured changes, artifacts, and resource links', async () => {
    const tasks = new FakeTasks();
    tasks.seed(makeTask('task-1', { updatedAt: 10, title: 'Lead follow-up' }));
    const receipts = new MemoryReceiptStore();
    const comment = createTaskMutationTools({ tasks, receipts }).find((tool) => tool.name === 'task_comment_add')!;
    const result = await exec(comment, context({ operationId: 'op-link' }), {
      taskId: 'task-1',
      expectedUpdatedAt: 10,
      text: 'Called the lead',
    });
    expect(result.ok).toBe(true);
    expect(result.changes?.[0].resourceKey).toBe('task:task-1');
    expect(dataOf(result).resourceLinks.some((link) => link.resourceKey === 'task:task-1')).toBe(true);
    expect(dataOf(result).resourceLinks.some((link) => link.kind === 'task_comment')).toBe(true);
    expect(dataOf(result).projectionPending).toBe(true);
  });

  it('creates CRM records and task links through domain commands', async () => {
    const created: string[] = [];
    const crm: CRMMutationPort = {
      async createContact(_operation, values) {
        created.push('contact');
        return {
          id: 'contact-1',
          firstName: String(values.firstName),
          lastName: String(values.lastName),
          email: String(values.email),
          tags: [],
          createdAt: '2026-08-20T00:00:00.000Z',
          updatedAt: '2026-08-20T00:00:00.000Z',
        } satisfies CRMContact;
      },
      async createCompany() {
        created.push('company');
        return { id: 'company-1', name: 'Acme', tags: [], createdAt: 't', updatedAt: 't' } satisfies CRMCompany;
      },
      async createLead() {
        created.push('lead');
        return {
          id: 'lead-1',
          title: 'Inquiry',
          contactId: 'contact-1',
          status: 'new',
          stage: 'new',
          tags: [],
          createdAt: 't',
          updatedAt: 't',
        } satisfies CRMLead;
      },
      async updateEntity() {
        created.push('update');
        return {
          id: 'contact-1',
          firstName: 'Ada',
          lastName: 'Lovelace',
          tags: [],
          createdAt: 't',
          updatedAt: 't2',
        } satisfies CRMContact;
      },
      async setDealStage() {
        created.push('stage');
        return {
          id: 'deal-1',
          title: 'Deal',
          stage: 'qualified',
          tags: [],
          createdAt: 't',
          updatedAt: 't2',
        } satisfies CRMDeal;
      },
      async addNote() {
        created.push('note');
        return { id: 'note-1', body: 'hi', createdAt: 't', updatedAt: 't' } satisfies CRMNote;
      },
      async createTaskLink() {
        created.push('link');
        return { id: 'link-1', taskId: 'task-1', leadId: 'lead-1', createdAt: 't' } satisfies CRMTaskLink;
      },
    };
    const tools = createCrmMutationTools({ crm, receipts: new MemoryReceiptStore() });
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    const contact = await exec(byName.crm_contact_create, context({ operationId: 'op-c' }), {
      values: { firstName: 'Ada', lastName: 'Lovelace', email: 'ADA@example.com' },
    });
    const link = await exec(byName.crm_task_link_create, context({ operationId: 'op-l' }), {
      taskId: 'task-1',
      entityType: 'lead',
      entityId: 'lead-1',
      expectedUpdatedAt: 't',
    });
    expect(contact.ok).toBe(true);
    expect(link.ok).toBe(true);
    expect(created).toEqual(['contact', 'link']);
    expect(dataOf(link).resourceLinks.some((item) => item.resourceKey === 'task:task-1')).toBe(true);
    expect(dataOf(link).resourceLinks.some((item) => item.resourceKey === 'crm:lead:lead-1')).toBe(true);
  });

  it('creates a document file through the document command boundary', async () => {
    const commands = {
      async createDocument(args: DocumentCreateArgs): Promise<DocumentMutationResult> {
        expect(args.target.kind === 'file' ? args.target.scopeId : '').toBe('scope-1');
        return snapshot('doc-1', args.title, args.content, 'sha256:abc');
      },
      async updateDocument(): Promise<DocumentMutationResult> {
        throw new Error('unused');
      },
    };
    const create = createDocumentMutationTools({ commands, receipts: new MemoryReceiptStore() }).find((tool) => tool.name === 'document_create')!;
    const result = await exec(create, context({ operationId: 'op-doc' }), {
      workspaceId: 'ws-1',
      title: 'Follow-up.md',
      target: { kind: 'file', relativePath: 'Follow-up.md', expectedState: 'absent' },
      content: 'Hello',
      expectedWorkspaceRevision: 'ws-rev',
    });
    expect(result.ok).toBe(true);
    expect(dataOf(result).resourceLinks[0].resourceKey).toBe('document:doc-1');
    expect(result.changes?.[0].type).toBe('created');
  });
});
