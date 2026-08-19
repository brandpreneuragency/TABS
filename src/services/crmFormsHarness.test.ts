import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { crmFormsDb } from '../data/crmFormsDb';
import { db } from './db';
import {
  CrmDuplicateError,
  CrmFormsCommandService,
  CrmRevisionConflictError,
  normalizeCompanyDuplicateKey,
  normalizeContactDuplicateKey,
  normalizeLeadDuplicateKey,
} from './crmFormsCommands';
import { clearDomainChangeSubscribersForTests, subscribeToDomainChanges, type DomainChangeEvent } from './domainEvents';
import { blankForm, FormRevisionConflictError, updateFormCommand, validateForm } from './formsService';
import { ingestSubmission } from './submissionService';
import type { AgentOperationReceipt } from '../types/agent';
import type { Task } from '../types';

const op = (id: string, effectFingerprint = `effect:${id}`) => ({ operationId: id, effectFingerprint });

async function resetDatabases(): Promise<void> {
  crmFormsDb.close();
  db.close();
  await indexedDB.deleteDatabase('ZenEditorCRMFormsDB');
  await indexedDB.deleteDatabase('ZenEditorDB');
  await Promise.all([crmFormsDb.open(), db.open()]);
}

beforeEach(async () => {
  clearDomainChangeSubscribersForTests();
  await resetDatabases();
});

afterEach(() => {
  clearDomainChangeSubscribersForTests();
  crmFormsDb.close();
  db.close();
});

