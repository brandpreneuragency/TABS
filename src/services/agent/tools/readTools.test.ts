import { describe, expect, it } from 'vitest';
import type {
  AgentContextRef,
  AgentToolResult,
  ToolExecutionContext,
} from '../../../types/agent';
import type { Project, Task, TaskComment } from '../../../types';
import type { CRMActivity, CRMContact, CRMLead, CRMNote } from '../../../types/crm';
import type { LeadForm, LeadFormSubmission } from '../../../types/forms';
import {
  captureContextRefs,
  captureRunContext,
  CONTEXT_KINDS,
} from '../contextManager';
import { MAX_LIST_PAGE_SIZE, MIN_LIST_PAGE_SIZE, MAX_TOOL_RESULT_BYTES } from '../helpers';
import { ToolRegistry } from '../toolRegistry';
import {
  DocumentCommandService,
  type DocumentFileAccess,
  type OpenDocumentBuffer,
} from '../../documents/documentCommands';
import type { CRMEntityBundle, CRMReadPort, CRMSearchHit } from './crmTools';
import type { DocumentSearchHit, WorkspaceReadRecord } from './documentTools';
import type { FormReadPort } from './formTools';
import { INLINE_RESULT_BYTE_LIMIT, READ_TOOL_NAMES, fail as toolFail, sliceLines } from './readSupport';
import type { TaskReadPort } from './taskTools';

const ROOT = '/workspace';
const NOTES = `${ROOT}/notes.md`;
const SCOPE_ID = 'opaque-native-scope';

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

function context(refs: AgentContextRef[] = []): ToolExecutionContext {
  return {
    runId: 'run-1',
    turn: 1,
    executionEpoch: 0,
    mode: 'read_only',
    contextRefs: refs,
    abortSignal: new AbortController().signal,
  };
}

function runState(refs: AgentContextRef[] = []) {
  return { runId: 'run-1', mode: 'read_only' as const, policyRevision: 1, contextRefs: refs };
}

function makeTask(id: string, title: string, extra: Partial<Task> = {}): Task {
  return {
    id,
    title,
    content: extra.content ?? '',
    status: extra.status ?? 'pending',
    importance: extra.importance ?? 'medium',
    date: extra.date ?? '2026-08-20',
    projectId: extra.projectId ?? null,
    assignees: extra.assignees ?? [],
    createdAt: extra.createdAt ?? 1,
    updatedAt: extra.updatedAt ?? 10,
    order: extra.order ?? 0,
    parentId: extra.parentId,
    deletedAt: extra.deletedAt,
  };
}

function makeForm(id: string, extra: Partial<LeadForm> = {}): LeadForm {
  return {
    id,
    name: extra.name ?? `Form ${id}`,
    status: extra.status ?? 'published',
    fields: extra.fields ?? [
      { id: 'f1', type: 'email', label: 'Email', name: 'email', order: 0, required: true },
    ],
    steps: extra.steps ?? [{ id: 's1', title: 'Step 1', order: 0 }],
    logicRules: extra.logicRules ?? [],
    style: extra.style ?? {},
    embed: extra.embed ?? { allowedDomains: [], defaultMode: 'iframe' },
    successMessage: extra.successMessage ?? 'Thanks',
    createdAt: extra.createdAt ?? '2026-08-20T00:00:00.000Z',
    updatedAt: extra.updatedAt ?? '2026-08-20T00:00:00.000Z',
    description: extra.description,
  };
}

function makeSubmission(id: string, extra: Partial<LeadFormSubmission> = {}): LeadFormSubmission {
  return {
    id,
    formId: extra.formId ?? 'form-1',
    status: extra.status ?? 'new',
    fields: extra.fields ?? { email: 'ada@example.com', name: 'Ada Lovelace' },
    hiddenFields: extra.hiddenFields ?? {},
    createdAt: extra.createdAt ?? '2026-08-20T00:00:00.000Z',
    leadId: extra.leadId,
    contactId: extra.contactId,
    companyId: extra.companyId,
    sourceDomain: extra.sourceDomain ?? 'example.com',
    spamScore: extra.spamScore,
    allowedDomainMatched: extra.allowedDomainMatched,
  };
}

