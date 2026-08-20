import { emitDomainChange } from '../domainEvents';
import {
  exists as fsExists,
  joinPath,
  readTextFile,
  writeTextFile,
} from '../fs-adapter';

export const DOCUMENT_COMMANDS = [
  'readDocument',
  'switchDocument',
  'createDocument',
  'updateDocument',
  'saveDocument',
] as const;

export type DocumentCommandName = (typeof DOCUMENT_COMMANDS)[number];

/** Content revisions are lowercase SHA-256 digests of UTF-8 bytes. */
export const REVISION_SCHEME = 'sha256';

export const DOCUMENT_READ_MIN_LIMIT = 1;
export const DOCUMENT_READ_MAX_LIMIT = 100;

const DRAFT_PATH_PREFIX = '__draft__:';

export type DocumentCreateTarget =
  | { kind: 'draft' }
  | {
      kind: 'file';
      relativePath: string;
      expectedState: 'absent';
      /** Opaque native workspace scope ID. Required for agent file targets. */
      scopeId: string;
    };

export type DocumentEdit =
  | { kind: 'replace_all'; content: string }
  | {
      kind: 'replace_text';
      oldText: string;
      newText: string;
      replaceAll: boolean;
      expectedMatchCount: number;
    };

export interface DocumentCreateArgs {
  workspaceId: string;
  title: string;
  target: DocumentCreateTarget;
  content: string;
  expectedWorkspaceRevision: string;
  operationId?: string;
}

export interface DocumentUpdateArgs {
  workspaceId: string;
  documentId: string;
  expectedRevision: string;
  edit: DocumentEdit;
  operationId?: string;
}

export interface DocumentReadArgs {
  workspaceId: string;
  documentId?: string;
  /** Agent file targets use a native scope ID plus a relative path. */
  target?: { scopeId: string; relativePath: string };
  revision?: string;
  section?: string;
  cursor?: string | number;
  limit?: number;
}

export interface OpenDocumentBuffer {
  path: string;
  name: string;
  content: string;
  isDirty: boolean;
}

export interface DocumentSnapshot {
  documentId: string;
  workspaceId: string;
  title: string;
  content: string;
  revision: string;
  path: string;
  relativePath: string | null;
  scopeId: string | null;
  kind: 'draft' | 'file';
  isDirty: boolean;
}

export interface DocumentConflict {
  ok: false;
  status: 'conflict';
  reason: 'stale_revision' | 'path_collision' | 'dirty_buffer' | 'workspace_revision' | 'edit_mismatch';
  currentRevision: string;
  content?: string;
  documentId?: string;
}

export interface DocumentMutationSuccess {
  ok: true;
  documentId: string;
  revision: string;
  operation: 'created' | 'updated';
  snapshot: DocumentSnapshot;
}

export type DocumentMutationResult = DocumentMutationSuccess | DocumentConflict;

export interface DocumentReadResult {
  documentId: string;
  workspaceId: string;
  title: string;
  revision: string;
  source: 'editor' | 'disk';
  content: string;
  offset: number;
  length: number;
  totalLength: number;
  truncated: boolean;
  nextCursor?: string;
}

export type DocumentSwitchResult =
  | {
      status: 'opened';
      documentId: string;
      path: string;
      name: string;
      content: string;
      revision: string;
    }
  | { status: 'blocked'; reason: 'dirty_buffer' }
  | { status: 'error'; message: string };

export type DocumentSaveOutcome =
  | { status: 'saved'; path: string; revision: string; documentId: string }
  | { status: 'cancelled' }
  | { status: 'conflict'; reason: 'stale_revision' | 'path_collision'; currentRevision: string }
  | { status: 'error'; message: string };

export interface DocumentFileAccess {
  exists(path: string): Promise<boolean>;
  readText(path: string): Promise<string>;
  writeText(path: string, content: string): Promise<void>;
}

export interface DocumentWorkspaceAccess {
  getOpenBuffer?: (workspaceId: string) => OpenDocumentBuffer | null;
  getWorkspaceRoot?: (workspaceId: string) => string | null;
}

export interface SaveDocumentArgs {
  workspaceId: string;
  expectedRevision?: string;
  forceSaveAs?: boolean;
  pickSavePath?: () => Promise<string | null>;
  writeFile?: (path: string, content: string) => Promise<void>;
  buffer?: OpenDocumentBuffer;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/');
}

function draftPathFor(workspaceId: string): string {
  return `${DRAFT_PATH_PREFIX}${workspaceId}`;
}

