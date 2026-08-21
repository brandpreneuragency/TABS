// ---------------------------------------------------------------------------
// TABS Work-OS Harness — Workspace and document read tools
// Handlers use run-owned context references. They never follow live UI
// selection. Open dirty editor buffers are authoritative.
// ---------------------------------------------------------------------------

import type { AgentToolDefinition, AgentToolResult, ToolExecutionContext } from '../../../types/agent';
import type { DocumentCreateArgs, DocumentMutationResult, DocumentReadArgs, DocumentReadResult, DocumentUpdateArgs } from '../../documents/documentCommands';
import {
  asRecord,
  type ArtifactSink,
  defaultReadNormalize,
  defineReadTool,
  DOCUMENT_READ_TOOL_NAMES,
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
} from './readSupport';
import {
  allowlistedUpdateGrant,
  change,
  defineMutationTool,
  DOCUMENT_MUTATION_TOOL_NAMES,
  effectContentHash,
  FilesystemUncertaintyError,
  filesystemUncertaintyResult,
  mapMutationError,
  mutationOk,
  mutationReceipt,
  type MutationReceiptStore,
  objectSchema,
  resolvePriorReceipt,
  resourceLink,
} from './mutationSupport';

export { DOCUMENT_READ_TOOL_NAMES, DOCUMENT_MUTATION_TOOL_NAMES };

export interface WorkspaceReadRecord {
  id: string;
  name: string;
  revision: string;
  activeDocumentId?: string | null;
}

export interface DocumentSearchHit {
  documentId: string;
  workspaceId: string;
  title: string;
  content: string;
  revision: string;
  source: 'editor' | 'disk';
}

export interface DocumentReadToolDependencies {
  listWorkspaces?: () => Promise<WorkspaceReadRecord[]>;
  getWorkspace?: (id: string) => Promise<WorkspaceReadRecord | undefined>;
  readDocument?: (args: DocumentReadArgs) => Promise<DocumentReadResult>;
  searchDocuments?: (query: string, workspaceId?: string) => Promise<DocumentSearchHit[]>;
  putArtifact?: ArtifactSink;
}

function workspaceFilters(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      query: { type: 'string' },
    },
  };
}

function documentSearchFilters(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      query: { type: 'string' },
      workspaceId: { type: 'string', minLength: 1 },
    },
  };
}

async function defaultListWorkspaces(): Promise<WorkspaceReadRecord[]> {
  const { db } = await import('../../db');
  const workspaces = await db.workspaces.toArray();
  return workspaces.map((workspace) => ({
    id: workspace.id,
    name: workspace.name,
    revision: String(workspace.updatedAt),
    activeDocumentId: workspace.currentFile ? `file:${workspace.currentFile.path}` : null,
  }));
}

async function defaultGetWorkspace(id: string): Promise<WorkspaceReadRecord | undefined> {
  const workspaces = await defaultListWorkspaces();
  return workspaces.find((workspace) => workspace.id === id);
}

async function defaultReadDocument(args: DocumentReadArgs): Promise<DocumentReadResult> {
  const { documentCommands } = await import('../../documents/documentCommands');
  return documentCommands.readDocument(args);
}

async function defaultSearchDocuments(query: string, workspaceId?: string): Promise<DocumentSearchHit[]> {
  const { db } = await import('../../db');
  const needle = query.trim().toLowerCase();
  const workspaces = await db.workspaces.toArray();
  const hits: DocumentSearchHit[] = [];
  for (const workspace of workspaces) {
    if (workspaceId && workspace.id !== workspaceId) continue;
    const file = workspace.currentFile;
    if (!file) continue;
    const haystack = `${file.name}\n${file.content}`.toLowerCase();
    if (needle && !haystack.includes(needle)) continue;
    hits.push({
      documentId: `file:${file.path}`,
      workspaceId: workspace.id,
      title: file.name,
      content: file.content,
      revision: String(workspace.updatedAt),
      source: file.isDirty ? 'editor' : 'disk',
    });
  }
  return hits;
}

