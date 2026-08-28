import { nanoid } from 'nanoid';
import type { Project, Task, TaskComment, TaskImportance, TaskStatus } from '../../types';
import { TASK_TITLE_MAX_LENGTH } from '../../types';
import type { AgentOperationReceipt } from '../../types/agent';
import { db, type TabsDB } from '../db';
import {
  enqueueTaskProjection,
  projectIndexPath,
  serializeProjectIndex,
  serializeTaskMarkdown,
  taskProjectionPath,
} from './taskProjectionWorker';

export const TASK_UPDATE_FIELDS = [
  'title',
  'content',
  'status',
  'importance',
  'date',
  'projectId',
  'assignees',
] as const;

export type TaskUpdateField = (typeof TASK_UPDATE_FIELDS)[number];
export type TaskUpdates = Partial<Pick<Task, TaskUpdateField>>;

interface OperationInput {
  operationId: string;
  effectFingerprint: string;
}

export interface CreateTaskInput extends OperationInput {
  title: string;
  content?: string;
  status?: TaskStatus;
  importance?: TaskImportance;
  date?: string;
  projectId?: string | null;
  assignees?: string[];
  sourcePath?: string;
  sourceChatMessageId?: string;
  order?: number;
}

export interface CreateSubtaskInput extends CreateTaskInput {
  parentId: string;
}

export interface UpdateTaskInput extends OperationInput {
  taskId: string;
  expectedUpdatedAt: number;
  updates: TaskUpdates;
}

export interface AddTaskCommentInput extends OperationInput {
  taskId: string;
  expectedUpdatedAt: number;
  text: string;
  sender?: string;
  replyTo?: TaskComment['replyTo'];
  attachmentDataUrl?: string;
  attachmentName?: string;
  attachmentMimeType?: string;
  attachmentSizeBytes?: number;
  attachmentPreviewDataUrl?: string;
  id?: string;
  createdAt?: number;
}

export interface SoftDeleteTaskInput extends OperationInput {
  taskId: string;
  expectedUpdatedAt: number;
  reason: string;
}

export interface TaskCommandResult {
  task: Task;
  comment?: TaskComment;
  receipt: AgentOperationReceipt;
  replayed: boolean;
}

export interface ProjectProjectionInput extends OperationInput {
  projectId: string;
  name?: string;
  color?: string;
}

export class TaskNotFoundError extends Error {
  constructor(taskId: string) {
    super(`Task ${taskId} was not found.`);
    this.name = 'TaskNotFoundError';
  }
}

export class TaskRevisionConflictError extends Error {
  readonly taskId: string;
  readonly expectedUpdatedAt: number;
  readonly actualUpdatedAt: number;

  constructor(taskId: string, expectedUpdatedAt: number, actualUpdatedAt: number) {
    super(`Task ${taskId} changed since revision ${expectedUpdatedAt}; current revision is ${actualUpdatedAt}.`);
    this.name = 'TaskRevisionConflictError';
    this.taskId = taskId;
    this.expectedUpdatedAt = expectedUpdatedAt;
    this.actualUpdatedAt = actualUpdatedAt;
  }
}

export class OperationReplayMismatchError extends Error {
  constructor(operationId: string) {
    super(`Operation ${operationId} was already committed with a different effect.`);
    this.name = 'OperationReplayMismatchError';
  }
}

function requireOperation(input: OperationInput): void {
  if (!input.operationId.trim()) throw new Error('operationId is required.');
  if (!input.effectFingerprint.trim()) throw new Error('effectFingerprint is required.');
}

function normalizeTitle(title: string): string {
  const normalized = title.trim();
  if (!normalized) throw new Error('Task title is required.');
  if (normalized.length > TASK_TITLE_MAX_LENGTH) {
    throw new Error(`Task title must be at most ${TASK_TITLE_MAX_LENGTH} characters.`);
  }
  return normalized;
}

function requireDate(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new Error('Task date must use YYYY-MM-DD.');
  }
  return date;
}

function normalizeAssignees(assignees: string[]): string[] {
  if (!assignees.every((value) => typeof value === 'string' && value.trim().length > 0)) {
    throw new Error('Task assignees must be non-empty strings.');
  }
  return Array.from(new Set(assignees.map((value) => value.trim())));
}