function draftDocumentId(workspaceId: string): string {
  return `draft:${workspaceId}`;
}

function fileDocumentId(scopeId: string, relativePath: string): string {
  return `scope:${scopeId}:${relativePath}`;
}

function absoluteDocumentId(path: string): string {
  return `file:${normalizePath(path)}`;
}

export function normalizeRelativePath(relativePath: string): string {
  const trimmed = normalizePath(relativePath).replace(/^\/+/, '').trim();
  if (!trimmed) {
    throw new Error('Path must be a non-empty relative path.');
  }
  const parts = trimmed.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error('Path must be a normalized relative path without parent components.');
  }
  return parts.join('/');
}

export function relativePathFromRoot(rootPath: string, fullPath: string): string {
  const root = normalizePath(rootPath).replace(/\/+$/, '');
  const full = normalizePath(fullPath);
  if (full === root) {
    throw new Error('Path must be a non-empty relative path.');
  }
  const prefix = `${root}/`;
  if (!full.startsWith(prefix)) {
    throw new Error('Path is outside the workspace root.');
  }
  return normalizeRelativePath(full.slice(prefix.length));
}

export function joinScopedPath(rootPath: string, relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath);
  return normalized.split('/').reduce((parent, part) => joinPath(parent, part), normalizePath(rootPath));
}

function bufferToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function computeRevision(content: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return `${REVISION_SCHEME}:${bufferToHex(digest)}`;
}

export async function computeWorkspaceRevision(input: {
  workspaceId: string;
  rootPath?: string | null;
  openPath?: string | null;
  openRevision?: string | null;
}): Promise<string> {
  return computeRevision(
    [input.workspaceId, input.rootPath ?? '', input.openPath ?? '', input.openRevision ?? ''].join('\0'),
  );
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DOCUMENT_READ_MAX_LIMIT;
  if (!Number.isInteger(limit) || limit < DOCUMENT_READ_MIN_LIMIT || limit > DOCUMENT_READ_MAX_LIMIT) {
    throw new Error(`limit must be an integer from ${DOCUMENT_READ_MIN_LIMIT} through ${DOCUMENT_READ_MAX_LIMIT}.`);
  }
  return limit;
}

function parseCursor(cursor: string | number | undefined): number {
  if (cursor === undefined || cursor === '') return 0;
  const value = typeof cursor === 'number' ? cursor : Number.parseInt(cursor, 10);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error('cursor must be a non-negative integer.');
  }
  return value;
}

function countMatches(haystack: string, needle: string): number {
  if (!needle) throw new Error('oldText must be non-empty.');
  let count = 0;
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) break;
    count += 1;
    from = at + needle.length;
  }
  return count;
}

function applyEdit(content: string, edit: DocumentEdit): { next: string } | { mismatch: true; currentRevision?: string } {
  if (edit.kind === 'replace_all') {
    return { next: edit.content };
  }
  const matches = countMatches(content, edit.oldText);
  if (matches !== edit.expectedMatchCount) {
    return { mismatch: true };
  }
  if (edit.replaceAll) {
    return { next: content.split(edit.oldText).join(edit.newText) };
  }
  const at = content.indexOf(edit.oldText);
  if (at === -1) return { mismatch: true };
  return { next: content.slice(0, at) + edit.newText + content.slice(at + edit.oldText.length) };
}

function sliceBounded(content: string, cursor: number, limit: number, section?: string): {
  content: string;
  offset: number;
  length: number;
  totalLength: number;
  truncated: boolean;
  nextCursor?: string;
} {
  const lines = content.split('\n');
  let offset = cursor;
  if (section) {
    const heading = lines.findIndex((line) => line.trim() === section || line.trim() === `# ${section}`);
    if (heading >= 0 && cursor === 0) offset = heading;
  }
  const slice = lines.slice(offset, offset + limit);
  const nextOffset = offset + slice.length;
  return {
    content: slice.join('\n'),
    offset,
    length: slice.length,
    totalLength: lines.length,
    truncated: nextOffset < lines.length,
    nextCursor: nextOffset < lines.length ? String(nextOffset) : undefined,
  };
}

function titleFromPath(path: string, fallback: string): string {
  const base = normalizePath(path).split('/').pop();
  return base && base.length > 0 ? base : fallback;
}

function createDefaultFileAccess(): DocumentFileAccess {
  return {
    exists: fsExists,
    readText: readTextFile,
    writeText: writeTextFile,
  };
}

