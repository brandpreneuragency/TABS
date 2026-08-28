import 'fake-indexeddb/auto';

import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db';
import { useTaskStore } from '../../stores/taskStore';
import {
  OperationReplayMismatchError,
  TaskRevisionConflictError,
  TaskService,
  TASK_UPDATE_FIELDS,
} from './taskService';

const DB_NAME = 'ZenEditorDB';
let tick = 1_000;
let service: TaskService;

function operation(id: string) {
  return { operationId: id, effectFingerprint: `effect:${id}` };
}

async function resetDatabase(): Promise<void> {
  db.close();
  await Dexie.delete(DB_NAME);
}

beforeEach(async () => {
  await resetDatabase();
  tick = 1_000;
  service = new TaskService(db, () => tick++);
  useTaskStore.setState({
    tasks: [],
    activeTaskId: null,
    openTaskIds: [],
    openTabs: [],
    activeTabId: null,
    isLoaded: false,
  });
  await db.open();
});

afterEach(resetDatabase);

describe('TaskService', () => {
  it('creates tasks and subtasks with normalized fields and atomic receipts', async () => {
    const created = await service.createTask({
      ...operation('create-parent'),
      title: '  Parent task  ',
      date: '2026-08-19',
      assignees: [' Alice ', 'Alice'],
    });
    const subtask = await service.createSubtask({
      ...operation('create-child'),
      parentId: created.task.id,
      title: 'Child task',
    });

    expect(created.replayed).toBe(false);
    expect(created.task.title).toBe('Parent task');
    expect(created.task.assignees).toEqual(['Alice']);
    expect(subtask.task).toMatchObject({
      parentId: created.task.id,
      projectId: created.task.projectId,
      date: created.task.date,
      status: 'in_progress',
    });
    expect(await db.tasks.count()).toBe(2);
    expect(await db.agentOperationReceipts.count()).toBe(2);
    expect(await db.agentOperationReceipts.where('operationId').equals('create-parent').first())
      .toMatchObject({ status: 'committed', domain: 'tasks' });
  });

  it('enforces task title, date, and update-field rules', async () => {
    await expect(service.createTask({
      ...operation('blank-title'),
      title: '   ',
      date: '2026-08-19',
    })).rejects.toThrow('Task title is required');
    await expect(service.createTask({
      ...operation('long-title'),
      title: 'x'.repeat(81),
      date: '2026-08-19',
    })).rejects.toThrow('at most 80');
    await expect(service.createTask({
      ...operation('bad-date'),
      title: 'Task',
      date: '19/08/2026',
    })).rejects.toThrow('YYYY-MM-DD');

    const created = await service.createTask({
      ...operation('create-for-fields'),
      title: 'Task',
      date: '2026-08-19',
    });
    await expect(service.updateTask({
      ...operation('bad-field'),
      taskId: created.task.id,
      expectedUpdatedAt: created.task.updatedAt,
      updates: { order: 4 } as never,
    })).rejects.toThrow('not allowed');
    expect(TASK_UPDATE_FIELDS).toEqual([
      'title', 'content', 'status', 'importance', 'date', 'projectId', 'assignees',
    ]);
  });

  it('updates checked fields and persists updatedAt for effective changes only', async () => {
    const created = await service.createTask({
      ...operation('create-update'),
      title: 'Before',
      date: '2026-08-19',
    });
    const updated = await service.updateTask({
      ...operation('update'),
      taskId: created.task.id,
      expectedUpdatedAt: created.task.updatedAt,
      updates: { title: ' After ', status: 'completed' },
    });
    const unchanged = await service.updateTask({
      ...operation('unchanged'),
      taskId: created.task.id,
      expectedUpdatedAt: updated.task.updatedAt,
      updates: { title: 'After' },
    });

    expect(updated.task.title).toBe('After');
    expect(updated.task.updatedAt).toBeGreaterThan(created.task.updatedAt);
    expect((await db.tasks.get(created.task.id))?.updatedAt).toBe(updated.task.updatedAt);
    expect(unchanged.task.updatedAt).toBe(updated.task.updatedAt);
  });

  it('adds a comment and updates its task in the same transaction', async () => {
    const created = await service.createTask({
      ...operation('create-commented'),
      title: 'Commented',
      date: '2026-08-19',
    });
    const result = await service.addComment({
      ...operation('comment'),
      taskId: created.task.id,
      expectedUpdatedAt: created.task.updatedAt,
      text: '  An update  ',
    });

    expect(result.comment?.text).toBe('An update');
    expect(result.task.updatedAt).toBeGreaterThan(created.task.updatedAt);
    expect(await db.taskComments.get(result.comment?.id ?? '')).toEqual(result.comment);
    expect(await db.agentOperationReceipts.where('operationId').equals('comment').count()).toBe(1);
  });

  it('soft deletes without removing the task and advances its revision', async () => {
    const created = await service.createTask({
      ...operation('create-delete'),
      title: 'Delete me',
      date: '2026-08-19',
    });
    const deleted = await service.softDeleteTask({
      ...operation('delete'),
      taskId: created.task.id,
      expectedUpdatedAt: created.task.updatedAt,
      reason: 'No longer needed',
    });

    expect(deleted.task.deletedAt).toBe(deleted.task.updatedAt);
    expect(deleted.task.updatedAt).toBeGreaterThan(created.task.updatedAt);
    expect(await db.tasks.get(created.task.id)).toEqual(deleted.task);
  });

  it('rejects stale updates and comments without writing a receipt', async () => {
    const created = await service.createTask({
      ...operation('create-stale'),
      title: 'Task',
      date: '2026-08-19',
    });
    const updated = await service.updateTask({
      ...operation('advance'),
      taskId: created.task.id,
      expectedUpdatedAt: created.task.updatedAt,
      updates: { content: 'new' },
    });

    await expect(service.updateTask({
      ...operation('stale-update'),
      taskId: created.task.id,
      expectedUpdatedAt: created.task.updatedAt,
      updates: { content: 'stale' },
    })).rejects.toBeInstanceOf(TaskRevisionConflictError);
    await expect(service.addComment({
      ...operation('stale-comment'),
      taskId: created.task.id,
      expectedUpdatedAt: created.task.updatedAt,
      text: 'stale',
    })).rejects.toBeInstanceOf(TaskRevisionConflictError);
    expect((await db.tasks.get(created.task.id))?.content).toBe(updated.task.content);
    expect(await db.agentOperationReceipts.where('operationId').equals('stale-update').count()).toBe(0);
  });

  it('returns the previous receipt on replay and rejects operation-id effect drift', async () => {
    const input = {
      ...operation('replayed-create'),
      title: 'One task',
      date: '2026-08-19',
    };
    const first = await service.createTask(input);
    const replayed = await service.createTask(input);

    expect(replayed.replayed).toBe(true);
    expect(replayed.task.id).toBe(first.task.id);
    expect(replayed.receipt).toEqual(first.receipt);
    expect(await db.tasks.count()).toBe(1);

    await expect(service.createTask({
      ...input,
      effectFingerprint: 'different-effect',
    })).rejects.toBeInstanceOf(OperationReplayMismatchError);
  });

  it('rolls back the domain row when the receipt cannot commit', async () => {
    await db.agentOperationReceipts.add({
      id: 'task-receipt:receipt-collision',
      operationId: 'another-operation',
      effectFingerprint: 'another-effect',
      domain: 'tasks',
      resourceKeys: [],
      status: 'committed',
      resultSummary: 'fixture',
      committedAt: 1,
    });

    await expect(service.createTask({
      ...operation('receipt-collision'),
      title: 'Must roll back',
      date: '2026-08-19',
    })).rejects.toMatchObject({ name: 'ConstraintError' });
    expect(await db.tasks.count()).toBe(0);
    expect(await db.agentOperationReceipts.count()).toBe(1);
  });

  it('refreshes the Zustand task projection after a store mutation', async () => {
    const task = await useTaskStore.getState().createTask('Store-created task', {
      date: '2026-08-19',
    });

    expect(task).not.toBeNull();
    expect(useTaskStore.getState().tasks).toContainEqual(task);
    expect(await db.tasks.get(task?.id ?? '')).toEqual(task);

    await useTaskStore.getState().updateTask(task?.id ?? '', { content: 'from store' });
    const projected = useTaskStore.getState().tasks.find((item) => item.id === task?.id);
    expect(projected?.content).toBe('from store');
    expect(projected).toEqual(await db.tasks.get(task?.id ?? ''));
  });
});
