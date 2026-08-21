// ---------------------------------------------------------------------------
// TABS Work-OS Harness — CRM search and entity read tools
// Mutation tools land in a later phase. Reads use the CRM service boundary.
// ---------------------------------------------------------------------------

import type {
  CRMActivity,
  CRMCompany,
  CRMContact,
  CRMDeal,
  CRMLead,
  CRMNote,
} from '../../../types/crm';
import type { AgentToolDefinition, AgentToolResult, ToolExecutionContext } from '../../../types/agent';
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

export { CRM_READ_TOOL_NAMES };

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