function validateStatus(status: TaskStatus): TaskStatus {
  if (!(['pending', 'in_progress', 'completed'] as const).includes(status)) {
    throw new Error('Invalid task status.');
  }
  return status;
}

function validateImportance(importance: TaskImportance): TaskImportance {
  if (!(['low', 'medium', 'high'] as const).includes(importance)) {
    throw new Error('Invalid task importance.');
  }
  return importance;
}

function normalizeUpdates(updates: TaskUpdates): TaskUpdates {
  const keys = Object.keys(updates);
  if (keys.length === 0) throw new Error('At least one task update field is required.');
  for (const key of keys) {
    if (!(TASK_UPDATE_FIELDS as readonly string[]).includes(key)) {
      throw new Error(`Task update field ${key} is not allowed.`);
    }
  }

  const normalized: TaskUpdates = { ...updates };
  if (updates.title !== undefined) normalized.title = normalizeTitle(updates.title);
  if (updates.status !== undefined) normalized.status = validateStatus(updates.status);
  if (updates.importance !== undefined) normalized.importance = validateImportance(updates.importance);
  if (updates.date !== undefined) normalized.date = requireDate(updates.date);
  if (updates.assignees !== undefined) normalized.assignees = normalizeAssignees(updates.assignees);
  return normalized;
}

function nextUpdatedAt(previous: number, clock: () => number): number {
  return Math.max(clock(), previous + 1);
}

function resultFromReceipt(receipt: AgentOperationReceipt): TaskCommandResult {
  const data = receipt.resultData as { task?: Task; comment?: TaskComment } | undefined;
  if (!data?.task) throw new Error(`Receipt ${receipt.operationId} has no task result.`);
  return { task: data.task, comment: data.comment, receipt, replayed: true };
}

export class TaskService {
  private readonly database: TabsDB;
  private readonly clock: () => number;

  constructor(database: TabsDB = db, clock: () => number = Date.now) {
    this.database = database;
    this.clock = clock;
  }

  private taskTransactionTables() {
    return [
      this.database.tasks,
      this.database.projects,
      this.database.taskComments,
      this.database.agentOperationReceipts,
      this.database.taskProjectionJobs,
    ] as const;
  }

  private async enqueueTaskEffects(input: OperationInput, task: Task, previous?: Task): Promise<void> {
    const now = this.clock();
    const project = task.projectId ? await this.database.projects.get(task.projectId) : undefined;
    const previousProject = previous?.projectId
      ? await this.database.projects.get(previous.projectId)
      : undefined;
    const targetPath = taskProjectionPath(task, project);
    const oldPath = previous ? taskProjectionPath(previous, previousProject) : undefined;
    const comments = await this.database.taskComments.where('taskId').equals(task.id).toArray();
    await enqueueTaskProjection(this.database, {
      sourceOperationId: input.operationId,
      taskId: task.id,
      projectId: task.projectId ?? undefined,
      projectionKey: `task:${task.id}`,
      kind: task.deletedAt ? 'remove_path' : 'write_task',
      desiredRevision: String(task.updatedAt),
      targetPath,
      stalePaths: oldPath ? [oldPath] : [],
      serializedContent: task.deletedAt ? undefined : serializeTaskMarkdown(task, project, comments),
    }, now);

    const affectedProjectIds = new Set<string | null>([task.projectId]);
    if (previous) affectedProjectIds.add(previous.projectId);
    for (const projectId of affectedProjectIds) {
      const affectedProject = projectId ? await this.database.projects.get(projectId) : undefined;
      const tasks = projectId
        ? await this.database.tasks.where('projectId').equals(projectId).toArray()
        : await this.database.tasks.filter((item) => item.projectId === null).toArray();
      await enqueueTaskProjection(this.database, {
        sourceOperationId: input.operationId,
        projectId: projectId ?? undefined,
        projectionKey: `project-index:${projectId ?? 'inbox'}`,
        kind: 'write_project_index',
        desiredRevision: `${affectedProject?.name ?? 'Inbox'}:${Math.max(0, ...tasks.map((item) => item.updatedAt))}`,
        targetPath: projectIndexPath(affectedProject),
        serializedContent: serializeProjectIndex(affectedProject, tasks),
      }, now);
    }
  }