export function createDocumentReadTools(deps: DocumentReadToolDependencies = {}): AgentToolDefinition[] {
  const listWorkspaces = deps.listWorkspaces ?? defaultListWorkspaces;
  const getWorkspace = deps.getWorkspace ?? defaultGetWorkspace;
  const readDocument = deps.readDocument ?? defaultReadDocument;
  const searchDocuments = deps.searchDocuments ?? defaultSearchDocuments;
  const putArtifact = deps.putArtifact;

  const workspaceList = defineReadTool({
    name: 'workspace_list',
    description: 'List available workspaces with stable identifiers and revisions.',
    inputSchema: listInputSchema(workspaceFilters()),
    resolveResourceKeys: () => ['workspace'],
    async execute(_context: ToolExecutionContext, args: unknown): Promise<AgentToolResult> {
      const record = asRecord(args);
      const filters = asRecord(record.filters);
      const query = typeof filters.query === 'string' ? filters.query.trim().toLowerCase() : '';
      try {
        const all = await listWorkspaces();
        const matched = query
          ? all.filter((workspace) => workspace.name.toLowerCase().includes(query) || workspace.id.includes(query))
          : all;
        const page = paginateList(matched, record.cursor, normalizeListLimit(record.limit));
        return ok(`Listed ${page.count} of ${page.total} workspaces`, {
          items: page.items.map((workspace) => ({
            ...sourceRef('workspace', workspace.id, workspace.revision),
            id: workspace.id,
            name: workspace.name,
            activeDocumentId: workspace.activeDocumentId ?? null,
          })),
          nextCursor: page.nextCursor,
          truncated: page.truncated,
          total: page.total,
        });
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : 'Workspace list failed';
        return fail('internal_error', message);
      }
    },
  });

  const workspaceGet = defineReadTool({
    name: 'workspace_get',
    description: 'Read workspace metadata and the active document reference captured for this run.',
    inputSchema: entityReadSchema(),
    resolveResourceKeys: (_context, args) => [`workspace:${asRecord(args).id}`],
    normalizeArgs: defaultReadNormalize,
    async execute(context: ToolExecutionContext, args: unknown): Promise<AgentToolResult> {
      const record = asRecord(args);
      const id = String(record.id);
      const frozen = resolveFrozenId(context, 'workspace', id);
      try {
        const workspace = await getWorkspace(id);
        if (!workspace) return fail('not_found', `Workspace ${id} was not found.`);
        const stale = staleIfMismatch(
          typeof record.revision === 'string' ? record.revision : frozen?.revision,
          workspace.revision,
          `Workspace ${id}`,
        );
        if (stale) return { ...stale, observedRevision: workspace.revision };
        const frozenDocument = resolveFrozenId(context, 'document');
        return ok(`Read workspace ${workspace.name}`, {
          ...sourceRef('workspace', workspace.id, workspace.revision),
          id: workspace.id,
          name: workspace.name,
          activeDocumentId: frozenDocument?.id ?? workspace.activeDocumentId ?? null,
          frozen: Boolean(frozen),
        }, { observedRevision: workspace.revision });
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : 'Workspace read failed';
        return fail('internal_error', message);
      }
    },
  });

  const documentRead = defineReadTool({
    name: 'document_read',
    description: 'Read a bounded document view. Dirty editor content is authoritative.',
    inputSchema: entityReadSchema({
      workspaceId: { type: 'string', minLength: 1 },
    }),
    resolveResourceKeys: (_context, args) => [`document:${asRecord(args).id}`],
    async execute(context: ToolExecutionContext, args: unknown): Promise<AgentToolResult> {
      const record = asRecord(args);
      const documentId = String(record.id);
      const frozenDocument = resolveFrozenId(context, 'document', documentId);
      const frozenWorkspace = resolveFrozenId(context, 'workspace');
      const workspaceId = typeof record.workspaceId === 'string'
        ? record.workspaceId
        : frozenWorkspace?.id ?? context.workspaceScope?.workspaceId;
      if (!workspaceId) return fail('validation_failed', 'workspaceId is required.');
      try {
        const result = await readDocument({
          workspaceId,
          documentId,
          revision: typeof record.revision === 'string' ? record.revision : undefined,
          section: typeof record.section === 'string' ? record.section : undefined,
          cursor: typeof record.cursor === 'string' || typeof record.cursor === 'number' ? record.cursor : undefined,
          limit: normalizeListLimit(record.limit),
        });
        const expected = typeof record.revision === 'string' ? record.revision : frozenDocument?.revision;
        const stale = staleIfMismatch(expected, result.revision, `Document ${documentId}`);
        if (stale) return { ...stale, observedRevision: result.revision };
        const payload = {
          ...sourceRef('document', result.documentId, result.revision),
          id: result.documentId,
          workspaceId: result.workspaceId,
          title: result.title,
          source: result.source,
          content: result.content,
          offset: result.offset,
          length: result.length,
          totalLength: result.totalLength,
          truncated: result.truncated,
          nextCursor: result.nextCursor,
        };
        const bounded = await spillIfLarge(context.runId, `document:${result.documentId}`, payload, putArtifact);
        return ok(
          `Read document ${result.title} from ${result.source}`,
          bounded.data,
          { observedRevision: result.revision, artifacts: bounded.artifacts },
        );
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : 'Document read failed';
        if (/not found|is not open|required/i.test(message)) return fail('not_found', message);
        return fail('internal_error', message);
      }
    },
  });

  const documentSearch = defineReadTool({
    name: 'document_search',
    description: 'Search document text and metadata with a bounded result page.',
    inputSchema: listInputSchema(documentSearchFilters()),
    resolveResourceKeys: (context, args) => {
      const filters = asRecord(asRecord(args).filters);
      const workspaceId = typeof filters.workspaceId === 'string'
        ? filters.workspaceId
        : resolveFrozenId(context, 'workspace')?.id;
      return workspaceId ? [`workspace:${workspaceId}:documents`] : ['document'];
    },
    async execute(context: ToolExecutionContext, args: unknown): Promise<AgentToolResult> {
      const record = asRecord(args);
      const filters = asRecord(record.filters);
      const query = typeof filters.query === 'string' ? filters.query : '';
      const workspaceId = typeof filters.workspaceId === 'string'
        ? filters.workspaceId
        : resolveFrozenId(context, 'workspace')?.id;
      try {
        const hits = await searchDocuments(query, workspaceId);
        const page = paginateList(hits, record.cursor, normalizeListLimit(record.limit));
        return ok(`Found ${page.total} document matches`, {
          items: page.items.map((hit) => ({
            ...sourceRef('document', hit.documentId, hit.revision),
            id: hit.documentId,
            workspaceId: hit.workspaceId,
            title: hit.title,
            snippet: hit.content.slice(0, 240),
            source: hit.source,
          })),
          nextCursor: page.nextCursor,
          truncated: page.truncated,
          total: page.total,
        });
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : 'Document search failed';
        return fail('internal_error', message);
      }
    },
  });

  return [workspaceList, workspaceGet, documentRead, documentSearch];
}

