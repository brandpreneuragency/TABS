import { nanoid } from 'nanoid';
import { crmFormsDb, type TabsCRMFormsDB } from '../data/crmFormsDb';
import type { AgentOperationReceipt } from '../types/agent';
import type {
  CRMActivity,
  CRMCompany,
  CRMContact,
  CRMDeal,
  CRMLead,
  CRMNote,
  CRMTaskLink,
} from '../types/crm';
import { db, type TabsDB } from './db';
import { emitDomainChange } from './domainEvents';

export interface CompanionOperation {
  operationId: string;
  effectFingerprint: string;
}

export class CrmRevisionConflictError extends Error {
  readonly entityType: string;
  readonly entityId: string;
  readonly expectedUpdatedAt: string;
  readonly actualUpdatedAt: string;
  constructor(
    entityType: string,
    entityId: string,
    expectedUpdatedAt: string,
    actualUpdatedAt: string,
  ) {
    super(`${entityType} ${entityId} changed since ${expectedUpdatedAt}; current revision is ${actualUpdatedAt}.`);
    this.name = 'CrmRevisionConflictError';
    this.entityType = entityType;
    this.entityId = entityId;
    this.expectedUpdatedAt = expectedUpdatedAt;
    this.actualUpdatedAt = actualUpdatedAt;
  }
}

export class CrmDuplicateError extends Error {
  readonly duplicateKey: string;
  readonly existingId: string;
  constructor(duplicateKey: string, existingId: string) {
    super(`CRM duplicate ${duplicateKey} already exists as ${existingId}.`);
    this.name = 'CrmDuplicateError';
    this.duplicateKey = duplicateKey;
    this.existingId = existingId;
  }
}

export class CompanionOperationMismatchError extends Error {
  constructor(operationId: string) {
    super(`Operation ${operationId} was already committed with a different effect.`);
    this.name = 'CompanionOperationMismatchError';
  }
}

export function normalizeContactDuplicateKey(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!normalized) throw new Error('Contact email is required.');
  return `contact:email:${normalized}`;
}

export function normalizeCompanyDuplicateKey(name: string): string {
  const normalized = name.trim().replace(/\s+/g, ' ').toLowerCase();
  if (!normalized) throw new Error('Company name is required.');
  return `company:name:${normalized}`;
}

export function normalizeLeadDuplicateKey(values: Pick<CRMLead, 'title' | 'contactId' | 'sourceSubmissionId'>): string {
  const sourceSubmissionId = values.sourceSubmissionId?.trim();
  if (sourceSubmissionId) return `lead:submission:${sourceSubmissionId}`;
  const contactId = values.contactId?.trim();
  const title = values.title.trim().replace(/\s+/g, ' ').toLowerCase();
  if (!contactId) throw new Error('A non-form lead requires contactId.');
  if (!title) throw new Error('Lead title is required.');
  return `lead:contact:${contactId}:title:${title}`;
}

function requireOperation(operation: CompanionOperation): void {
  if (!operation.operationId.trim()) throw new Error('operationId is required.');
  if (!operation.effectFingerprint.trim()) throw new Error('effectFingerprint is required.');
}

function nextIso(previous: string | undefined, clock: () => number): string {
  const minimum = previous ? Date.parse(previous) + 1 : 0;
  return new Date(Math.max(clock(), minimum)).toISOString();
}

function receipt(
  operation: CompanionOperation,
  summary: string,
  resourceKeys: string[],
  resultData: unknown,
  clock: () => number,
): AgentOperationReceipt {
  return {
    id: `crm-forms-receipt:${operation.operationId}`,
    operationId: operation.operationId,
    effectFingerprint: operation.effectFingerprint,
    domain: 'crm-forms',
    resourceKeys,
    status: 'committed',
    resultSummary: summary,
    resultData,
    committedAt: clock(),
  };
}

async function replay<T>(database: TabsCRMFormsDB, operation: CompanionOperation): Promise<T | undefined> {
  requireOperation(operation);
  const prior = await database.agentOperationReceipts.where('operationId').equals(operation.operationId).first();
  if (!prior) return undefined;
  if (prior.effectFingerprint !== operation.effectFingerprint) {
    throw new CompanionOperationMismatchError(operation.operationId);
  }
  return prior.resultData as T;
}

function activity(input: Omit<CRMActivity, 'id' | 'createdAt'>, timestamp: string): CRMActivity {
  return { ...input, id: nanoid(10), createdAt: timestamp };
}