describe('CRM and Forms background command safety', () => {
  it('defines deterministic duplicate keys and rejects duplicate creates', async () => {
    expect(normalizeContactDuplicateKey('  PERSON@Example.COM ')).toBe('contact:email:person@example.com');
    expect(normalizeCompanyDuplicateKey('  Acme   Holdings  ')).toBe('company:name:acme holdings');
    expect(normalizeLeadDuplicateKey({ title: ' Any ', sourceSubmissionId: ' sub-1' })).toBe('lead:submission:sub-1');
    expect(normalizeLeadDuplicateKey({ title: '  New   Inquiry ', contactId: 'contact-1' })).toBe('lead:contact:contact-1:title:new inquiry');

    const commands = new CrmFormsCommandService(crmFormsDb, db, () => 1_800_000_000_000);
    await commands.createContact(op('contact-1'), { firstName: 'Ada', lastName: 'Lovelace', email: 'ADA@example.com' });
    await expect(commands.createContact(op('contact-2'), { firstName: 'A.', lastName: 'L.', email: ' ada@EXAMPLE.com ' })).rejects.toBeInstanceOf(CrmDuplicateError);
    expect(await crmFormsDb.crmContacts.count()).toBe(1);
  });

  it('checks expected updatedAt and replays a committed update receipt', async () => {
    let now = 1_800_000_000_000;
    const commands = new CrmFormsCommandService(crmFormsDb, db, () => now++);
    const contact = await commands.createContact(op('create'), { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com' });
    await expect(commands.updateEntity(op('stale'), 'contact', contact.id, '2000-01-01T00:00:00.000Z', { firstName: 'Grace' })).rejects.toBeInstanceOf(CrmRevisionConflictError);
    const updated = await commands.updateEntity(op('update'), 'contact', contact.id, contact.updatedAt, { firstName: 'Grace' });
    const replayed = await commands.updateEntity(op('update'), 'contact', contact.id, contact.updatedAt, { firstName: 'Ignored by replay' });
    expect(replayed).toEqual(updated);
    expect(await crmFormsDb.agentOperationReceipts.where('operationId').equals('update').count()).toBe(1);
  });

  it('rolls back entity and activity when companion receipt persistence fails', async () => {
    const collision: AgentOperationReceipt = {
      id: 'crm-forms-receipt:rollback',
      operationId: 'other-operation',
      effectFingerprint: 'other-effect',
      domain: 'crm-forms',
      resourceKeys: [],
      status: 'committed',
      resultSummary: 'fixture',
      committedAt: 1,
    };
    await crmFormsDb.agentOperationReceipts.add(collision);
    const commands = new CrmFormsCommandService(crmFormsDb, db, () => 1_800_000_000_000);
    await expect(commands.createCompany(op('rollback'), { name: 'Rollback Incorporated' })).rejects.toThrow();
    expect(await crmFormsDb.crmCompanies.count()).toBe(0);
    expect(await crmFormsDb.crmActivities.count()).toBe(0);
  });

  it('ingests submission, CRM links, activities, and receipt in one transaction and replays', async () => {
    const form = blankForm('Contact us');
    await crmFormsDb.forms.add(form);
    const operation = op('submission-ingestion');
    const input = {
      formId: form.id,
      fields: { name: 'Ada Lovelace', email: 'ada@example.com', company: 'Analytical Engines', consent: true },
      hiddenFields: {},
      allowedDomainMatched: true,
    };
    const first = await ingestSubmission(input, operation);
    const second = await ingestSubmission(input, operation);
    expect(second).toEqual(first);
    expect(first.submission).toMatchObject({ leadId: first.leadId, contactId: first.contactId, companyId: first.companyId });
    expect(await crmFormsDb.formSubmissions.count()).toBe(1);
    expect(await crmFormsDb.crmContacts.count()).toBe(1);
    expect(await crmFormsDb.crmCompanies.count()).toBe(1);
    expect(await crmFormsDb.crmLeads.count()).toBe(1);
    expect(await crmFormsDb.agentOperationReceipts.where('operationId').equals(operation.operationId).count()).toBe(1);
  });

  it('centralizes field, step, logic, options, range, and pattern validation', () => {
    const form = blankForm('Invalid');
    form.fields.push({ id: form.fields[0].id, type: 'select', label: 'Bad', name: ' EMAIL ', order: -1, stepId: 'missing', validation: { min: 10, max: 1, pattern: '[' } });
    form.logicRules.push({ id: 'rule', type: 'show_field', triggerFieldId: 'missing', operator: 'eq', targetFieldIds: ['also-missing'], enabled: true });
    form.steps[0].showWhenRuleId = 'missing-rule';
    const result = validateForm(form);
    expect(result.valid).toBe(false);
    expect(new Set(result.issues.map((issue) => issue.code))).toEqual(new Set(['duplicate_id', 'duplicate_name', 'invalid_order', 'missing_step', 'missing_options', 'invalid_range', 'invalid_pattern', 'missing_reference']));
  });

  it('commits form receipt before emitting one change event and rejects stale form updates', async () => {
    const form = blankForm('Safe');
    await crmFormsDb.forms.add(form);
    const events: DomainChangeEvent[] = [];
    const unsubscribe = subscribeToDomainChanges((event) => events.push(event));
    const first = await updateFormCommand(op('form-update'), form.id, form.updatedAt, { name: 'Updated' });
    const replay = await updateFormCommand(op('form-update'), form.id, form.updatedAt, { name: 'Updated' });
    expect(replay.replayed).toBe(true);
    expect(first.form.name).toBe('Updated');
    expect(events).toHaveLength(1);
    await expect(updateFormCommand(op('form-stale'), form.id, form.updatedAt, { name: 'Stale' })).rejects.toBeInstanceOf(FormRevisionConflictError);
    unsubscribe();
  });

  it('emits CRM projections only after the receipt is committed', async () => {
    const events: DomainChangeEvent[] = [];
    subscribeToDomainChanges((event) => events.push(event));
    const commands = new CrmFormsCommandService(crmFormsDb, db, () => 1_800_000_000_000);
    await commands.createCompany(op('event-company'), { name: 'Event Company' });
    expect(await crmFormsDb.agentOperationReceipts.where('operationId').equals('event-company').count()).toBe(1);
    expect(events).toMatchObject([{ entityType: 'company', operation: 'created', operationId: 'event-company' }]);
  });

  it('recovers the task-link saga by replaying the companion receipt and reports orphan links', async () => {
    const task: Task = { id: 'task-1', title: 'Follow up', content: '', status: 'pending', importance: 'medium', date: '2026-08-19', projectId: null, assignees: [], createdAt: 1, updatedAt: 1, order: 0 };
    await db.tasks.add(task);
    let now = 1_800_000_000_000;
    const commands = new CrmFormsCommandService(crmFormsDb, db, () => now++);
    const contact = await commands.createContact(op('saga-contact'), { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com' });
    const operation = op('saga-link');
    const first = await commands.createTaskLink(operation, task.id, 'contact', contact.id, contact.updatedAt);
    const replay = await commands.createTaskLink(operation, task.id, 'contact', contact.id, contact.updatedAt);
    expect(replay).toEqual(first);
    expect(await crmFormsDb.crmTaskLinks.count()).toBe(1);
    expect(await commands.reconcileTaskLinks()).toEqual([]);
    await db.tasks.delete(task.id);
    expect(await commands.reconcileTaskLinks()).toEqual([first]);
  });
});
