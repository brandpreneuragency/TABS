import { describe, expect, it } from 'vitest';
import type { AgentMessage, AgentProfileSnapshot } from '../../types/agent';
import { buildQueuedAgentRun } from './buildQueuedAgentRun';
import { compileContextMessages, CONTEXT_USAGE_LIMIT, estimateUtf8Tokens } from './contextManager';
import {
  boundArtifactSection,
  buildCompactionRecord,
  compactConversation,
  compactUntilWithinBudget,
  compileInstructions,
  compileRunInstructions,
  COMPACTION_VERSION,
  getInitialProfile,
  hashInstructionSource,
  INITIAL_AGENT_PROFILES,
  isLegacyInstructionFile,
  loadWorkspaceAgentsMd,
  PROMPT_COMPILER_VERSION,
  PROMPT_ORDER,
  REQUEST_BUDGET_SHARE,
  reportRequestUsage,
  requestBudgetTokens,
  resumeFromCompaction,
  snapshotAgentProfile,
  TABS_SAFETY_INSTRUCTIONS,
  UTF8_TOKEN_DIVISOR,
} from './promptCompiler';
import {
  loadSelectedSkills,
  SkillLoadError,
  type SkillFileAccess,
  type SkillFileEntry,
} from './skillLoader';

class MemoryFs implements SkillFileAccess {
  readonly files: Map<string, string>;

  constructor(files: Map<string, string>) {
    this.files = files;
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async readText(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`missing ${path}`);
    return content;
  }

  async readDir(path: string): Promise<SkillFileEntry[]> {
    const prefix = path.replace(/\/+$/, '') + '/';
    const seen = new Map<string, SkillFileEntry>();
    const names = Array.from(this.files.keys());
    for (let index = 0; index < names.length; index++) {
      const key = names[index];
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const [name, ...nested] = rest.split('/');
      if (!name || seen.has(name)) continue;
      seen.set(name, { name, kind: nested.length > 0 ? 'directory' : 'file' });
    }
    return Array.from(seen.values());
  }
}

const SECRET = 'sk-abcdefghijklmnopqrstuvwxyz1234';

function profile(name = 'General Operator'): AgentProfileSnapshot {
  return snapshotAgentProfile(name);
}

function compileFixture(overrides: Partial<Parameters<typeof compileInstructions>[0]> = {}) {
  return compileInstructions({
    goal: 'Follow up the new lead',
    mode: 'guided',
    policy: { revision: 2, mode: 'guided', rulesHash: 'policy-rev-2' },
    profile: profile(),
    contextRefs: [{ kind: 'crm', id: 'lead-1', label: 'Ada', revision: 'rev-9' }],
    allowedTools: ['crm_entity_get', 'task_create'],
    remainingTurns: 12,
    remainingDurationMs: 60_000,
    ...overrides,
  });
}

function message(
  index: number,
  role: AgentMessage['role'],
  content: string,
  extras: Partial<AgentMessage> = {},
): AgentMessage {
  return {
    id: `m-${index}`,
    runId: 'run-1',
    messageIndex: index,
    turn: extras.turn ?? 0,
    role,
    content,
    state: extras.state ?? 'complete',
    streamVersion: 0,
    createdAt: extras.createdAt ?? index,
    ...extras,
  };
}

describe('prompt order and profiles', () => {
  it('uses the exact eight-level instruction order', () => {
    expect(PROMPT_ORDER).toEqual([
      'immutable_safety',
      'frozen_policy',
      'global_user',
      'workspace_agents_md',
      'agent_profile',
      'skill_instructions',
      'run_goal',
      'context_reference_summary',
    ]);
    const compiled = compileFixture({
      globalInstructions: 'Be terse.',
      workspaceAgentsMd: 'Workspace prefers short notes.',
    });
    const ids = compiled.layers.map((layer) => layer.id);
    expect(ids).toEqual([...PROMPT_ORDER]);
    const positions = PROMPT_ORDER.map((id) => compiled.compiledContent.indexOf(` ${id}`));
    for (let index = 1; index < positions.length; index++) {
      expect(positions[index]).toBeGreaterThan(positions[index - 1]);
    }
    expect(compiled.compiledContent).toContain('higher items win');
    expect(compiled.compiledContent.indexOf(TABS_SAFETY_INSTRUCTIONS.slice(0, 24)))
      .toBeLessThan(compiled.compiledContent.indexOf('Profile: General Operator'));
  });

  it('exposes the six initial profiles', () => {
    expect(INITIAL_AGENT_PROFILES.map((item) => item.name)).toEqual([
      'General Operator',
      'Follow-up Operator',
      'Task Planner',
      'Document Editor',
      'CRM Analyst',
      'Repository Assistant',
    ]);
    expect(getInitialProfile('crm-analyst').defaultMode).toBe('read_only');
    expect(getInitialProfile('unknown').name).toBe('General Operator');
  });
});