function fixtureCatalog() {
  const workspaces: WorkspaceReadRecord[] = [
    { id: 'ws-frozen', name: 'Frozen workspace', revision: 'ws-rev-1', activeDocumentId: 'doc-frozen' },
    { id: 'ws-live', name: 'Live workspace', revision: 'ws-rev-2', activeDocumentId: 'doc-live' },
    { id: 'ws-3', name: 'Third', revision: 'ws-rev-3' },
    { id: 'ws-4', name: 'Fourth', revision: 'ws-rev-4' },
    { id: 'ws-5', name: 'Fifth', revision: 'ws-rev-5' },
  ];
  const documents: DocumentSearchHit[] = [
    {
      documentId: 'doc-frozen',
      workspaceId: 'ws-frozen',
      title: 'frozen.md',
      content: 'frozen body',
      revision: 'doc-rev-1',
      source: 'disk',
    },
    {
      documentId: 'doc-live',
      workspaceId: 'ws-live',
      title: 'live.md',
      content: 'later selection',
      revision: 'doc-rev-live',
      source: 'disk',
    },
  ];
  const tasks = [
    makeTask('task-frozen', 'Frozen task', { updatedAt: 100, order: 0 }),
    makeTask('task-2', 'Follow up', { updatedAt: 110, order: 1, projectId: 'proj-1' }),
    makeTask('task-3', 'Inbox item', { updatedAt: 120, order: 2 }),
    makeTask('task-child', 'Child', { updatedAt: 130, order: 0, parentId: 'task-frozen' }),
  ];
  const comments: TaskComment[] = [
    { id: 'c1', taskId: 'task-frozen', sender: 'You', text: 'first note', createdAt: 1 },
    { id: 'c2', taskId: 'task-frozen', sender: 'You', text: 'second note', createdAt: 2 },
  ];
  const projects: Project[] = [
    { id: 'proj-1', name: 'Launch', color: '#111', createdAt: 1 },
    { id: 'proj-2', name: 'Inbox work', color: '#222', createdAt: 2 },
  ];
  const lead: CRMLead = {
    id: 'lead-1',
    title: 'Website inquiry',
    contactId: 'contact-1',
    status: 'new',
    stage: 'new',
    tags: ['form'],
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
    sourceSubmissionId: 'sub-1',
    sourceFormId: 'form-1',
  };
  const contact: CRMContact = {
    id: 'contact-1',
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'ada@example.com',
    tags: [],
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
  };
  const activities: CRMActivity[] = [
    { id: 'a1', type: 'form_submitted', title: 'Form submitted', leadId: 'lead-1', createdAt: '2026-08-20T00:00:00.000Z' },
    { id: 'a2', type: 'lead_created', title: 'Lead created', leadId: 'lead-1', createdAt: '2026-08-20T00:01:00.000Z' },
  ];
  const notes: CRMNote[] = [
    { id: 'n1', body: 'Call back', leadId: 'lead-1', createdAt: '2026-08-20T00:02:00.000Z', updatedAt: '2026-08-20T00:02:00.000Z' },
  ];
  const forms = [
    makeForm('form-1', { name: 'Contact form' }),
    makeForm('form-invalid', {
      name: 'Broken',
      fields: [
        { id: 'dup', type: 'text', label: 'A', name: 'a', order: 0 },
        { id: 'dup', type: 'text', label: 'B', name: 'a', order: 1 },
      ],
    }),
  ];
  const submissions = [
    makeSubmission('sub-1', { formId: 'form-1', leadId: 'lead-1', contactId: 'contact-1' }),
    makeSubmission('sub-2', { formId: 'form-1', fields: { email: 'other@example.com' } }),
    makeSubmission('sub-3', { formId: 'form-1', status: 'spam' }),
  ];
  const mutations = { forms: 0, crm: 0, tasks: 0, submissions: 0 };

  const taskPort: TaskReadPort = {
    async listTasks(filters = {}) {
      let listed = tasks.filter((task) => !task.deletedAt || filters.includeDeleted);
      if (filters.projectId !== undefined) listed = listed.filter((task) => task.projectId === filters.projectId);
      if (filters.status) listed = listed.filter((task) => task.status === filters.status);
      if (filters.parentId !== undefined) {
        listed = filters.parentId
          ? listed.filter((task) => task.parentId === filters.parentId)
          : listed.filter((task) => !task.parentId);
      }
      const query = filters.query?.trim().toLowerCase();
      if (query) listed = listed.filter((task) => task.title.toLowerCase().includes(query));
      return listed;
    },
    async getTask(taskId) {
      return tasks.find((task) => task.id === taskId);
    },
    async listSubtasks(parentId) {
      return tasks.filter((task) => task.parentId === parentId);
    },
    async listTaskComments(taskId) {
      return comments.filter((comment) => comment.taskId === taskId);
    },
    async listProjects() {
      return projects;
    },
  };

  const crmPort: CRMReadPort = {
    async search(query, entityTypes) {
      const needle = query.trim().toLowerCase();
      const types = entityTypes && entityTypes.length > 0 ? entityTypes : ['lead', 'contact', 'company', 'deal'];
      const hits: CRMSearchHit[] = [];
      if (types.includes('lead') && (!needle || lead.title.toLowerCase().includes(needle))) {
        hits.push({ entityType: 'lead', id: lead.id, title: lead.title, revision: lead.updatedAt });
      }
      if (types.includes('contact') && (!needle || `${contact.firstName} ${contact.lastName}`.toLowerCase().includes(needle) || (contact.email ?? '').includes(needle))) {
        hits.push({
          entityType: 'contact',
          id: contact.id,
          title: `${contact.firstName} ${contact.lastName}`,
          revision: contact.updatedAt,
        });
      }
      return hits;
    },
    async getEntity(entityType, entityId): Promise<CRMEntityBundle | undefined> {
      if (entityType === 'lead' && entityId === lead.id) {
        return { entityType, entity: lead, timeline: activities, notes };
      }
      if (entityType === 'contact' && entityId === contact.id) {
        return { entityType, entity: contact, timeline: [], notes: [] };
      }
      return undefined;
    },
  };

  const formPort: FormReadPort = {
    async listForms() {
      return forms;
    },
    async getForm(id) {
      return forms.find((form) => form.id === id);
    },
    validateForm(form) {
      const ids = form.fields.map((field) => field.id);
      const names = form.fields.map((field) => field.name);
      const issues = [];
      if (new Set(ids).size !== ids.length) {
        issues.push({ path: 'fields', code: 'duplicate_id' as const, message: 'Duplicate field id.' });
      }
      if (new Set(names).size !== names.length) {
        issues.push({ path: 'fields', code: 'duplicate_name' as const, message: 'Duplicate field name.' });
      }
      return { valid: issues.length === 0, issues };
    },
    async listSubmissions(formId) {
      return formId ? submissions.filter((submission) => submission.formId === formId) : submissions;
    },
    async getSubmission(id) {
      return submissions.find((submission) => submission.id === id);
    },
  };

  const artifacts = new Map<string, { revision: string; content: string }>([
    ['art-1', { revision: 'sha256:abc', content: Array.from({ length: 12 }, (_, index) => `line-${index}`).join('\n') }],
  ]);

  return {
    workspaces,
    documents,
    tasks,
    mutations,
    lead,
    contact,
    forms,
    submissions,
    artifacts,
    read: {
      documents: {
        listWorkspaces: async () => workspaces,
        getWorkspace: async (id: string) => workspaces.find((workspace) => workspace.id === id),
        searchDocuments: async (query: string, workspaceId?: string) => documents.filter((hit) => {
          if (workspaceId && hit.workspaceId !== workspaceId) return false;
          if (!query.trim()) return true;
          return `${hit.title}\n${hit.content}`.toLowerCase().includes(query.toLowerCase());
        }),
      },
      tasks: { tasks: taskPort },
      crm: { crm: crmPort },
      forms: { forms: formPort },
    },
    system: {
      readArtifact: async (request: {
        runId: string;
        id: string;
        revision?: string;
        section?: string;
        cursor?: string | number;
        limit: number;
      }): Promise<AgentToolResult> => {
        const artifact = artifacts.get(request.id);
        if (!artifact) return toolFail('not_found', `Artifact ${request.id} was not found.`);
        if (request.revision && request.revision !== artifact.revision) {
          return {
            ok: false,
            summary: `Artifact ${request.id} changed since revision ${request.revision}; current revision is ${artifact.revision}.`,
            observedRevision: artifact.revision,
            error: { code: 'stale_revision', message: 'stale artifact revision', retryable: false },
          };
        }
        const page = sliceLines(artifact.content, request.cursor, request.limit, request.section);
        return {
          ok: true,
          summary: `Read artifact ${request.id}`,
          observedRevision: artifact.revision,
          data: {
            sourceId: `artifact:${request.id}`,
            sourceKind: 'file',
            revision: artifact.revision,
            content: page.content,
            offset: page.offset,
            truncated: page.truncated,
            nextCursor: page.nextCursor,
            total: page.total,
          },
        };
      },
    },
  };
}

