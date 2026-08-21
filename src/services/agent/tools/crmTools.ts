// ---------------------------------------------------------------------------
// TABS Work-OS Harness — CRM search, entity, and mutation tools
// Mutation handlers call domain commands. They never write Dexie or Zustand.
// ---------------------------------------------------------------------------

import type {
  CRMActivity,
  CRMCompany,
  CRMContact,
  CRMDeal,
  CRMLead,
  CRMNote,
  CRMTaskLink,
} from '../../../types/crm';
import type { AgentOperationReceipt, AgentToolDefinition, AgentToolResult, ToolExecutionContext } from '../../../types/agent';
import type { CompanionOperation } from '../../crmFormsCommands';
import {
  asRecord,
  type ArtifactSink,
  CRM_READ_TOOL_NAMES,
  defineReadTool,
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
  asNumber,
  asString,
  change,
  CRM_MUTATION_TOOL_NAMES,
  defineMutationTool,
  mapMutationError,
  mutationOk,
  mutationReceipt,
  type MutationReceiptStore,
  objectSchema,
  resolvePriorReceipt,
  resourceLink,
} from './mutationSupport';

export { CRM_READ_TOOL_NAMES, CRM_MUTATION_TOOL_NAMES };

export type CRMEntityType = 'lead' | 'contact' | 'company' | 'deal';

export interface CRMSearchHit {
  entityType: CRMEntityType;
  id: string;
  title: string;
  revision: string;
}

export interface CRMEntityBundle {
  entityType: CRMEntityType;
  entity: CRMLead | CRMContact | CRMCompany | CRMDeal;
  timeline: CRMActivity[];
  notes: CRMNote[];
}

export interface CRMReadPort {
  search(query: string, entityTypes?: CRMEntityType[]): Promise<CRMSearchHit[]>;
  getEntity(entityType: CRMEntityType, entityId: string): Promise<CRMEntityBundle | undefined>;
}

export interface CRMReadToolDependencies {
  crm?: CRMReadPort;
  putArtifact?: ArtifactSink;
}

const ENTITY_TYPES: CRMEntityType[] = ['lead', 'contact', 'company', 'deal'];

function searchFilters(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      query: { type: 'string' },
      entityTypes: {
        type: 'array',
        items: { type: 'string', enum: ENTITY_TYPES },
      },
    },
  };
}

function titleOf(entityType: CRMEntityType, entity: CRMLead | CRMContact | CRMCompany | CRMDeal): string {
  if (entityType === 'contact') {
    const contact = entity as CRMContact;
    return `${contact.firstName} ${contact.lastName}`.trim();
  }
  if (entityType === 'company') return (entity as CRMCompany).name;
  if (entityType === 'lead') return (entity as CRMLead).title;
  return (entity as CRMDeal).title;
}

function matchesQuery(entityType: CRMEntityType, entity: CRMLead | CRMContact | CRMCompany | CRMDeal, query: string): boolean {
  if (!query) return true;
  const haystacks: string[] = [titleOf(entityType, entity).toLowerCase(), entity.id.toLowerCase()];
  if ('email' in entity && entity.email) haystacks.push(entity.email.toLowerCase());
  if ('tags' in entity && Array.isArray(entity.tags)) haystacks.push(entity.tags.join(' ').toLowerCase());
  return haystacks.some((value) => value.includes(query));
}

async function defaultCrmPort(): Promise<CRMReadPort> {
  const crm = await import('../../crmService');
  return {
    async search(query, entityTypes) {
      const types = entityTypes && entityTypes.length > 0 ? entityTypes : ENTITY_TYPES;
      const needle = query.trim().toLowerCase();
      const hits: CRMSearchHit[] = [];
      if (types.includes('lead')) {
        for (const lead of await crm.listLeads()) {
          if (matchesQuery('lead', lead, needle)) {
            hits.push({ entityType: 'lead', id: lead.id, title: lead.title, revision: lead.updatedAt });
          }
        }
      }
      if (types.includes('contact')) {
        for (const contact of await crm.listContacts()) {
          if (matchesQuery('contact', contact, needle)) {
            hits.push({
              entityType: 'contact',
              id: contact.id,
              title: titleOf('contact', contact),
              revision: contact.updatedAt,
            });
          }
        }
      }
      if (types.includes('company')) {
        for (const company of await crm.listCompanies()) {
          if (matchesQuery('company', company, needle)) {
            hits.push({ entityType: 'company', id: company.id, title: company.name, revision: company.updatedAt });
          }
        }
      }
      if (types.includes('deal')) {
        for (const deal of await crm.listDeals()) {
          if (matchesQuery('deal', deal, needle)) {
            hits.push({ entityType: 'deal', id: deal.id, title: deal.title, revision: deal.updatedAt });
          }
        }
      }
      return hits;
    },
    async getEntity(entityType, entityId) {
      const entity = entityType === 'lead'
        ? await crm.getLead(entityId)
        : entityType === 'contact'
          ? await crm.getContact(entityId)
          : entityType === 'company'
            ? await crm.getCompany(entityId)
            : await crm.getDeal(entityId);
      if (!entity) return undefined;
      const activities = await crm.listActivities();
      const notes = await crm.listNotes();
      const timeline = activities.filter((activity) => (
        (entityType === 'lead' && activity.leadId === entityId)
        || (entityType === 'contact' && activity.contactId === entityId)
        || (entityType === 'company' && activity.companyId === entityId)
        || (entityType === 'deal' && activity.dealId === entityId)
      ));
      const relatedNotes = notes.filter((note) => (
        (entityType === 'lead' && note.leadId === entityId)
        || (entityType === 'contact' && note.contactId === entityId)
        || (entityType === 'company' && note.companyId === entityId)
        || (entityType === 'deal' && note.dealId === entityId)
      ));
      return { entityType, entity, timeline, notes: relatedNotes };
    },
  };
}