export class CrmFormsCommandService {
  private readonly database: TabsCRMFormsDB;
  private readonly mainDatabase: TabsDB;
  private readonly clock: () => number;
  constructor(
    database: TabsCRMFormsDB = crmFormsDb,
    mainDatabase: TabsDB = db,
    clock: () => number = Date.now,
  ) {
    this.database = database;
    this.mainDatabase = mainDatabase;
    this.clock = clock;
  }

  async createContact(operation: CompanionOperation, values: Omit<CRMContact, 'id' | 'createdAt' | 'updatedAt' | 'tags'> & Partial<Pick<CRMContact, 'tags'>>): Promise<CRMContact> {
    const prior = await replay<{ contact: CRMContact }>(this.database, operation);
    if (prior) return prior.contact;
    const duplicateKey = normalizeContactDuplicateKey(values.email ?? '');
    const result = await this.database.transaction('rw', this.database.crmContacts, this.database.crmActivities, this.database.agentOperationReceipts, async () => {
      const raced = await replay<{ contact: CRMContact }>(this.database, operation);
      if (raced) return raced.contact;
      const contacts = await this.database.crmContacts.toArray();
      const duplicate = contacts.find((item) => item.email && normalizeContactDuplicateKey(item.email) === duplicateKey);
      if (duplicate) throw new CrmDuplicateError(duplicateKey, duplicate.id);
      const timestamp = new Date(this.clock()).toISOString();
      const contact: CRMContact = { ...values, id: nanoid(8), email: values.email?.trim().toLowerCase(), tags: values.tags ?? [], createdAt: timestamp, updatedAt: timestamp, lastActivityAt: timestamp };
      const event = activity({ type: 'contact_created', title: `Contact created: ${contact.firstName} ${contact.lastName}`, contactId: contact.id, companyId: contact.companyId }, timestamp);
      await this.database.crmContacts.add(contact);
      await this.database.crmActivities.add(event);
      const operationReceipt = receipt(operation, 'contact created', [duplicateKey, `crm:contact:${contact.id}`], { contact }, this.clock);
      await this.database.agentOperationReceipts.add(operationReceipt);
      return contact;
    });
    emitDomainChange({ domain: 'crm', entityType: 'contact', entityId: result.id, operation: 'created', revision: result.updatedAt, operationId: operation.operationId });
    return result;
  }

  async createCompany(operation: CompanionOperation, values: Omit<CRMCompany, 'id' | 'createdAt' | 'updatedAt' | 'tags'> & Partial<Pick<CRMCompany, 'tags'>>): Promise<CRMCompany> {
    const prior = await replay<{ company: CRMCompany }>(this.database, operation);
    if (prior) return prior.company;
    const duplicateKey = normalizeCompanyDuplicateKey(values.name);
    const result = await this.database.transaction('rw', this.database.crmCompanies, this.database.crmActivities, this.database.agentOperationReceipts, async () => {
      const raced = await replay<{ company: CRMCompany }>(this.database, operation);
      if (raced) return raced.company;
      const companies = await this.database.crmCompanies.toArray();
      const duplicate = companies.find((item) => normalizeCompanyDuplicateKey(item.name) === duplicateKey);
      if (duplicate) throw new CrmDuplicateError(duplicateKey, duplicate.id);
      const timestamp = new Date(this.clock()).toISOString();
      const company: CRMCompany = { ...values, name: values.name.trim().replace(/\s+/g, ' '), id: nanoid(8), tags: values.tags ?? [], createdAt: timestamp, updatedAt: timestamp, lastActivityAt: timestamp };
      await this.database.crmCompanies.add(company);
      await this.database.crmActivities.add(activity({ type: 'company_created', title: `Company created: ${company.name}`, companyId: company.id }, timestamp));
      await this.database.agentOperationReceipts.add(receipt(operation, 'company created', [duplicateKey, `crm:company:${company.id}`], { company }, this.clock));
      return company;
    });
    emitDomainChange({ domain: 'crm', entityType: 'company', entityId: result.id, operation: 'created', revision: result.updatedAt, operationId: operation.operationId });
    return result;
  }

