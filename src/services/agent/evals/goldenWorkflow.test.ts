import { describe, expect, it } from 'vitest';
import { containsSecret, redactSecrets, redactStructuredValue } from '../redaction';
import {
  EXPECTED_MUTATIONS,
  FAKE_SECRET,
  FAULT_POINTS,
  assertNoSecret,
  createGoldenHarness,
  emptySinks,
  evalLogger,
  formatUiError,
  putEvalArtifact,
  resetGoldenFixture,
  runWithRestart,
  type FaultPoint,
  type MutationCounts,
} from './goldenFixtures';

function oneExpectedSet(): MutationCounts {
  return {
    crm_entity_update: 1,
    crm_note_add: 1,
    task_create: 1,
    crm_task_link_create: 1,
    document_create: 1,
  };
}

function noneExpected(): MutationCounts {
  return {
    crm_entity_update: 0,
    crm_note_add: 0,
    task_create: 0,
    crm_task_link_create: 0,
    document_create: 0,
  };
}

describe('golden submission follow-up workflow', () => {
  it('starts every isolated run from the same reset fixture with authoritative CRM links', () => {
    const first = resetGoldenFixture();
    const second = resetGoldenFixture();
    expect(first.submission.contactId).toBe('contact-ada');
    expect(first.submission.leadId).toBe('lead-inquiry');
    expect(first.submission.companyId).toBe('company-ae');
    expect(first.submission.status).toBe('new');
    expect(second.submission).toEqual(first.submission);
    expect(second.contact).toEqual(first.contact);
    expect(second.lead).toEqual(first.lead);
    expect(first.notes).toEqual([]);
    expect(first.tasks).toEqual([]);
    expect(first.taskLinks).toEqual([]);
    expect(first.documents).toEqual([]);
  });

  it.each(FAULT_POINTS)(
    'isolated golden run injects duplicate delivery and %s yet produces one mutation set',
    async (faultPoint: FaultPoint) => {
      const world = resetGoldenFixture();
      const harness = await createGoldenHarness({ world, faultPoint, mode: 'delegated' });
      const finished = await runWithRestart(harness);

      expect(finished.status).toBe('completed');
      expect(world.duplicateDelivered).toBe(true);
      expect(world.faultFired).toBe(true);
      expect(world.counts).toEqual(oneExpectedSet());
      expect(world.notes).toHaveLength(1);
      expect(world.tasks).toHaveLength(1);
      expect(world.taskLinks).toHaveLength(1);
      expect(world.documents).toHaveLength(1);
      expect(world.contact.jobTitle).toBe('Analyst');
      expect(finished.finalSummary).toContain(world.contact.id);
      expect(finished.finalSummary).toContain(world.tasks[0]?.id);
      expect(finished.finalSummary).toContain(world.documents[0]?.id);
      expect(EXPECTED_MUTATIONS).toEqual([
        'crm_entity_update',
        'crm_note_add',
        'task_create',
        'crm_task_link_create',
        'document_create',
      ]);
    },
  );

  it('stops a spam submission before CRM, task, or document mutations', async () => {
    const world = resetGoldenFixture('spam');
    const harness = await createGoldenHarness({ world, mode: 'delegated' });
    const finished = await runWithRestart(harness);
    expect(finished.status).toBe('completed');
    expect(world.counts).toEqual(noneExpected());
    expect(world.notes).toHaveLength(0);
    expect(world.tasks).toHaveLength(0);
    expect(world.taskLinks).toHaveLength(0);
    expect(world.documents).toHaveLength(0);
    expect(finished.finalSummary).toMatch(/spam/i);
  });

  it('produces no mutations when mutation tools are denied', async () => {
    const world = resetGoldenFixture();
    const harness = await createGoldenHarness({ world, mode: 'read_only' });
    const finished = await runWithRestart(harness);
    expect(finished.status).toBe('completed');
    expect(world.counts).toEqual(noneExpected());
    expect(world.notes).toHaveLength(0);
    expect(world.tasks).toHaveLength(0);
    expect(world.taskLinks).toHaveLength(0);
    expect(world.documents).toHaveLength(0);
  });
});

describe('redaction sinks', () => {
  it('redacts fake secrets across provider bodies, events, messages, tool results, artifacts, logs, and UI errors', async () => {
    const sinks = emptySinks();
    const payload = {
      note: `api key material ${FAKE_SECRET}`,
      nested: { token: FAKE_SECRET },
    };

    sinks.providerBodies.push(redactStructuredValue({ messages: [{ role: 'user', content: FAKE_SECRET }] }));
    sinks.events.push(redactStructuredValue({ type: 'run.failed', data: payload }));
    sinks.messages.push(redactStructuredValue({ role: 'assistant', content: `error ${FAKE_SECRET}` }));
    sinks.toolResults.push(redactSecrets(JSON.stringify({ ok: false, summary: FAKE_SECRET })));
    putEvalArtifact(sinks, `artifact body ${FAKE_SECRET}`);
    evalLogger(sinks, `logger call ${FAKE_SECRET}`);
    formatUiError(sinks, new Error(`User-visible runtime error ${FAKE_SECRET}`));

    for (const value of [
      ...sinks.providerBodies,
      ...sinks.events,
      ...sinks.messages,
      ...sinks.toolResults,
      ...sinks.artifacts,
      ...sinks.logger,
      ...sinks.uiErrors,
    ]) {
      assertNoSecret(value);
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      expect(containsSecret(text) && text.includes(FAKE_SECRET)).toBe(false);
      expect(text).not.toContain(FAKE_SECRET);
    }
    expect(JSON.stringify(sinks.logger)).toContain('[REDACTED_KEY]');
    expect(JSON.stringify(sinks.uiErrors)).toContain('[REDACTED_KEY]');
  });

  it('redacts a secret that enters the live golden run sinks', async () => {
    const world = resetGoldenFixture();
    const harness = await createGoldenHarness({
      world,
      mode: 'delegated',
      goal: `Review submission ${world.submission.id}. Credential fixture ${FAKE_SECRET}`,
    });
    evalLogger(harness.sinks, `starting eval ${FAKE_SECRET}`);
    putEvalArtifact(harness.sinks, `provider body copy ${FAKE_SECRET}`);
    formatUiError(harness.sinks, new Error(`sidebar error ${FAKE_SECRET}`));
    const finished = await runWithRestart(harness);
    expect(finished.status).toBe('completed');

    const captured = [
      ...harness.sinks.providerBodies,
      ...harness.sinks.events,
      ...harness.sinks.messages,
      ...harness.sinks.toolResults,
      ...harness.sinks.artifacts,
      ...harness.sinks.logger,
      ...harness.sinks.uiErrors,
      finished.finalSummary ?? '',
    ];
    for (const value of captured) {
      assertNoSecret(value);
    }
    expect(JSON.stringify(harness.sinks.providerBodies)).not.toContain(FAKE_SECRET);
  });
});
