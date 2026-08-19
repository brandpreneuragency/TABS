import 'fake-indexeddb/auto';

import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../types';
import { db } from '../db';
import { TaskService } from './taskService';
import {
  enqueueTaskProjection,
  projectIndexPath,
  TaskProjectionWorker,
  TASK_PROJECTION_MAX_ATTEMPTS,
  taskProjectionPath,
} from './taskProjectionWorker';

const DB_NAME = 'ZenEditorDB';
let now = 10_000;
let service: TaskService;

function operation(operationId: string) {
  return { operationId, effectFingerprint: `effect:${operationId}` };
}

async function resetDatabase(): Promise<void> {
  db.close();
  await Dexie.delete(DB_NAME);
}

beforeEach(async () => {
  await resetDatabase();
  now = 10_000;
  service = new TaskService(db, () => now++);
  await db.open();
});

afterEach(resetDatabase);

describe('task projection transaction enqueueing', () => {
  it('stores the exact task and project-index snapshots in the task transaction', async () => {
    const result = await service.createTask({
      ...operation('create-exact'),
      title: 'Exact Snapshot',
      content: '{"type":"doc","content":[]}',
      date: '2026-08-19',
    });
    const jobs = await db.taskProjectionJobs.where('sourceOperationId').equals('create-exact').toArray();

    expect(jobs).toHaveLength(2);
    const taskJob = jobs.find((job) => job.kind === 'write_task');
    expect(taskJob).toMatchObject({
      sourceOperationId: 'create-exact',
      projectionKey: `task:${result.task.id}`,
      desiredRevision: String(result.task.updatedAt),
      targetPath: taskProjectionPath(result.task),
      status: 'queued',
      attempt: 0,
      maxAttempts: TASK_PROJECTION_MAX_ATTEMPTS,
    });
    expect(taskJob?.serializedContent).toContain('# Exact Snapshot');
    expect(taskJob?.serializedContent).toContain('{"type":"doc","content":[]}');
    expect(jobs.find((job) => job.kind === 'write_project_index')).toMatchObject({
      projectionKey: 'project-index:inbox',
      targetPath: '_inbox/INDEX.md',
    });
  });

  it('enqueues task moves, stale task paths, and both affected project indexes', async () => {
    const first: Project = { id: 'first', name: 'First Project', color: 'blue', createdAt: 1 };
    const second: Project = { id: 'second', name: 'Second Project', color: 'green', createdAt: 2 };
    await service.createProjectProjection(first, operation('project-first'));
    await service.createProjectProjection(second, operation('project-second'));
    const created = await service.createTask({
      ...operation('create-moving'),
      title: 'Moving Task',
      date: '2026-08-19',
      projectId: first.id,
    });

    const moved = await service.updateTask({
      ...operation('move-task'),
      taskId: created.task.id,
      expectedUpdatedAt: created.task.updatedAt,
      updates: { projectId: second.id, title: 'Moved Task' },
    });
    const jobs = await db.taskProjectionJobs.where('sourceOperationId').equals('move-task').toArray();
    const taskJob = jobs.find((job) => job.projectionKey === `task:${created.task.id}`);

    expect(taskJob?.targetPath).toBe(taskProjectionPath(moved.task, second));
    expect(taskJob?.stalePaths).toEqual([taskProjectionPath(created.task, first)]);
    expect(jobs.map((job) => job.projectionKey)).toEqual(expect.arrayContaining([
      'project-index:first',
      'project-index:second',
    ]));
  });

  it('enqueues every task and moves the index when a project is renamed', async () => {
    const project: Project = { id: 'rename', name: 'Before', color: 'blue', createdAt: 1 };
    await service.createProjectProjection(project, operation('create-project'));
    const task = await service.createTask({
      ...operation('create-in-project'),
      title: 'Project Task',
      date: '2026-08-19',
      projectId: project.id,
    });

    const renamed = await service.updateProjectProjection({
      ...operation('rename-project'),
      projectId: project.id,
      name: 'After',
    });
    const jobs = await db.taskProjectionJobs.where('sourceOperationId').equals('rename-project').toArray();
    const taskJob = jobs.find((job) => job.projectionKey === `task:${task.task.id}`);
    const indexJob = jobs.find((job) => job.projectionKey === `project-index:${project.id}`);

    expect(taskJob).toMatchObject({
      targetPath: taskProjectionPath(task.task, renamed),
      stalePaths: [taskProjectionPath(task.task, project)],
    });
    expect(indexJob).toMatchObject({
      targetPath: projectIndexPath(renamed),
      stalePaths: [projectIndexPath(project)],
    });
  });
});