  private async replay(input: OperationInput): Promise<TaskCommandResult | undefined> {
    requireOperation(input);
    const receipt = await this.database.agentOperationReceipts
      .where('operationId')
      .equals(input.operationId)
      .first();
    if (!receipt) return undefined;
    if (receipt.effectFingerprint !== input.effectFingerprint) {
      throw new OperationReplayMismatchError(input.operationId);
    }
    return resultFromReceipt(receipt);
  }

  private receipt(
    input: OperationInput,
    operation: string,
    task: Task,
    comment?: TaskComment,
  ): AgentOperationReceipt {
    return {
      id: `task-receipt:${input.operationId}`,
      operationId: input.operationId,
      effectFingerprint: input.effectFingerprint,
      domain: 'tasks',
      resourceKeys: [`task:${task.id}`],
      status: 'committed',
      resultSummary: operation,
      resultData: { task, comment },
      committedAt: this.clock(),
    };
  }

  async createTask(input: CreateTaskInput): Promise<TaskCommandResult> {
    const replay = await this.replay(input);
    if (replay) return replay;
    const now = this.clock();
    const task: Task = {
      id: nanoid(8),
      title: normalizeTitle(input.title),
      content: input.content ?? '',
      status: validateStatus(input.status ?? 'pending'),
      importance: validateImportance(input.importance ?? 'medium'),
      date: requireDate(input.date ?? new Date(now).toISOString().slice(0, 10)),
      projectId: input.projectId ?? null,
      assignees: normalizeAssignees(input.assignees ?? []),
      createdAt: now,
      updatedAt: now,
      sourcePath: input.sourcePath,
      sourceChatMessageId: input.sourceChatMessageId,
      order: input.order ?? await this.database.tasks.count(),
    };
    const receipt = this.receipt(input, 'task created', task);
    return this.database.transaction('rw', ...this.taskTransactionTables(), async () => {
      const raced = await this.replay(input);
      if (raced) return raced;
      await this.database.tasks.add(task);
      await this.database.agentOperationReceipts.add(receipt);
      await this.enqueueTaskEffects(input, task);
      return { task, receipt, replayed: false };
    });
  }

  async createSubtask(input: CreateSubtaskInput): Promise<TaskCommandResult> {
    const replay = await this.replay(input);
    if (replay) return replay;
    const parent = await this.database.tasks.get(input.parentId);
    if (!parent || parent.deletedAt) throw new TaskNotFoundError(input.parentId);
    const now = this.clock();
    const task: Task = {
      id: nanoid(8),
      title: normalizeTitle(input.title),
      content: input.content ?? '',
      status: validateStatus(input.status ?? 'in_progress'),
      importance: validateImportance(input.importance ?? 'medium'),
      date: requireDate(input.date ?? parent.date),
      projectId: input.projectId === undefined ? parent.projectId : input.projectId,
      assignees: normalizeAssignees(input.assignees ?? []),
      createdAt: now,
      updatedAt: now,
      sourcePath: input.sourcePath,
      sourceChatMessageId: input.sourceChatMessageId,
      order: input.order ?? 0,
      parentId: parent.id,
    };
    const receipt = this.receipt(input, 'subtask created', task);
    return this.database.transaction('rw', ...this.taskTransactionTables(), async () => {
      const raced = await this.replay(input);
      if (raced) return raced;
      const currentParent = await this.database.tasks.get(input.parentId);
      if (!currentParent || currentParent.deletedAt) throw new TaskNotFoundError(input.parentId);
      await this.database.tasks.add(task);
      await this.database.agentOperationReceipts.add(receipt);
      await this.enqueueTaskEffects(input, task);
      return { task, receipt, replayed: false };
    });
  }

