// Submission service — public form submission ingestion + duplicate handling.
//
// This is the bridge between a published form and the CRM. It:
//   1. Validates the payload (honeypot + spam score placeholder).
//   2. Applies the duplicate-handling rule (see resolveDuplicate + Step 6 of
//      the data-agent spec) to decide whether to create or update CRM records.
//   3. Persists the LeadFormSubmission and links it to lead/contact/company.
//   4. Records a `form_submitted` activity.
//
// `resolveDuplicate` is exported as a PURE helper so it can be unit-tested
// without Dexie.

import { nanoid } from 'nanoid';
import { crmFormsDb } from '../data/crmFormsDb';
import {
  createCompany,
  createContact,
  createLead,
  getCompanyByName,
  getContactByEmail,
  recordActivity,
  updateContact,
  updateLead,
} from './crmService';
import type { CRMContact, CRMLead, CRMUtmData } from '../types/crm';
import type { LeadForm, LeadFormSubmission } from '../types/forms';
import type { AgentOperationReceipt } from '../types/agent';
import { emitDomainChange } from './domainEvents';
import { validateForm } from './formValidation';
import type { CompanionOperation } from './crmFormsCommands';

// CRM_FORMS_PUBLIC_CAPTURE_TODO:
// Production embedded forms require a public VPS/API endpoint.
// Implement public form rendering, submission ingestion, allowed-domain checks,
// CORS, rate limits, spam protection, duplicate matching, and CRM lead creation.

export interface SubmissionInput {
  formId: string;
  /** Submitted field values keyed by field name. */
  fields: Record<string, unknown>;
  /** Hidden/UTM capture merged into the submission. */
  hiddenFields: CRMUtmData & Record<string, unknown>;
  /** Source domain the form was posted from (e.g. "acmecorp.com"). */
  sourceDomain?: string;
  /** Whether the source domain matched the form's allowedDomains list. */
  allowedDomainMatched?: boolean;
  /** Honeypot field value; non-empty = likely bot. */
  honeypot?: string;
  /** Optional override of the placeholder spam score (0..100). */
  spamScore?: number;
}

export interface IngestionResult {
  submission: LeadFormSubmission;
  leadId?: string;
  contactId?: string;
  companyId?: string;
  /** Flags indicating which entities were freshly created vs reused. */
  created: {
    contact: boolean;
    company: boolean;
    lead: boolean;
  };
  /** Why the submission was handled the way it was. */
  reason: 'created' | 'attached_to_existing' | 'spam';
}

// ---------------------------------------------------------------------------
// Field extraction (tolerant of varying field names)
// ---------------------------------------------------------------------------

function asString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  return undefined;
}

function extractEmail(fields: Record<string, unknown>): string | undefined {
  return asString(fields['email']);
}

function extractName(
  fields: Record<string, unknown>,
): { firstName: string; lastName: string } | undefined {
  const full = asString(fields['name']);
  if (full) {
    const parts = full.split(/\s+/);
    if (parts.length === 1) return { firstName: parts[0], lastName: '' };
    return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
  }
  const first = asString(fields['first_name']);
  const last = asString(fields['last_name']);
  if (first || last) return { firstName: first ?? '', lastName: last ?? '' };
  return undefined;
}

function extractPhone(fields: Record<string, unknown>): string | undefined {
  return asString(fields['phone']);
}

function extractCompany(fields: Record<string, unknown>): string | undefined {
  return asString(fields['company']);
}

function extractJobTitle(fields: Record<string, unknown>): string | undefined {
  return asString(fields['job_title']) ?? asString(fields['title']);
}

// ---------------------------------------------------------------------------
// Spam scoring (placeholder — real scoring lives on the future VPS endpoint)
// ---------------------------------------------------------------------------

const SPAM_SCORE_THRESHOLD = 60;

function computeSpamScore(input: SubmissionInput): number {
  if (typeof input.spamScore === 'number') return input.spamScore;
  let score = 0;
  if (input.honeypot && input.honeypot.trim() !== '') score += 90;
  if (input.allowedDomainMatched === false) score += 25;
  const message = asString(input.fields['message']) ?? '';
  if (/https?:\/\//gi.test(message) && (message.match(/https?:\/\//gi) ?? []).length >= 3) {
    score += 25;
  }
  if (/buy now|free money|casino|viagra|seo service/i.test(message)) {
    score += 30;
  }
  return Math.min(100, score);
}

// ---------------------------------------------------------------------------
// Duplicate resolution — PURE helper (no Dexie, no side effects)
// ---------------------------------------------------------------------------

export type DuplicateResolution =
  | { mode: 'existing'; contact: CRMContact; lead?: CRMLead }
  | { mode: 'new' };

/**
 * Decide whether a submission is a duplicate of an existing contact/lead.
 *
 * Rule (Step 6): if the submitted email matches an existing contact (by email)
 * OR an existing lead via that contact's email, attach to the existing
 * contact/lead instead of creating duplicates. Otherwise, create new.
 *
 * This function is pure: callers pass in the candidate contact (looked up by
 * email) and the leads attached to that contact. It makes no DB calls.
 */
