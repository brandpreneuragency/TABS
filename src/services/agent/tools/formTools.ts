// ---------------------------------------------------------------------------
// TABS Work-OS Harness — Form and submission read tools
// Form builder mutation / publish / delete stay outside the first release.
// ---------------------------------------------------------------------------

import type { LeadForm, LeadFormSubmission } from '../../../types/forms';
import type { AgentToolDefinition, AgentToolResult, ToolExecutionContext } from '../../../types/agent';
import type { FormValidationResult } from '../../formValidation';
import {
  asRecord,
  type ArtifactSink,
  defineReadTool,
  entityReadSchema,
  fail,
  FORM_READ_TOOL_NAMES,
  listInputSchema,
  normalizeListLimit,
  ok,
  paginateList,
  resolveFrozenId,
  sourceRef,
  spillIfLarge,
  staleIfMismatch,
} from './readSupport';

export { FORM_READ_TOOL_NAMES };

export interface FormReadPort {
  listForms(): Promise<LeadForm[]>;
  getForm(id: string): Promise<LeadForm | undefined>;
  validateForm(form: LeadForm): FormValidationResult;
  listSubmissions(formId?: string): Promise<LeadFormSubmission[]>;
  getSubmission(id: string): Promise<LeadFormSubmission | undefined>;
}

export interface FormReadToolDependencies {
  forms?: FormReadPort;
  putArtifact?: ArtifactSink;
}

const FORM_STATUSES = ['draft', 'published', 'archived'] as const;
const SUBMISSION_STATUSES = ['new', 'converted', 'spam'] as const;

function formFilters(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      query: { type: 'string' },
      status: { type: 'string', enum: [...FORM_STATUSES] },
    },
  };
}

function submissionFilters(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      formId: { type: 'string', minLength: 1 },
      status: { type: 'string', enum: [...SUBMISSION_STATUSES] },
      query: { type: 'string' },
    },
  };
}

async function defaultFormPort(): Promise<FormReadPort> {
  const forms = await import('../../formsService');
  return {
    listForms: () => forms.listForms(),
    getForm: (id) => forms.getForm(id),
    validateForm: (form) => forms.validateForm(form),
    async listSubmissions(formId) {
      return formId ? forms.listSubmissionsForForm(formId) : forms.listSubmissions();
    },
    getSubmission: (id) => forms.getSubmission(id),
  };
}

let cachedDefault: FormReadPort | undefined;

async function formPort(override?: FormReadPort): Promise<FormReadPort> {
  if (override) return override;
  cachedDefault ??= await defaultFormPort();
  return cachedDefault;
}

function formSummary(form: LeadForm) {
  return {
    ...sourceRef('form', form.id, form.updatedAt),
    id: form.id,
    name: form.name,
    status: form.status,
    fieldCount: form.fields.length,
    updatedAt: form.updatedAt,
  };
}

function submissionSummary(submission: LeadFormSubmission) {
  return {
    ...sourceRef('submission', submission.id, submission.createdAt),
    id: submission.id,
    formId: submission.formId,
    status: submission.status,
    sourceDomain: submission.sourceDomain ?? null,
    leadId: submission.leadId ?? null,
    contactId: submission.contactId ?? null,
    companyId: submission.companyId ?? null,
    createdAt: submission.createdAt,
  };
}