  async updateTask(input: UpdateTaskInput): Promise<TaskCommandResult> {
    const replay = await this.replay(input);
    if (replay) return replay;
    const updates = normalizeUpdates(input.updates);
    return this.database.transaction('rw', ...this.taskTransactionTables(), async () => {
      const raced = await this.replay(input);
      if (raced) return raced;
      const current = await this.database.tasks.get(input.taskId);
      if (!current || current.deletedAt) throw new TaskNotFoundError(input.taskId);
      if (current.updatedAt !== input.expectedUpdatedAt) {
        throw new TaskRevisionConflictError(input.taskId, input.expectedUpdatedAt, current.updatedAt);
      }
      const changed = Object.entries(updates).some(([key, value]) => {
        const currentValue = current[key as TaskUpdateField];
        return Array.isArray(value)
          ? JSON.stringify(value) !== JSON.stringify(currentValue)
          : value !== currentValue;
      });
      const task = changed
        ? { ...current, ...updates, updatedAt: nextUpdatedAt(current.updatedAt, this.clock) }
        : current;
      if (changed) await this.database.tasks.put(task);
      const receipt = this.receipt(input, changed ? 'task updated' : 'task unchanged', task);
      await this.database.agentOperationReceipts.add(receipt);
      await this.enqueueTaskEffects(input, task, current);
      return { task, receipt, replayed: false };
    });
  }

  async addComment(input: AddTaskCommentInput): Promise<TaskCommandResult> {
    const replay = await this.replay(input);
    if (replay) return replay;
    const text = input.text.trim();
    if (!text && !input.attachmentDataUrl) throw new Error('A task comment needs text or an attachment.');
    return this.database.transaction(
      'rw',
      ...this.taskTransactionTables(),
      async () => {
        const raced = await this.replay(input);
        if (raced) return raced;
        const current = await this.database.tasks.get(input.taskId);
        if (!current || current.deletedAt) throw new TaskNotFoundError(input.taskId);
        if (current.updatedAt !== input.expectedUpdatedAt) {
          throw new TaskRevisionConflictError(input.taskId, input.expectedUpdatedAt, current.updatedAt);
        }
        const createdAt = input.createdAt ?? this.clock();
        const comment: TaskComment = {
          id: input.id ?? nanoid(8),
          taskId: input.taskId,
          sender: input.sender?.trim() || 'You',
          text,
          replyTo: input.replyTo,
          attachmentDataUrl: input.attachmentDataUrl,
          attachmentName: input.attachmentName,
          attachmentMimeType: input.attachmentMimeType,
          attachmentSizeBytes: input.attachmentSizeBytes,
          attachmentPreviewDataUrl: input.attachmentPreviewDataUrl,
          createdAt,
        };
        const task = { ...current, updatedAt: nextUpdatedAt(current.updatedAt, this.clock) };
        const receipt = this.receipt(input, 'task comment added', task, comment);
        await this.database.taskComments.add(comment);
        await this.database.tasks.put(task);
        await this.database.agentOperationReceipts.add(receipt);
        await this.enqueueTaskEffects(input, task, current);
        return { task, comment, receipt, replayed: false };
      },
    );
  }

  async softDeleteTask(input: SoftDeleteTaskInput): Promise<TaskCommandResult> {
    const replay = await this.replay(input);
    if (replay) return replay;
    if (!input.reason.trim()) throw new Error('A soft-delete reason is required.');
    return this.database.transaction('rw', ...this.taskTransactionTables(), async () => {
      const raced = await this.replay(input);
      if (raced) return raced;
      const current = await this.database.tasks.get(input.taskId);
      if (!current || current.deletedAt) throw new TaskNotFoundError(input.taskId);
      if (current.updatedAt !== input.expectedUpdatedAt) {
        throw new TaskRevisionConflictError(input.taskId, input.expectedUpdatedAt, current.updatedAt);
      }
      const changedAt = nextUpdatedAt(current.updatedAt, this.clock);
      const task = { ...current, deletedAt: changedAt, updatedAt: changedAt };
      const receipt = this.receipt(input, 'task soft deleted', task);
      await this.database.tasks.put(task);
      await this.database.agentOperationReceipts.add(receipt);
      await this.enqueueTaskEffects(input, task, current);
      return { task, receipt, replayed: false };
    });
  }

