// ---------------------------------------------------------------------------
// TABS Work-OS Harness — Task and project tools
// Reads and mutations go through TaskService. Handlers never write Dexie
// or Zustand directly.
// ---------------------------------------------------------------------------

import type { Project, Task, TaskComment, TaskImportance, TaskStatus } from '../../../types';
import { TASK_TITLE_MAX_LENGTH } from '../../../types';
import type { AgentToolDefinition, AgentToolResult, ToolExecutionContext } from '../../../types/agent';
import {
  taskService,
  type AddTaskCommentInput,
  type CreateSubtaskInput,
  type CreateTaskInput,
  type SoftDeleteTaskInput,
  type TaskCommandResult,
  type UpdateTaskInput,
} from '../../tasks/taskService';
import {
  asRecord,
  type ArtifactSink,
  defineReadTool,
  entityReadSchema,
  fail,
  listInputSchema,
  normalizeListLimit,
  ok,
  paginateList,
  resolveFrozenId,
  sourceRef,
  spillIfLarge,
  staleIfMismatch,
  TASK_READ_TOOL_NAMES,
} from './readSupport';
import {
  allowlistedUpdateGrant,
  asNumber,
  asString,
  change,
  defineMutationTool,
  mapMutationError,
  mutationOk,
  type MutationReceiptStore,
  objectSchema,
  resolvePriorReceipt,
  resourceLink,
  stringList,
  TASK_MUTATION_TOOL_NAMES,
} from './mutationSupport';

export { TASK_READ_TOOL_NAMES, TASK_MUTATION_TOOL_NAMES };

export interface TaskListFilters {
  projectId?: string | null;
  status?: TaskStatus;
  parentId?: string;
  query?: string;
  includeDeleted?: boolean;
}

export interface TaskReadPort {
  listTasks(filters?: TaskListFilters): Promise<Task[]>;
  getTask(taskId: string): Promise<Task | undefined>;
  listSubtasks(parentId: string): Promise<Task[]>;
  listTaskComments(taskId: string): Promise<TaskComment[]>;
  listProjects(): Promise<Project[]>;
  getProject?(projectId: string): Promise<Project | undefined>;
}

export interface TaskReadToolDependencies {
  tasks?: TaskReadPort;
  putArtifact?: ArtifactSink;
}

const TASK_STATUS = ['pending', 'in_progress', 'completed'] as const;
const TASK_IMPORTANCE = ['low', 'medium', 'high'] as const;

function taskFilters(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      projectId: { type: ['string', 'null'] },
      status: { type: 'string', enum: [...TASK_STATUS] },
      importance: { type: 'string', enum: [...TASK_IMPORTANCE] },
      parentId: { type: 'string' },
      query: { type: 'string' },
      includeDeleted: { type: 'boolean' },
    },
  };
}

function projectFilters(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      query: { type: 'string' },
    },
  };
}

function defaultTaskPort(): TaskReadPort {
  return {
    listTasks: (filters) => taskService.listTasks(filters),
    getTask: (taskId) => taskService.getTask(taskId),
    listSubtasks: (parentId) => taskService.listSubtasks(parentId),
    listTaskComments: (taskId) => taskService.listTaskComments(taskId),
    listProjects: () => taskService.listProjects(),
    getProject: (projectId) => taskService.getProject(projectId),
  };
}

function taskSummary(task: Task) {
  return {
    ...sourceRef('task', task.id, String(task.updatedAt)),
    id: task.id,
    title: task.title,
    status: task.status,
    importance: task.importance,
    date: task.date,
    projectId: task.projectId,
    parentId: task.parentId ?? null,
    updatedAt: task.updatedAt,
  };
}

