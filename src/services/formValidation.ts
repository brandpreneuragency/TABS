import type { LeadForm, LeadFormField } from '../types/forms';

export interface FormValidationIssue {
  path: string;
  code:
    | 'duplicate_id'
    | 'duplicate_name'
    | 'invalid_order'
    | 'missing_step'
    | 'missing_reference'
    | 'invalid_range'
    | 'invalid_pattern'
    | 'missing_options';
  message: string;
}

export interface FormValidationResult {
  valid: boolean;
  issues: FormValidationIssue[];
}

function duplicateValues(values: string[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  values.forEach((value) => {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  });
  return duplicates;
}

function validateField(field: LeadFormField, index: number, stepIds: Set<string>): FormValidationIssue[] {
  const issues: FormValidationIssue[] = [];
  const path = `fields[${index}]`;
  if (!Number.isInteger(field.order) || field.order < 0) {
    issues.push({ path: `${path}.order`, code: 'invalid_order', message: 'Field order must be a non-negative integer.' });
  }
  if (field.stepId && !stepIds.has(field.stepId)) {
    issues.push({ path: `${path}.stepId`, code: 'missing_step', message: 'Field stepId must reference an existing step.' });
  }
  if ((field.type === 'select' || field.type === 'radio') && (!field.options || field.options.length === 0)) {
    issues.push({ path: `${path}.options`, code: 'missing_options', message: 'Select and radio fields require options.' });
  }
  const validation = field.validation;
  if (validation?.minLength !== undefined && validation.maxLength !== undefined && validation.minLength > validation.maxLength) {
    issues.push({ path: `${path}.validation`, code: 'invalid_range', message: 'minLength cannot exceed maxLength.' });
  }
  if (validation?.min !== undefined && validation.max !== undefined && validation.min > validation.max) {
    issues.push({ path: `${path}.validation`, code: 'invalid_range', message: 'min cannot exceed max.' });
  }
  if (validation?.pattern !== undefined) {
    try {
      new RegExp(validation.pattern);
    } catch {
      issues.push({ path: `${path}.validation.pattern`, code: 'invalid_pattern', message: 'Pattern must be a valid regular expression.' });
    }
  }
  return issues;
}

/** Canonical field, step, and logic-reference validation used by stores and agent reads. */
export function validateForm(form: Pick<LeadForm, 'fields' | 'steps' | 'logicRules'>): FormValidationResult {
  const issues: FormValidationIssue[] = [];
  const fieldIds = new Set(form.fields.map((field) => field.id));
  const stepIds = new Set(form.steps.map((step) => step.id));
  const ruleIds = new Set(form.logicRules.map((rule) => rule.id));

  duplicateValues(form.fields.map((field) => field.id)).forEach((id) =>
    issues.push({ path: 'fields', code: 'duplicate_id', message: `Duplicate field id: ${id}.` }),
  );
  duplicateValues(form.fields.map((field) => field.name.trim().toLowerCase())).forEach((name) =>
    issues.push({ path: 'fields', code: 'duplicate_name', message: `Duplicate field name: ${name}.` }),
  );
  duplicateValues(form.steps.map((step) => step.id)).forEach((id) =>
    issues.push({ path: 'steps', code: 'duplicate_id', message: `Duplicate step id: ${id}.` }),
  );
  duplicateValues(form.logicRules.map((rule) => rule.id)).forEach((id) =>
    issues.push({ path: 'logicRules', code: 'duplicate_id', message: `Duplicate logic rule id: ${id}.` }),
  );

  form.fields.forEach((field, index) => issues.push(...validateField(field, index, stepIds)));
  form.steps.forEach((step, index) => {
    if (!Number.isInteger(step.order) || step.order < 0) {
      issues.push({ path: `steps[${index}].order`, code: 'invalid_order', message: 'Step order must be a non-negative integer.' });
    }
    if (step.showWhenRuleId && !ruleIds.has(step.showWhenRuleId)) {
      issues.push({ path: `steps[${index}].showWhenRuleId`, code: 'missing_reference', message: 'Step rule must exist.' });
    }
  });
  form.logicRules.forEach((rule, index) => {
    if (!fieldIds.has(rule.triggerFieldId)) {
      issues.push({ path: `logicRules[${index}].triggerFieldId`, code: 'missing_reference', message: 'Trigger field must exist.' });
    }
    rule.targetFieldIds?.forEach((id) => {
      if (!fieldIds.has(id)) issues.push({ path: `logicRules[${index}].targetFieldIds`, code: 'missing_reference', message: `Target field ${id} must exist.` });
    });
    if (rule.targetStepId && !stepIds.has(rule.targetStepId)) {
      issues.push({ path: `logicRules[${index}].targetStepId`, code: 'missing_reference', message: 'Target step must exist.' });
    }
  });

  return { valid: issues.length === 0, issues };
}