  async createProjectProjection(project: Project, input: OperationInput): Promise<Project> {
    requireOperation(input);
    return this.database.transaction('rw', ...this.taskTransactionTables(), async () => {
      await this.database.projects.add(project);
      await enqueueTaskProjection(this.database, {
        sourceOperationId: input.operationId,
        projectId: project.id,
        projectionKey: `project-index:${project.id}`,
        kind: 'write_project_index',
        desiredRevision: `${project.name}:0`,
        targetPath: projectIndexPath(project),
        serializedContent: serializeProjectIndex(project, []),
      }, this.clock());
      return project;
    });
  }

  async updateProjectProjection(input: ProjectProjectionInput): Promise<Project> {
    requireOperation(input);
    return this.database.transaction('rw', ...this.taskTransactionTables(), async () => {
      const current = await this.database.projects.get(input.projectId);
      if (!current) throw new Error(`Project ${input.projectId} was not found.`);
      const next: Project = {
        ...current,
        ...(input.name === undefined ? {} : { name: normalizeTitle(input.name) }),
        ...(input.color === undefined ? {} : { color: input.color }),
      };
      await this.database.projects.put(next);
      if (next.name !== current.name) {
        const tasks = await this.database.tasks.where('projectId').equals(next.id).toArray();
        const now = this.clock();
        for (const task of tasks) {
          const comments = await this.database.taskComments.where('taskId').equals(task.id).toArray();
          await enqueueTaskProjection(this.database, {
            sourceOperationId: input.operationId,
            taskId: task.id,
            projectId: next.id,
            projectionKey: `task:${task.id}`,
            kind: task.deletedAt ? 'remove_path' : 'write_task',
            desiredRevision: String(task.updatedAt),
            targetPath: taskProjectionPath(task, next),
            stalePaths: [taskProjectionPath(task, current)],
            serializedContent: task.deletedAt ? undefined : serializeTaskMarkdown(task, next, comments),
          }, now);
        }
        await enqueueTaskProjection(this.database, {
          sourceOperationId: input.operationId,
          projectId: next.id,
          projectionKey: `project-index:${next.id}`,
          kind: 'write_project_index',
          desiredRevision: `${next.name}:${Math.max(0, ...tasks.map((task) => task.updatedAt))}`,
          targetPath: projectIndexPath(next),
          stalePaths: [projectIndexPath(current)],
          serializedContent: serializeProjectIndex(next, tasks),
        }, now);
      }
      return next;
    });
  }

  async getTask(taskId: string): Promise<Task | undefined> {
    return this.database.tasks.get(taskId);
  }

  async listTasks(filters: {
    projectId?: string | null;
    status?: TaskStatus;
    parentId?: string;
    query?: string;
    includeDeleted?: boolean;
  } = {}): Promise<Task[]> {
    let tasks = await this.database.tasks.toArray();
    if (!filters.includeDeleted) tasks = tasks.filter((task) => !task.deletedAt);
    if (filters.projectId !== undefined) {
      tasks = tasks.filter((task) => task.projectId === filters.projectId);
    }
    if (filters.status) tasks = tasks.filter((task) => task.status === filters.status);
    if (filters.parentId !== undefined) {
      tasks = filters.parentId
        ? tasks.filter((task) => task.parentId === filters.parentId)
        : tasks.filter((task) => !task.parentId);
    }
    const query = filters.query?.trim().toLowerCase();
    if (query) {
      tasks = tasks.filter((task) => (
        task.title.toLowerCase().includes(query)
        || task.content.toLowerCase().includes(query)
      ));
    }
    return tasks.sort((left, right) => left.order - right.order || left.createdAt - right.createdAt);
  }

  async listSubtasks(parentId: string): Promise<Task[]> {
    return this.listTasks({ parentId });
  }

  async listTaskComments(taskId: string): Promise<TaskComment[]> {
    const comments = await this.database.taskComments.where('taskId').equals(taskId).toArray();
    return comments.sort((left, right) => left.createdAt - right.createdAt);
  }

  async listProjects(): Promise<Project[]> {
    const projects = await this.database.projects.toArray();
    return projects.sort((left, right) => left.createdAt - right.createdAt);
  }