export function resolveDuplicate(params: {
  email?: string;
  existingContact?: CRMContact;
  existingLead?: CRMLead;
}): DuplicateResolution {
  const { email, existingContact, existingLead } = params;
  if (!email || !existingContact) return { mode: 'new' };
  return { mode: 'existing', contact: existingContact, lead: existingLead };
}

// ---------------------------------------------------------------------------
// Public ingestion entrypoint
// ---------------------------------------------------------------------------

export async function ingestSubmission(
  input: SubmissionInput,
  operation: CompanionOperation = {
    operationId: `submission:${nanoid(12)}`,
    effectFingerprint: JSON.stringify(input),
  },
): Promise<IngestionResult> {
  if (!operation.operationId.trim() || !operation.effectFingerprint.trim()) throw new Error('Operation identity is required.');
  const prior = await crmFormsDb.agentOperationReceipts.where('operationId').equals(operation.operationId).first();
  if (prior) {
    if (prior.effectFingerprint !== operation.effectFingerprint) throw new Error('Operation replay effect mismatch.');
    return prior.resultData as IngestionResult;
  }
  const result: IngestionResult = await crmFormsDb.transaction(
    'rw',
    [
      crmFormsDb.forms,
      crmFormsDb.formSubmissions,
      crmFormsDb.crmContacts,
      crmFormsDb.crmCompanies,
      crmFormsDb.crmLeads,
      crmFormsDb.crmActivities,
      crmFormsDb.agentOperationReceipts,
    ],
    async () => {
      const raced = await crmFormsDb.agentOperationReceipts.where('operationId').equals(operation.operationId).first();
      if (raced) {
        if (raced.effectFingerprint !== operation.effectFingerprint) throw new Error('Operation replay effect mismatch.');
        return raced.resultData as IngestionResult;
      }
      const outcome = await ingestSubmissionTransaction(input);
      const receipt: AgentOperationReceipt = {
        id: `crm-forms-receipt:${operation.operationId}`,
        operationId: operation.operationId,
        effectFingerprint: operation.effectFingerprint,
        domain: 'forms',
        resourceKeys: [
          `form:${input.formId}`,
          `submission:${outcome.submission.id}`,
          ...(outcome.contactId ? [`crm:contact:${outcome.contactId}`] : []),
          ...(outcome.companyId ? [`crm:company:${outcome.companyId}`] : []),
          ...(outcome.leadId ? [`crm:lead:${outcome.leadId}`] : []),
        ],
        status: 'committed',
        resultSummary: `submission ${outcome.reason}`,
        resultData: outcome,
        committedAt: Date.now(),
      };
      await crmFormsDb.agentOperationReceipts.add(receipt);
      return outcome;
    },
  );
  emitDomainChange({ domain: 'forms', entityType: 'submission', entityId: result.submission.id, operation: 'created', revision: result.submission.createdAt, operationId: operation.operationId });
  if (result.contactId) emitDomainChange({ domain: 'crm', entityType: 'contact', entityId: result.contactId, operation: result.created.contact ? 'created' : 'updated', revision: result.submission.createdAt, operationId: operation.operationId });
  if (result.companyId && result.created.company) emitDomainChange({ domain: 'crm', entityType: 'company', entityId: result.companyId, operation: 'created', revision: result.submission.createdAt, operationId: operation.operationId });
  if (result.leadId) emitDomainChange({ domain: 'crm', entityType: 'lead', entityId: result.leadId, operation: result.created.lead ? 'created' : 'updated', revision: result.submission.createdAt, operationId: operation.operationId });
  return result;
}