export function createTaskReadTools(deps: TaskReadToolDependencies = {}): AgentToolDefinition[] {
  const tasks = deps.tasks ?? defaultTaskPort();
  const putArtifact = deps.putArtifact;

  const taskList = defineReadTool({
    name: 'task_list',
    description: 'Query tasks with bounded filters, cursors, and limits.',
    inputSchema: listInputSchema(taskFilters()),
    resolveResourceKeys: (_context, args) => {
      const filters = asRecord(asRecord(args).filters);
      if (typeof filters.projectId === 'string') return [`project:${filters.projectId}:tasks`];
      return ['task'];
    },
    async execute(_context: ToolExecutionContext, args: unknown): Promise<AgentToolResult> {
      const record = asRecord(args);
      const filters = asRecord(record.filters);
      const query: TaskListFilters = {
        query: typeof filters.query === 'string' ? filters.query : undefined,
        status: TASK_STATUS.includes(filters.status as TaskStatus) ? filters.status as TaskStatus : undefined,
        parentId: typeof filters.parentId === 'string' ? filters.parentId : undefined,
        includeDeleted: filters.includeDeleted === true,
      };
      if (filters.projectId === null) query.projectId = null;
      else if (typeof filters.projectId === 'string') query.projectId = filters.projectId;
      try {
        let listed = await tasks.listTasks(query);
        if (TASK_IMPORTANCE.includes(filters.importance as TaskImportance)) {
          listed = listed.filter((task) => task.importance === filters.importance);
        }
        const page = paginateList(listed, record.cursor, normalizeListLimit(record.limit));
        return ok(`Listed ${page.count} of ${page.total} tasks`, {
          items: page.items.map(taskSummary),
          nextCursor: page.nextCursor,
          truncated: page.truncated,
          total: page.total,
        });
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : 'Task list failed';
        return fail('internal_error', message);
      }
    },
  });

  const taskGet = defineReadTool({
    name: 'task_get',
    description: 'Read a task, subtasks, comments, and revision.',
    inputSchema: entityReadSchema(),
    resolveResourceKeys: (_context, args) => [`task:${asRecord(args).id}`],
    async execute(context: ToolExecutionContext, args: unknown): Promise<AgentToolResult> {
      const record = asRecord(args);
      const id = String(record.id);
      const frozen = resolveFrozenId(context, 'task', id);
      try {
        const task = await tasks.getTask(id);
        if (!task || (task.deletedAt && record.section !== 'deleted')) {
          return fail('not_found', `Task ${id} was not found.`);
        }
        const revision = String(task.updatedAt);
        const stale = staleIfMismatch(
          typeof record.revision === 'string' ? record.revision : frozen?.revision,
          revision,
          `Task ${id}`,
        );
        if (stale) return { ...stale, observedRevision: revision };
        const [subtasks, comments] = await Promise.all([
          tasks.listSubtasks(id),
          tasks.listTaskComments(id),
        ]);
        const commentPage = paginateList(comments, record.cursor, normalizeListLimit(record.limit));
        const payload = {
          ...sourceRef('task', task.id, revision),
          id: task.id,
          title: task.title,
          content: record.section === 'comments' ? undefined : task.content,
          status: task.status,
          importance: task.importance,
          date: task.date,
          projectId: task.projectId,
          assignees: task.assignees,
          parentId: task.parentId ?? null,
          updatedAt: task.updatedAt,
          subtasks: subtasks.map(taskSummary),
          comments: commentPage.items.map((comment) => ({
            id: comment.id,
            taskId: comment.taskId,
            sender: comment.sender,
            text: comment.text,
            createdAt: comment.createdAt,
          })),
          commentsTruncated: commentPage.truncated,
          commentsNextCursor: commentPage.nextCursor,
        };
        const bounded = await spillIfLarge(context.runId, `task:${task.id}`, payload, putArtifact);
        return ok(`Read task ${task.title}`, bounded.data, {
          observedRevision: revision,
          artifacts: bounded.artifacts,
        });
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : 'Task read failed';
        return fail('internal_error', message);
      }
    },
  });

  const projectList = defineReadTool({
    name: 'project_list',
    description: 'List projects with stable identifiers.',
    inputSchema: listInputSchema(projectFilters()),
    resolveResourceKeys: () => ['project'],
    async execute(_context: ToolExecutionContext, args: unknown): Promise<AgentToolResult> {
      const record = asRecord(args);
      const filters = asRecord(record.filters);
      const query = typeof filters.query === 'string' ? filters.query.trim().toLowerCase() : '';
      try {
        const projects = await tasks.listProjects();
        const matched = query
          ? projects.filter((project) => project.name.toLowerCase().includes(query) || project.id.includes(query))
          : projects;
        const page = paginateList(matched, record.cursor, normalizeListLimit(record.limit));
        return ok(`Listed ${page.count} of ${page.total} projects`, {
          items: page.items.map((project) => ({
            sourceId: `project:${project.id}`,
            sourceKind: 'task',
            revision: String(project.createdAt),
            id: project.id,
            name: project.name,
            color: project.color,
            createdAt: project.createdAt,
          })),
          nextCursor: page.nextCursor,
          truncated: page.truncated,
          total: page.total,
        });
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : 'Project list failed';
        return fail('internal_error', message);
      }
    },
  });

  return [taskList, taskGet, projectList];
}