function registryFor(catalog: ReturnType<typeof fixtureCatalog>, documentRead?: DocumentCommandService) {
  return ToolRegistry.createDefault({
    system: catalog.system,
    read: {
      ...catalog.read,
      documents: {
        ...catalog.read.documents,
        readDocument: documentRead
          ? (args) => documentRead.readDocument(args)
          : async () => {
              throw new Error('Document missing.md was not found.');
            },
        putArtifact: async ({ label, content }) => ({
          id: `artifact:${label}`,
          kind: 'tool_output',
          label,
          byteSize: content.length,
        }),
      },
      tasks: {
        ...catalog.read.tasks,
        putArtifact: async ({ label, content }) => ({
          id: `artifact:${label}`,
          kind: 'tool_output',
          label,
          byteSize: content.length,
        }),
      },
    },
  });
}

async function invoke(
  registry: ToolRegistry,
  name: string,
  args: unknown,
  refs: AgentContextRef[] = [],
) {
  return registry.invoke(context(refs), name, args, { run: runState(refs) });
}

describe('frozen context references', () => {
  it('captures context kinds and ignores later mutation attempts', () => {
    expect(CONTEXT_KINDS).toEqual(['workspace', 'document', 'task', 'crm', 'form', 'submission', 'file']);
    const captured = captureRunContext({
      contextRefs: [
        { kind: 'submission', id: 'sub-1', label: 'Website inquiry', revision: '2026-08-20T00:00:00.000Z' },
      ],
      workspaceScope: {
        workspaceId: 'ws-frozen',
        rootPath: ROOT,
        rootRevision: 'root-1',
      },
    });
    expect(() => {
      (captured.contextRefs as AgentContextRef[]).push({ kind: 'document', id: 'nope', label: 'nope' });
    }).toThrow();
    expect(captured.contextRefs).toHaveLength(1);
    expect(captured.workspaceScope?.workspaceId).toBe('ws-frozen');
  });
});