let cachedDefault: CRMReadPort | undefined;

async function crmPort(override?: CRMReadPort): Promise<CRMReadPort> {
  if (override) return override;
  cachedDefault ??= await defaultCrmPort();
  return cachedDefault;
}

export function createCrmReadTools(deps: CRMReadToolDependencies = {}): AgentToolDefinition[] {
  const putArtifact = deps.putArtifact;

  const crmSearch = defineReadTool({
    name: 'crm_search',
    description: 'Search leads, contacts, companies, and deals with a bounded page.',
    inputSchema: listInputSchema(searchFilters()),
    resolveResourceKeys: () => ['crm'],
    async execute(_context: ToolExecutionContext, args: unknown): Promise<AgentToolResult> {
      const record = asRecord(args);
      const filters = asRecord(record.filters);
      const query = typeof filters.query === 'string' ? filters.query : '';
      const entityTypes = Array.isArray(filters.entityTypes)
        ? filters.entityTypes.filter((entry): entry is CRMEntityType => ENTITY_TYPES.includes(entry as CRMEntityType))
        : undefined;
      try {
        const port = await crmPort(deps.crm);
        const hits = await port.search(query, entityTypes);
        const page = paginateList(hits, record.cursor, normalizeListLimit(record.limit));
        return ok(`Found ${page.total} CRM matches`, {
          items: page.items.map((hit) => ({
            ...sourceRef('crm', hit.id, hit.revision),
            id: hit.id,
            entityType: hit.entityType,
            title: hit.title,
          })),
          nextCursor: page.nextCursor,
          truncated: page.truncated,
          total: page.total,
        });
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : 'CRM search failed';
        return fail('internal_error', message);
      }
    },
  });

  const crmEntityGet = defineReadTool({
    name: 'crm_entity_get',
    description: 'Read a CRM entity and its related timeline.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'entityType'],
      properties: {
        id: { type: 'string', minLength: 1 },
        entityType: { type: 'string', enum: ENTITY_TYPES },
        revision: { type: 'string' },
        section: { type: 'string' },
        cursor: { type: ['string', 'number'] },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
    },
    resolveResourceKeys: (_context, args) => {
      const record = asRecord(args);
      const entityType = String(record.entityType || 'lead');
      return [`crm:${entityType}:${record.id}`];
    },
    async execute(context: ToolExecutionContext, args: unknown): Promise<AgentToolResult> {
      const record = asRecord(args);
      const id = String(record.id);
      const entityType = ENTITY_TYPES.includes(record.entityType as CRMEntityType)
        ? record.entityType as CRMEntityType
        : undefined;
      if (!entityType) return fail('validation_failed', 'entityType is required.');
      const frozen = resolveFrozenId(context, 'crm', id);
      try {
        const port = await crmPort(deps.crm);
        const bundle = await port.getEntity(entityType, id);
        if (!bundle) return fail('not_found', `${entityType} ${id} was not found.`);
        const revision = bundle.entity.updatedAt;
        const stale = staleIfMismatch(
          typeof record.revision === 'string' ? record.revision : frozen?.revision,
          revision,
          `${entityType} ${id}`,
        );
        if (stale) return { ...stale, observedRevision: revision };
        const timelinePage = paginateList(bundle.timeline, record.cursor, normalizeListLimit(record.limit));
        const payload = {
          ...sourceRef('crm', bundle.entity.id, revision),
          id: bundle.entity.id,
          entityType,
          title: titleOf(entityType, bundle.entity),
          entity: record.section === 'timeline' ? undefined : bundle.entity,
          timeline: timelinePage.items,
          notes: record.section === 'timeline' ? undefined : bundle.notes,
          nextCursor: timelinePage.nextCursor,
          truncated: timelinePage.truncated,
          totalTimeline: timelinePage.total,
        };
        const bounded = await spillIfLarge(context.runId, `crm:${entityType}:${id}`, payload, putArtifact);
        return ok(`Read ${entityType} ${titleOf(entityType, bundle.entity)}`, bounded.data, {
          observedRevision: revision,
          artifacts: bounded.artifacts,
        });
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : 'CRM entity read failed';
        return fail('internal_error', message);
      }
    },
  });

  return [crmSearch, crmEntityGet];
}