export function createFormReadTools(deps: FormReadToolDependencies = {}): AgentToolDefinition[] {
  const putArtifact = deps.putArtifact;

  const formList = defineReadTool({
    name: 'form_list',
    description: 'List forms with safe metadata.',
    inputSchema: listInputSchema(formFilters()),
    resolveResourceKeys: () => ['form'],
    async execute(_context: ToolExecutionContext, args: unknown): Promise<AgentToolResult> {
      const record = asRecord(args);
      const filters = asRecord(record.filters);
      const query = typeof filters.query === 'string' ? filters.query.trim().toLowerCase() : '';
      try {
        const port = await formPort(deps.forms);
        let forms = await port.listForms();
        if (typeof filters.status === 'string') {
          forms = forms.filter((form) => form.status === filters.status);
        }
        if (query) {
          forms = forms.filter((form) => form.name.toLowerCase().includes(query) || form.id.includes(query));
        }
        const page = paginateList(forms, record.cursor, normalizeListLimit(record.limit));
        return ok(`Listed ${page.count} of ${page.total} forms`, {
          items: page.items.map(formSummary),
          nextCursor: page.nextCursor,
          truncated: page.truncated,
          total: page.total,
        });
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : 'Form list failed';
        return fail('internal_error', message);
      }
    },
  });

  const formGet = defineReadTool({
    name: 'form_get',
    description: 'Read a form schema and revision.',
    inputSchema: entityReadSchema(),
    resolveResourceKeys: (_context, args) => [`form:${asRecord(args).id}`],
    async execute(context: ToolExecutionContext, args: unknown): Promise<AgentToolResult> {
      const record = asRecord(args);
      const id = String(record.id);
      const frozen = resolveFrozenId(context, 'form', id);
      try {
        const port = await formPort(deps.forms);
        const form = await port.getForm(id);
        if (!form) return fail('not_found', `Form ${id} was not found.`);
        const stale = staleIfMismatch(
          typeof record.revision === 'string' ? record.revision : frozen?.revision,
          form.updatedAt,
          `Form ${id}`,
        );
        if (stale) return { ...stale, observedRevision: form.updatedAt };
        const payload = {
          ...sourceRef('form', form.id, form.updatedAt),
          id: form.id,
          name: form.name,
          status: form.status,
          description: form.description,
          fields: form.fields,
          steps: form.steps,
          logicRules: form.logicRules,
          successMessage: form.successMessage,
          updatedAt: form.updatedAt,
        };
        const bounded = await spillIfLarge(context.runId, `form:${form.id}`, payload, putArtifact);
        return ok(`Read form ${form.name}`, bounded.data, {
          observedRevision: form.updatedAt,
          artifacts: bounded.artifacts,
        });
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : 'Form read failed';
        return fail('internal_error', message);
      }
    },
  });

  const formValidate = defineReadTool({
    name: 'form_validate',
    description: 'Validate form fields, steps, and logic references.',
    inputSchema: entityReadSchema(),
    resolveResourceKeys: (_context, args) => [`form:${asRecord(args).id}`],
    async execute(context: ToolExecutionContext, args: unknown): Promise<AgentToolResult> {
      const record = asRecord(args);
      const id = String(record.id);
      const frozen = resolveFrozenId(context, 'form', id);
      try {
        const port = await formPort(deps.forms);
        const form = await port.getForm(id);
        if (!form) return fail('not_found', `Form ${id} was not found.`);
        const stale = staleIfMismatch(
          typeof record.revision === 'string' ? record.revision : frozen?.revision,
          form.updatedAt,
          `Form ${id}`,
        );
        if (stale) return { ...stale, observedRevision: form.updatedAt };
        const validation = port.validateForm(form);
        return ok(
          validation.valid ? `Form ${form.name} is valid` : `Form ${form.name} has ${validation.issues.length} issues`,
          {
            ...sourceRef('form', form.id, form.updatedAt),
            id: form.id,
            valid: validation.valid,
            issues: validation.issues,
          },
          { observedRevision: form.updatedAt },
        );
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : 'Form validation failed';
        return fail('internal_error', message);
      }
    },
  });

  const submissionList = defineReadTool({
    name: 'submission_list',
    description: 'Query form submissions with bounded filters.',
    inputSchema: listInputSchema(submissionFilters()),
    resolveResourceKeys: (_context, args) => {
      const filters = asRecord(asRecord(args).filters);
      if (typeof filters.formId === 'string') return [`form:${filters.formId}:submissions`];
      return ['submission'];
    },
    async execute(context: ToolExecutionContext, args: unknown): Promise<AgentToolResult> {
      const record = asRecord(args);
      const filters = asRecord(record.filters);
      const frozenSubmission = resolveFrozenId(context, 'submission');
      const formId = typeof filters.formId === 'string'
        ? filters.formId
        : resolveFrozenId(context, 'form')?.id;
      try {
        const port = await formPort(deps.forms);
        let submissions = await port.listSubmissions(formId);
        if (typeof filters.status === 'string') {
          submissions = submissions.filter((submission) => submission.status === filters.status);
        }
        const query = typeof filters.query === 'string' ? filters.query.trim().toLowerCase() : '';
        if (query) {
          submissions = submissions.filter((submission) => (
            submission.id.includes(query)
            || submission.formId.includes(query)
            || JSON.stringify(submission.fields).toLowerCase().includes(query)
          ));
        }
        const page = paginateList(submissions, record.cursor, normalizeListLimit(record.limit));
        return ok(`Listed ${page.count} of ${page.total} submissions`, {
          items: page.items.map(submissionSummary),
          nextCursor: page.nextCursor,
          truncated: page.truncated,
          total: page.total,
          focusedSubmissionId: frozenSubmission?.id ?? null,
        });
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : 'Submission list failed';
        return fail('internal_error', message);
      }
    },
  });

  const submissionGet = defineReadTool({
    name: 'submission_get',
    description: 'Read one submission and its source metadata. Read-only.',
    inputSchema: entityReadSchema(),
    resolveResourceKeys: (_context, args) => [`submission:${asRecord(args).id}`],
    async execute(context: ToolExecutionContext, args: unknown): Promise<AgentToolResult> {
      const record = asRecord(args);
      const id = String(record.id);
      const frozen = resolveFrozenId(context, 'submission', id);
      try {
        const port = await formPort(deps.forms);
        const submission = await port.getSubmission(id);
        if (!submission) return fail('not_found', `Submission ${id} was not found.`);
        const revision = submission.createdAt;
        const stale = staleIfMismatch(
          typeof record.revision === 'string' ? record.revision : frozen?.revision,
          revision,
          `Submission ${id}`,
        );
        if (stale) return { ...stale, observedRevision: revision };
        const payload = {
          ...submissionSummary(submission),
          fields: submission.fields,
          hiddenFields: submission.hiddenFields,
          honeypot: undefined,
          spamScore: submission.spamScore,
          allowedDomainMatched: submission.allowedDomainMatched,
        };
        const bounded = await spillIfLarge(context.runId, `submission:${id}`, payload, putArtifact);
        return ok(`Read submission ${id}`, bounded.data, {
          observedRevision: revision,
          artifacts: bounded.artifacts,
        });
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : 'Submission read failed';
        return fail('internal_error', message);
      }
    },
  });

  return [formList, formGet, formValidate, submissionList, submissionGet];
}