const DOCUMENT_CREATE_TARGET_SCHEMA = {
  oneOf: [
    objectSchema({
      kind: { type: 'string', const: 'draft' },
    }, ['kind']),
    objectSchema({
      kind: { type: 'string', const: 'file' },
      relativePath: { type: 'string', minLength: 1 },
      expectedState: { type: 'string', const: 'absent' },
    }, ['kind', 'relativePath', 'expectedState']),
  ],
};

const DOCUMENT_EDIT_SCHEMA = {
  oneOf: [
    objectSchema({
      kind: { type: 'string', const: 'replace_all' },
      content: { type: 'string' },
    }, ['kind', 'content']),
    objectSchema({
      kind: { type: 'string', const: 'replace_text' },
      oldText: { type: 'string', minLength: 1 },
      newText: { type: 'string' },
      replaceAll: { type: 'boolean' },
      expectedMatchCount: { type: 'integer', minimum: 0 },
    }, ['kind', 'oldText', 'newText', 'replaceAll', 'expectedMatchCount']),
  ],
};

export interface DocumentMutationPort {
  createDocument(args: DocumentCreateArgs): Promise<DocumentMutationResult>;
  updateDocument(args: DocumentUpdateArgs): Promise<DocumentMutationResult>;
}

export interface DocumentMutationToolDependencies {
  commands?: DocumentMutationPort;
  receipts?: MutationReceiptStore;
  putArtifact?: ArtifactSink;
}

async function defaultDocumentCommands(): Promise<DocumentMutationPort> {
  const { documentCommands } = await import('../../documents/documentCommands');
  return {
    createDocument: (args) => documentCommands.createDocument(args),
    updateDocument: (args) => documentCommands.updateDocument(args),
  };
}

function documentConflictResult(result: Extract<DocumentMutationResult, { ok: false }>): AgentToolResult {
  const code = result.reason === 'stale_revision' || result.reason === 'workspace_revision'
    ? 'stale_revision'
    : 'conflict';
  return {
    ok: false,
    summary: `Document ${result.reason.replace(/_/g, ' ')}`,
    observedRevision: result.currentRevision,
    data: {
      reason: result.reason,
      documentId: result.documentId,
      content: result.content,
    },
    error: {
      code,
      message: `Document ${result.reason.replace(/_/g, ' ')}`,
      retryable: false,
    },
  };
}

