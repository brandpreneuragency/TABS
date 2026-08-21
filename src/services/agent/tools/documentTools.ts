// ---------------------------------------------------------------------------
// TABS Work-OS Harness — Workspace and document read tools
// Handlers use run-owned context references. They never follow live UI
// selection. Open dirty editor buffers are authoritative.
// ---------------------------------------------------------------------------

import type { AgentToolDefinition, AgentToolResult, ToolExecutionContext } from '../../../types/agent';
import type { DocumentReadArgs, DocumentReadResult } from '../../documents/documentCommands';
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

export { DOCUMENT_READ_TOOL_NAMES };

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