describe('read tools', () => {
  it('registers every domain read tool', () => {
    const catalog = fixtureCatalog();
    const registry = registryFor(catalog);
    for (const name of READ_TOOL_NAMES) {
      expect(registry.get(name)?.name).toBe(name);
    }
  });

  it('paginates workspace lists and rejects out-of-range limits', async () => {
    const catalog = fixtureCatalog();
    const registry = registryFor(catalog);
    const page = await invoke(registry, 'workspace_list', { filters: {}, limit: 2 });
    expect(page.decision.outcome).toBe('allow');
    expect(page.result.ok).toBe(true);
    const data = page.result.data as { items: Array<{ id: string }>; nextCursor?: string; truncated: boolean };
    expect(data.items).toHaveLength(2);
    expect(data.nextCursor).toBe('2');
    expect(data.truncated).toBe(true);

    const next = await invoke(registry, 'workspace_list', { filters: {}, limit: 2, cursor: '2' });
    const nextData = next.result.data as { items: Array<{ id: string }> };
    expect(nextData.items[0]?.id).toBe('ws-3');

    const tooSmall = await invoke(registry, 'workspace_list', { filters: {}, limit: 0 });
    expect(tooSmall.result.error?.code).toBe('validation_failed');
    const tooLarge = await invoke(registry, 'workspace_list', { filters: {}, limit: MAX_LIST_PAGE_SIZE + 1 });
    expect(tooLarge.result.error?.code).toBe('validation_failed');
    expect(MIN_LIST_PAGE_SIZE).toBe(1);
  });

  it('does not follow later UI navigation away from frozen context', async () => {
    const catalog = fixtureCatalog();
    const liveUi = { selectedWorkspaceId: 'ws-frozen', selectedDocumentId: 'doc-frozen', selectedTaskId: 'task-frozen' };
    const frozen = captureContextRefs([
      { kind: 'workspace', id: 'ws-frozen', label: 'Frozen workspace', revision: 'ws-rev-1' },
      { kind: 'document', id: 'doc-frozen', label: 'frozen.md', revision: 'doc-rev-1' },
      { kind: 'task', id: 'task-frozen', label: 'Frozen task', revision: '100' },
      { kind: 'submission', id: 'sub-1', label: 'Website inquiry', revision: '2026-08-20T00:00:00.000Z' },
    ]);
    liveUi.selectedWorkspaceId = 'ws-live';
    liveUi.selectedDocumentId = 'doc-live';
    liveUi.selectedTaskId = 'task-2';
    catalog.workspaces[0].activeDocumentId = 'doc-live';

    const registry = registryFor(catalog);
    const workspace = await invoke(registry, 'workspace_get', { id: 'ws-frozen' }, frozen);
    expect((workspace.result.data as { id: string; activeDocumentId: string }).id).toBe('ws-frozen');
    expect((workspace.result.data as { activeDocumentId: string }).activeDocumentId).toBe('doc-frozen');
    expect(liveUi.selectedWorkspaceId).toBe('ws-live');

    const task = await invoke(registry, 'task_get', { id: 'task-frozen' }, frozen);
    expect((task.result.data as { id: string; title: string }).title).toBe('Frozen task');
    const submission = await invoke(registry, 'submission_get', { id: 'sub-1' }, frozen);
    expect((submission.result.data as { id: string }).id).toBe('sub-1');
  });

  it('returns current editor content for an open dirty document', async () => {
    const files = memoryFiles({ [NOTES]: 'disk version\nline two' });
    const open: { current: OpenDocumentBuffer | null } = {
      current: { path: NOTES, name: 'notes.md', content: 'editor dirty buffer\nextra', isDirty: true },
    };
    const documents = new DocumentCommandService(files, {
      getOpenBuffer: () => open.current,
      getWorkspaceRoot: () => ROOT,
    });
    documents.registerRoot(SCOPE_ID, ROOT);
    documents.registerRoot('workspace:ws-1', ROOT);
    const catalog = fixtureCatalog();
    const registry = registryFor(catalog, documents);
    const read = await invoke(registry, 'document_read', {
      id: `scope:${SCOPE_ID}:notes.md`,
      workspaceId: 'ws-1',
      limit: 1,
    });
    expect(read.result.ok).toBe(true);
    const data = read.result.data as { source: string; content: string; sourceId: string };
    expect(data.source).toBe('editor');
    expect(data.content).toBe('editor dirty buffer');
    expect(data.sourceId).toBe(`document:scope:${SCOPE_ID}:notes.md`);
    expect(files.store.get(NOTES)).toBe('disk version\nline two');
  });

  it('returns not_found for missing records', async () => {
    const catalog = fixtureCatalog();
    const registry = registryFor(catalog);
    const missingTask = await invoke(registry, 'task_get', { id: 'missing-task' });
    expect(missingTask.result.error?.code).toBe('not_found');
    const missingCrm = await invoke(registry, 'crm_entity_get', { id: 'missing', entityType: 'lead' });
    expect(missingCrm.result.error?.code).toBe('not_found');
    const missingForm = await invoke(registry, 'form_get', { id: 'missing-form' });
    expect(missingForm.result.error?.code).toBe('not_found');
    const missingSubmission = await invoke(registry, 'submission_get', { id: 'missing-sub' });
    expect(missingSubmission.result.error?.code).toBe('not_found');
    const missingWorkspace = await invoke(registry, 'workspace_get', { id: 'missing-ws' });
    expect(missingWorkspace.result.error?.code).toBe('not_found');
    const missingDocument = await invoke(registry, 'document_read', { id: 'missing.md', workspaceId: 'ws-1' });
    expect(missingDocument.result.error?.code).toBe('not_found');
    const missingArtifact = await invoke(registry, 'artifact_read', { id: 'missing-art', limit: 10 });
    expect(missingArtifact.result.error?.code).toBe('not_found');
  });

  it('returns stale_revision when a frozen or requested revision no longer matches', async () => {
    const catalog = fixtureCatalog();
    const registry = registryFor(catalog);
    const frozen = captureContextRefs([
      { kind: 'workspace', id: 'ws-frozen', label: 'Frozen workspace', revision: 'ws-old' },
      { kind: 'task', id: 'task-frozen', label: 'Frozen task', revision: '1' },
      { kind: 'form', id: 'form-1', label: 'Contact form', revision: 'old' },
    ]);
    const workspace = await invoke(registry, 'workspace_get', { id: 'ws-frozen' }, frozen);
    expect(workspace.result.error?.code).toBe('stale_revision');
    const task = await invoke(registry, 'task_get', { id: 'task-frozen', revision: '9' });
    expect(task.result.error?.code).toBe('stale_revision');
    const form = await invoke(registry, 'form_get', { id: 'form-1' }, frozen);
    expect(form.result.error?.code).toBe('stale_revision');
    const artifact = await invoke(registry, 'artifact_read', { id: 'art-1', revision: 'sha256:stale', limit: 4 });
    expect(artifact.result.error?.code).toBe('stale_revision');
  });

  it('bounds search matches and includes source identifiers', async () => {
    const catalog = fixtureCatalog();
    const registry = registryFor(catalog);
    const docs = await invoke(registry, 'document_search', { filters: { query: 'frozen' }, limit: 1 });
    const docData = docs.result.data as { items: Array<{ sourceId: string; revision: string }>; total: number };
    expect(docs.result.ok).toBe(true);
    expect(docData.items[0]?.sourceId).toBe('document:doc-frozen');
    expect(docData.items[0]?.revision).toBe('doc-rev-1');

    const crm = await invoke(registry, 'crm_search', { filters: { query: 'ada', entityTypes: ['contact'] }, limit: 10 });
    const crmData = crm.result.data as { items: Array<{ sourceId: string; entityType: string }> };
    expect(crmData.items).toHaveLength(1);
    expect(crmData.items[0]?.sourceId).toBe('crm:contact-1');
  });

  it('paginates tasks and projects through the task service port', async () => {
    const catalog = fixtureCatalog();
    const registry = registryFor(catalog);
    const listed = await invoke(registry, 'task_list', { filters: {}, limit: 2 });
    const data = listed.result.data as { items: Array<{ id: string }>; nextCursor?: string; total: number };
    expect(data.items).toHaveLength(2);
    expect(data.nextCursor).toBe('2');
    const projects = await invoke(registry, 'project_list', { filters: { query: 'Launch' }, limit: 10 });
    expect((projects.result.data as { items: Array<{ id: string }> }).items).toEqual([
      expect.objectContaining({ id: 'proj-1', sourceId: 'project:proj-1' }),
    ]);
  });

  it('spills oversized reads into a bounded artifact', async () => {
    const catalog = fixtureCatalog();
    catalog.tasks[0].content = 'x'.repeat(INLINE_RESULT_BYTE_LIMIT + 200);
    const registry = registryFor(catalog);
    const read = await invoke(registry, 'task_get', { id: 'task-frozen' });
    expect(read.result.ok).toBe(true);
    const data = read.result.data as { truncated?: boolean; artifactId?: string };
    expect(data.truncated).toBe(true);
    expect(data.artifactId).toMatch(/^artifact:task:/);
    expect(read.result.artifacts?.[0]?.id).toBe(data.artifactId);
  });

  it('reads artifact sections with cursors and limits', async () => {
    const catalog = fixtureCatalog();
    const registry = registryFor(catalog);
    const first = await invoke(registry, 'artifact_read', { id: 'art-1', limit: 4 });
    expect(first.result.ok).toBe(true);
    const data = first.result.data as { content: string; nextCursor?: string; truncated: boolean; sourceId: string };
    expect(data.sourceId).toBe('artifact:art-1');
    expect(data.content.split('\n')).toHaveLength(4);
    expect(data.nextCursor).toBe('4');
    const rest = await invoke(registry, 'artifact_read', { id: 'art-1', cursor: data.nextCursor, limit: 100 });
    expect((rest.result.data as { truncated: boolean }).truncated).toBe(false);
  });

  it('runs a read-only workflow from a selected submission without mutations', async () => {
    const catalog = fixtureCatalog();
    const frozen = captureContextRefs([
      { kind: 'submission', id: 'sub-1', label: 'Website inquiry', revision: '2026-08-20T00:00:00.000Z' },
      { kind: 'form', id: 'form-1', label: 'Contact form', revision: '2026-08-20T00:00:00.000Z' },
      { kind: 'crm', id: 'lead-1', label: 'Website inquiry', revision: '2026-08-20T00:00:00.000Z' },
    ]);
    const registry = registryFor(catalog);
    const submission = await invoke(registry, 'submission_get', { id: 'sub-1' }, frozen);
    expect(submission.result.ok).toBe(true);
    const submissionData = submission.result.data as { formId: string; leadId: string; sourceId: string };
    expect(submissionData.formId).toBe('form-1');
    expect(submissionData.leadId).toBe('lead-1');

    const form = await invoke(registry, 'form_get', { id: submissionData.formId }, frozen);
    expect(form.result.ok).toBe(true);
    const validated = await invoke(registry, 'form_validate', { id: submissionData.formId }, frozen);
    expect((validated.result.data as { valid: boolean }).valid).toBe(true);

    const entity = await invoke(registry, 'crm_entity_get', { id: 'lead-1', entityType: 'lead', limit: 10 }, frozen);
    expect(entity.result.ok).toBe(true);
    const entityData = entity.result.data as { timeline: unknown[]; title: string };
    expect(entityData.title).toBe('Website inquiry');
    expect(entityData.timeline.length).toBeGreaterThan(0);

    const listed = await invoke(registry, 'submission_list', { filters: { formId: 'form-1' }, limit: 10 }, frozen);
    expect((listed.result.data as { focusedSubmissionId: string }).focusedSubmissionId).toBe('sub-1');
    const forms = await invoke(registry, 'form_list', { filters: { query: 'Contact' }, limit: 10 }, frozen);
    expect((forms.result.data as { items: Array<{ id: string }> }).items[0]?.id).toBe('form-1');
    expect(catalog.mutations).toEqual({ forms: 0, crm: 0, tasks: 0, submissions: 0 });

    const invalid = await invoke(registry, 'form_validate', { id: 'form-invalid' });
    expect((invalid.result.data as { valid: boolean }).valid).toBe(false);
  });

  it('keeps result byte metadata aligned with harness limits', () => {
    expect(INLINE_RESULT_BYTE_LIMIT).toBe(8_192);
    expect(MAX_LIST_PAGE_SIZE).toBe(100);
    expect(MAX_TOOL_RESULT_BYTES).toBe(65_536);
  });
});