function documentSuccess(
  operation: 'created' | 'updated',
  result: Extract<DocumentMutationResult, { ok: true }>,
  operationId: string,
  fingerprint: string,
  receipt: ReturnType<typeof mutationReceipt>,
  extras: { replayed?: boolean; repeatedEffect?: boolean; projectionPending?: boolean },
): AgentToolResult {
  const resourceKey = `document:${result.documentId}`;
  return mutationOk({
    summary: operation === 'created' ? `Created document ${result.snapshot.title}` : `Updated document ${result.snapshot.title}`,
    operationId,
    effectFingerprint: fingerprint,
    receipt,
    resourceLinks: [resourceLink('document', result.documentId, resourceKey, result.snapshot.title)],
    changes: [change(resourceKey, operation, `${operation} ${result.snapshot.title}`)],
    entity: result.snapshot,
    after: result.snapshot,
    observedRevision: result.revision,
    projectionPending: extras.projectionPending === true,
    replayed: extras.replayed,
    repeatedEffect: extras.repeatedEffect,
  });
}

export function createDocumentMutationTools(deps: DocumentMutationToolDependencies = {}): AgentToolDefinition[] {
  const receipts = deps.receipts;

  const documentCreate = defineMutationTool({
    name: 'document_create',
    description: 'Create a document or local draft using an expected workspace revision.',
    risk: 'local_create',
    sideEffect: 'reversible',
    inputSchema: objectSchema({
      workspaceId: { type: 'string', minLength: 1 },
      title: { type: 'string', minLength: 1 },
      target: DOCUMENT_CREATE_TARGET_SCHEMA,
      content: { type: 'string' },
      expectedWorkspaceRevision: { type: 'string', minLength: 1 },
    }, ['workspaceId', 'title', 'target', 'content', 'expectedWorkspaceRevision']),
    resolveResourceKeys: (_context, args) => {
      const record = asRecord(args);
      const workspaceId = String(record.workspaceId ?? '');
      const target = asRecord(record.target);
      if (target.kind === 'file' && typeof target.relativePath === 'string') {
        return [`workspace:${workspaceId}`, `workspace:${workspaceId}:path:${target.relativePath}`];
      }
      return [`workspace:${workspaceId}`, `workspace:${workspaceId}:draft`];
    },
    buildEffectPayload: (args) => {
      const record = asRecord(args);
      const target = asRecord(record.target);
      return {
        tool: 'document_create',
        workspaceId: record.workspaceId,
        title: record.title,
        target: target.kind === 'file'
          ? { kind: 'file', relativePath: target.relativePath, expectedState: 'absent' }
          : { kind: 'draft' },
        contentHash: effectContentHash(String(record.content ?? '')),
      };
    },
    validateGrant: (grant, args) => {
      const parents = grant.argumentConstraints.parentResourceKeys;
      if (!Array.isArray(parents) || parents.length === 0) return true;
      const workspaceId = String(asRecord(args).workspaceId ?? '');
      return parents.includes(`workspace:${workspaceId}`);
    },
    async execute(context: ToolExecutionContext, args: unknown): Promise<AgentToolResult> {
      const record = asRecord(args);
      const operationId = context.operationId as string;
      const fingerprint = context.effectFingerprint as string;
      const prior = await resolvePriorReceipt(receipts, operationId, fingerprint);
      if (prior.kind === 'mismatch') return fail('conflict', `Operation ${operationId} was already committed with a different effect.`);
      if (prior.kind === 'replay' || prior.kind === 'repeat') {
        const stored = prior.receipt.resultData as Extract<DocumentMutationResult, { ok: true }>;
        return documentSuccess('created', stored, operationId, fingerprint, prior.receipt, {
          replayed: prior.kind === 'replay',
          repeatedEffect: prior.kind === 'repeat',
        });
      }
      const targetRecord = asRecord(record.target);
      const target: DocumentCreateArgs['target'] = targetRecord.kind === 'file'
        ? {
            kind: 'file',
            relativePath: String(targetRecord.relativePath),
            expectedState: 'absent',
            scopeId: context.workspaceScope?.nativeScopeId ?? '',
          }
        : { kind: 'draft' };
      if (target.kind === 'file' && !target.scopeId) {
        return fail('unavailable', 'Native workspace scope is required for file document creation.');
      }
      try {
        const commands = deps.commands ?? await defaultDocumentCommands();
        const result = await commands.createDocument({
          workspaceId: String(record.workspaceId),
          title: String(record.title),
          target,
          content: String(record.content ?? ''),
          expectedWorkspaceRevision: String(record.expectedWorkspaceRevision),
          operationId,
        });
        if (result.ok === false) return documentConflictResult(result);
        const receipt = mutationReceipt({
          operationId,
          effectFingerprint: fingerprint,
          domain: 'documents',
          resourceKeys: [`document:${result.documentId}`],
          summary: 'document created',
          resultData: result,
        });
        await receipts?.put(receipt);
        return documentSuccess('created', result, operationId, fingerprint, receipt, {
          projectionPending: result.snapshot.kind === 'file',
        });
      } catch (caught) {
        if (caught instanceof FilesystemUncertaintyError) return filesystemUncertaintyResult(caught);
        return mapMutationError(caught);
      }
    },
  });

  const documentUpdate = defineMutationTool({
    name: 'document_update',
    description: 'Apply a checked document update using an expected revision.',
    risk: 'local_update',
    sideEffect: 'reversible',
    inputSchema: objectSchema({
      workspaceId: { type: 'string', minLength: 1 },
      documentId: { type: 'string', minLength: 1 },
      expectedRevision: { type: 'string', minLength: 1 },
      edit: DOCUMENT_EDIT_SCHEMA,
    }, ['workspaceId', 'documentId', 'expectedRevision', 'edit']),
    resolveResourceKeys: (_context, args) => {
      const record = asRecord(args);
      return [`document:${record.documentId}`, `workspace:${record.workspaceId}`];
    },
    buildEffectPayload: (args) => {
      const record = asRecord(args);
      const edit = asRecord(record.edit);
      return {
        tool: 'document_update',
        workspaceId: record.workspaceId,
        documentId: record.documentId,
        edit: edit.kind === 'replace_all'
          ? { kind: 'replace_all', contentHash: effectContentHash(String(edit.content ?? '')) }
          : {
              kind: 'replace_text',
              oldText: edit.oldText,
              newText: edit.newText,
              replaceAll: edit.replaceAll,
              expectedMatchCount: edit.expectedMatchCount,
              contentHash: effectContentHash(String(edit.newText ?? '')),
            },
      };
    },
    validateGrant: allowlistedUpdateGrant,
    async execute(context: ToolExecutionContext, args: unknown): Promise<AgentToolResult> {
      const record = asRecord(args);
      const operationId = context.operationId as string;
      const fingerprint = context.effectFingerprint as string;
      const prior = await resolvePriorReceipt(receipts, operationId, fingerprint);
      if (prior.kind === 'mismatch') return fail('conflict', `Operation ${operationId} was already committed with a different effect.`);
      if (prior.kind === 'replay' || prior.kind === 'repeat') {
        const stored = prior.receipt.resultData as Extract<DocumentMutationResult, { ok: true }>;
        return documentSuccess('updated', stored, operationId, fingerprint, prior.receipt, {
          replayed: prior.kind === 'replay',
          repeatedEffect: prior.kind === 'repeat',
        });
      }
      const editRecord = asRecord(record.edit);
      const edit: DocumentUpdateArgs['edit'] = editRecord.kind === 'replace_text'
        ? {
            kind: 'replace_text',
            oldText: String(editRecord.oldText),
            newText: String(editRecord.newText ?? ''),
            replaceAll: editRecord.replaceAll === true,
            expectedMatchCount: Number(editRecord.expectedMatchCount),
          }
        : { kind: 'replace_all', content: String(editRecord.content ?? '') };
      try {
        const commands = deps.commands ?? await defaultDocumentCommands();
        const result = await commands.updateDocument({
          workspaceId: String(record.workspaceId),
          documentId: String(record.documentId),
          expectedRevision: String(record.expectedRevision),
          edit,
          operationId,
        });
        if (result.ok === false) return documentConflictResult(result);
        const receipt = mutationReceipt({
          operationId,
          effectFingerprint: fingerprint,
          domain: 'documents',
          resourceKeys: [`document:${result.documentId}`],
          summary: 'document updated',
          resultData: result,
        });
        await receipts?.put(receipt);
        return documentSuccess('updated', result, operationId, fingerprint, receipt, {});
      } catch (caught) {
        if (caught instanceof FilesystemUncertaintyError) return filesystemUncertaintyResult(caught);
        return mapMutationError(caught);
      }
    },
  });

  return [documentCreate, documentUpdate];
}