export class DocumentCommandService {
  private readonly files: DocumentFileAccess;
  private workspaceAccess: DocumentWorkspaceAccess;
  private readonly roots = new Map<string, string>();
  private readonly diskRevisions = new Map<string, string>();
  private readonly snapshots = new Map<string, DocumentSnapshot>();

  constructor(
    files: DocumentFileAccess = createDefaultFileAccess(),
    workspaceAccess: DocumentWorkspaceAccess = {},
  ) {
    this.files = files;
    this.workspaceAccess = workspaceAccess;
  }

  setWorkspaceAccess(access: DocumentWorkspaceAccess): void {
    this.workspaceAccess = { ...this.workspaceAccess, ...access };
  }

  /** Remember a native (or UI) scope ID → canonical workspace root. */
  registerRoot(scopeId: string, rootPath: string): void {
    this.roots.set(scopeId, normalizePath(rootPath));
  }

  revokeRoot(scopeId: string): void {
    this.roots.delete(scopeId);
  }

  getDocumentSnapshot(documentId: string): DocumentSnapshot | undefined {
    return this.snapshots.get(documentId);
  }

  clearSnapshotsForTests(): void {
    this.snapshots.clear();
    this.diskRevisions.clear();
    this.roots.clear();
  }

  async currentWorkspaceRevision(workspaceId: string): Promise<string> {
    const open = this.openBuffer(workspaceId);
    const rootPath = this.workspaceAccess.getWorkspaceRoot?.(workspaceId) ?? this.roots.get(`workspace:${workspaceId}`) ?? null;
    const openRevision = open ? await computeRevision(open.content) : null;
    return computeWorkspaceRevision({
      workspaceId,
      rootPath,
      openPath: open?.path ?? null,
      openRevision,
    });
  }

  async readDocument(args: DocumentReadArgs): Promise<DocumentReadResult> {
    const resolved = await this.resolveAuthoritative(args.workspaceId, args.documentId, args.target);
    const limit = clampLimit(args.limit);
    const cursor = parseCursor(args.cursor);
    const bounded = sliceBounded(resolved.content, cursor, limit, args.section);
    return {
      documentId: resolved.documentId,
      workspaceId: args.workspaceId,
      title: resolved.title,
      revision: resolved.revision,
      source: resolved.source,
      content: bounded.content,
      offset: bounded.offset,
      length: bounded.length,
      totalLength: bounded.totalLength,
      truncated: bounded.truncated,
      nextCursor: bounded.nextCursor,
    };
  }