describe('instruction snapshots', () => {
  it('snapshots compiled content and source hashes at run creation', () => {
    const first = compileFixture({ workspaceAgentsMd: 'Keep the vault tidy.' });
    const second = compileFixture({ workspaceAgentsMd: 'Keep the vault tidy.' });
    expect(first.snapshot.compiledContent).toBe(second.snapshot.compiledContent);
    expect(first.snapshot.compiledContentHash).toBe(second.snapshot.compiledContentHash);
    expect(first.snapshot.safetyInstructionsHash).toBe(hashInstructionSource(TABS_SAFETY_INSTRUCTIONS));
    expect(first.snapshot.workspaceInstructionsHash).toBe(first.layers[3].hash);
    expect(first.snapshot.profileHash).toBe(first.layers[4].hash);

    const later = compileFixture({ workspaceAgentsMd: 'Changed after start.' });
    expect(later.snapshot.compiledContentHash).not.toBe(first.snapshot.compiledContentHash);
    expect(first.snapshot.compiledContent).toContain('Keep the vault tidy.');
    expect(first.snapshot.compiledContent).not.toContain('Changed after start.');
  });

  it('freezes compiled instructions on queued run creation', () => {
    const run = buildQueuedAgentRun({
      goal: 'Draft the follow-up note',
      mode: 'guided',
      profileName: 'Follow-up Operator',
      providerId: 'p1',
      modelId: 'm1',
      contextRefs: [{ kind: 'form', id: 'form-1', label: 'Intake' }],
    });
    expect(run.profileSnapshot.name).toBe('Follow-up Operator');
    expect(run.instructionSnapshot.compiledContent).toContain('immutable_safety');
    expect(run.instructionSnapshot.compiledContent).toContain('Draft the follow-up note');
    expect(run.instructionSnapshot.compiledContentHash).not.toBe('pending');
    expect(run.instructionSnapshot.compiledContentHash).toBe(
      hashInstructionSource(run.instructionSnapshot.compiledContent),
    );
  });
});

describe('workspace instructions and skills', () => {
  it('loads root AGENTS.md and ignores legacy writer/task files', async () => {
    const fs = new MemoryFs(new Map([
      ['/ws/AGENTS.md', 'Use local CRM tools first.'],
      ['/ws/.tabs/writerinstructions.md', 'LEGACY_WRITER_SHOULD_NOT_LOAD'],
      ['/ws/.tabs/taskinstructions.md', 'LEGACY_TASK_SHOULD_NOT_LOAD'],
    ]));
    const reads: string[] = [];
    const tracking: SkillFileAccess = {
      exists: (path) => fs.exists(path),
      readDir: (path) => fs.readDir(path),
      readText: async (path) => {
        reads.push(path);
        return fs.readText(path);
      },
    };
    const loaded = await loadWorkspaceAgentsMd('/ws', tracking);
    const compiled = await compileRunInstructions({
      goal: 'Review the workspace',
      mode: 'read_only',
      policy: { revision: 1, mode: 'read_only', rulesHash: 'r' },
      profile: profile('CRM Analyst'),
      workspaceRoot: '/ws',
      fs: tracking,
    });
    expect(loaded).toBe('Use local CRM tools first.');
    expect(compiled.compiledContent).toContain('Use local CRM tools first.');
    expect(compiled.compiledContent).not.toContain('LEGACY_WRITER_SHOULD_NOT_LOAD');
    expect(compiled.compiledContent).not.toContain('LEGACY_TASK_SHOULD_NOT_LOAD');
    expect(reads.every((path) => !path.includes('writerinstructions') && !path.includes('taskinstructions'))).toBe(true);
    expect(isLegacyInstructionFile('.tabs/writerinstructions.md')).toBe(true);
    expect(isLegacyInstructionFile('AGENTS.md')).toBe(false);
  });

  it('loads selected skills with references and never executes skill code', async () => {
    const fs = new MemoryFs(new Map([
      ['/ws/.tabs/skills/follow-up/skill.json', JSON.stringify({
        name: 'follow-up',
        version: '1.0.0',
        description: 'Follow up a lead',
        requiredTools: ['crm_entity_get'],
      })],
      ['/ws/.tabs/skills/follow-up/SKILL.md', 'Write a concise follow-up note.'],
      ['/ws/.tabs/skills/follow-up/references/tone.md', 'Keep the tone warm.'],
      ['/ws/.tabs/skills/follow-up/run.js', 'globalThis.__tabsSkillExecuted = true;'],
    ]));
    const skills = await loadSelectedSkills({
      workspaceRoot: '/ws',
      skillNames: ['follow-up'],
      availableTools: ['crm_entity_get', 'task_create'],
      fs,
    });
    expect(skills).toHaveLength(1);
    expect(skills[0].instructions).toContain('concise follow-up');
    expect(skills[0].references).toEqual([
      { path: 'references/tone.md', content: 'Keep the tone warm.' },
    ]);
    expect((globalThis as { __tabsSkillExecuted?: boolean }).__tabsSkillExecuted).toBeUndefined();
    const compiled = compileFixture({ skills });
    expect(compiled.compiledContent).toContain('Keep the tone warm.');
    expect(compiled.snapshot.skillHashes).toEqual([skills[0].sourceHash]);
  });

  it('rejects missing, invalid, executable, and unmet skill packages', async () => {
    const fs = new MemoryFs(new Map([
      ['/ws/.tabs/skills/broken/skill.json', '{not-json'],
      ['/ws/.tabs/skills/broken/SKILL.md', 'ok'],
      ['/ws/.tabs/skills/no-md/skill.json', JSON.stringify({ name: 'no-md', version: '1' })],
      ['/ws/.tabs/skills/codey/skill.json', JSON.stringify({
        name: 'codey',
        version: '1.0.0',
        execute: 'node index.js',
      })],
      ['/ws/.tabs/skills/codey/SKILL.md', 'no'],
      ['/ws/.tabs/skills/needs-shell/skill.json', JSON.stringify({
        name: 'needs-shell',
        version: '1.0.0',
        requiredTools: ['shell_exec'],
      })],
      ['/ws/.tabs/skills/needs-shell/SKILL.md', 'run shell'],
    ]));

    await expect(loadSelectedSkills({
      workspaceRoot: '/ws',
      skillNames: ['missing'],
      availableTools: [],
      fs,
    })).rejects.toMatchObject({ code: 'missing_manifest' } satisfies Partial<SkillLoadError>);

    await expect(loadSelectedSkills({
      workspaceRoot: '/ws',
      skillNames: ['no-md'],
      availableTools: [],
      fs,
    })).rejects.toMatchObject({ code: 'missing_instructions' });

    await expect(loadSelectedSkills({
      workspaceRoot: '/ws',
      skillNames: ['broken'],
      availableTools: [],
      fs,
    })).rejects.toMatchObject({ code: 'invalid_manifest' });

    await expect(loadSelectedSkills({
      workspaceRoot: '/ws',
      skillNames: ['codey'],
      availableTools: [],
      fs,
    })).rejects.toMatchObject({ code: 'code_forbidden' });

    await expect(loadSelectedSkills({
      workspaceRoot: '/ws',
      skillNames: ['needs-shell'],
      availableTools: ['task_list'],
      fs,
    })).rejects.toMatchObject({ code: 'unmet_tools' });
  });
});