async function ingestSubmissionTransaction(input: SubmissionInput): Promise<IngestionResult> {
  const ts = new Date().toISOString();
  const form = await crmFormsDb.forms.get(input.formId);
  if (!form) throw new Error(`Form ${input.formId} was not found.`);
  const validation = validateForm(form);
  if (!validation.valid) throw new Error(`Invalid form: ${validation.issues.map((issue) => issue.message).join(' ')}`);

  const spamScore = computeSpamScore(input);
  const isSpam = spamScore >= SPAM_SCORE_THRESHOLD || (input.allowedDomainMatched === false && spamScore >= 40);

  // Build the submission record first (always persisted, even spam).
  const submission: LeadFormSubmission = {
    id: nanoid(12),
    formId: input.formId,
    status: isSpam ? 'spam' : 'converted',
    fields: input.fields,
    hiddenFields: input.hiddenFields,
    honeypot: input.honeypot,
    spamScore,
    sourceDomain: input.sourceDomain,
    allowedDomainMatched: input.allowedDomainMatched,
    createdAt: ts,
  };

  if (isSpam) {
    await crmFormsDb.formSubmissions.add(submission);
    return {
      submission,
      created: { contact: false, company: false, lead: false },
      reason: 'spam',
    };
  }

  // Resolve duplicate against existing contact by email.
  const email = extractEmail(input.fields) ?? '';
  const existingContact = email ? await getContactByEmail(email) : undefined;
  const existingLead = existingContact
    ? await crmFormsDb.crmLeads.where('contactId').equals(existingContact.id).first()
    : undefined;

  const resolution = resolveDuplicate({ email, existingContact, existingLead });

  if (resolution.mode === 'existing') {
    const contact = resolution.contact;
    const lead = resolution.lead;

    // Attach the submission as an activity on the existing contact/lead and
    // bump lastActivityAt. Do NOT create a duplicate contact.
    await recordActivity({
      type: 'form_submitted',
      title: `Form submitted: ${form?.name ?? input.formId}`,
      description: `Repeat submission from ${contact.email ?? contact.firstName}.`,
      leadId: lead?.id,
      contactId: contact.id,
      companyId: contact.companyId,
      formId: input.formId,
      submissionId: submission.id,
      metadata: { sourceDomain: input.sourceDomain, duplicate: true },
    });

    if (lead) {
      await updateLead(lead.id, {
        lastActivityAt: ts,
        sourceSubmissionId: submission.id,
      });
    }
    await updateContact(contact.id, { lastActivityAt: ts });

    submission.leadId = lead?.id;
    submission.contactId = contact.id;
    submission.companyId = contact.companyId;
    await crmFormsDb.formSubmissions.add(submission);

    return {
      submission,
      leadId: lead?.id,
      contactId: contact.id,
      companyId: contact.companyId,
      created: { contact: false, company: false, lead: false },
      reason: 'attached_to_existing',
    };
  }

  // New record path: create Company (if named and not existing) + Contact + Lead.
  const name = extractName(input.fields);
  const companyName = extractCompany(input.fields);

  let companyId: string | undefined;
  let createdCompany = false;
  if (companyName) {
    const existingCompany = await getCompanyByName(companyName);
    if (existingCompany) {
      companyId = existingCompany.id;
    } else {
      const company = await createCompany({ name: companyName, website: extractCompanyWebsite(input.hiddenFields) });
      companyId = company.id;
      createdCompany = true;
    }
  }

  const contact = await createContact({
    firstName: name?.firstName ?? '',
    lastName: name?.lastName ?? '',
    email: email || undefined,
    phone: extractPhone(input.fields),
    jobTitle: extractJobTitle(input.fields),
    companyId,
    lifecycleStatus: 'lead',
    tags: [],
  });

  const lead = await createLead({
    title: buildLeadTitle(form, companyName, name),
    contactId: contact.id,
    companyId,
    status: 'new',
    stage: 'new',
    source: form?.name,
    sourceFormId: input.formId,
    sourceSubmissionId: submission.id,
    sourcePageUrl: asString(input.hiddenFields['page_url']) ?? asString(input.hiddenFields['landing_page']),
    utm: extractUtm(input.hiddenFields),
  });

  // Activity already recorded by createLead/createContact/createCompany; add
  // the form_submitted activity linking everything together.
  await recordActivity({
    type: 'form_submitted',
    title: `Form submitted: ${form?.name ?? input.formId}`,
    description: `New submission from ${contact.email ?? contact.firstName}.`,
    leadId: lead.id,
    contactId: contact.id,
    companyId,
    formId: input.formId,
    submissionId: submission.id,
    metadata: { sourceDomain: input.sourceDomain, duplicate: false },
  });

  submission.leadId = lead.id;
  submission.contactId = contact.id;
  submission.companyId = companyId;
  await crmFormsDb.formSubmissions.add(submission);

  return {
    submission,
    leadId: lead.id,
    contactId: contact.id,
    companyId,
    created: { contact: true, company: createdCompany, lead: true },
    reason: 'created',
  };
}

function extractCompanyWebsite(hidden: CRMUtmData & Record<string, unknown>): string | undefined {
  return asString(hidden['website']) ?? asString(hidden['referrer']);
}

function extractUtm(hidden: CRMUtmData & Record<string, unknown>): CRMUtmData {
  return {
    utm_source: asString(hidden['utm_source']),
    utm_medium: asString(hidden['utm_medium']),
    utm_campaign: asString(hidden['utm_campaign']),
    utm_term: asString(hidden['utm_term']),
    utm_content: asString(hidden['utm_content']),
    referrer: asString(hidden['referrer']),
    landing_page: asString(hidden['landing_page']),
    page_url: asString(hidden['page_url']),
    device_type: asString(hidden['device_type']),
    submitted_at: asString(hidden['submitted_at']),
  };
}

function buildLeadTitle(
  form: LeadForm | undefined,
  companyName: string | undefined,
  name: { firstName: string; lastName: string } | undefined,
): string {
  const who = name ? `${name.firstName} ${name.lastName}`.trim() : undefined;
  const subject = companyName ?? who ?? 'New lead';
  const formName = form?.name ?? 'Form';
  return `${subject} — ${formName}`;
}