  async createLead(operation: CompanionOperation, values: Omit<CRMLead, 'id' | 'createdAt' | 'updatedAt' | 'tags' | 'status' | 'stage'> & Partial<Pick<CRMLead, 'tags' | 'status' | 'stage'>>): Promise<CRMLead> {
    const prior = await replay<{ lead: CRMLead }>(this.database, operation);
    if (prior) return prior.lead;
    const duplicateKey = normalizeLeadDuplicateKey(values);
    const result = await this.database.transaction('rw', this.database.crmLeads, this.database.crmActivities, this.database.agentOperationReceipts, async () => {
      const raced = await replay<{ lead: CRMLead }>(this.database, operation);
      if (raced) return raced.lead;
      const leads = await this.database.crmLeads.toArray();
      const duplicate = leads.find((item) => normalizeLeadDuplicateKey(item) === duplicateKey);
      if (duplicate) throw new CrmDuplicateError(duplicateKey, duplicate.id);
      const timestamp = new Date(this.clock()).toISOString();
      const lead: CRMLead = { ...values, title: values.title.trim().replace(/\s+/g, ' '), id: nanoid(8), status: values.status ?? 'new', stage: values.stage ?? 'new', tags: values.tags ?? [], createdAt: timestamp, updatedAt: timestamp, lastActivityAt: timestamp };
      await this.database.crmLeads.add(lead);
      await this.database.crmActivities.add(activity({ type: 'lead_created', title: `Lead created: ${lead.title}`, leadId: lead.id, contactId: lead.contactId, companyId: lead.companyId }, timestamp));
      await this.database.agentOperationReceipts.add(receipt(operation, 'lead created', [duplicateKey, `crm:lead:${lead.id}`], { lead }, this.clock));
      return lead;
    });
    emitDomainChange({ domain: 'crm', entityType: 'lead', entityId: result.id, operation: 'created', revision: result.updatedAt, operationId: operation.operationId });
    return result;
  }

  async updateEntity<T extends CRMLead | CRMContact | CRMCompany | CRMDeal>(
    operation: CompanionOperation,
    entityType: 'lead' | 'contact' | 'company' | 'deal',
    entityId: string,
    expectedUpdatedAt: string,
    updates: Partial<T>,
  ): Promise<T> {
    const prior = await replay<{ entity: T }>(this.database, operation);
    if (prior) return prior.entity;
    const table = entityType === 'lead' ? this.database.crmLeads : entityType === 'contact' ? this.database.crmContacts : entityType === 'company' ? this.database.crmCompanies : this.database.crmDeals;
    const result = await this.database.transaction('rw', table, this.database.crmActivities, this.database.agentOperationReceipts, async () => {
      const raced = await replay<{ entity: T }>(this.database, operation);
      if (raced) return raced.entity;
      const existing = await table.get(entityId) as T | undefined;
      if (!existing) throw new Error(`${entityType} ${entityId} was not found.`);
      if (existing.updatedAt !== expectedUpdatedAt) throw new CrmRevisionConflictError(entityType, entityId, expectedUpdatedAt, existing.updatedAt);
      const updatedAt = nextIso(existing.updatedAt, this.clock);
      const entity = { ...existing, ...updates, id: entityId, updatedAt } as T;
      await table.put(entity as never);
      await this.database.crmActivities.add(activity({ type: entityType === 'lead' ? 'lead_updated' : 'ai_suggestion_applied', title: `${entityType} updated`, [`${entityType}Id`]: entityId, metadata: updates as Record<string, unknown> } as Omit<CRMActivity, 'id' | 'createdAt'>, updatedAt));
      await this.database.agentOperationReceipts.add(receipt(operation, `${entityType} updated`, [`crm:${entityType}:${entityId}`], { entity }, this.clock));
      return entity;
    });
    emitDomainChange({ domain: 'crm', entityType, entityId, operation: 'updated', revision: result.updatedAt, operationId: operation.operationId });
    return result;
  }

