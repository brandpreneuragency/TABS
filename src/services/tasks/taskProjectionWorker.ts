import { nanoid } from 'nanoid';
import type { Project, Task, TaskComment } from '../../types';
import type { TaskProjectionJob, TaskProjectionJobKind } from '../../types/agent';
import { db, type TabsDB } from '../db';

export const TASK_PROJECTION_STATES = [
  'queued',
  'running',
  'retry_wait',
  'succeeded',
  'superseded',
  'failed',
] as const;
export const TASK_PROJECTION_MAX_ATTEMPTS = 5;
export const TASK_PROJECTION_BACKOFF_MS = [250, 500, 1_000, 2_000] as const;

export interface TaskProjectionWrite {
  targetPath: string;
  serializedContent?: string;
  stalePaths: string[];
}

export type TaskProjectionWriter = (write: TaskProjectionWrite) => Promise<void>;

function safeSegment(value: string): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'untitled';
}

export function projectDirectory(project: Project | undefined): string {
  return project ? `${safeSegment(project.name)}--${project.id}` : '_inbox';
}

export function taskProjectionPath(task: Task, project?: Project): string {
  return `${projectDirectory(project)}/${safeSegment(task.title)}--${task.id}.md`;
}

export function projectIndexPath(project: Project | undefined): string {
  return `${projectDirectory(project)}/INDEX.md`;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

export function serializeTaskMarkdown(
  task: Task,
  project: Project | undefined,
  comments: TaskComment[],
): string {
  const lines = [
    '---',
    `id: ${yamlString(task.id)}`,
    `title: ${yamlString(task.title)}`,
    `status: ${yamlString(task.status)}`,
    `importance: ${yamlString(task.importance)}`,
    `date: ${yamlString(task.date)}`,
    `project_id: ${task.projectId ? yamlString(task.projectId) : 'null'}`,
    `project: ${project ? yamlString(project.name) : 'null'}`,
    `parent_id: ${task.parentId ? yamlString(task.parentId) : 'null'}`,
    `assignees: ${JSON.stringify(task.assignees)}`,
    `created_at: ${task.createdAt}`,
    `updated_at: ${task.updatedAt}`,
    `deleted_at: ${task.deletedAt ?? 'null'}`,
    '---',
    '',
    `# ${task.title}`,
    '',
    task.content,
  ];

  if (comments.length > 0) {
    lines.push('', '## Comments', '');
    for (const comment of comments.sort((a, b) => a.createdAt - b.createdAt)) {
      lines.push(`- **${comment.sender || 'You'}** (${comment.createdAt}): ${comment.text}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export function serializeProjectIndex(project: Project | undefined, tasks: Task[]): string {
  const title = project?.name ?? 'Inbox';
  const active = tasks
    .filter((task) => !task.deletedAt)
    .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const lines = [
    '---',
    `project_id: ${project ? yamlString(project.id) : 'null'}`,
    `project: ${yamlString(title)}`,
    '---',
    '',
    `# ${title}`,
    '',
  ];
  if (active.length === 0) lines.push('_No tasks._');
  for (const task of active) {
    const marker = task.status === 'completed' ? 'x' : ' ';
    lines.push(`- [${marker}] [${task.title}](./${safeSegment(task.title)}--${task.id}.md)`);
  }
  return `${lines.join('\n')}\n`;
}

export interface ProjectionJobInput {
  sourceOperationId: string;
  taskId?: string;
  projectId?: string;
  projectionKey: string;
  kind: TaskProjectionJobKind;
  desiredRevision: string;
  targetPath: string;
  stalePaths?: string[];
  serializedContent?: string;
}

/** Must be called inside the same Dexie transaction as the domain mutation. */
export async function enqueueTaskProjection(
  database: TabsDB,
  input: ProjectionJobInput,
  now: number,
): Promise<TaskProjectionJob> {
  const prior = await database.taskProjectionJobs
    .where('projectionKey')
    .equals(input.projectionKey)
    .filter((job) => job.status === 'queued' || job.status === 'running' || job.status === 'retry_wait')
    .toArray();
  await Promise.all(prior.map((job) => database.taskProjectionJobs.update(job.id, {
    status: 'superseded',
    finishedAt: now,
  })));

  const job: TaskProjectionJob = {
    id: `task-projection:${input.sourceOperationId}:${input.projectionKey}`,
    sourceOperationId: input.sourceOperationId,
    taskId: input.taskId,
    projectId: input.projectId,
    projectionKey: input.projectionKey,
    kind: input.kind,
    desiredRevision: input.desiredRevision,
    targetPath: input.targetPath,
    stalePaths: Array.from(new Set(input.stalePaths ?? [])).filter((path) => path !== input.targetPath),
    serializedContent: input.serializedContent,
    status: 'queued',
    attempt: 0,
    maxAttempts: TASK_PROJECTION_MAX_ATTEMPTS,
    nextAttemptAt: now,
    createdAt: now,
  };
  await database.taskProjectionJobs.add(job);
  return job;
}

async function nativeProjectionWriter(write: TaskProjectionWrite): Promise<void> {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
    throw new Error('Task projection is available only in the Tauri desktop runtime.');
  }
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('task_projection_apply', {
    targetPath: write.targetPath,
    serializedContent: write.serializedContent ?? null,
    stalePaths: write.stalePaths,
  });
}

export class TaskProjectionWorker {
  private stopped = true;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly database: TabsDB;
  private readonly writer: TaskProjectionWriter;
  private readonly clock: () => number;
  private readonly schedule: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;

  constructor(
    database: TabsDB = db,
    writer: TaskProjectionWriter = nativeProjectionWriter,
    clock: () => number = Date.now,
    schedule: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout> = setTimeout,
  ) {
    this.database = database;
    this.writer = writer;
    this.clock = clock;
    this.schedule = schedule;
  }

  async recoverInterruptedJobs(): Promise<number> {
    const now = this.clock();
    return this.database.taskProjectionJobs.where('status').equals('running').modify({
      status: 'retry_wait',
      nextAttemptAt: now,
      lastError: 'Projection worker restarted during an attempt.',
    });
  }

  private async claimNext(): Promise<TaskProjectionJob | undefined> {
    const now = this.clock();
    return this.database.transaction('rw', this.database.taskProjectionJobs, async () => {
      const candidates = await this.database.taskProjectionJobs
        .where('[status+nextAttemptAt]')
        .between(['queued', DexieMinKey], ['retry_wait', now], true, true)
        .filter((job) => (job.status === 'queued' || job.status === 'retry_wait') && job.nextAttemptAt <= now)
        .sortBy('createdAt');
      const job = candidates[0];
      if (!job) return undefined;

      const newer = await this.database.taskProjectionJobs
        .where('projectionKey')
        .equals(job.projectionKey)
        .filter((candidate) => candidate.id !== job.id && candidate.createdAt >= job.createdAt
          && candidate.status !== 'superseded' && candidate.status !== 'failed')
        .first();
      if (newer) {
        await this.database.taskProjectionJobs.update(job.id, { status: 'superseded', finishedAt: now });
        return undefined;
      }
      const attempt = job.attempt + 1;
      await this.database.taskProjectionJobs.update(job.id, { status: 'running', attempt, lastError: undefined });
      return { ...job, status: 'running', attempt };
    });
  }

  async runOnce(): Promise<TaskProjectionJob | undefined> {
    const job = await this.claimNext();
    if (!job) return undefined;
    try {
      await this.writer({
        targetPath: job.targetPath,
        serializedContent: job.kind === 'remove_path' ? undefined : job.serializedContent,
        stalePaths: job.stalePaths,
      });
      const now = this.clock();
      const status = await this.database.transaction('rw', this.database.taskProjectionJobs, async () => {
        const current = await this.database.taskProjectionJobs.get(job.id);
        if (current?.status === 'superseded') return 'superseded' as const;
        await this.database.taskProjectionJobs.update(job.id, {
          status: 'succeeded',
          finishedAt: now,
          lastError: undefined,
        });
        return 'succeeded' as const;
      });
      return { ...job, status, finishedAt: now };
    } catch (error) {
      const now = this.clock();
      const lastError = error instanceof Error ? error.message : 'Task projection failed.';
      const current = await this.database.taskProjectionJobs.get(job.id);
      if (current?.status === 'superseded') {
        return { ...job, status: 'superseded', finishedAt: current.finishedAt ?? now };
      }
      if (job.attempt >= job.maxAttempts) {
        await this.database.taskProjectionJobs.update(job.id, { status: 'failed', finishedAt: now, lastError });
        return { ...job, status: 'failed', finishedAt: now, lastError };
      }
      const delay = TASK_PROJECTION_BACKOFF_MS[Math.min(job.attempt - 1, TASK_PROJECTION_BACKOFF_MS.length - 1)];
      const nextAttemptAt = now + delay;
      await this.database.taskProjectionJobs.update(job.id, { status: 'retry_wait', nextAttemptAt, lastError });
      return { ...job, status: 'retry_wait', nextAttemptAt, lastError };
    }
  }

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    await this.recoverInterruptedJobs();
    const pump = async () => {
      if (this.stopped) return;
      await this.runOnce();
      this.timer = this.schedule(() => { void pump(); }, 250);
    };
    await pump();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

// Dexie accepts this sentinel in compound-index ranges but does not export a
// browser-stable named constant from the module's default import.
const DexieMinKey = -Infinity;

export const taskProjectionWorker = new TaskProjectionWorker();

export function projectionOperationId(prefix: string): string {
  return `local:projection:${prefix}:${nanoid()}`;
}
