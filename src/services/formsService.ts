// Forms service — persistence boundary between the forms Zustand store and
// Dexie. CRUD for forms / templates / submissions / webhooks, plus publish
// state transitions, duplicate-form, create-from-template, save-as-template,
// and CSV export for submissions.
//
// Architecture: React -> Zustand store -> service -> Dexie adapter now / VPS
// API later. UI never touches Dexie directly.

import { nanoid } from 'nanoid';
import { crmFormsDb, isFormsDataEmpty } from '../data/crmFormsDb';
import {
  SEED_FORMS,
  SEED_SUBMISSIONS,
  SEED_TEMPLATES,
  SEED_WEBHOOKS,
} from '../data/formsSeed';
import { exportToCsv } from '../utils/csvExport';
import type {
  LeadForm,
  LeadFormField,
  LeadFormSubmission,
  FormTemplate,
  FormStatus,
  WebhookConfig,
} from '../types/forms';
import type { AgentOperationReceipt } from '../types/agent';
import { emitDomainChange } from './domainEvents';
import { validateForm } from './formValidation';

export { validateForm } from './formValidation';
export type { FormValidationIssue, FormValidationResult } from './formValidation';

function nowIso(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Bootstrap / seeding
// ---------------------------------------------------------------------------

export async function ensureFormsSeeded(): Promise<boolean> {
  if (!(await isFormsDataEmpty())) return false;
  await crmFormsDb.transaction(
    'rw',
    [crmFormsDb.forms, crmFormsDb.formSubmissions, crmFormsDb.formTemplates, crmFormsDb.formWebhooks],
    async () => {
      await crmFormsDb.forms.bulkAdd(SEED_FORMS);
      await crmFormsDb.formSubmissions.bulkAdd(SEED_SUBMISSIONS);
      await crmFormsDb.formTemplates.bulkAdd(SEED_TEMPLATES);
      await crmFormsDb.formWebhooks.bulkAdd(SEED_WEBHOOKS);
    },
  );
  return true;
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

export async function listForms(): Promise<LeadForm[]> {
  const forms = await crmFormsDb.forms.toArray();
  return forms.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function getForm(id: string): Promise<LeadForm | undefined> {
  return crmFormsDb.forms.get(id);
}

export function blankForm(name = 'Untitled Form'): LeadForm {
  const ts = nowIso();
  return {
    id: nanoid(10),
    name,
    status: 'draft',
    fields: defaultFields(),
    steps: [{ id: nanoid(8), title: 'Step 1', order: 0 }],
    logicRules: [],
    style: defaultStyle(),
    embed: defaultEmbed(),
    successMessage: 'Thanks for your submission!',
    createdAt: ts,
    updatedAt: ts,
  };
}

export async function createForm(name?: string): Promise<LeadForm> {
  const form = blankForm(name);
  await crmFormsDb.forms.add(form);
  emitDomainChange({ domain: 'forms', entityType: 'form', entityId: form.id, operation: 'created', revision: form.updatedAt });
  return form;
}

export interface FormMutationOperation {
  operationId: string;
  effectFingerprint: string;
}

export class FormRevisionConflictError extends Error {
  readonly formId: string;
  readonly expectedUpdatedAt: string;
  readonly actualUpdatedAt: string;
  constructor(formId: string, expectedUpdatedAt: string, actualUpdatedAt: string) {
    super(`Form ${formId} changed since ${expectedUpdatedAt}; current revision is ${actualUpdatedAt}.`);
    this.name = 'FormRevisionConflictError';
    this.formId = formId;
    this.expectedUpdatedAt = expectedUpdatedAt;
    this.actualUpdatedAt = actualUpdatedAt;
  }
}

export async function updateFormCommand(
  operation: FormMutationOperation,
  id: string,
  expectedUpdatedAt: string,
  updates: Partial<LeadForm>,
): Promise<{ form: LeadForm; receipt: AgentOperationReceipt; replayed: boolean }> {
  if (!operation.operationId.trim() || !operation.effectFingerprint.trim()) throw new Error('Operation identity is required.');
  const prior = await crmFormsDb.agentOperationReceipts.where('operationId').equals(operation.operationId).first();
  if (prior) {
    if (prior.effectFingerprint !== operation.effectFingerprint) throw new Error('Operation replay effect mismatch.');
    const form = (prior.resultData as { form: LeadForm }).form;
    return { form, receipt: prior, replayed: true };
  }
  const result = await crmFormsDb.transaction('rw', crmFormsDb.forms, crmFormsDb.agentOperationReceipts, async () => {
    const raced = await crmFormsDb.agentOperationReceipts.where('operationId').equals(operation.operationId).first();
    if (raced) return { form: (raced.resultData as { form: LeadForm }).form, receipt: raced, replayed: true };
    const existing = await crmFormsDb.forms.get(id);
    if (!existing) throw new Error(`Form ${id} was not found.`);
    if (existing.updatedAt !== expectedUpdatedAt) throw new FormRevisionConflictError(id, expectedUpdatedAt, existing.updatedAt);
    const next: LeadForm = { ...existing, ...updates, id, updatedAt: new Date(Math.max(Date.now(), Date.parse(existing.updatedAt) + 1)).toISOString() };
    const validation = validateForm(next);
    if (!validation.valid) throw new Error(`Invalid form: ${validation.issues.map((issue) => issue.message).join(' ')}`);
    const receipt: AgentOperationReceipt = {
      id: `crm-forms-receipt:${operation.operationId}`,
      operationId: operation.operationId,
      effectFingerprint: operation.effectFingerprint,
      domain: 'forms',
      resourceKeys: [`form:${id}`],
      status: 'committed',
      resultSummary: 'form updated',
      resultData: { form: next },
      committedAt: Date.now(),
    };
    await crmFormsDb.forms.put(next);
    await crmFormsDb.agentOperationReceipts.add(receipt);
    return { form: next, receipt, replayed: false };
  });
  if (!result.replayed) emitDomainChange({ domain: 'forms', entityType: 'form', entityId: id, operation: 'updated', revision: result.form.updatedAt, operationId: operation.operationId });
  return result;
}

export async function updateForm(
  id: string,
  updates: Partial<LeadForm>,
): Promise<LeadForm | undefined> {
  const existing = await crmFormsDb.forms.get(id);
  if (!existing) return undefined;
  const result = await updateFormCommand(
    { operationId: `ui:form:update:${nanoid(12)}`, effectFingerprint: JSON.stringify(updates) },
    id,
    existing.updatedAt,
    updates,
  );
  return result.form;
}

export async function deleteForm(id: string): Promise<void> {
  await crmFormsDb.transaction(
    'rw',
    [crmFormsDb.forms, crmFormsDb.formSubmissions, crmFormsDb.formWebhooks],
    async () => {
      await crmFormsDb.forms.delete(id);
      await crmFormsDb.formSubmissions.where('formId').equals(id).delete();
      await crmFormsDb.formWebhooks.where('formId').equals(id).delete();
    },
  );
}

export async function duplicateForm(id: string): Promise<LeadForm | undefined> {
  const source = await crmFormsDb.forms.get(id);
  if (!source) return undefined;
  const ts = nowIso();
  const copy: LeadForm = {
    ...source,
    id: nanoid(10),
    name: `${source.name} (copy)`,
    status: 'draft',
    createdAt: ts,
    updatedAt: ts,
  };
  await crmFormsDb.forms.add(copy);
  return copy;
}

// ---------------------------------------------------------------------------
// Publish state transitions
// ---------------------------------------------------------------------------

export async function setFormStatus(
  id: string,
  status: FormStatus,
): Promise<LeadForm | undefined> {
  return updateForm(id, { status });
}

export async function publishForm(id: string): Promise<LeadForm | undefined> {
  return setFormStatus(id, 'published');
}

export async function archiveForm(id: string): Promise<LeadForm | undefined> {
  return setFormStatus(id, 'archived');
}

export async function unpublishForm(id: string): Promise<LeadForm | undefined> {
  return setFormStatus(id, 'draft');
}

// ---------------------------------------------------------------------------
// Fields (field-level helpers used by the builder)
// ---------------------------------------------------------------------------

export async function addField(
  formId: string,
  fieldInput: Omit<LeadFormField, 'id' | 'order'> & Partial<Pick<LeadFormField, 'order'>>,
): Promise<LeadForm | undefined> {
  const form = await crmFormsDb.forms.get(formId);
  if (!form) return undefined;
  const order = fieldInput.order ?? form.fields.length;
  const newField: LeadFormField = {
    ...fieldInput,
    id: nanoid(8),
    order,
  };
  return updateForm(formId, { fields: [...form.fields, newField] });
}

export async function updateField(
  formId: string,
  fieldId: string,
  updates: Partial<LeadFormField>,
): Promise<LeadForm | undefined> {
  const form = await crmFormsDb.forms.get(formId);
  if (!form) return undefined;
  const fields = form.fields.map((f) => (f.id === fieldId ? { ...f, ...updates, id: fieldId } : f));
  return updateForm(formId, { fields });
}

export async function removeField(
  formId: string,
  fieldId: string,
): Promise<LeadForm | undefined> {
  const form = await crmFormsDb.forms.get(formId);
  if (!form) return undefined;
  const fields = form.fields.filter((f) => f.id !== fieldId);
  return updateForm(formId, { fields });
}

export async function reorderFields(
  formId: string,
  orderedFieldIds: string[],
): Promise<LeadForm | undefined> {
  const form = await crmFormsDb.forms.get(formId);
  if (!form) return undefined;
  const byId = new Map(form.fields.map((f) => [f.id, f]));
  const fields = orderedFieldIds
    .map((id, index) => {
      const f = byId.get(id);
      return f ? { ...f, order: index } : undefined;
    })
    .filter((f): f is LeadFormField => f !== undefined);
  return updateForm(formId, { fields });
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export async function listTemplates(): Promise<FormTemplate[]> {
  const templates = await crmFormsDb.formTemplates.toArray();
  return templates.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function createFormFromTemplate(
  templateId: string,
  name: string,
): Promise<LeadForm | undefined> {
  const template = await crmFormsDb.formTemplates.get(templateId);
  if (!template) return undefined;
  const ts = nowIso();
  const form: LeadForm = {
    ...template.schema,
    id: nanoid(10),
    name,
    status: 'draft',
    createdAt: ts,
    updatedAt: ts,
  };
  await crmFormsDb.forms.add(form);
  return form;
}

export async function saveFormAsTemplate(
  formId: string,
  templateName: string,
  description?: string,
): Promise<FormTemplate | undefined> {
  const form = await crmFormsDb.forms.get(formId);
  if (!form) return undefined;
  const ts = nowIso();
  const template: FormTemplate = {
    id: nanoid(10),
    name: templateName,
    description,
    schema: {
      fields: form.fields,
      steps: form.steps,
      logicRules: form.logicRules,
      style: form.style,
      embed: form.embed,
      notificationEmail: form.notificationEmail,
      successMessage: form.successMessage,
    },
    createdAt: ts,
    updatedAt: ts,
  };
  await crmFormsDb.formTemplates.add(template);
  return template;
}

export async function getTemplate(id: string): Promise<FormTemplate | undefined> {
  return crmFormsDb.formTemplates.get(id);
}

export type FormTemplateSchema = FormTemplate['schema'];

export async function updateTemplate(
  id: string,
  updates: {
    name?: string;
    description?: string;
    schema?: Partial<FormTemplateSchema>;
  },
): Promise<FormTemplate | undefined> {
  const existing = await crmFormsDb.formTemplates.get(id);
  if (!existing) return undefined;
  const next: FormTemplate = {
    ...existing,
    name: updates.name ?? existing.name,
    description: updates.description !== undefined ? updates.description : existing.description,
    schema: updates.schema ? { ...existing.schema, ...updates.schema } : existing.schema,
    id,
    updatedAt: nowIso(),
  };
  await crmFormsDb.formTemplates.put(next);
  return next;
}

export async function updateTemplateFromFormPatch(
  id: string,
  updates: Partial<LeadForm>,
): Promise<FormTemplate | undefined> {
  const { name, description, fields, steps, logicRules, style, embed, notificationEmail, successMessage } =
    updates;
  const schema: Partial<FormTemplateSchema> = {};
  if (fields !== undefined) schema.fields = fields;
  if (steps !== undefined) schema.steps = steps;
  if (logicRules !== undefined) schema.logicRules = logicRules;
  if (style !== undefined) schema.style = style;
  if (embed !== undefined) schema.embed = embed;
  if (notificationEmail !== undefined) schema.notificationEmail = notificationEmail;
  if (successMessage !== undefined) schema.successMessage = successMessage;
  return updateTemplate(id, {
    name,
    description,
    schema: Object.keys(schema).length > 0 ? schema : undefined,
  });
}

export async function addTemplateField(
  templateId: string,
  fieldInput: Omit<LeadFormField, 'id' | 'order'> & Partial<Pick<LeadFormField, 'order'>>,
): Promise<FormTemplate | undefined> {
  const template = await crmFormsDb.formTemplates.get(templateId);
  if (!template) return undefined;
  const order = fieldInput.order ?? template.schema.fields.length;
  const newField: LeadFormField = {
    ...fieldInput,
    id: nanoid(8),
    order,
  };
  return updateTemplate(templateId, {
    schema: { fields: [...template.schema.fields, newField] },
  });
}

export async function updateTemplateField(
  templateId: string,
  fieldId: string,
  updates: Partial<LeadFormField>,
): Promise<FormTemplate | undefined> {
  const template = await crmFormsDb.formTemplates.get(templateId);
  if (!template) return undefined;
  const fields = template.schema.fields.map((f) =>
    f.id === fieldId ? { ...f, ...updates, id: fieldId } : f,
  );
  return updateTemplate(templateId, { schema: { fields } });
}

export async function removeTemplateField(
  templateId: string,
  fieldId: string,
): Promise<FormTemplate | undefined> {
  const template = await crmFormsDb.formTemplates.get(templateId);
  if (!template) return undefined;
  const fields = template.schema.fields.filter((f) => f.id !== fieldId);
  return updateTemplate(templateId, { schema: { fields } });
}

export async function reorderTemplateFields(
  templateId: string,
  orderedFieldIds: string[],
): Promise<FormTemplate | undefined> {
  const template = await crmFormsDb.formTemplates.get(templateId);
  if (!template) return undefined;
  const byId = new Map(template.schema.fields.map((f) => [f.id, f]));
  const fields = orderedFieldIds
    .map((id, index) => {
      const f = byId.get(id);
      return f ? { ...f, order: index } : undefined;
    })
    .filter((f): f is LeadFormField => f !== undefined);
  return updateTemplate(templateId, { schema: { fields } });
}

export async function deleteTemplate(id: string): Promise<void> {
  await crmFormsDb.formTemplates.delete(id);
}

// ---------------------------------------------------------------------------
// Submissions
// ---------------------------------------------------------------------------

export async function listSubmissions(): Promise<LeadFormSubmission[]> {
  const all = await crmFormsDb.formSubmissions.toArray();
  return all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function listSubmissionsForForm(
  formId: string,
): Promise<LeadFormSubmission[]> {
  const all = await crmFormsDb.formSubmissions.where('formId').equals(formId).toArray();
  return all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function getSubmission(
  id: string,
): Promise<LeadFormSubmission | undefined> {
  return crmFormsDb.formSubmissions.get(id);
}

export async function setSubmissionStatus(
  id: string,
  status: LeadFormSubmission['status'],
): Promise<LeadFormSubmission | undefined> {
  const existing = await crmFormsDb.formSubmissions.get(id);
  if (!existing) return undefined;
  const next: LeadFormSubmission = { ...existing, id, status };
  await crmFormsDb.formSubmissions.put(next);
  return next;
}

export async function deleteSubmission(id: string): Promise<void> {
  await crmFormsDb.formSubmissions.delete(id);
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

// CRM_FORMS_WEBHOOK_DELIVERY_TODO:
// Webhook settings are stored now, but delivery/retry/logging is deferred.
// Future backend agent must implement signed payloads, timeouts, retries,
// webhook logs, failure states, and test-send action.

export async function listWebhooks(): Promise<WebhookConfig[]> {
  return crmFormsDb.formWebhooks.toArray();
}

export async function listWebhooksForForm(formId: string): Promise<WebhookConfig[]> {
  return crmFormsDb.formWebhooks.where('formId').equals(formId).toArray();
}

export async function createWebhook(
  input: Omit<WebhookConfig, 'id' | 'createdAt' | 'updatedAt'>,
): Promise<WebhookConfig> {
  const ts = nowIso();
  const webhook: WebhookConfig = {
    id: nanoid(10),
    formId: input.formId,
    url: input.url,
    secret: input.secret,
    enabled: input.enabled,
    events: input.events,
    createdAt: ts,
    updatedAt: ts,
  };
  await crmFormsDb.formWebhooks.add(webhook);
  return webhook;
}

export async function updateWebhook(
  id: string,
  updates: Partial<WebhookConfig>,
): Promise<WebhookConfig | undefined> {
  const existing = await crmFormsDb.formWebhooks.get(id);
  if (!existing) return undefined;
  const next: WebhookConfig = { ...existing, ...updates, id, updatedAt: nowIso() };
  await crmFormsDb.formWebhooks.put(next);
  return next;
}

export async function deleteWebhook(id: string): Promise<void> {
  await crmFormsDb.formWebhooks.delete(id);
}

// ---------------------------------------------------------------------------
// CSV export — submissions
// ---------------------------------------------------------------------------

export async function exportSubmissionsToCsv(
  formId?: string,
): Promise<void> {
  const submissions =
    formId != null ? await listSubmissionsForForm(formId) : await listSubmissions();
  const rows = submissions.map((s) => {
    const flat: Record<string, unknown> = {
      id: s.id,
      formId: s.formId,
      status: s.status,
      sourceDomain: s.sourceDomain ?? '',
      spamScore: s.spamScore ?? '',
      leadId: s.leadId ?? '',
      contactId: s.contactId ?? '',
      companyId: s.companyId ?? '',
      createdAt: s.createdAt,
    };
    // Flatten submitted fields under a `field_` prefix so each answer gets a column.
    for (const [key, value] of Object.entries(s.fields)) {
      flat[`field_${key}`] = value;
    }
    // Flatten UTM/hidden capture.
    for (const [key, value] of Object.entries(s.hiddenFields)) {
      flat[`utm_${key}`] = value;
    }
    return flat;
  });
  exportToCsv(
    formId ? `submissions-${formId}` : 'submissions-export',
    rows,
    deriveSubmissionColumns(rows),
  );
}

function deriveSubmissionColumns(rows: Record<string, unknown>[]): string[] {
  const priority = [
    'id',
    'formId',
    'status',
    'sourceDomain',
    'spamScore',
    'leadId',
    'contactId',
    'companyId',
    'createdAt',
  ];
  const seen = new Set<string>(priority);
  const extras: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        extras.push(key);
      }
    }
  }
  return [...priority, ...extras];
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_IFRAME_HEIGHT = 640;
const DEFAULT_PUBLIC_BASE_URL = 'https://tabs.app';

function defaultFields(): LeadFormField[] {
  return [
    { id: nanoid(8), type: 'text', label: 'Full name', name: 'name', order: 0, required: true },
    { id: nanoid(8), type: 'email', label: 'Email', name: 'email', order: 1, required: true },
    { id: nanoid(8), type: 'textarea', label: 'Message', name: 'message', order: 2 },
    { id: nanoid(8), type: 'consent', label: 'I agree to be contacted', name: 'consent', order: 3, required: true },
    { id: nanoid(8), type: 'submit', label: 'Submit', name: 'submit', order: 4 },
  ];
}

function defaultStyle(): LeadForm['style'] {
  return {
    primaryColor: '#4f46e5',
    backgroundColor: '#ffffff',
    textColor: '#111827',
    labelColor: '#374151',
    borderColor: '#d1d5db',
    borderRadius: 8,
    fontFamily: 'Inter, system-ui, sans-serif',
    fontSize: 14,
    buttonStyle: 'solid',
    inputStyle: 'boxed',
    layout: 'single',
    padding: 20,
  };
}

function defaultEmbed(): LeadForm['embed'] {
  return {
    allowedDomains: [],
    defaultMode: 'iframe',
    iframeHeight: DEFAULT_IFRAME_HEIGHT,
    publicBaseUrl: DEFAULT_PUBLIC_BASE_URL,
    showBranding: true,
  };
}

