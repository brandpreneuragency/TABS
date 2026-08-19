// CRM service — persistence boundary between the Zustand store and Dexie.
// Architecture: React -> Zustand store -> service -> Dexie adapter now / VPS
// API later. UI never touches Dexie directly.
//
// All mutating functions write to Dexie and return the updated/created entity
// so stores can update their in-memory state. Timestamps are ISO 8601 strings.

import { nanoid } from 'nanoid';
import { crmFormsDb, isCrmDataEmpty } from '../data/crmFormsDb';
import {
  SEED_COMPANIES,
  SEED_CONTACTS,
  SEED_LEADS,
  SEED_DEALS,
  SEED_ACTIVITIES,
  SEED_NOTES,
  SEED_SAVED_VIEWS,
  SEED_PIPELINE_STAGES,
} from '../data/crmSeed';
import { exportToCsv } from '../utils/csvExport';
import type {
  CRMLead,
  CRMContact,
  CRMCompany,
  CRMDeal,
  CRMActivity,
  CRMActivityType,
  CRMNote,
  CRMTaskLink,
  CRMSavedView,
  CRMLeadStatus,
  CRMDealStage,
  PipelineStage,
  CRMDashboardKPIs,
} from '../types/crm';

export {
  CompanionOperationMismatchError,
  CrmDuplicateError,
  CrmFormsCommandService,
  CrmRevisionConflictError,
  crmFormsCommands,
  normalizeCompanyDuplicateKey,
  normalizeContactDuplicateKey,
  normalizeLeadDuplicateKey,
} from './crmFormsCommands';
export type { CompanionOperation } from './crmFormsCommands';

const OPEN_STAGES: CRMDealStage[] = ['new', 'contacted', 'qualified', 'proposal'];
const WON_STAGES: CRMDealStage[] = ['won'];