const TASK_UPDATES_SCHEMA = objectSchema({
  title: { type: 'string', minLength: 1, maxLength: TASK_TITLE_MAX_LENGTH },
  content: { type: 'string' },
  status: { type: 'string', enum: [...TASK_STATUS] },
  importance: { type: 'string', enum: [...TASK_IMPORTANCE] },
  date: { type: 'string' },
  projectId: { type: ['string', 'null'] },
  assignees: { type: 'array', items: { type: 'string', minLength: 1 } },
}, [], { minProperties: 1 });

export interface TaskMutationPort {
  createTask(input: CreateTaskInput): Promise<TaskCommandResult>;
  createSubtask(input: CreateSubtaskInput): Promise<TaskCommandResult>;
  updateTask(input: UpdateTaskInput): Promise<TaskCommandResult>;
  addComment(input: AddTaskCommentInput): Promise<TaskCommandResult>;
  softDeleteTask(input: SoftDeleteTaskInput): Promise<TaskCommandResult>;
}

export interface TaskMutationToolDependencies {
  tasks?: TaskMutationPort;
  receipts?: MutationReceiptStore;
}

function defaultTaskMutations(): TaskMutationPort {
  return {
    createTask: (input) => taskService.createTask(input),
    createSubtask: (input) => taskService.createSubtask(input),
    updateTask: (input) => taskService.updateTask(input),
    addComment: (input) => taskService.addComment(input),
    softDeleteTask: (input) => taskService.softDeleteTask(input),
  };
}

function taskResourceKey(taskId: string): string {
  return `task:${taskId}`;
}

function taskMutationSuccess(
  summary: string,
  type: 'created' | 'updated' | 'deleted',
  result: TaskCommandResult,
  operationId: string,
  fingerprint: string,
  extras: { replayed?: boolean; repeatedEffect?: boolean },
): AgentToolResult {
  const key = taskResourceKey(result.task.id);
  return mutationOk({
    summary,
    operationId,
    effectFingerprint: fingerprint,
    receipt: result.receipt,
    resourceLinks: [resourceLink('task', result.task.id, key, result.task.title)],
    changes: [change(key, type, summary)],
    entity: result.task,
    after: result.task,
    observedRevision: String(result.task.updatedAt),
    projectionPending: true,
    replayed: extras.replayed ?? result.replayed,
    repeatedEffect: extras.repeatedEffect,
  });
}

function resultFromReceipt(receipt: TaskCommandResult['receipt']): TaskCommandResult {
  const data = receipt.resultData as { task?: Task; comment?: TaskComment } | undefined;
  if (!data?.task) throw new Error(`Receipt ${receipt.operationId} has no task result.`);
  return { task: data.task, comment: data.comment, receipt, replayed: true };
}