const CRM_STAGE = ['new', 'contacted', 'qualified', 'proposal', 'won', 'lost', 'spam'] as const;
const CRM_LINK_ENTITY = ['lead', 'contact', 'company', 'deal'] as const;

const CONTACT_VALUE_PROPERTIES = {
  firstName: { type: 'string', minLength: 1 },
  lastName: { type: 'string', minLength: 1 },
  email: { type: 'string', minLength: 1 },
  phone: { type: 'string' },
  jobTitle: { type: 'string' },
  companyId: { type: 'string' },
  lifecycleStatus: { type: 'string' },
  tags: { type: 'array', items: { type: 'string' } },
  notes: { type: 'string' },
};

const COMPANY_VALUE_PROPERTIES = {
  name: { type: 'string', minLength: 1 },
  website: { type: 'string' },
  industry: { type: 'string' },
  size: { type: 'string' },
  city: { type: 'string' },
  country: { type: 'string' },
  ownerId: { type: 'string' },
  tags: { type: 'array', items: { type: 'string' } },
  notes: { type: 'string' },
};

const LEAD_VALUE_PROPERTIES = {
  title: { type: 'string', minLength: 1 },
  contactId: { type: 'string', minLength: 1 },
  companyId: { type: 'string' },
  status: { type: 'string', enum: [...CRM_STAGE] },
  stage: { type: 'string', enum: [...CRM_STAGE] },
  score: { type: 'number', minimum: 0, maximum: 100 },
  ownerId: { type: 'string' },
  tags: { type: 'array', items: { type: 'string' } },
  source: { type: 'string' },
  sourceFormId: { type: 'string' },
  sourceSubmissionId: { type: 'string' },
  sourcePageUrl: { type: 'string' },
};

export interface CRMMutationPort {
  createContact(operation: CompanionOperation, values: Record<string, unknown>): Promise<CRMContact>;
  createCompany(operation: CompanionOperation, values: Record<string, unknown>): Promise<CRMCompany>;
  createLead(operation: CompanionOperation, values: Record<string, unknown>): Promise<CRMLead>;
  updateEntity(
    operation: CompanionOperation,
    entityType: 'lead' | 'contact' | 'company',
    entityId: string,
    expectedUpdatedAt: string,
    updates: Record<string, unknown>,
  ): Promise<CRMLead | CRMContact | CRMCompany>;
  setDealStage(
    operation: CompanionOperation,
    dealId: string,
    expectedUpdatedAt: string,
    fromStage: CRMDeal['stage'],
    toStage: CRMDeal['stage'],
  ): Promise<CRMDeal>;
  addNote(
    operation: CompanionOperation,
    entityType: 'lead' | 'contact' | 'company' | 'deal',
    entityId: string,
    expectedUpdatedAt: string,
    text: string,
  ): Promise<CRMNote>;
  createTaskLink(
    operation: CompanionOperation,
    taskId: string,
    entityType: 'lead' | 'contact' | 'company' | 'deal',
    entityId: string,
    expectedUpdatedAt: string,
  ): Promise<CRMTaskLink>;
}

export interface CRMMutationToolDependencies {
  crm?: CRMMutationPort;
  receipts?: MutationReceiptStore;
}

async function defaultCrmMutations(): Promise<CRMMutationPort> {
  const { crmFormsCommands } = await import('../../crmFormsCommands');
  return {
    createContact: (operation, values) => crmFormsCommands.createContact(operation, values as never),
    createCompany: (operation, values) => crmFormsCommands.createCompany(operation, values as never),
    createLead: (operation, values) => crmFormsCommands.createLead(operation, values as never),
    updateEntity: (operation, entityType, entityId, expectedUpdatedAt, updates) => (
      crmFormsCommands.updateEntity(operation, entityType, entityId, expectedUpdatedAt, updates) as Promise<CRMLead | CRMContact | CRMCompany>
    ),
    setDealStage: (operation, dealId, expectedUpdatedAt, fromStage, toStage) => (
      crmFormsCommands.setDealStage(operation, dealId, expectedUpdatedAt, fromStage, toStage)
    ),
    addNote: (operation, entityType, entityId, expectedUpdatedAt, text) => (
      crmFormsCommands.addNote(operation, entityType, entityId, expectedUpdatedAt, text)
    ),
    createTaskLink: (operation, taskId, entityType, entityId, expectedUpdatedAt) => (
      crmFormsCommands.createTaskLink(operation, taskId, entityType, entityId, expectedUpdatedAt)
    ),
  };
}