describe('budgets, usage, and artifacts', () => {
  it('uses a conservative UTF-8 estimate and an 80 percent request budget', () => {
    expect(REQUEST_BUDGET_SHARE).toBe(0.8);
    expect(REQUEST_BUDGET_SHARE).toBe(CONTEXT_USAGE_LIMIT);
    expect(UTF8_TOKEN_DIVISOR).toBe(3);
    expect(estimateUtf8Tokens('å'.repeat(10))).toBe(Math.ceil(new TextEncoder().encode('å'.repeat(10)).length / 3));
    expect(requestBudgetTokens(1000)).toBe(800);
    const usage = reportRequestUsage({
      requestText: 'hello',
      contextWindow: 100,
    });
    expect(usage.withinBudget).toBe(true);
    expect(usage.budgetTokens).toBe(80);
    expect(usage.reportedTokens).toBe(usage.estimatedTokens);
  });

  it('replaces the estimate with provider usage after a completed request', () => {
    const usage = reportRequestUsage({
      requestText: 'a'.repeat(300),
      contextWindow: 100,
      providerUsage: { promptTokens: 40, completionTokens: 12 },
    });
    expect(usage.estimatedTokens).toBeGreaterThan(40);
    expect(usage.reportedTokens).toBe(40);
    expect(usage.providerCompletionTokens).toBe(12);
    expect(usage.withinBudget).toBe(true);
  });

  it('keeps compacted requests within the budget when history is large', () => {
    const compiled = 'TABS safety and policy occupy a small prefix.';
    const result = compactUntilWithinBudget({
      contextWindow: 400,
      compiledContent: compiled,
      recentText: 'tool output '.repeat(4000),
      facts: {
        sourceSequenceStart: 0,
        sourceSequenceEnd: 40,
        goal: 'Follow up the new lead',
        plan: 'Read CRM, then write a note',
        nextStep: 'Call crm_entity_get',
      },
    });
    expect(result.usage.withinBudget).toBe(true);
    expect(result.usage.reportedTokens).toBeLessThanOrEqual(result.usage.budgetTokens);
    expect(result.requestText).toContain('Follow up the new lead');
  });

  it('returns bounded artifact sections with cursors', () => {
    const content = ['# Intro', 'alpha', 'beta', '# Next', 'gamma', 'delta'].join('\n');
    const first = boundArtifactSection(content, { limit: 2 });
    expect(first.content).toBe('# Intro\nalpha');
    expect(first.nextCursor).toBe('2');
    expect(first.truncated).toBe(true);
    const rest = boundArtifactSection(content, { cursor: first.nextCursor, limit: 10 });
    expect(rest.truncated).toBe(false);
    const section = boundArtifactSection(content, { section: 'Next', limit: 2 });
    expect(section.content).toContain('# Next');
    const tiny = boundArtifactSection(content, { maxBytes: 8 });
    expect(tiny.byteSize).toBeLessThanOrEqual(8);
  });
});