export function createTaskMutationTools(deps: TaskMutationToolDependencies = {}): AgentToolDefinition[] {
  const tasks = deps.tasks ?? defaultTaskMutations();
  const receipts = deps.receipts;

  const taskCreate = defineMutationTool({
    name: 'task_create',
    description: 'Create a task or subtask through the task service.',
    risk: 'local_create',
    sideEffect: 'reversible',
    inputSchema: objectSchema({
      projectId: { type: ['string', 'null'] },
      parentId: { type: 'string' },
      title: { type: 'string', minLength: 1, maxLength: TASK_TITLE_MAX_LENGTH },
      content: { type: 'string' },
      date: { type: 'string' },
      importance: { type: 'string', enum: [...TASK_IMPORTANCE] },
      assignees: { type: 'array', items: { type: 'string', minLength: 1 } },
    }, ['title']),
    resolveResourceKeys: (_context, args) => {
      const record = asRecord(args);
      if (typeof record.parentId === 'string') return [`task:${record.parentId}`];
      if (typeof record.projectId === 'string') return [`project:${record.projectId}`];
      return ['task'];
    },
    buildEffectPayload: (args) => {
      const record = asRecord(args);
      return {
        tool: 'task_create',
        projectId: record.projectId ?? null,
        parentId: record.parentId ?? null,
        title: record.title,
        content: record.content ?? '',
        date: record.date,
        importance: record.importance ?? 'medium',
        assignees: stringList(record.assignees) ?? [],
      };
    },
    async execute(context, args): Promise<AgentToolResult> {
      const record = asRecord(args);
      const operationId = context.operationId as string;
      const fingerprint = context.effectFingerprint as string;
      const prior = await resolvePriorReceipt(receipts, operationId, fingerprint);
      if (prior.kind === 'mismatch') return fail('conflict', `Operation ${operationId} was already committed with a different effect.`);
      if (prior.kind === 'replay' || prior.kind === 'repeat') {
        return taskMutationSuccess('Created task', 'created', resultFromReceipt(prior.receipt), operationId, fingerprint, {
          replayed: prior.kind === 'replay',
          repeatedEffect: prior.kind === 'repeat',
        });
      }
      const base = {
        operationId,
        effectFingerprint: fingerprint,
        title: String(record.title),
        content: asString(record.content),
        date: asString(record.date),
        importance: TASK_IMPORTANCE.includes(record.importance as TaskImportance)
          ? record.importance as TaskImportance
          : undefined,
        assignees: stringList(record.assignees),
        projectId: record.projectId === null ? null : asString(record.projectId),
      };
      try {
        const result = typeof record.parentId === 'string'
          ? await tasks.createSubtask({ ...base, parentId: record.parentId })
          : await tasks.createTask(base);
        await receipts?.put(result.receipt);
        return taskMutationSuccess(`Created task ${result.task.title}`, 'created', result, operationId, fingerprint, {});
      } catch (caught) {
        return mapMutationError(caught);
      }
    },
  });

  const taskUpdate = defineMutationTool({
    name: 'task_update',
    description: 'Update allowed task fields using an expected revision.',
    risk: 'local_update',
    sideEffect: 'reversible',
    inputSchema: objectSchema({
      taskId: { type: 'string', minLength: 1 },
      expectedUpdatedAt: { type: 'integer' },
      updates: TASK_UPDATES_SCHEMA,
    }, ['taskId', 'expectedUpdatedAt', 'updates']),
    resolveResourceKeys: (_context, args) => [`task:${asRecord(args).taskId}`],
    buildEffectPayload: (args) => {
      const record = asRecord(args);
      return {
        tool: 'task_update',
        taskId: record.taskId,
        updates: asRecord(record.updates),
      };
    },
    validateGrant: allowlistedUpdateGrant,
    async execute(context, args): Promise<AgentToolResult> {
      const record = asRecord(args);
      const operationId = context.operationId as string;
      const fingerprint = context.effectFingerprint as string;
      const prior = await resolvePriorReceipt(receipts, operationId, fingerprint);
      if (prior.kind === 'mismatch') return fail('conflict', `Operation ${operationId} was already committed with a different effect.`);
      if (prior.kind === 'replay' || prior.kind === 'repeat') {
        return taskMutationSuccess('Updated task', 'updated', resultFromReceipt(prior.receipt), operationId, fingerprint, {
          replayed: prior.kind === 'replay',
          repeatedEffect: prior.kind === 'repeat',
        });
      }
      try {
        const result = await tasks.updateTask({
          operationId,
          effectFingerprint: fingerprint,
          taskId: String(record.taskId),
          expectedUpdatedAt: asNumber(record.expectedUpdatedAt) ?? 0,
          updates: asRecord(record.updates),
        });
        await receipts?.put(result.receipt);
        return taskMutationSuccess(`Updated task ${result.task.title}`, 'updated', result, operationId, fingerprint, {});
      } catch (caught) {
        return mapMutationError(caught);
      }
    },
  });

  const taskCommentAdd = defineMutationTool({
    name: 'task_comment_add',
    description: 'Add a task comment using an expected revision.',
    risk: 'local_create',
    sideEffect: 'reversible',
    inputSchema: objectSchema({
      taskId: { type: 'string', minLength: 1 },
      expectedUpdatedAt: { type: 'integer' },
      text: { type: 'string', minLength: 1 },
    }, ['taskId', 'expectedUpdatedAt', 'text']),
    resolveResourceKeys: (_context, args) => [`task:${asRecord(args).taskId}`],
    buildEffectPayload: (args) => {
      const record = asRecord(args);
      return { tool: 'task_comment_add', taskId: record.taskId, text: record.text };
    },
    async execute(context, args): Promise<AgentToolResult> {
      const record = asRecord(args);
      const operationId = context.operationId as string;
      const fingerprint = context.effectFingerprint as string;
      const prior = await resolvePriorReceipt(receipts, operationId, fingerprint);
      if (prior.kind === 'mismatch') return fail('conflict', `Operation ${operationId} was already committed with a different effect.`);
      if (prior.kind === 'replay' || prior.kind === 'repeat') {
        return taskMutationSuccess('Added task comment', 'updated', resultFromReceipt(prior.receipt), operationId, fingerprint, {
          replayed: prior.kind === 'replay',
          repeatedEffect: prior.kind === 'repeat',
        });
      }
      try {
        const result = await tasks.addComment({
          operationId,
          effectFingerprint: fingerprint,
          taskId: String(record.taskId),
          expectedUpdatedAt: asNumber(record.expectedUpdatedAt) ?? 0,
          text: String(record.text),
        });
        await receipts?.put(result.receipt);
        const commentId = result.comment?.id;
        const extra = commentId
          ? [resourceLink('task_comment', commentId, `task:${result.task.id}:comment:${commentId}`, 'comment')]
          : [];
        const key = taskResourceKey(result.task.id);
        return mutationOk({
          summary: `Added comment on ${result.task.title}`,
          operationId,
          effectFingerprint: fingerprint,
          receipt: result.receipt,
          resourceLinks: [resourceLink('task', result.task.id, key, result.task.title), ...extra],
          changes: [change(key, 'updated', 'comment added')],
          entity: result.comment,
          after: result.task,
          observedRevision: String(result.task.updatedAt),
          projectionPending: true,
        });
      } catch (caught) {
        return mapMutationError(caught);
      }
    },
  });

  const taskSoftDelete = defineMutationTool({
    name: 'task_soft_delete',
    description: 'Move a task to trash using an expected revision.',
    risk: 'local_delete',
    sideEffect: 'irreversible',
    supportsRetry: true,
    inputSchema: objectSchema({
      taskId: { type: 'string', minLength: 1 },
      expectedUpdatedAt: { type: 'integer' },
      reason: { type: 'string', minLength: 1 },
    }, ['taskId', 'expectedUpdatedAt', 'reason']),
    resolveResourceKeys: (_context, args) => [`task:${asRecord(args).taskId}`],
    buildEffectPayload: (args) => {
      const record = asRecord(args);
      return { tool: 'task_soft_delete', taskId: record.taskId, reason: record.reason };
    },
    async execute(context, args): Promise<AgentToolResult> {
      const record = asRecord(args);
      const operationId = context.operationId as string;
      const fingerprint = context.effectFingerprint as string;
      const prior = await resolvePriorReceipt(receipts, operationId, fingerprint);
      if (prior.kind === 'mismatch') return fail('conflict', `Operation ${operationId} was already committed with a different effect.`);
      if (prior.kind === 'replay' || prior.kind === 'repeat') {
        return taskMutationSuccess('Soft deleted task', 'deleted', resultFromReceipt(prior.receipt), operationId, fingerprint, {
          replayed: prior.kind === 'replay',
          repeatedEffect: prior.kind === 'repeat',
        });
      }
      try {
        const result = await tasks.softDeleteTask({
          operationId,
          effectFingerprint: fingerprint,
          taskId: String(record.taskId),
          expectedUpdatedAt: asNumber(record.expectedUpdatedAt) ?? 0,
          reason: String(record.reason),
        });
        await receipts?.put(result.receipt);
        return taskMutationSuccess(`Moved ${result.task.title} to trash`, 'deleted', result, operationId, fingerprint, {});
      } catch (caught) {
        return mapMutationError(caught);
      }
    },
  });

  return [taskCreate, taskUpdate, taskCommentAdd, taskSoftDelete];
}