  async addNote(operation: CompanionOperation, entityType: 'lead' | 'contact' | 'company' | 'deal', entityId: string, expectedUpdatedAt: string, text: string, createdBy?: string): Promise<CRMNote> {
    const prior = await replay<{ note: CRMNote }>(this.database, operation);
    if (prior) return prior.note;
    const table = entityType === 'lead' ? this.database.crmLeads : entityType === 'contact' ? this.database.crmContacts : entityType === 'company' ? this.database.crmCompanies : this.database.crmDeals;
    const result = await this.database.transaction('rw', table, this.database.crmNotes, this.database.crmActivities, this.database.agentOperationReceipts, async () => {
      const raced = await replay<{ note: CRMNote }>(this.database, operation);
      if (raced) return raced.note;
      const entity = await table.get(entityId) as CRMLead | CRMContact | CRMCompany | CRMDeal | undefined;
      if (!entity) throw new Error(`${entityType} ${entityId} was not found.`);
      if (entity.updatedAt !== expectedUpdatedAt) throw new CrmRevisionConflictError(entityType, entityId, expectedUpdatedAt, entity.updatedAt);
      const timestamp = nextIso(entity.updatedAt, this.clock);
      const note: CRMNote = { id: nanoid(10), body: text.trim(), [`${entityType}Id`]: entityId, createdBy, createdAt: timestamp, updatedAt: timestamp };
      if (!note.body) throw new Error('Note text is required.');
      await this.database.crmNotes.add(note);
      await table.update(entityId, { updatedAt: timestamp, ...('lastActivityAt' in entity ? { lastActivityAt: timestamp } : {}) });
      await this.database.crmActivities.add(activity({ type: 'note_added', title: 'Note added', [`${entityType}Id`]: entityId }, timestamp));
      await this.database.agentOperationReceipts.add(receipt(operation, 'note added', [`crm:${entityType}:${entityId}`, `crm:note:${note.id}`], { note }, this.clock));
      return note;
    });
    emitDomainChange({ domain: 'crm', entityType: 'note', entityId: result.id, operation: 'created', revision: result.updatedAt, operationId: operation.operationId });
    return result;
  }

  async createTaskLink(operation: CompanionOperation, taskId: string, entityType: 'lead' | 'contact' | 'company' | 'deal', entityId: string, expectedUpdatedAt: string, createdBy?: string): Promise<CRMTaskLink> {
    const prior = await replay<{ link: CRMTaskLink }>(this.database, operation);
    if (prior) return prior.link;
    if (!(await this.mainDatabase.tasks.get(taskId))) throw new Error(`Task ${taskId} was not found.`);
    const table = entityType === 'lead' ? this.database.crmLeads : entityType === 'contact' ? this.database.crmContacts : entityType === 'company' ? this.database.crmCompanies : this.database.crmDeals;
    const result = await this.database.transaction('rw', table, this.database.crmTaskLinks, this.database.crmActivities, this.database.agentOperationReceipts, async () => {
      const raced = await replay<{ link: CRMTaskLink }>(this.database, operation);
      if (raced) return raced.link;
      const entity = await table.get(entityId) as CRMLead | CRMContact | CRMCompany | CRMDeal | undefined;
      if (!entity) throw new Error(`${entityType} ${entityId} was not found.`);
      if (entity.updatedAt !== expectedUpdatedAt) throw new CrmRevisionConflictError(entityType, entityId, expectedUpdatedAt, entity.updatedAt);
      const existing = await this.database.crmTaskLinks.where('taskId').equals(taskId).filter((link) => link[`${entityType}Id` as keyof CRMTaskLink] === entityId).first();
      if (existing) return existing;
      const timestamp = nextIso(entity.updatedAt, this.clock);
      const link: CRMTaskLink = { id: nanoid(10), taskId, [`${entityType}Id`]: entityId, createdBy, createdAt: timestamp };
      await this.database.crmTaskLinks.add(link);
      await table.update(entityId, { updatedAt: timestamp, ...('lastActivityAt' in entity ? { lastActivityAt: timestamp } : {}) });
      await this.database.crmActivities.add(activity({ type: 'task_linked', title: 'Task linked', taskId, [`${entityType}Id`]: entityId }, timestamp));
      await this.database.agentOperationReceipts.add(receipt(operation, 'task linked', [`task:${taskId}`, `crm:${entityType}:${entityId}`], { link }, this.clock));
      return link;
    });
    emitDomainChange({ domain: 'crm', entityType: 'task_link', entityId: result.id, operation: 'created', revision: result.createdAt, operationId: operation.operationId });
    return result;
  }

  /** Reports companion links whose authoritative main-database task is absent. */
  async reconcileTaskLinks(): Promise<CRMTaskLink[]> {
    const links = await this.database.crmTaskLinks.toArray();
    const tasks = await this.mainDatabase.tasks.bulkGet(links.map((link) => link.taskId));
    return links.filter((_, index) => !tasks[index]);
  }
}

export const crmFormsCommands = new CrmFormsCommandService();