describe('TaskProjectionWorker', () => {
  it('supersedes an older projection key and writes only the newer snapshot', async () => {
    await enqueueTaskProjection(db, {
      sourceOperationId: 'old',
      projectionKey: 'task:one',
      kind: 'write_task',
      desiredRevision: '1',
      targetPath: '_inbox/one.md',
      serializedContent: 'old',
    }, now++);
    await enqueueTaskProjection(db, {
      sourceOperationId: 'new',
      projectionKey: 'task:one',
      kind: 'write_task',
      desiredRevision: '2',
      targetPath: '_inbox/one.md',
      serializedContent: 'new',
    }, now++);
    const writer = vi.fn().mockResolvedValue(undefined);
    const worker = new TaskProjectionWorker(db, writer, () => now);

    const completed = await worker.runOnce();

    expect((await db.taskProjectionJobs.get('task-projection:old:task:one'))?.status).toBe('superseded');
    expect(completed?.status).toBe('succeeded');
    expect(writer).toHaveBeenCalledOnce();
    expect(writer).toHaveBeenCalledWith(expect.objectContaining({ serializedContent: 'new' }));
  });

  it('does not let an in-flight older job overwrite its superseded state', async () => {
    await enqueueTaskProjection(db, {
      sourceOperationId: 'in-flight-old',
      projectionKey: 'task:in-flight',
      kind: 'write_task',
      desiredRevision: '1',
      targetPath: '_inbox/in-flight.md',
      serializedContent: 'old',
    }, now++);
    const writer = vi.fn(async (write: { serializedContent?: string }) => {
      if (write.serializedContent !== 'old') return;
      await enqueueTaskProjection(db, {
        sourceOperationId: 'in-flight-new',
        projectionKey: 'task:in-flight',
        kind: 'write_task',
        desiredRevision: '2',
        targetPath: '_inbox/in-flight.md',
        serializedContent: 'new',
      }, now++);
    });
    const worker = new TaskProjectionWorker(db, writer, () => now);

    expect((await worker.runOnce())?.status).toBe('superseded');
    expect((await db.taskProjectionJobs.get('task-projection:in-flight-old:task:in-flight'))?.status)
      .toBe('superseded');
    expect((await worker.runOnce())?.status).toBe('succeeded');
    expect(writer).toHaveBeenLastCalledWith(expect.objectContaining({ serializedContent: 'new' }));
  });

  it('uses bounded backoff and fails after exactly five attempts', async () => {
    await enqueueTaskProjection(db, {
      sourceOperationId: 'retry',
      projectionKey: 'task:retry',
      kind: 'write_task',
      desiredRevision: '1',
      targetPath: '_inbox/retry.md',
      serializedContent: 'content',
    }, now);
    const writer = vi.fn().mockRejectedValue(new Error('disk unavailable'));
    const worker = new TaskProjectionWorker(db, writer, () => now);

    for (let attempt = 1; attempt <= TASK_PROJECTION_MAX_ATTEMPTS; attempt += 1) {
      const result = await worker.runOnce();
      expect(result?.attempt).toBe(attempt);
      if (attempt < TASK_PROJECTION_MAX_ATTEMPTS) {
        expect(result?.status).toBe('retry_wait');
        now = result?.nextAttemptAt ?? now;
      } else {
        expect(result?.status).toBe('failed');
      }
    }
    expect(writer).toHaveBeenCalledTimes(5);
  });

  it('recovers interrupted running jobs into retry-wait', async () => {
    await enqueueTaskProjection(db, {
      sourceOperationId: 'interrupted',
      projectionKey: 'task:interrupted',
      kind: 'remove_path',
      desiredRevision: 'deleted',
      targetPath: '_inbox/interrupted.md',
    }, now);
    await db.taskProjectionJobs.update('task-projection:interrupted:task:interrupted', { status: 'running' });
    const worker = new TaskProjectionWorker(db, vi.fn(), () => now + 10);

    expect(await worker.recoverInterruptedJobs()).toBe(1);
    expect(await db.taskProjectionJobs.get('task-projection:interrupted:task:interrupted')).toMatchObject({
      status: 'retry_wait',
      nextAttemptAt: now + 10,
    });
  });
});