function nowIso(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Bootstrap / seeding
// ---------------------------------------------------------------------------

export async function ensureCrmSeeded(): Promise<boolean> {
  if (!(await isCrmDataEmpty())) return false;
  await crmFormsDb.transaction(
    'rw',
    [
      crmFormsDb.crmLeads,
      crmFormsDb.crmContacts,
      crmFormsDb.crmCompanies,
      crmFormsDb.crmDeals,
      crmFormsDb.crmActivities,
      crmFormsDb.crmNotes,
      crmFormsDb.crmSavedViews,
      crmFormsDb.crmPipelineStages,
    ],
    async () => {
      await crmFormsDb.crmCompanies.bulkAdd(SEED_COMPANIES);
      await crmFormsDb.crmContacts.bulkAdd(SEED_CONTACTS);
      await crmFormsDb.crmLeads.bulkAdd(SEED_LEADS);
      await crmFormsDb.crmDeals.bulkAdd(SEED_DEALS);
      await crmFormsDb.crmActivities.bulkAdd(SEED_ACTIVITIES);
      await crmFormsDb.crmNotes.bulkAdd(SEED_NOTES);
      await crmFormsDb.crmSavedViews.bulkAdd(SEED_SAVED_VIEWS);
      await crmFormsDb.crmPipelineStages.bulkAdd(SEED_PIPELINE_STAGES);
    },
  );
  return true;
}

// ---------------------------------------------------------------------------
// Pipeline stages
// ---------------------------------------------------------------------------

export async function getPipelineStages(): Promise<PipelineStage[]> {
  const stages = await crmFormsDb.crmPipelineStages.toArray();
  if (stages.length === 0) {
    await crmFormsDb.crmPipelineStages.bulkAdd(SEED_PIPELINE_STAGES);
    return [...SEED_PIPELINE_STAGES].sort((a, b) => a.order - b.order);
  }
  return stages.sort((a, b) => a.order - b.order);
}

// ---------------------------------------------------------------------------
// Leads
// ---------------------------------------------------------------------------

export async function listLeads(): Promise<CRMLead[]> {
  return crmFormsDb.crmLeads.toArray();
}

export async function getLead(id: string): Promise<CRMLead | undefined> {
  return crmFormsDb.crmLeads.get(id);
}

export async function createLead(
  input: Omit<CRMLead, 'id' | 'createdAt' | 'updatedAt' | 'tags' | 'status' | 'stage'> &
    Partial<Pick<CRMLead, 'tags' | 'status' | 'stage' | 'score' | 'ownerId' | 'source'>>,
): Promise<CRMLead> {
  const ts = nowIso();
  const lead: CRMLead = {
    id: nanoid(8),
    status: input.status ?? 'new',
    stage: input.stage ?? 'new',
    tags: input.tags ?? [],
    score: input.score,
    ownerId: input.ownerId,
    source: input.source,
    createdAt: ts,
    updatedAt: ts,
    lastActivityAt: ts,
    contactId: input.contactId,
    companyId: input.companyId,
    title: input.title,
    sourceFormId: input.sourceFormId,
    sourceSubmissionId: input.sourceSubmissionId,
    sourcePageUrl: input.sourcePageUrl,
    utm: input.utm,
    customFields: input.customFields,
  };
  await crmFormsDb.crmLeads.add(lead);
  await recordActivity({
    type: 'lead_created',
    title: `Lead created: ${lead.title}`,
    leadId: lead.id,
    contactId: lead.contactId,
    companyId: lead.companyId,
  });
  return lead;
}

export async function updateLead(
  id: string,
  updates: Partial<CRMLead>,
): Promise<CRMLead | undefined> {
  const existing = await crmFormsDb.crmLeads.get(id);
  if (!existing) return undefined;
  const next: CRMLead = { ...existing, ...updates, id, updatedAt: nowIso() };
  await crmFormsDb.crmLeads.put(next);
  await recordActivity({
    type: 'lead_updated',
    title: `Lead updated: ${next.title}`,
    leadId: next.id,
    contactId: next.contactId,
    companyId: next.companyId,
    metadata: updates as unknown as Record<string, unknown>,
  });
  return next;
}

export async function setLeadStatus(
  id: string,
  status: CRMLeadStatus,
): Promise<CRMLead | undefined> {
  return updateLead(id, { status, stage: status, lastActivityAt: nowIso() });
}

export async function deleteLead(id: string): Promise<void> {
  await crmFormsDb.crmLeads.delete(id);
  await crmFormsDb.crmActivities.where('leadId').equals(id).delete();
  await crmFormsDb.crmNotes.where('leadId').equals(id).delete();
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

export async function listContacts(): Promise<CRMContact[]> {
  return crmFormsDb.crmContacts.toArray();
}

export async function getContact(id: string): Promise<CRMContact | undefined> {
  return crmFormsDb.crmContacts.get(id);
}

export async function getContactByEmail(
  email: string,
): Promise<CRMContact | undefined> {
  if (!email) return undefined;
  const normalized = email.trim().toLowerCase();
  return crmFormsDb.crmContacts
    .where('email')
    .equalsIgnoreCase(normalized)
    .first();
}

export async function createContact(
  input: Omit<CRMContact, 'id' | 'createdAt' | 'updatedAt' | 'tags'> &
    Partial<Pick<CRMContact, 'tags' | 'lifecycleStatus' | 'notes'>>,
): Promise<CRMContact> {
  const ts = nowIso();
  const contact: CRMContact = {
    id: nanoid(8),
    firstName: input.firstName,
    lastName: input.lastName,
    email: input.email,
    phone: input.phone,
    jobTitle: input.jobTitle,
    companyId: input.companyId,
    lifecycleStatus: input.lifecycleStatus,
    tags: input.tags ?? [],
    notes: input.notes,
    createdAt: ts,
    updatedAt: ts,
    lastActivityAt: ts,
  };
  await crmFormsDb.crmContacts.add(contact);
  await recordActivity({
    type: 'contact_created',
    title: `Contact created: ${contact.firstName} ${contact.lastName}`,
    contactId: contact.id,
    companyId: contact.companyId,
  });
  return contact;
}

export async function updateContact(
  id: string,
  updates: Partial<CRMContact>,
): Promise<CRMContact | undefined> {
  const existing = await crmFormsDb.crmContacts.get(id);
  if (!existing) return undefined;
  const next: CRMContact = { ...existing, ...updates, id, updatedAt: nowIso() };
  await crmFormsDb.crmContacts.put(next);
  return next;
}

export async function deleteContact(id: string): Promise<void> {
  await crmFormsDb.crmContacts.delete(id);
  await crmFormsDb.crmActivities.where('contactId').equals(id).delete();
  await crmFormsDb.crmNotes.where('contactId').equals(id).delete();
}

// ---------------------------------------------------------------------------
// Companies
// ---------------------------------------------------------------------------

export async function listCompanies(): Promise<CRMCompany[]> {
  return crmFormsDb.crmCompanies.toArray();
}

export async function getCompany(id: string): Promise<CRMCompany | undefined> {
  return crmFormsDb.crmCompanies.get(id);
}

export async function getCompanyByName(
  name: string,
): Promise<CRMCompany | undefined> {
  if (!name) return undefined;
  const normalized = name.trim().toLowerCase();
  const all = await crmFormsDb.crmCompanies.toArray();
  return all.find((c) => c.name.trim().toLowerCase() === normalized);
}

export async function createCompany(
  input: Omit<CRMCompany, 'id' | 'createdAt' | 'updatedAt' | 'tags'> &
    Partial<Pick<CRMCompany, 'tags' | 'notes' | 'ownerId'>>,
): Promise<CRMCompany> {
  const ts = nowIso();
  const company: CRMCompany = {
    id: nanoid(8),
    name: input.name,
    website: input.website,
    industry: input.industry,
    size: input.size,
    city: input.city,
    country: input.country,
    ownerId: input.ownerId,
    tags: input.tags ?? [],
    notes: input.notes,
    createdAt: ts,
    updatedAt: ts,
    lastActivityAt: ts,
  };
  await crmFormsDb.crmCompanies.add(company);
  await recordActivity({
    type: 'company_created',
    title: `Company created: ${company.name}`,
    companyId: company.id,
  });
  return company;
}

export async function updateCompany(
  id: string,
  updates: Partial<CRMCompany>,
): Promise<CRMCompany | undefined> {
  const existing = await crmFormsDb.crmCompanies.get(id);
  if (!existing) return undefined;
  const next: CRMCompany = { ...existing, ...updates, id, updatedAt: nowIso() };
  await crmFormsDb.crmCompanies.put(next);
  return next;
}

export async function deleteCompany(id: string): Promise<void> {
  await crmFormsDb.crmCompanies.delete(id);
  await crmFormsDb.crmActivities.where('companyId').equals(id).delete();
  await crmFormsDb.crmNotes.where('companyId').equals(id).delete();
}

// ---------------------------------------------------------------------------
// Deals
// ---------------------------------------------------------------------------

export async function listDeals(): Promise<CRMDeal[]> {
  return crmFormsDb.crmDeals.toArray();
}

export async function getDeal(id: string): Promise<CRMDeal | undefined> {
  return crmFormsDb.crmDeals.get(id);
}

export async function createDeal(
  input: Omit<CRMDeal, 'id' | 'createdAt' | 'updatedAt' | 'tags'> &
    Partial<Pick<CRMDeal, 'tags' | 'currency' | 'probability' | 'ownerId'>>,
): Promise<CRMDeal> {
  const ts = nowIso();
  const deal: CRMDeal = {
    id: nanoid(8),
    title: input.title,
    leadId: input.leadId,
    contactId: input.contactId,
    companyId: input.companyId,
    stage: input.stage,
    value: input.value,
    currency: input.currency ?? 'USD',
    probability: input.probability,
    expectedCloseDate: input.expectedCloseDate,
    ownerId: input.ownerId,
    tags: input.tags ?? [],
    createdAt: ts,
    updatedAt: ts,
  };
  await crmFormsDb.crmDeals.add(deal);
  await recordActivity({
    type: 'deal_created',
    title: `Deal created: ${deal.title}`,
    leadId: deal.leadId,
    contactId: deal.contactId,
    companyId: deal.companyId,
    dealId: deal.id,
  });
  return deal;
}

export async function updateDeal(
  id: string,
  updates: Partial<CRMDeal>,
): Promise<CRMDeal | undefined> {
  const existing = await crmFormsDb.crmDeals.get(id);
  if (!existing) return undefined;
  const next: CRMDeal = { ...existing, ...updates, id, updatedAt: nowIso() };
  await crmFormsDb.crmDeals.put(next);
  if (updates.stage && updates.stage !== existing.stage) {
    await recordActivity({
      type: 'deal_stage_changed',
      title: `${next.title} moved to ${next.stage}`,
      leadId: next.leadId,
      contactId: next.contactId,
      companyId: next.companyId,
      dealId: next.id,
      metadata: { from: existing.stage, to: next.stage },
    });
    // Keep the linked lead stage in sync with the deal stage.
    if (next.leadId) {
      await updateLead(next.leadId, { stage: next.stage, status: next.stage });
    }
  }
  return next;
}

export async function setDealStage(
  id: string,
  stage: CRMDealStage,
): Promise<CRMDeal | undefined> {
  return updateDeal(id, { stage });
}

export async function deleteDeal(id: string): Promise<void> {
  await crmFormsDb.crmDeals.delete(id);
}

// ---------------------------------------------------------------------------
// Activities
// ---------------------------------------------------------------------------

export async function listActivities(): Promise<CRMActivity[]> {
  const all = await crmFormsDb.crmActivities.toArray();
  return all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function listActivitiesForLead(
  leadId: string,
): Promise<CRMActivity[]> {
  const all = await crmFormsDb.crmActivities.where('leadId').equals(leadId).toArray();
  return all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function recordActivity(
  input: Omit<CRMActivity, 'id' | 'createdAt'> & {
    type: CRMActivityType;
    title: string;
  } & Partial<Pick<CRMActivity, 'description' | 'createdBy' | 'metadata'>>,
): Promise<CRMActivity> {
  const activity: CRMActivity = {
    id: nanoid(10),
    createdAt: nowIso(),
    type: input.type,
    title: input.title,
    description: input.description,
    leadId: input.leadId,
    contactId: input.contactId,
    companyId: input.companyId,
    dealId: input.dealId,
    formId: input.formId,
    submissionId: input.submissionId,
    taskId: input.taskId,
    createdBy: input.createdBy,
    metadata: input.metadata,
  };
  await crmFormsDb.crmActivities.add(activity);
  // Bump lastActivityAt on linked entities.
  const ts = activity.createdAt;
  if (activity.leadId) {
    await crmFormsDb.crmLeads.update(activity.leadId, {
      lastActivityAt: ts,
      updatedAt: ts,
    });
  }
  if (activity.contactId) {
    await crmFormsDb.crmContacts.update(activity.contactId, {
      lastActivityAt: ts,
      updatedAt: ts,
    });
  }
  if (activity.companyId) {
    await crmFormsDb.crmCompanies.update(activity.companyId, {
      lastActivityAt: ts,
      updatedAt: ts,
    });
  }
  return activity;
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

export async function listNotes(): Promise<CRMNote[]> {
  const all = await crmFormsDb.crmNotes.toArray();
  return all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function addNote(
  input: Omit<CRMNote, 'id' | 'createdAt' | 'updatedAt'>,
): Promise<CRMNote> {
  const ts = nowIso();
  const note: CRMNote = {
    id: nanoid(10),
    body: input.body,
    leadId: input.leadId,
    contactId: input.contactId,
    companyId: input.companyId,
    dealId: input.dealId,
    createdBy: input.createdBy,
    createdAt: ts,
    updatedAt: ts,
  };
  await crmFormsDb.crmNotes.add(note);
  await recordActivity({
    type: 'note_added',
    title: 'Note added',
    leadId: note.leadId,
    contactId: note.contactId,
    companyId: note.companyId,
    dealId: note.dealId,
  });
  return note;
}

export async function deleteNote(id: string): Promise<void> {
  await crmFormsDb.crmNotes.delete(id);
}

// ---------------------------------------------------------------------------
// Task links
// ---------------------------------------------------------------------------

export async function listTaskLinks(): Promise<CRMTaskLink[]> {
  return crmFormsDb.crmTaskLinks.toArray();
}

export async function linkTask(
  input: Omit<CRMTaskLink, 'id' | 'createdAt'>,
): Promise<CRMTaskLink> {
  const link: CRMTaskLink = {
    id: nanoid(10),
    taskId: input.taskId,
    leadId: input.leadId,
    contactId: input.contactId,
    companyId: input.companyId,
    dealId: input.dealId,
    createdBy: input.createdBy,
    createdAt: nowIso(),
  };
  await crmFormsDb.crmTaskLinks.add(link);
  await recordActivity({
    type: 'task_linked',
    title: 'Task linked',
    leadId: link.leadId,
    contactId: link.contactId,
    companyId: link.companyId,
    dealId: link.dealId,
    taskId: link.taskId,
  });
  return link;
}

export async function unlinkTask(id: string): Promise<void> {
  await crmFormsDb.crmTaskLinks.delete(id);
}

// ---------------------------------------------------------------------------
// Saved views
// ---------------------------------------------------------------------------

export async function listSavedViews(): Promise<CRMSavedView[]> {
  return crmFormsDb.crmSavedViews.toArray();
}

export async function createSavedView(
  input: Omit<CRMSavedView, 'id' | 'createdAt' | 'updatedAt'>,
): Promise<CRMSavedView> {
  const ts = nowIso();
  const view: CRMSavedView = {
    id: nanoid(10),
    name: input.name,
    entity: input.entity,
    filters: input.filters,
    columns: input.columns,
    isDefault: input.isDefault,
    createdAt: ts,
    updatedAt: ts,
  };
  await crmFormsDb.crmSavedViews.add(view);
  return view;
}

export async function deleteSavedView(id: string): Promise<void> {
  await crmFormsDb.crmSavedViews.delete(id);
}

// ---------------------------------------------------------------------------
// Derived selectors
// ---------------------------------------------------------------------------

export function selectLeadsByStage(leads: CRMLead[]): Record<CRMDealStage, CRMLead[]> {
  const buckets: Record<CRMDealStage, CRMLead[]> = {
    new: [],
    contacted: [],
    qualified: [],
    proposal: [],
    won: [],
    lost: [],
    spam: [],
  };
  for (const lead of leads) {
    buckets[lead.stage].push(lead);
  }
  return buckets;
}

export function selectDealsByStage(deals: CRMDeal[]): Record<CRMDealStage, CRMDeal[]> {
  const buckets: Record<CRMDealStage, CRMDeal[]> = {
    new: [],
    contacted: [],
    qualified: [],
    proposal: [],
    won: [],
    lost: [],
    spam: [],
  };
  for (const deal of deals) {
    buckets[deal.stage].push(deal);
  }
  return buckets;
}

export function computeDashboardKPIs(
  leads: CRMLead[],
  deals: CRMDeal[],
  tasksDue = 0,
): CRMDashboardKPIs {
  const newLeads = leads.filter((l) => l.status === 'new').length;
  const openDeals = deals.filter((d) => OPEN_STAGES.includes(d.stage));
  const wonDeals = deals.filter((d) => WON_STAGES.includes(d.stage));
  const totalPipelineValue = openDeals.reduce((sum, d) => sum + (d.value ?? 0), 0);
  const weightedPipelineValue = openDeals.reduce(
    (sum, d) => sum + (d.value ?? 0) * (d.probability ?? 0),
    0,
  );
  const wonDealsValue = wonDeals.reduce((sum, d) => sum + (d.value ?? 0), 0);
  const closedTotal = wonDeals.length + leads.filter((l) => l.status === 'lost').length;
  const conversionRate = closedTotal > 0 ? wonDeals.length / closedTotal : 0;
  return {
    newLeads,
    openDeals: openDeals.length,
    totalPipelineValue,
    weightedPipelineValue,
    conversionRate,
    wonDealsValue,
    tasksDue,
  };
}

// ---------------------------------------------------------------------------
// CSV export — leads
// ---------------------------------------------------------------------------

const LEAD_EXPORT_COLUMNS = [
  'id',
  'title',
  'status',
  'stage',
  'score',
  'firstName',
  'lastName',
  'email',
  'phone',
  'company',
  'source',
  'sourceFormId',
  'sourcePageUrl',
  'ownerId',
  'tags',
  'createdAt',
  'updatedAt',
  'lastActivityAt',
];

export async function exportLeadsToCsv(
  contacts: CRMContact[],
  companies: CRMCompany[],
): Promise<void> {
  const leads = await listLeads();
  const contactMap = new Map(contacts.map((c) => [c.id, c]));
  const companyMap = new Map(companies.map((c) => [c.id, c]));
  const rows = leads.map((lead) => {
    const contact = lead.contactId ? contactMap.get(lead.contactId) : undefined;
    const company = lead.companyId ? companyMap.get(lead.companyId) : undefined;
    return {
      id: lead.id,
      title: lead.title,
      status: lead.status,
      stage: lead.stage,
      score: lead.score ?? '',
      firstName: contact?.firstName ?? '',
      lastName: contact?.lastName ?? '',
      email: contact?.email ?? '',
      phone: contact?.phone ?? '',
      company: company?.name ?? '',
      source: lead.source ?? '',
      sourceFormId: lead.sourceFormId ?? '',
      sourcePageUrl: lead.sourcePageUrl ?? '',
      ownerId: lead.ownerId ?? '',
      tags: lead.tags.join('; '),
      createdAt: lead.createdAt,
      updatedAt: lead.updatedAt,
      lastActivityAt: lead.lastActivityAt ?? '',
    };
  });
  await recordActivity({
    type: 'export_created',
    title: 'Exported leads to CSV',
    metadata: { count: rows.length, format: 'csv' },
  });
  exportToCsv('leads-export', rows as unknown as Record<string, unknown>[], LEAD_EXPORT_COLUMNS);
}