function crmKey(entityType: string, entityId: string): string {
  return `crm:${entityType}:${entityId}`;
}

function crmLabel(entityType: string, entity: { id: string; firstName?: string; lastName?: string; name?: string; title?: string }): string {
  if (entityType === 'contact') return `${entity.firstName ?? ''} ${entity.lastName ?? ''}`.trim() || entity.id;
  if (entityType === 'company') return entity.name ?? entity.id;
  return entity.title ?? entity.id;
}

function crmSuccess(input: {
  summary: string;
  type: 'created' | 'updated';
  entityType: string;
  entity: { id: string; updatedAt?: string; createdAt?: string; firstName?: string; lastName?: string; name?: string; title?: string };
  operationId: string;
  fingerprint: string;
  receipt: AgentOperationReceipt;
  extraLinks?: ReturnType<typeof resourceLink>[];
  replayed?: boolean;
  repeatedEffect?: boolean;
}): AgentToolResult {
  const key = crmKey(input.entityType, input.entity.id);
  return mutationOk({
    summary: input.summary,
    operationId: input.operationId,
    effectFingerprint: input.fingerprint,
    receipt: input.receipt,
    resourceLinks: [
      resourceLink('crm', input.entity.id, key, crmLabel(input.entityType, input.entity)),
      ...(input.extraLinks ?? []),
    ],
    changes: [change(key, input.type, input.summary)],
    entity: input.entity,
    after: input.entity,
    observedRevision: input.entity.updatedAt ?? input.entity.createdAt,
    projectionPending: false,
    replayed: input.replayed,
    repeatedEffect: input.repeatedEffect,
  });
}

function receiptFromEntity(
  operationId: string,
  fingerprint: string,
  domain: string,
  resourceKeys: string[],
  summary: string,
  entity: unknown,
): AgentOperationReceipt {
  return mutationReceipt({
    operationId,
    effectFingerprint: fingerprint,
    domain,
    resourceKeys,
    summary,
    resultData: { entity },
  });
}

function entityFromReceipt<T>(receipt: AgentOperationReceipt): T {
  const data = receipt.resultData as { entity?: T; contact?: T; company?: T; lead?: T; note?: T; link?: T } | undefined;
  return (data?.entity ?? data?.contact ?? data?.company ?? data?.lead ?? data?.note ?? data?.link) as T;
}

function contactAbsenceKey(email: string): string {
  return `contact:email:${email.trim().toLowerCase()}`;
}

function companyAbsenceKey(name: string): string {
  return `company:name:${name.trim().replace(/\s+/g, ' ').toLowerCase()}`;
}