  async switchDocument(args: {
    workspaceId: string;
    nextPath: string;
    nextName: string;
    skipDirtyCheck?: boolean;
  }): Promise<DocumentSwitchResult> {
    const open = this.openBuffer(args.workspaceId);
    if (open?.isDirty && !args.skipDirtyCheck && normalizePath(open.path) !== normalizePath(args.nextPath)) {
      return { status: 'blocked', reason: 'dirty_buffer' };
    }
    try {
      const content = await this.files.readText(args.nextPath);
      const revision = await computeRevision(content);
      this.diskRevisions.set(normalizePath(args.nextPath), revision);
      const documentId = absoluteDocumentId(args.nextPath);
      const snapshot: DocumentSnapshot = {
        documentId,
        workspaceId: args.workspaceId,
        title: args.nextName,
        content,
        revision,
        path: args.nextPath,
        relativePath: null,
        scopeId: null,
        kind: 'file',
        isDirty: false,
      };
      this.snapshots.set(documentId, snapshot);
      return {
        status: 'opened',
        documentId,
        path: args.nextPath,
        name: args.nextName,
        content,
        revision,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { status: 'error', message };
    }
  }

  async createDocument(args: DocumentCreateArgs): Promise<DocumentMutationResult> {
    const currentWorkspaceRevision = await this.currentWorkspaceRevision(args.workspaceId);
    if (args.expectedWorkspaceRevision !== currentWorkspaceRevision) {
      return {
        ok: false,
        status: 'conflict',
        reason: 'workspace_revision',
        currentRevision: currentWorkspaceRevision,
      };
    }

    if (args.target.kind === 'draft') {
      const documentId = draftDocumentId(args.workspaceId);
      const path = draftPathFor(args.workspaceId);
      const revision = await computeRevision(args.content);
      const snapshot: DocumentSnapshot = {
        documentId,
        workspaceId: args.workspaceId,
        title: args.title.trim() || 'Untitled',
        content: args.content,
        revision,
        path,
        relativePath: null,
        scopeId: null,
        kind: 'draft',
        isDirty: true,
      };
      this.remember(snapshot);
      this.emit(snapshot, 'created', args.operationId);
      return { ok: true, documentId, revision, operation: 'created', snapshot };
    }

    const relativePath = normalizeRelativePath(args.target.relativePath);
    if (args.target.expectedState !== 'absent') {
      throw new Error('File creation requires expectedState "absent".');
    }
    const absolutePath = this.resolveScopePath(args.target.scopeId, relativePath);
    const existed = await this.files.exists(absolutePath);
    if (existed) {
      const current = await this.files.readText(absolutePath);
      const currentRevision = await computeRevision(current);
      this.diskRevisions.set(normalizePath(absolutePath), currentRevision);
      return {
        ok: false,
        status: 'conflict',
        reason: 'path_collision',
        currentRevision,
        content: current,
        documentId: fileDocumentId(args.target.scopeId, relativePath),
      };
    }

    await this.files.writeText(absolutePath, args.content);
    const revision = await computeRevision(args.content);
    this.diskRevisions.set(normalizePath(absolutePath), revision);
    const documentId = fileDocumentId(args.target.scopeId, relativePath);
    const snapshot: DocumentSnapshot = {
      documentId,
      workspaceId: args.workspaceId,
      title: args.title.trim() || titleFromPath(absolutePath, relativePath),
      content: args.content,
      revision,
      path: absolutePath,
      relativePath,
      scopeId: args.target.scopeId,
      kind: 'file',
      isDirty: false,
    };
    this.remember(snapshot);
    this.emit(snapshot, 'created', args.operationId);
    return { ok: true, documentId, revision, operation: 'created', snapshot };
  }

  async updateDocument(args: DocumentUpdateArgs): Promise<DocumentMutationResult> {
    const resolved = await this.resolveAuthoritative(args.workspaceId, args.documentId, undefined);
    if (resolved.revision !== args.expectedRevision) {
      return {
        ok: false,
        status: 'conflict',
        reason: 'stale_revision',
        currentRevision: resolved.revision,
        content: resolved.content,
        documentId: resolved.documentId,
      };
    }

    const edited = applyEdit(resolved.content, args.edit);
    if ('mismatch' in edited) {
      return {
        ok: false,
        status: 'conflict',
        reason: 'edit_mismatch',
        currentRevision: resolved.revision,
        content: resolved.content,
        documentId: resolved.documentId,
      };
    }

    const nextContent = edited.next;
    const revision = await computeRevision(nextContent);
    const isOpenEditor = resolved.source === 'editor';
    if (!isOpenEditor) {
      await this.files.writeText(resolved.path, nextContent);
      this.diskRevisions.set(normalizePath(resolved.path), revision);
    }

    const snapshot: DocumentSnapshot = {
      documentId: resolved.documentId,
      workspaceId: args.workspaceId,
      title: resolved.title,
      content: nextContent,
      revision,
      path: resolved.path,
      relativePath: resolved.relativePath,
      scopeId: resolved.scopeId,
      kind: resolved.kind,
      isDirty: isOpenEditor,
    };
    this.remember(snapshot);
    this.emit(snapshot, 'updated', args.operationId);
    return { ok: true, documentId: resolved.documentId, revision, operation: 'updated', snapshot };
  }

  async saveDocument(args: SaveDocumentArgs): Promise<DocumentSaveOutcome> {
    const buffer = args.buffer ?? this.openBuffer(args.workspaceId);
    if (!buffer) {
      return { status: 'error', message: 'No open document to save.' };
    }

    let targetPath = buffer.path;
    if (args.forceSaveAs || isVirtualPath(targetPath)) {
      if (!args.pickSavePath) {
        return { status: 'error', message: 'Save As requires a path picker.' };
      }
      const picked = await args.pickSavePath();
      if (!picked) return { status: 'cancelled' };
      targetPath = picked;
    }

    const normalizedTarget = normalizePath(targetPath);
    const previousDisk = args.expectedRevision ?? this.diskRevisions.get(normalizedTarget);
    const exists = await this.files.exists(targetPath);
    if (exists && previousDisk) {
      try {
        const onDisk = await computeRevision(await this.files.readText(targetPath));
        if (onDisk !== previousDisk) {
          return { status: 'conflict', reason: 'stale_revision', currentRevision: onDisk };
        }
      } catch {
        // Binary or unreadable targets skip the text-hash stale check.
      }
    }

    const write = args.writeFile ?? ((path: string, content: string) => this.files.writeText(path, content));
    try {
      await write(targetPath, buffer.content);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { status: 'error', message };
    }

    let diskRevision = await computeRevision(buffer.content);
    try {
      diskRevision = await computeRevision(await this.files.readText(targetPath));
    } catch {
      // Keep the editor-content hash when the saved file is not UTF-8 text.
    }
    this.diskRevisions.set(normalizedTarget, diskRevision);

    const documentId = isVirtualPath(buffer.path)
      ? draftDocumentId(args.workspaceId)
      : absoluteDocumentId(targetPath);
    const snapshot: DocumentSnapshot = {
      documentId,
      workspaceId: args.workspaceId,
      title: titleFromPath(targetPath, buffer.name),
      content: buffer.content,
      revision: await computeRevision(buffer.content),
      path: targetPath,
      relativePath: null,
      scopeId: null,
      kind: 'file',
      isDirty: false,
    };
    this.remember(snapshot);
    this.emit(snapshot, 'updated');
    return { status: 'saved', path: targetPath, revision: snapshot.revision, documentId };
  }

  private openBuffer(workspaceId: string): OpenDocumentBuffer | null {
    return this.workspaceAccess.getOpenBuffer?.(workspaceId) ?? null;
  }

  private resolveScopePath(scopeId: string, relativePath: string): string {
    const root = this.roots.get(scopeId);
    if (!root) {
      throw new Error('WorkspaceScopeUnavailable');
    }
    return joinScopedPath(root, relativePath);
  }

  private remember(snapshot: DocumentSnapshot): void {
    this.snapshots.set(snapshot.documentId, snapshot);
  }

  private emit(snapshot: DocumentSnapshot, operation: 'created' | 'updated', operationId?: string): void {
    emitDomainChange({
      domain: 'documents',
      entityType: 'document',
      entityId: snapshot.documentId,
      operation,
      revision: snapshot.revision,
      operationId,
    });
  }

  private parseScopedDocumentId(documentId: string): { scopeId: string; relativePath: string } | null {
    if (!documentId.startsWith('scope:')) return null;
    const rest = documentId.slice('scope:'.length);
    const scopeIds = Array.from(this.roots.keys()).sort((a, b) => b.length - a.length);
    for (const scopeId of scopeIds) {
      const prefix = `${scopeId}:`;
      if (rest.startsWith(prefix)) {
        return { scopeId, relativePath: rest.slice(prefix.length) };
      }
    }
    return null;
  }

  private async resolveAuthoritative(
    workspaceId: string,
    documentId: string | undefined,
    target: { scopeId: string; relativePath: string } | undefined,
  ): Promise<{
    documentId: string;
    title: string;
    content: string;
    revision: string;
    path: string;
    relativePath: string | null;
    scopeId: string | null;
    kind: 'draft' | 'file';
    source: 'editor' | 'disk';
    isDirty: boolean;
  }> {
    const open = this.openBuffer(workspaceId);

    if (target) {
      const relativePath = normalizeRelativePath(target.relativePath);
      const absolutePath = this.resolveScopePath(target.scopeId, relativePath);
      const id = fileDocumentId(target.scopeId, relativePath);
      if (open?.isDirty && normalizePath(open.path) === normalizePath(absolutePath)) {
        const revision = await computeRevision(open.content);
        return {
          documentId: id,
          title: open.name,
          content: open.content,
          revision,
          path: open.path,
          relativePath,
          scopeId: target.scopeId,
          kind: 'file',
          source: 'editor',
          isDirty: true,
        };
      }
      const content = await this.files.readText(absolutePath);
      const revision = await computeRevision(content);
      this.diskRevisions.set(normalizePath(absolutePath), revision);
      return {
        documentId: id,
        title: titleFromPath(absolutePath, relativePath),
        content,
        revision,
        path: absolutePath,
        relativePath,
        scopeId: target.scopeId,
        kind: 'file',
        source: 'disk',
        isDirty: false,
      };
    }

    if (documentId) {
      const scoped = this.parseScopedDocumentId(documentId);
      if (scoped) {
        return this.resolveAuthoritative(workspaceId, undefined, scoped);
      }
      if (documentId === draftDocumentId(workspaceId) || documentId.startsWith('draft:')) {
        if (open && (open.path === draftPathFor(workspaceId) || open.path.startsWith(DRAFT_PATH_PREFIX))) {
          const revision = await computeRevision(open.content);
          return {
            documentId: draftDocumentId(workspaceId),
            title: open.name,
            content: open.content,
            revision,
            path: open.path,
            relativePath: null,
            scopeId: null,
            kind: 'draft',
            source: 'editor',
            isDirty: open.isDirty,
          };
        }
        const remembered = this.snapshots.get(draftDocumentId(workspaceId));
        if (remembered) {
          return {
            ...remembered,
            source: 'editor',
            isDirty: remembered.isDirty,
          };
        }
        throw new Error(`Draft ${documentId} is not open.`);
      }

      if (open) {
        const openId = absoluteDocumentId(open.path);
        if (documentId === openId || this.snapshots.get(documentId)?.path === open.path) {
          const revision = await computeRevision(open.content);
          return {
            documentId,
            title: open.name,
            content: open.content,
            revision,
            path: open.path,
            relativePath: this.snapshots.get(documentId)?.relativePath ?? null,
            scopeId: this.snapshots.get(documentId)?.scopeId ?? null,
            kind: 'file',
            source: 'editor',
            isDirty: open.isDirty,
          };
        }
      }

      const remembered = this.snapshots.get(documentId);
      if (remembered) {
        if (remembered.scopeId && remembered.relativePath) {
          const absolutePath = this.resolveScopePath(remembered.scopeId, remembered.relativePath);
          if (open?.isDirty && normalizePath(open.path) === normalizePath(absolutePath)) {
            const revision = await computeRevision(open.content);
            return {
              documentId,
              title: open.name,
              content: open.content,
              revision,
              path: open.path,
              relativePath: remembered.relativePath,
              scopeId: remembered.scopeId,
              kind: 'file',
              source: 'editor',
              isDirty: true,
            };
          }
          const content = await this.files.readText(absolutePath);
          const revision = await computeRevision(content);
          this.diskRevisions.set(normalizePath(absolutePath), revision);
          return {
            documentId,
            title: remembered.title,
            content,
            revision,
            path: absolutePath,
            relativePath: remembered.relativePath,
            scopeId: remembered.scopeId,
            kind: 'file',
            source: 'disk',
            isDirty: false,
          };
        }
        if (remembered.kind === 'file') {
          const content = await this.files.readText(remembered.path);
          const revision = await computeRevision(content);
          this.diskRevisions.set(normalizePath(remembered.path), revision);
          return {
            documentId,
            title: remembered.title,
            content,
            revision,
            path: remembered.path,
            relativePath: remembered.relativePath,
            scopeId: remembered.scopeId,
            kind: 'file',
            source: 'disk',
            isDirty: false,
          };
        }
      }

      if (documentId.startsWith('file:')) {
        const path = documentId.slice('file:'.length);
        if (open?.isDirty && normalizePath(open.path) === normalizePath(path)) {
          const revision = await computeRevision(open.content);
          return {
            documentId,
            title: open.name,
            content: open.content,
            revision,
            path: open.path,
            relativePath: null,
            scopeId: null,
            kind: 'file',
            source: 'editor',
            isDirty: true,
          };
        }
        const content = await this.files.readText(path);
        const revision = await computeRevision(content);
        this.diskRevisions.set(normalizePath(path), revision);
        return {
          documentId,
          title: titleFromPath(path, path),
          content,
          revision,
          path,
          relativePath: null,
          scopeId: null,
          kind: 'file',
          source: 'disk',
          isDirty: false,
        };
      }

      throw new Error(`Document ${documentId} was not found.`);
    }

    if (open) {
      const revision = await computeRevision(open.content);
      const kind = open.path.startsWith(DRAFT_PATH_PREFIX) ? 'draft' : 'file';
      return {
        documentId: kind === 'draft' ? draftDocumentId(workspaceId) : absoluteDocumentId(open.path),
        title: open.name,
        content: open.content,
        revision,
        path: open.path,
        relativePath: null,
        scopeId: null,
        kind,
        source: 'editor',
        isDirty: open.isDirty,
      };
    }

    throw new Error('A documentId or scoped file target is required.');
  }
}

function isVirtualPath(path: string): boolean {
  const normalized = normalizePath(path);
  if (normalized.startsWith(DRAFT_PATH_PREFIX)) return true;
  return !(normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized));
}

export const documentCommands = new DocumentCommandService();
