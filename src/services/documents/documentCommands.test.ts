import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearDomainChangeSubscribersForTests,
  subscribeToDomainChanges,
  type DomainChangeEvent,
} from '../domainEvents';
import {
  computeRevision,
  DocumentCommandService,
  type DocumentFileAccess,
  type OpenDocumentBuffer,
} from './documentCommands';

const SCOPE_ID = 'opaque-native-scope';
const ROOT = '/workspace';
const NOTES = `${ROOT}/notes.md`;

function memoryFiles(initial: Record<string, string> = {}): DocumentFileAccess & { store: Map<string, string> } {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async exists(path: string) {
      return store.has(path);
    },
    async readText(path: string) {
      const content = store.get(path);
      if (content === undefined) throw new Error(`Missing file: ${path}`);
      return content;
    },
    async writeText(path: string, content: string) {
      store.set(path, content);
    },
  };
}

describe('DocumentCommandService', () => {
  let files: ReturnType<typeof memoryFiles>;
  let open: { current: OpenDocumentBuffer | null };
  let service: DocumentCommandService;
  let events: DomainChangeEvent[];
  let unsubscribe: () => void;

  beforeEach(() => {
    clearDomainChangeSubscribersForTests();
    files = memoryFiles({ [NOTES]: 'disk version\nline two\nline three' });
    open = { current: null };
    service = new DocumentCommandService(files, {
      getOpenBuffer: () => open.current,
      getWorkspaceRoot: () => ROOT,
    });
    service.registerRoot(SCOPE_ID, ROOT);
    service.registerRoot('workspace:ws-1', ROOT);
    events = [];
    unsubscribe = subscribeToDomainChanges((event) => events.push(event));
  });

  afterEach(() => {
    unsubscribe();
    clearDomainChangeSubscribersForTests();
    service.clearSnapshotsForTests();
  });

  it('returns dirty editor content as authoritative and bounds the read', async () => {
    open.current = {
      path: NOTES,
      name: 'notes.md',
      content: 'editor dirty buffer\nextra',
      isDirty: true,
    };

    const read = await service.readDocument({
      workspaceId: 'ws-1',
      target: { scopeId: SCOPE_ID, relativePath: 'notes.md' },
      limit: 1,
    });

    expect(read.source).toBe('editor');
    expect(read.content).toBe('editor dirty buffer');
    expect(read.truncated).toBe(true);
    expect(read.revision).toBe(await computeRevision('editor dirty buffer\nextra'));
    expect(files.store.get(NOTES)).toBe('disk version\nline two\nline three');
  });

  it('rejects file creation that would overwrite an existing path', async () => {
    const expectedWorkspaceRevision = await service.currentWorkspaceRevision('ws-1');
    const result = await service.createDocument({
      workspaceId: 'ws-1',
      title: 'notes.md',
      content: 'new',
      expectedWorkspaceRevision,
      target: {
        kind: 'file',
        scopeId: SCOPE_ID,
        relativePath: 'notes.md',
        expectedState: 'absent',
      },
    });

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({
      status: 'conflict',
      reason: 'path_collision',
      currentRevision: await computeRevision('disk version\nline two\nline three'),
    });
    expect(files.store.get(NOTES)).toBe('disk version\nline two\nline three');
    expect(events).toEqual([]);
  });

  it('preserves a dirty buffer when the expected revision is stale', async () => {
    const dirty = 'user is still typing';
    open.current = {
      path: NOTES,
      name: 'notes.md',
      content: dirty,
      isDirty: true,
    };
    const diskRevision = await computeRevision('disk version\nline two\nline three');
    const notesStale = await service.updateDocument({
      workspaceId: 'ws-1',
      documentId: `scope:${SCOPE_ID}:notes.md`,
      expectedRevision: diskRevision,
      edit: { kind: 'replace_all', content: 'agent overwrite' },
    });

    expect(notesStale.ok).toBe(false);
    expect(notesStale).toMatchObject({
      status: 'conflict',
      reason: 'stale_revision',
      content: dirty,
      currentRevision: await computeRevision(dirty),
    });
    expect(open.current?.content).toBe(dirty);
    expect(files.store.get(NOTES)).toBe('disk version\nline two\nline three');
  });

  it('returns cancelled when Save As is dismissed and does not write', async () => {
    open.current = {
      path: '__draft__:ws-1',
      name: 'Untitled',
      content: 'draft text',
      isDirty: true,
    };
    const pickSavePath = vi.fn().mockResolvedValue(null);

    const outcome = await service.saveDocument({
      workspaceId: 'ws-1',
      forceSaveAs: true,
      pickSavePath,
    });

    expect(outcome).toEqual({ status: 'cancelled' });
    expect(pickSavePath).toHaveBeenCalledTimes(1);
    expect(files.store.has('/workspace/Untitled.md')).toBe(false);
    expect(events).toEqual([]);
  });

  it('returns a structured conflict when save hits a stale disk revision', async () => {
    await service.switchDocument({
      workspaceId: 'ws-1',
      nextPath: NOTES,
      nextName: 'notes.md',
    });
    files.store.set(NOTES, 'changed on disk');
    open.current = {
      path: NOTES,
      name: 'notes.md',
      content: 'editor save',
      isDirty: true,
    };
    const outcome = await service.saveDocument({
      workspaceId: 'ws-1',
      expectedRevision: await computeRevision('disk version\nline two\nline three'),
    });
    expect(outcome).toMatchObject({
      status: 'conflict',
      reason: 'stale_revision',
      currentRevision: await computeRevision('changed on disk'),
    });
    expect(files.store.get(NOTES)).toBe('changed on disk');
    expect(events).toEqual([]);
  });

  it('emits one domain change after a successful draft create and file update', async () => {
    const draft = await service.createDocument({
      workspaceId: 'ws-1',
      title: 'Follow-up',
      content: 'hello',
      expectedWorkspaceRevision: await service.currentWorkspaceRevision('ws-1'),
      target: { kind: 'draft' },
      operationId: 'op-draft',
    });
    expect(draft.ok).toBe(true);
    if (!draft.ok) throw new Error('expected draft');
    open.current = {
      path: draft.snapshot.path,
      name: draft.snapshot.title,
      content: draft.snapshot.content,
      isDirty: true,
    };

    const updated = await service.updateDocument({
      workspaceId: 'ws-1',
      documentId: draft.documentId,
      expectedRevision: draft.revision,
      edit: { kind: 'replace_all', content: 'hello world' },
      operationId: 'op-update',
    });
    expect(updated.ok).toBe(true);

    expect(events).toEqual([
      {
        domain: 'documents',
        entityType: 'document',
        entityId: draft.documentId,
        operation: 'created',
        revision: draft.revision,
        operationId: 'op-draft',
      },
      {
        domain: 'documents',
        entityType: 'document',
        entityId: draft.documentId,
        operation: 'updated',
        revision: updated.ok ? updated.revision : '',
        operationId: 'op-update',
      },
    ]);
    expect(draft.documentId).toBe('draft:ws-1');
  });

  it('hashes closed files and rejects stale replacements without writing', async () => {
    const read = await service.readDocument({
      workspaceId: 'ws-1',
      target: { scopeId: SCOPE_ID, relativePath: 'notes.md' },
    });
    expect(read.source).toBe('disk');
    expect(read.content).toContain('disk version');
    const closedHash = await computeRevision('disk version\nline two\nline three');
    expect(read.revision).toBe(closedHash);

    const stale = await service.updateDocument({
      workspaceId: 'ws-1',
      documentId: `scope:${SCOPE_ID}:notes.md`,
      expectedRevision: 'sha256:deadbeef',
      edit: {
        kind: 'replace_text',
        oldText: 'disk version',
        newText: 'changed',
        replaceAll: false,
        expectedMatchCount: 1,
      },
    });
    expect(stale).toMatchObject({ ok: false, status: 'conflict', reason: 'stale_revision', currentRevision: closedHash });
    expect(files.store.get(NOTES)).toBe('disk version\nline two\nline three');

    const updated = await service.updateDocument({
      workspaceId: 'ws-1',
      documentId: `scope:${SCOPE_ID}:notes.md`,
      expectedRevision: closedHash,
      edit: {
        kind: 'replace_text',
        oldText: 'disk version',
        newText: 'changed',
        replaceAll: false,
        expectedMatchCount: 1,
      },
    });
    expect(updated.ok).toBe(true);
    expect(files.store.get(NOTES)).toBe('changed\nline two\nline three');
    expect(events).toHaveLength(1);
  });

  it('rejects draft creation while a dirty draft buffer is open', async () => {
    open.current = {
      path: '__draft__:ws-1',
      name: 'Untitled',
      content: 'user draft',
      isDirty: true,
    };
    const result = await service.createDocument({
      workspaceId: 'ws-1',
      title: 'Follow-up',
      content: 'agent draft',
      expectedWorkspaceRevision: await service.currentWorkspaceRevision('ws-1'),
      target: { kind: 'draft' },
    });
    expect(result).toMatchObject({
      ok: false,
      status: 'conflict',
      reason: 'dirty_buffer',
      content: 'user draft',
    });
    expect(open.current?.content).toBe('user draft');
    expect(events).toEqual([]);
  });

  it('rejects create when the workspace revision is stale', async () => {
    const result = await service.createDocument({
      workspaceId: 'ws-1',
      title: 'stale.md',
      content: 'nope',
      expectedWorkspaceRevision: 'sha256:deadbeef',
      target: { kind: 'draft' },
    });
    expect(result).toMatchObject({ ok: false, status: 'conflict', reason: 'workspace_revision' });
    expect(events).toEqual([]);
  });

  it('rejects replace_text when the match count does not match', async () => {
    const read = await service.readDocument({
      workspaceId: 'ws-1',
      target: { scopeId: SCOPE_ID, relativePath: 'notes.md' },
    });
    const mismatch = await service.updateDocument({
      workspaceId: 'ws-1',
      documentId: read.documentId,
      expectedRevision: read.revision,
      edit: {
        kind: 'replace_text',
        oldText: 'missing',
        newText: 'changed',
        replaceAll: false,
        expectedMatchCount: 1,
      },
    });
    expect(mismatch).toMatchObject({ ok: false, status: 'conflict', reason: 'edit_mismatch' });
    expect(files.store.get(NOTES)).toBe('disk version\nline two\nline three');
    expect(events).toEqual([]);
  });

  it('blocks dirty switching and creates a file only through a native scope ID', async () => {
    open.current = {
      path: NOTES,
      name: 'notes.md',
      content: 'unsaved',
      isDirty: true,
    };
    const blocked = await service.switchDocument({
      workspaceId: 'ws-1',
      nextPath: `${ROOT}/other.md`,
      nextName: 'other.md',
    });
    expect(blocked).toEqual({ status: 'blocked', reason: 'dirty_buffer' });

    open.current = null;
    const created = await service.createDocument({
      workspaceId: 'ws-1',
      title: 'scoped.md',
      content: 'from agent',
      expectedWorkspaceRevision: await service.currentWorkspaceRevision('ws-1'),
      target: {
        kind: 'file',
        scopeId: SCOPE_ID,
        relativePath: 'nested/scoped.md',
        expectedState: 'absent',
      },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error('expected create');
    expect(created.documentId).toBe(`scope:${SCOPE_ID}:nested/scoped.md`);
    expect(files.store.get(`${ROOT}/nested/scoped.md`)).toBe('from agent');
  });
});