  async getProject(projectId: string): Promise<Project | undefined> {
    return this.database.projects.get(projectId);
  }

  async restoreTask(taskId: string): Promise<Task | undefined> {
    const operation = localTaskOperation('restore');
    return this.database.transaction('rw', ...this.taskTransactionTables(), async () => {
      const current = await this.database.tasks.get(taskId);
      if (!current) return undefined;
      const task = { ...current, deletedAt: undefined, updatedAt: nextUpdatedAt(current.updatedAt, this.clock) };
      await this.database.tasks.put(task);
      await this.enqueueTaskEffects(operation, task, current);
      return task;
    });
  }

  async permanentlyDeleteTask(taskId: string): Promise<void> {
    const operation = localTaskOperation('permanent-delete');
    await this.database.transaction('rw', ...this.taskTransactionTables(), async () => {
      const current = await this.database.tasks.get(taskId);
      if (!current) return;
      await this.database.taskComments.where('taskId').equals(taskId).delete();
      await this.database.tasks.delete(taskId);
      const changedAt = nextUpdatedAt(current.updatedAt, this.clock);
      await this.enqueueTaskEffects(
        operation,
        { ...current, updatedAt: changedAt, deletedAt: changedAt },
        current,
      );
    });
  }

  async reorderSubtasks(orderedIds: string[]): Promise<Task[]> {
    return this.database.transaction('rw', ...this.taskTransactionTables(), async () => {
      const changed: Task[] = [];
      for (let order = 0; order < orderedIds.length; order += 1) {
        const id = orderedIds[order];
        const current = await this.database.tasks.get(id);
        if (!current || current.order === order) continue;
        const task = { ...current, order, updatedAt: nextUpdatedAt(current.updatedAt, this.clock) };
        await this.database.tasks.put(task);
        await this.enqueueTaskEffects(localTaskOperation('reorder'), task, current);
        changed.push(task);
      }
      return changed;
    });
  }

  async updateComment(commentId: string, text: string): Promise<TaskComment | undefined> {
    const normalized = text.trim();
    const operation = localTaskOperation('update-comment');
    return this.database.transaction('rw', ...this.taskTransactionTables(), async () => {
      const comment = await this.database.taskComments.get(commentId);
      if (!comment) return undefined;
      const updated = { ...comment, text: normalized };
      await this.database.taskComments.put(updated);
      const task = await this.database.tasks.get(comment.taskId);
      if (task) {
        const changed = { ...task, updatedAt: nextUpdatedAt(task.updatedAt, this.clock) };
        await this.database.tasks.put(changed);
        await this.enqueueTaskEffects(operation, changed, task);
      }
      return updated;
    });
  }

  async deleteComment(commentId: string): Promise<void> {
    const operation = localTaskOperation('delete-comment');
    await this.database.transaction('rw', ...this.taskTransactionTables(), async () => {
      const comment = await this.database.taskComments.get(commentId);
      if (!comment) return;
      await this.database.taskComments.delete(commentId);
      const task = await this.database.tasks.get(comment.taskId);
      if (task) {
        const changed = { ...task, updatedAt: nextUpdatedAt(task.updatedAt, this.clock) };
        await this.database.tasks.put(changed);
        await this.enqueueTaskEffects(operation, changed, task);
      }
    });
  }

  async clearComments(taskId: string): Promise<void> {
    const operation = localTaskOperation('clear-comments');
    await this.database.transaction('rw', ...this.taskTransactionTables(), async () => {
      const count = await this.database.taskComments.where('taskId').equals(taskId).delete();
      if (count > 0) {
        const task = await this.database.tasks.get(taskId);
        if (task) {
          const changed = { ...task, updatedAt: nextUpdatedAt(task.updatedAt, this.clock) };
          await this.database.tasks.put(changed);
          await this.enqueueTaskEffects(operation, changed, task);
        }
      }
    });
  }
}

export const taskService = new TaskService();

export function localTaskOperation(prefix: string): OperationInput {
  const operationId = `local:${prefix}:${nanoid()}`;
  return { operationId, effectFingerprint: operationId };
}