describe('compaction retention, recovery, and redaction', () => {
  it('retains required compaction facts and source sequence ranges', () => {
    const record = buildCompactionRecord({
      sourceSequenceStart: 2,
      sourceSequenceEnd: 18,
      goal: 'Follow up the new lead',
      plan: 'Approved plan: capture a task',
      decisions: ['Use CRM note, not email'],
      changedResources: ['crm:lead-1', 'task:task-9'],
      errors: ['crm_entity_get timed out once'],
      approvals: ['pending:crm_note_add'],
      results: ['Lead stage is new'],
      nextStep: 'Retry crm_entity_get',
    });
    expect(record.version).toBe(COMPACTION_VERSION);
    expect(record.compilerVersion).toBe(PROMPT_COMPILER_VERSION);
    expect(record.sourceSequenceStart).toBe(2);
    expect(record.sourceSequenceEnd).toBe(18);
    expect(record.summary).toContain('Follow up the new lead');
    expect(record.summary).toContain('Approved plan: capture a task');
    expect(record.summary).toContain('Use CRM note, not email');
    expect(record.summary).toContain('crm:lead-1');
    expect(record.summary).toContain('crm_entity_get timed out once');
    expect(record.summary).toContain('pending:crm_note_add');
    expect(record.summary).toContain('Lead stage is new');
    expect(record.summary).toContain('Retry crm_entity_get');
  });

  it('resumes from compacted context with required facts intact', () => {
    const history = [
      message(0, 'user', 'Start the follow-up'),
      message(1, 'assistant', 'I will read CRM first'),
      message(2, 'tool', '{"ok":true,"summary":"lead new","id":"crm:lead-1"}'),
      message(3, 'assistant', `Leaked ${SECRET}`),
    ];
    const compacted = compactConversation({
      runId: 'run-1',
      messages: history,
      facts: {
        sourceSequenceStart: 0,
        sourceSequenceEnd: 3,
        goal: 'Follow up the new lead',
        plan: 'Approved plan',
        decisions: ['Use CRM note'],
        changedResources: ['crm:lead-1'],
        errors: [],
        approvals: ['approved:crm_note_add'],
        results: ['Lead stage is new'],
        nextStep: 'Write the note',
      },
    });
    expect(compacted.retainedMessages.every((item) => item.state === 'compacted')).toBe(true);
    const resumed = resumeFromCompaction(compacted.record, [
      compacted.summaryMessage,
      message(4, 'user', 'Continue'),
    ]);
    const joined = resumed.map((item) => String(item.content)).join('\n');
    expect(joined).toContain('Follow up the new lead');
    expect(joined).toContain('Approved plan');
    expect(joined).toContain('crm:lead-1');
    expect(joined).toContain('Write the note');
    expect(joined).toContain('Continue');

    const compiled = compileContextMessages({
      run: buildQueuedAgentRun({
        goal: 'Follow up the new lead',
        mode: 'guided',
        profileName: 'Follow-up Operator',
        providerId: 'p1',
        modelId: 'm1',
        contextRefs: [],
      }),
      messages: resumed,
    });
    const visible = JSON.stringify(compiled);
    expect(visible).toContain('Follow up the new lead');
    expect(visible).not.toContain(SECRET);
  });

  it('redacts secrets from compiled instructions and compaction summaries', () => {
    const compiled = compileFixture({
      globalInstructions: `Store this key ${SECRET} in the prompt`,
      workspaceAgentsMd: `api_key=${SECRET}`,
    });
    expect(compiled.compiledContent).not.toContain(SECRET);
    expect(compiled.compiledContent).toMatch(/REDACTED/);
    const record = buildCompactionRecord({
      sourceSequenceStart: 0,
      sourceSequenceEnd: 1,
      goal: `Do not leak ${SECRET}`,
      results: [`token ${SECRET}`],
      nextStep: 'Keep going',
    });
    expect(record.summary).not.toContain(SECRET);
    expect(record.facts.goal).not.toContain(SECRET);
  });
});
