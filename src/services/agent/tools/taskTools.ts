// ---------------------------------------------------------------------------
// TABS Work-OS Harness — Task and project read tools
// Mutation handlers land in a later phase. Reads go through TaskService.
// ---------------------------------------------------------------------------

import type { Project, Task, TaskComment, TaskImportance, TaskStatus } from '../../../types';
import type { AgentToolDefinition, AgentToolResult, ToolExecutionContext } from '../../../types/agent';
import { taskService } from '../../tasks/taskService';
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

export { TASK_READ_TOOL_NAMES };

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