function leadAbsenceKey(values: Record<string, unknown>): string {
  const sourceSubmissionId = asString(values.sourceSubmissionId)?.trim();
  if (sourceSubmissionId) return `lead:submission:${sourceSubmissionId}`;
  const contactId = asString(values.contactId)?.trim() ?? '';
  const title = String(values.title ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
  return `lead:contact:${contactId}:title:${title}`;
}

export function createCrmMutationTools(deps: CRMMutationToolDependencies = {}): AgentToolDefinition[] {
  const receipts = deps.receipts;

  async function port(): Promise<CRMMutationPort> {
    return deps.crm ?? await defaultCrmMutations();
  }

  const crmContactCreate = defineMutationTool({
    name: 'crm_contact_create',
    description: 'Create a contact with duplicate checks on normalized email.',
    risk: 'local_create',
    sideEffect: 'reversible',
    inputSchema: objectSchema({
      values: objectSchema(CONTACT_VALUE_PROPERTIES, ['firstName', 'lastName', 'email']),
    }, ['values']),
    resolveResourceKeys: (_context, args) => {
      const values = asRecord(asRecord(args).values);
      return ['crm:contact', contactAbsenceKey(String(values.email ?? ''))];
    },
    buildEffectPayload: (args) => {
      const values = asRecord(asRecord(args).values);
      return {
        tool: 'crm_contact_create',
        values: {
          ...values,
          email: String(values.email ?? '').trim().toLowerCase(),
        },
      };
    },
    normalizeArgs: (args) => {
      const record = asRecord(args);
      const values = asRecord(record.values);
      return {
        values: {
          ...values,
          firstName: asString(values.firstName)?.trim(),
          lastName: asString(values.lastName)?.trim(),
          email: asString(values.email)?.trim().toLowerCase(),
        },
      };
    },
    async execute(context, args): Promise<AgentToolResult> {
      const values = asRecord(asRecord(args).values);
      const operationId = context.operationId as string;
      const fingerprint = context.effectFingerprint as string;
      const prior = await resolvePriorReceipt(receipts, operationId, fingerprint);
      if (prior.kind === 'mismatch') return fail('conflict', `Operation ${operationId} was already committed with a different effect.`);
      if (prior.kind === 'replay' || prior.kind === 'repeat') {
        const entity = entityFromReceipt<CRMContact>(prior.receipt);
        return crmSuccess({
          summary: `Created contact ${crmLabel('contact', entity)}`,
          type: 'created',
          entityType: 'contact',
          entity,
          operationId,
          fingerprint,
          receipt: prior.receipt,
          replayed: prior.kind === 'replay',
          repeatedEffect: prior.kind === 'repeat',
        });
      }
      try {
        const entity = await (await port()).createContact({ operationId, effectFingerprint: fingerprint }, values);
        const receipt = receiptFromEntity(operationId, fingerprint, 'crm', [crmKey('contact', entity.id)], 'contact created', entity);
        await receipts?.put(receipt);
        return crmSuccess({
          summary: `Created contact ${crmLabel('contact', entity)}`,
          type: 'created',
          entityType: 'contact',
          entity,
          operationId,
          fingerprint,
          receipt,
        });
      } catch (caught) {
        return mapMutationError(caught);
      }
    },
  });

  const crmCompanyCreate = defineMutationTool({
    name: 'crm_company_create',
    description: 'Create a company with duplicate checks on normalized name.',
    risk: 'local_create',
    sideEffect: 'reversible',
    inputSchema: objectSchema({
      values: objectSchema(COMPANY_VALUE_PROPERTIES, ['name']),
    }, ['values']),
    resolveResourceKeys: (_context, args) => {
      const values = asRecord(asRecord(args).values);
      return ['crm:company', companyAbsenceKey(String(values.name ?? ''))];
    },
    buildEffectPayload: (args) => {
      const values = asRecord(asRecord(args).values);
      return {
        tool: 'crm_company_create',
        values: {
          ...values,
          name: String(values.name ?? '').trim().replace(/\s+/g, ' '),
        },
      };
    },
    async execute(context, args): Promise<AgentToolResult> {
      const values = asRecord(asRecord(args).values);
      const operationId = context.operationId as string;
      const fingerprint = context.effectFingerprint as string;
      const prior = await resolvePriorReceipt(receipts, operationId, fingerprint);
      if (prior.kind === 'mismatch') return fail('conflict', `Operation ${operationId} was already committed with a different effect.`);
      if (prior.kind === 'replay' || prior.kind === 'repeat') {
        const entity = entityFromReceipt<CRMCompany>(prior.receipt);
        return crmSuccess({
          summary: `Created company ${entity.name}`,
          type: 'created',
          entityType: 'company',
          entity,
          operationId,
          fingerprint,
          receipt: prior.receipt,
          replayed: prior.kind === 'replay',
          repeatedEffect: prior.kind === 'repeat',
        });
      }
      try {
        const entity = await (await port()).createCompany({ operationId, effectFingerprint: fingerprint }, values);
        const receipt = receiptFromEntity(operationId, fingerprint, 'crm', [crmKey('company', entity.id)], 'company created', entity);
        await receipts?.put(receipt);
        return crmSuccess({
          summary: `Created company ${entity.name}`,
          type: 'created',
          entityType: 'company',
          entity,
          operationId,
          fingerprint,
          receipt,
        });
      } catch (caught) {
        return mapMutationError(caught);
      }
    },
  });

  const crmLeadCreate = defineMutationTool({
    name: 'crm_lead_create',
    description: 'Create a lead with source links and duplicate checks.',
    risk: 'local_create',
    sideEffect: 'reversible',
    inputSchema: objectSchema({
      values: objectSchema(LEAD_VALUE_PROPERTIES, ['title', 'contactId']),
    }, ['values']),
    resolveResourceKeys: (_context, args) => {
      const values = asRecord(asRecord(args).values);
      const keys = ['crm:lead', leadAbsenceKey(values)];
      if (typeof values.contactId === 'string') keys.push(`crm:contact:${values.contactId}`);
      return keys;
    },
    buildEffectPayload: (args) => {
      const values = asRecord(asRecord(args).values);
      return {
        tool: 'crm_lead_create',
        values: {
          ...values,
          title: String(values.title ?? '').trim().replace(/\s+/g, ' '),
          score: asNumber(values.score),
        },
      };
    },
    async execute(context, args): Promise<AgentToolResult> {
      const values = asRecord(asRecord(args).values);
      const operationId = context.operationId as string;
      const fingerprint = context.effectFingerprint as string;
      const prior = await resolvePriorReceipt(receipts, operationId, fingerprint);
      if (prior.kind === 'mismatch') return fail('conflict', `Operation ${operationId} was already committed with a different effect.`);
      if (prior.kind === 'replay' || prior.kind === 'repeat') {
        const entity = entityFromReceipt<CRMLead>(prior.receipt);
        return crmSuccess({
          summary: `Created lead ${entity.title}`,
          type: 'created',
          entityType: 'lead',
          entity,
          operationId,
          fingerprint,
          receipt: prior.receipt,
          replayed: prior.kind === 'replay',
          repeatedEffect: prior.kind === 'repeat',
        });
      }
      try {
        const entity = await (await port()).createLead({ operationId, effectFingerprint: fingerprint }, values);
        const receipt = receiptFromEntity(operationId, fingerprint, 'crm', [crmKey('lead', entity.id)], 'lead created', entity);
        await receipts?.put(receipt);
        return crmSuccess({
          summary: `Created lead ${entity.title}`,
          type: 'created',
          entityType: 'lead',
          entity,
          operationId,
          fingerprint,
          receipt,
        });
      } catch (caught) {
        return mapMutationError(caught);
      }
    },
  });

  const crmEntityUpdate = defineMutationTool({
    name: 'crm_entity_update',
    description: 'Update allowed CRM entity fields using an expected revision.',
    risk: 'local_update',
    sideEffect: 'reversible',
    inputSchema: {
      oneOf: [
        objectSchema({
          entityType: { type: 'string', const: 'contact' },
          entityId: { type: 'string', minLength: 1 },
          expectedUpdatedAt: { type: 'string', minLength: 1 },
          updates: objectSchema(CONTACT_VALUE_PROPERTIES, [], { minProperties: 1 }),
        }, ['entityType', 'entityId', 'expectedUpdatedAt', 'updates']),
        objectSchema({
          entityType: { type: 'string', const: 'company' },
          entityId: { type: 'string', minLength: 1 },
          expectedUpdatedAt: { type: 'string', minLength: 1 },
          updates: objectSchema(COMPANY_VALUE_PROPERTIES, [], { minProperties: 1 }),
        }, ['entityType', 'entityId', 'expectedUpdatedAt', 'updates']),
        objectSchema({
          entityType: { type: 'string', const: 'lead' },
          entityId: { type: 'string', minLength: 1 },
          expectedUpdatedAt: { type: 'string', minLength: 1 },
          updates: objectSchema(LEAD_VALUE_PROPERTIES, [], { minProperties: 1 }),
        }, ['entityType', 'entityId', 'expectedUpdatedAt', 'updates']),
      ],
    },
    resolveResourceKeys: (_context, args) => {
      const record = asRecord(args);
      return [crmKey(String(record.entityType), String(record.entityId))];
    },
    buildEffectPayload: (args) => {
      const record = asRecord(args);
      return {
        tool: 'crm_entity_update',
        entityType: record.entityType,
        entityId: record.entityId,
        updates: asRecord(record.updates),
      };
    },
    validateGrant: allowlistedUpdateGrant,
    async execute(context, args): Promise<AgentToolResult> {
      const record = asRecord(args);
      const entityType = record.entityType as 'lead' | 'contact' | 'company';
      const operationId = context.operationId as string;
      const fingerprint = context.effectFingerprint as string;
      const prior = await resolvePriorReceipt(receipts, operationId, fingerprint);
      if (prior.kind === 'mismatch') return fail('conflict', `Operation ${operationId} was already committed with a different effect.`);
      if (prior.kind === 'replay' || prior.kind === 'repeat') {
        const entity = entityFromReceipt<CRMLead | CRMContact | CRMCompany>(prior.receipt);
        return crmSuccess({
          summary: `Updated ${entityType}`,
          type: 'updated',
          entityType,
          entity,
          operationId,
          fingerprint,
          receipt: prior.receipt,
          replayed: prior.kind === 'replay',
          repeatedEffect: prior.kind === 'repeat',
        });
      }
      try {
        const entity = await (await port()).updateEntity(
          { operationId, effectFingerprint: fingerprint },
          entityType,
          String(record.entityId),
          String(record.expectedUpdatedAt),
          asRecord(record.updates),
        );
        const receipt = receiptFromEntity(operationId, fingerprint, 'crm', [crmKey(entityType, entity.id)], `${entityType} updated`, entity);
        await receipts?.put(receipt);
        return crmSuccess({
          summary: `Updated ${entityType} ${crmLabel(entityType, entity)}`,
          type: 'updated',
          entityType,
          entity,
          operationId,
          fingerprint,
          receipt,
        });
      } catch (caught) {
        return mapMutationError(caught);
      }
    },
  });

  const crmDealStageSet = defineMutationTool({
    name: 'crm_deal_stage_set',
    description: 'Change a deal stage through domain rules.',
    risk: 'local_update',
    sideEffect: 'reversible',
    inputSchema: objectSchema({
      dealId: { type: 'string', minLength: 1 },
      expectedUpdatedAt: { type: 'string', minLength: 1 },
      fromStage: { type: 'string', enum: [...CRM_STAGE] },
      toStage: { type: 'string', enum: [...CRM_STAGE] },
    }, ['dealId', 'expectedUpdatedAt', 'fromStage', 'toStage']),
    resolveResourceKeys: (_context, args) => [`crm:deal:${asRecord(args).dealId}`],
    buildEffectPayload: (args) => {
      const record = asRecord(args);
      return { tool: 'crm_deal_stage_set', dealId: record.dealId, toStage: record.toStage };
    },
    async execute(context, args): Promise<AgentToolResult> {
      const record = asRecord(args);
      const operationId = context.operationId as string;
      const fingerprint = context.effectFingerprint as string;
      const prior = await resolvePriorReceipt(receipts, operationId, fingerprint);
      if (prior.kind === 'mismatch') return fail('conflict', `Operation ${operationId} was already committed with a different effect.`);
      if (prior.kind === 'replay' || prior.kind === 'repeat') {
        const entity = entityFromReceipt<CRMDeal>(prior.receipt);
        return crmSuccess({
          summary: `Set deal stage to ${entity.stage}`,
          type: 'updated',
          entityType: 'deal',
          entity,
          operationId,
          fingerprint,
          receipt: prior.receipt,
          replayed: prior.kind === 'replay',
          repeatedEffect: prior.kind === 'repeat',
        });
      }
      try {
        const entity = await (await port()).setDealStage(
          { operationId, effectFingerprint: fingerprint },
          String(record.dealId),
          String(record.expectedUpdatedAt),
          record.fromStage as CRMDeal['stage'],
          record.toStage as CRMDeal['stage'],
        );
        const receipt = receiptFromEntity(operationId, fingerprint, 'crm', [crmKey('deal', entity.id)], 'deal stage set', entity);
        await receipts?.put(receipt);
        return crmSuccess({
          summary: `Moved deal ${entity.title} to ${entity.stage}`,
          type: 'updated',
          entityType: 'deal',
          entity,
          operationId,
          fingerprint,
          receipt,
        });
      } catch (caught) {
        return mapMutationError(caught);
      }
    },
  });

  const crmNoteAdd = defineMutationTool({
    name: 'crm_note_add',
    description: 'Add a CRM note with run provenance.',
    risk: 'local_create',
    sideEffect: 'reversible',
    inputSchema: objectSchema({
      entityType: { type: 'string', enum: [...CRM_LINK_ENTITY] },
      entityId: { type: 'string', minLength: 1 },
      expectedUpdatedAt: { type: 'string', minLength: 1 },
      text: { type: 'string', minLength: 1 },
    }, ['entityType', 'entityId', 'expectedUpdatedAt', 'text']),
    resolveResourceKeys: (_context, args) => {
      const record = asRecord(args);
      return [crmKey(String(record.entityType), String(record.entityId))];
    },
    buildEffectPayload: (args) => {
      const record = asRecord(args);
      return {
        tool: 'crm_note_add',
        entityType: record.entityType,
        entityId: record.entityId,
        text: record.text,
      };
    },
    async execute(context, args): Promise<AgentToolResult> {
      const record = asRecord(args);
      const entityType = record.entityType as 'lead' | 'contact' | 'company' | 'deal';
      const operationId = context.operationId as string;
      const fingerprint = context.effectFingerprint as string;
      const prior = await resolvePriorReceipt(receipts, operationId, fingerprint);
      if (prior.kind === 'mismatch') return fail('conflict', `Operation ${operationId} was already committed with a different effect.`);
      if (prior.kind === 'replay' || prior.kind === 'repeat') {
        const note = entityFromReceipt<CRMNote>(prior.receipt);
        return crmSuccess({
          summary: 'Added CRM note',
          type: 'created',
          entityType: 'note',
          entity: note,
          operationId,
          fingerprint,
          receipt: prior.receipt,
          extraLinks: [resourceLink('crm', String(record.entityId), crmKey(entityType, String(record.entityId)), entityType)],
          replayed: prior.kind === 'replay',
          repeatedEffect: prior.kind === 'repeat',
        });
      }
      try {
        const note = await (await port()).addNote(
          { operationId, effectFingerprint: fingerprint },
          entityType,
          String(record.entityId),
          String(record.expectedUpdatedAt),
          String(record.text),
        );
        const receipt = receiptFromEntity(
          operationId,
          fingerprint,
          'crm',
          [crmKey(entityType, String(record.entityId)), `crm:note:${note.id}`],
          'note added',
          note,
        );
        await receipts?.put(receipt);
        return crmSuccess({
          summary: `Added note to ${entityType} ${record.entityId}`,
          type: 'created',
          entityType: 'note',
          entity: note,
          operationId,
          fingerprint,
          receipt,
          extraLinks: [resourceLink('crm', String(record.entityId), crmKey(entityType, String(record.entityId)), entityType)],
        });
      } catch (caught) {
        return mapMutationError(caught);
      }
    },
  });

  const crmTaskLinkCreate = defineMutationTool({
    name: 'crm_task_link_create',
    description: 'Link a TABS task to a CRM entity as a receipt-backed saga step.',
    risk: 'local_create',
    sideEffect: 'reversible',
    inputSchema: objectSchema({
      taskId: { type: 'string', minLength: 1 },
      entityType: { type: 'string', enum: [...CRM_LINK_ENTITY] },
      entityId: { type: 'string', minLength: 1 },
      expectedUpdatedAt: { type: 'string', minLength: 1 },
    }, ['taskId', 'entityType', 'entityId', 'expectedUpdatedAt']),
    resolveResourceKeys: (_context, args) => {
      const record = asRecord(args);
      return [`task:${record.taskId}`, crmKey(String(record.entityType), String(record.entityId))];
    },
    buildEffectPayload: (args) => {
      const record = asRecord(args);
      return {
        tool: 'crm_task_link_create',
        taskId: record.taskId,
        entityType: record.entityType,
        entityId: record.entityId,
      };
    },
    async execute(context, args): Promise<AgentToolResult> {
      const record = asRecord(args);
      const entityType = record.entityType as 'lead' | 'contact' | 'company' | 'deal';
      const operationId = context.operationId as string;
      const fingerprint = context.effectFingerprint as string;
      const prior = await resolvePriorReceipt(receipts, operationId, fingerprint);
      if (prior.kind === 'mismatch') return fail('conflict', `Operation ${operationId} was already committed with a different effect.`);
      if (prior.kind === 'replay' || prior.kind === 'repeat') {
        const link = entityFromReceipt<CRMTaskLink>(prior.receipt);
        return crmSuccess({
          summary: 'Linked task to CRM entity',
          type: 'created',
          entityType: 'task_link',
          entity: link,
          operationId,
          fingerprint,
          receipt: prior.receipt,
          extraLinks: [
            resourceLink('task', String(record.taskId), `task:${record.taskId}`, 'task'),
            resourceLink('crm', String(record.entityId), crmKey(entityType, String(record.entityId)), entityType),
          ],
          replayed: prior.kind === 'replay',
          repeatedEffect: prior.kind === 'repeat',
        });
      }
      try {
        const link = await (await port()).createTaskLink(
          { operationId, effectFingerprint: fingerprint },
          String(record.taskId),
          entityType,
          String(record.entityId),
          String(record.expectedUpdatedAt),
        );
        const receipt = receiptFromEntity(
          operationId,
          fingerprint,
          'crm',
          [`task:${record.taskId}`, crmKey(entityType, String(record.entityId))],
          'task linked',
          link,
        );
        await receipts?.put(receipt);
        return crmSuccess({
          summary: `Linked task ${record.taskId} to ${entityType} ${record.entityId}`,
          type: 'created',
          entityType: 'task_link',
          entity: link,
          operationId,
          fingerprint,
          receipt,
          extraLinks: [
            resourceLink('task', String(record.taskId), `task:${record.taskId}`, 'task'),
            resourceLink('crm', String(record.entityId), crmKey(entityType, String(record.entityId)), entityType),
          ],
        });
      } catch (caught) {
        return mapMutationError(caught);
      }
    },
  });

  return [
    crmContactCreate,
    crmCompanyCreate,
    crmLeadCreate,
    crmEntityUpdate,
    crmDealStageSet,
    crmNoteAdd,
    crmTaskLinkCreate,
  ];
}
