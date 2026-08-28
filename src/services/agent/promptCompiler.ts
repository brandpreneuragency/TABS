// ---------------------------------------------------------------------------
// TABS Work-OS Harness — Prompt compiler, profiles, budgets, and compaction
// Eight-level instruction order. Snapshots freeze at run creation.
// New runs load root AGENTS.md and selected skills. They never load
// `.tabs/writerinstructions.md` or `.tabs/taskinstructions.md`.
// ---------------------------------------------------------------------------

import type {
  AgentApproval,
  AgentContextRef,
  AgentMessage,
  AgentPolicySnapshot,
  AgentProfileSnapshot,
  AgentRun,
  InstructionSnapshot,
  WorkspaceScopeSnapshot,
} from '../../types/agent';
import {
  CONTEXT_USAGE_LIMIT,
  contextRefForModel,
  contextTokenLimit,
  estimateUtf8Tokens,
  workspaceScopeForModel,
} from './contextManager';
import { MAX_ARTIFACT_READ_LIMIT, MIN_LIST_PAGE_SIZE } from './helpers';
import { redactSecrets } from './redaction';
import {
  joinWorkspacePath,
  loadSelectedSkills,
  type LoadedSkill,
  type SkillFileAccess,
} from './skillLoader';

export const PROMPT_COMPILER_VERSION = '1.0.0';
export const COMPACTION_VERSION = '1';
export const REQUEST_BUDGET_SHARE = CONTEXT_USAGE_LIMIT;
export const UTF8_TOKEN_DIVISOR = 3;

export const LEGACY_INSTRUCTION_FILES = [
  'writerinstructions.md',
  'taskinstructions.md',
] as const;

export const WORKSPACE_AGENTS_MD = 'AGENTS.md';

export const PROMPT_ORDER = [
  'immutable_safety',
  'frozen_policy',
  'global_user',
  'workspace_agents_md',
  'agent_profile',
  'skill_instructions',
  'run_goal',
  'context_reference_summary',
] as const;

export type PromptLayerId = (typeof PROMPT_ORDER)[number];

export const TABS_SAFETY_INSTRUCTIONS = [
  'You are the TABS local Work-OS harness.',
  'Follow the eight-level instruction order. Higher items win when instructions conflict.',
  'Never reveal secrets, credentials, API keys, tokens, cookies, or private keys.',
  'Do not insert or request hidden settings.',
  'Do not dump the full workspace, full CRM tables, or all tasks into the prompt.',
  'Use tools for current data. Prefer references and compact summaries.',
  'Stay inside the frozen workspace scope and run policy.',
  'Do not bypass approvals, policy grants, or tool restrictions.',
  'Include stable resource identifiers when referring to data.',
  'Never execute skill package code. Skills are instruction documents only.',
].join('\n');

export interface AgentProfileDefinition extends AgentProfileSnapshot {
  id: string;
}

export const INITIAL_AGENT_PROFILES: AgentProfileDefinition[] = [
  {
    id: 'general-operator',
    name: 'General Operator',
    description: 'Cross-feature operator for documents, tasks, CRM, and forms.',
    systemInstructions: 'Coordinate work across Documents, Tasks, CRM, and Forms. Ask before irreversible changes in guided mode.',
    preferredReasoning: 'default',
    defaultMode: 'guided',
    allowedToolGroups: ['documents', 'tasks', 'crm', 'forms', 'files'],
    defaultSkills: [],
  },
  {
    id: 'follow-up-operator',
    name: 'Follow-up Operator',
    description: 'Turns inquiries into follow-up notes, tasks, and documents.',
    systemInstructions: 'Qualify follow-ups from forms and CRM records. Capture next actions as tasks and notes.',
    preferredReasoning: 'default',
    defaultMode: 'guided',
    allowedToolGroups: ['crm', 'tasks', 'forms', 'documents'],
    defaultSkills: ['follow-up'],
  },
  {
    id: 'task-planner',
    name: 'Task Planner',
    description: 'Plans and structures local tasks and project work.',
    systemInstructions: 'Break goals into tasks, dependencies, and next steps. Keep plans small and reviewable.',
    preferredReasoning: 'default',
    defaultMode: 'guided',
    allowedToolGroups: ['tasks', 'documents'],
    defaultSkills: [],
  },
  {
    id: 'document-editor',
    name: 'Document Editor',
    description: 'Edits and organizes local documents without dumping whole files.',
    systemInstructions: 'Edit documents with bounded reads and precise updates. Preserve the user voice and structure.',
    preferredReasoning: 'default',
    defaultMode: 'guided',
    allowedToolGroups: ['documents', 'files'],
    defaultSkills: [],
  },
  {
    id: 'crm-analyst',
    name: 'CRM Analyst',
    description: 'Read-only CRM and forms analyst.',
    systemInstructions: 'Analyze CRM and form records through tools. Do not mutate records unless the run mode allows it.',
    preferredReasoning: 'default',
    defaultMode: 'read_only',
    allowedToolGroups: ['crm', 'forms', 'tasks'],
    defaultSkills: [],
  },
  {
    id: 'repository-assistant',
    name: 'Repository Assistant',
    description: 'Helps with local repository files in support of business work.',
    systemInstructions: 'Use bounded file reads for repository work. Do not treat TABS as a coding-agent clone.',
    preferredReasoning: 'default',
    defaultMode: 'guided',
    allowedToolGroups: ['files', 'documents', 'tasks'],
    defaultSkills: [],
  },
];

export function getInitialProfile(nameOrId?: string): AgentProfileDefinition {
  if (!nameOrId) return INITIAL_AGENT_PROFILES[0];
  const needle = nameOrId.trim().toLowerCase();
  return INITIAL_AGENT_PROFILES.find((profile) => (
    profile.id === needle
    || profile.name.toLowerCase() === needle
  )) ?? INITIAL_AGENT_PROFILES[0];
}

export function snapshotAgentProfile(
  nameOrId: string | undefined,
  overrides: Partial<AgentProfileSnapshot> = {},
): AgentProfileSnapshot {
  const profile = getInitialProfile(nameOrId);
  return {
    name: overrides.name ?? profile.name,
    description: overrides.description ?? profile.description,
    systemInstructions: overrides.systemInstructions ?? profile.systemInstructions,
    preferredProviderId: overrides.preferredProviderId ?? profile.preferredProviderId,
    preferredModelId: overrides.preferredModelId ?? profile.preferredModelId,
    preferredReasoning: overrides.preferredReasoning ?? profile.preferredReasoning,
    defaultMode: overrides.defaultMode ?? profile.defaultMode,
    allowedToolGroups: overrides.allowedToolGroups ?? [...profile.allowedToolGroups],
    defaultSkills: overrides.defaultSkills ?? [...profile.defaultSkills],
  };
}

export function isLegacyInstructionFile(fileName: string): boolean {
  const base = fileName.replace(/\\/g, '/').split('/').pop() ?? fileName;
  return (LEGACY_INSTRUCTION_FILES as readonly string[]).includes(base.toLowerCase());
}

export function hashInstructionSource(content: string): string {
  const bytes = new TextEncoder().encode(content);
  let hash = 5381;
  for (let index = 0; index < bytes.length; index++) {
    hash = ((hash << 5) + hash + bytes[index]) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function estimateRequestTokens(text: string): number {
  return estimateUtf8Tokens(text);
}

export function requestBudgetTokens(contextWindow: number): number {
  return contextTokenLimit(contextWindow);
}

export interface PromptLayer {
  id: PromptLayerId;
  content: string;
  hash: string;
}

export interface CompileInstructionsInput {
  goal: string;
  mode: AgentRun['mode'];
  policy: AgentPolicySnapshot;
  profile: AgentProfileSnapshot;
  contextRefs?: AgentContextRef[];
  workspaceScope?: WorkspaceScopeSnapshot;
  globalInstructions?: string;
  workspaceAgentsMd?: string;
  skills?: LoadedSkill[];
  allowedTools?: string[];
  remainingTurns?: number;
  remainingDurationMs?: number;
  maxTurns?: number;
  maxDurationMs?: number;
}

export interface CompiledInstructions {
  snapshot: InstructionSnapshot;
  layers: PromptLayer[];
  compiledContent: string;
}

function layer(id: PromptLayerId, content: string): PromptLayer {
  const redacted = redactSecrets(content).trim();
  return { id, content: redacted, hash: hashInstructionSource(redacted) };
}

function contextSummary(input: CompileInstructionsInput): string {
  const refs = (input.contextRefs ?? []).map((ref) => {
    const safe = contextRefForModel(ref);
    const revision = safe.revision ? `@${safe.revision}` : '';
    return `${safe.kind}:${safe.id}${revision} (${safe.label})`;
  });
  const lines = [
    'Use tools for current data. Do not assume full workspace, CRM tables, or task lists are present.',
  ];
  if (input.workspaceScope) {
    const visible = workspaceScopeForModel(input.workspaceScope);
    lines.push(`Workspace: ${visible.workspaceId} revision ${visible.rootRevision}`);
  }
  if (refs.length > 0) {
    lines.push(`Context references: ${refs.join('; ')}`);
  } else {
    lines.push('Context references: none');
  }
  if (input.allowedTools && input.allowedTools.length > 0) {
    lines.push(`Allowed tools: ${input.allowedTools.join(', ')}`);
  }
  lines.push(`Allowed tool groups: ${input.profile.allowedToolGroups.join(', ') || 'none'}`);
  const remainingTurns = input.remainingTurns ?? input.maxTurns;
  const remainingDurationMs = input.remainingDurationMs ?? input.maxDurationMs;
  if (remainingTurns !== undefined || remainingDurationMs !== undefined) {
    lines.push(
      `Remaining run limits: turns=${remainingTurns ?? 'n/a'} durationMs=${remainingDurationMs ?? 'n/a'}`,
    );
  }
  return lines.join('\n');
}

function skillLayerContent(skills: LoadedSkill[]): string {
  if (skills.length === 0) return '';
  return skills.map((skill) => {
    const references = skill.references
      .map((reference) => `Reference ${reference.path}:\n${reference.content}`)
      .join('\n\n');
    return [
      `Skill ${skill.manifest.name}@${skill.manifest.version}`,
      skill.manifest.description ?? '',
      skill.instructions,
      references,
    ].filter((part) => part.trim().length > 0).join('\n');
  }).join('\n\n');
}

export function compileInstructions(input: CompileInstructionsInput): CompiledInstructions {
  const layers: PromptLayer[] = [
    layer('immutable_safety', TABS_SAFETY_INSTRUCTIONS),
    layer(
      'frozen_policy',
      [
        `Run mode: ${input.mode}`,
        `Policy mode: ${input.policy.mode}`,
        `Policy revision: ${input.policy.revision}`,
        `Policy rules hash: ${input.policy.rulesHash}`,
      ].join('\n'),
    ),
    layer('global_user', input.globalInstructions ?? ''),
    layer('workspace_agents_md', input.workspaceAgentsMd ?? ''),
    layer(
      'agent_profile',
      [
        `Profile: ${input.profile.name}`,
        input.profile.description,
        input.profile.systemInstructions,
      ].filter((part) => part.trim().length > 0).join('\n'),
    ),
    layer('skill_instructions', skillLayerContent(input.skills ?? [])),
    layer('run_goal', `Goal: ${input.goal}`),
    layer('context_reference_summary', contextSummary(input)),
  ];

  const body = [
    `Prompt compiler ${PROMPT_COMPILER_VERSION}. Instruction order (higher items win): ${PROMPT_ORDER.join(', ')}.`,
    ...layers.map((entry, index) => (
      `## ${index + 1}. ${entry.id}\n${entry.content || '(none)'}`
    )),
  ];
  const compiledContent = redactSecrets(body.join('\n\n'));
  const snapshot: InstructionSnapshot = {
    safetyInstructionsHash: layers[0].hash,
    policyHash: layers[1].hash,
    globalInstructionsHash: input.globalInstructions ? layers[2].hash : undefined,
    workspaceInstructionsHash: input.workspaceAgentsMd ? layers[3].hash : undefined,
    profileHash: layers[4].hash,
    skillHashes: (input.skills ?? []).map((skill) => skill.sourceHash),
    compiledContent,
    compiledContentHash: hashInstructionSource(compiledContent),
  };
  return { snapshot, layers, compiledContent };
}

export async function loadWorkspaceAgentsMd(
  workspaceRoot: string | undefined,
  fs: SkillFileAccess,
): Promise<string | undefined> {
  if (!workspaceRoot) return undefined;
  const agentsPath = joinWorkspacePath(workspaceRoot, WORKSPACE_AGENTS_MD);
  // New harness runs load only root AGENTS.md. Legacy writer/task instruction
  // files remain on disk and are never read here.
  if (!(await fs.exists(agentsPath))) return undefined;
  return fs.readText(agentsPath);
}

export interface CompileRunInstructionsInput extends CompileInstructionsInput {
  workspaceRoot?: string;
  skillNames?: string[];
  availableTools?: string[];
  availableToolGroups?: string[];
  fs?: SkillFileAccess;
}

export async function compileRunInstructions(
  input: CompileRunInstructionsInput,
): Promise<CompiledInstructions> {
  const fs = input.fs;
  const workspaceAgentsMd = input.workspaceAgentsMd
    ?? (fs ? await loadWorkspaceAgentsMd(input.workspaceRoot, fs) : undefined);
  const skills = input.skills ?? (
    fs && input.workspaceRoot && (input.skillNames?.length ?? 0) > 0
      ? await loadSelectedSkills({
          workspaceRoot: input.workspaceRoot,
          skillNames: input.skillNames ?? [],
          availableTools: input.availableTools ?? input.allowedTools ?? [],
          availableToolGroups: input.availableToolGroups ?? input.profile.allowedToolGroups,
          fs,
        })
      : []
  );
  return compileInstructions({
    ...input,
    workspaceAgentsMd,
    skills,
  });
}

export interface RequestUsageReport {
  estimatedTokens: number;
  providerPromptTokens?: number;
  providerCompletionTokens?: number;
  reportedTokens: number;
  budgetTokens: number;
  share: number;
  withinBudget: boolean;
}

export function reportRequestUsage(input: {
  requestText: string;
  contextWindow: number;
  providerUsage?: { promptTokens?: number; completionTokens?: number };
}): RequestUsageReport {
  const estimatedTokens = estimateRequestTokens(input.requestText);
  const budgetTokens = requestBudgetTokens(input.contextWindow);
  const providerPromptTokens = input.providerUsage?.promptTokens;
  const reportedTokens = providerPromptTokens ?? estimatedTokens;
  return {
    estimatedTokens,
    providerPromptTokens,
    providerCompletionTokens: input.providerUsage?.completionTokens,
    reportedTokens,
    budgetTokens,
    share: REQUEST_BUDGET_SHARE,
    withinBudget: reportedTokens <= budgetTokens,
  };
}

export interface CompactionFacts {
  goal: string;
  plan?: string;
  decisions: string[];
  changedResources: string[];
  errors: string[];
  approvals: string[];
  results: string[];
  nextStep: string;
}

export interface CompactionRecord {
  version: string;
  compilerVersion: string;
  sourceSequenceStart: number;
  sourceSequenceEnd: number;
  summary: string;
  facts: CompactionFacts;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Map<string, true>();
  const result: string[] = [];
  for (const value of values) {
    const text = redactSecrets(value).trim();
    if (!text || seen.has(text)) continue;
    seen.set(text, true);
    result.push(text);
  }
  return result;
}

function listBlock(title: string, values: string[]): string {
  if (values.length === 0) return `${title}: none`;
  return `${title}:\n${values.map((value) => `- ${value}`).join('\n')}`;
}

export function buildCompactionRecord(input: {
  sourceSequenceStart: number;
  sourceSequenceEnd: number;
  goal: string;
  plan?: string;
  decisions?: string[];
  changedResources?: string[];
  errors?: string[];
  approvals?: string[];
  results?: string[];
  nextStep?: string;
}): CompactionRecord {
  const facts: CompactionFacts = {
    goal: redactSecrets(input.goal).trim(),
    plan: input.plan ? redactSecrets(input.plan).trim() : undefined,
    decisions: uniqueStrings(input.decisions ?? []),
    changedResources: uniqueStrings(input.changedResources ?? []),
    errors: uniqueStrings(input.errors ?? []),
    approvals: uniqueStrings(input.approvals ?? []),
    results: uniqueStrings(input.results ?? []),
    nextStep: redactSecrets(input.nextStep ?? '').trim() || 'Continue the run with tools.',
  };
  const summary = redactSecrets([
    `Compaction v${COMPACTION_VERSION}`,
    `Compiler: ${PROMPT_COMPILER_VERSION}`,
    `Source sequences: ${input.sourceSequenceStart}-${input.sourceSequenceEnd}`,
    `Goal: ${facts.goal}`,
    `Plan: ${facts.plan ?? 'none'}`,
    listBlock('Decisions', facts.decisions),
    listBlock('Changed resources', facts.changedResources),
    listBlock('Errors', facts.errors),
    listBlock('Approvals', facts.approvals),
    listBlock('Results', facts.results),
    `Next step: ${facts.nextStep}`,
  ].join('\n'));
  return {
    version: COMPACTION_VERSION,
    compilerVersion: PROMPT_COMPILER_VERSION,
    sourceSequenceStart: input.sourceSequenceStart,
    sourceSequenceEnd: input.sourceSequenceEnd,
    summary,
    facts,
  };
}

export function extractCompactionFacts(input: {
  run: Pick<AgentRun, 'goal'>;
  messages: AgentMessage[];
  approvals?: AgentApproval[];
  plan?: string;
  nextStep?: string;
}): Omit<Parameters<typeof buildCompactionRecord>[0], 'sourceSequenceStart' | 'sourceSequenceEnd'> {
  const decisions: string[] = [];
  const changedResources: string[] = [];
  const errors: string[] = [];
  const results: string[] = [];
  for (const message of input.messages) {
    const text = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
    if (message.role === 'assistant' && text.trim()) decisions.push(text.slice(0, 240));
    if (message.role === 'tool') {
      results.push(text.slice(0, 240));
      if (text.includes('"ok":false') || text.toLowerCase().includes('error')) {
        errors.push(text.slice(0, 240));
      }
      const keys = text.match(/[a-z]+:[A-Za-z0-9._-]+/g) ?? [];
      changedResources.push(...keys);
    }
  }
  const approvals = (input.approvals ?? []).map((approval) => (
    `${approval.status}:${approval.toolName ?? approval.planId ?? approval.id}`
  ));
  return {
    goal: input.run.goal,
    plan: input.plan,
    decisions,
    changedResources,
    errors,
    approvals,
    results,
    nextStep: input.nextStep,
  };
}

export interface CompactConversationResult {
  record: CompactionRecord;
  retainedMessages: AgentMessage[];
  summaryMessage: AgentMessage;
}

export function compactConversation(input: {
  runId: string;
  messages: AgentMessage[];
  facts: Parameters<typeof buildCompactionRecord>[0];
  now?: number;
}): CompactConversationResult {
  const record = buildCompactionRecord(input.facts);
  const summaryMessage: AgentMessage = {
    id: `compaction:${record.sourceSequenceStart}:${record.sourceSequenceEnd}`,
    runId: input.runId,
    messageIndex: record.sourceSequenceEnd + 1,
    turn: 0,
    role: 'system',
    content: record.summary,
    state: 'complete',
    streamVersion: 0,
    createdAt: input.now ?? 0,
  };
  const retainedMessages = input.messages.map((message) => (
    message.messageIndex >= record.sourceSequenceStart
      && message.messageIndex <= record.sourceSequenceEnd
      ? { ...message, state: 'compacted' as const, consumedAtTurn: message.turn }
      : message
  ));
  return { record, retainedMessages, summaryMessage };
}

export function resumeFromCompaction(
  record: CompactionRecord,
  laterMessages: AgentMessage[],
): AgentMessage[] {
  const summary: AgentMessage = {
    id: `compaction-resume:${record.sourceSequenceStart}:${record.sourceSequenceEnd}`,
    runId: laterMessages[0]?.runId ?? 'resume',
    messageIndex: record.sourceSequenceStart,
    turn: 0,
    role: 'system',
    content: record.summary,
    state: 'complete',
    streamVersion: 0,
    createdAt: laterMessages[0]?.createdAt ?? 0,
  };
  const rest = laterMessages.filter((message) => (
    message.messageIndex > record.sourceSequenceEnd && message.state !== 'compacted'
  ));
  return [summary, ...rest];
}

export function compactUntilWithinBudget(input: {
  contextWindow: number;
  compiledContent: string;
  recentText: string;
  facts: Parameters<typeof buildCompactionRecord>[0];
}): { requestText: string; record: CompactionRecord; usage: RequestUsageReport } {
  const record = buildCompactionRecord(input.facts);
  const prefix = `${input.compiledContent}\n\n${record.summary}\n\n`;
  let recent = input.recentText;
  let requestText = `${prefix}${recent}`;
  let usage = reportRequestUsage({ requestText, contextWindow: input.contextWindow });
  while (!usage.withinBudget && recent.length > 0) {
    recent = recent.slice(-Math.floor(recent.length / 2));
    requestText = `${prefix}${recent}`;
    usage = reportRequestUsage({ requestText, contextWindow: input.contextWindow });
  }
  if (!usage.withinBudget) {
    requestText = record.summary;
    usage = reportRequestUsage({ requestText, contextWindow: input.contextWindow });
  }
  return { requestText, record, usage };
}

export interface ArtifactSectionRead {
  content: string;
  offset: number;
  count: number;
  total: number;
  truncated: boolean;
  nextCursor?: string;
  byteSize: number;
}

export function boundArtifactSection(
  content: string,
  options: {
    cursor?: number | string;
    limit?: number;
    section?: string;
    maxBytes?: number;
  } = {},
): ArtifactSectionRead {
  const lines = content.split('\n');
  let offset = typeof options.cursor === 'number' ? options.cursor : Number.parseInt(String(options.cursor ?? '0'), 10);
  if (!Number.isInteger(offset) || offset < 0) offset = 0;
  if (options.section) {
    const heading = lines.findIndex((line) => (
      line.trim() === options.section || line.trim() === `# ${options.section}`
    ));
    if (heading >= 0 && offset === 0) offset = heading;
  }
  const limit = Math.min(
    MAX_ARTIFACT_READ_LIMIT,
    Math.max(MIN_LIST_PAGE_SIZE, options.limit ?? MAX_ARTIFACT_READ_LIMIT),
  );
  let slice = lines.slice(offset, offset + limit);
  let text = slice.join('\n');
  const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
  const encoded = new TextEncoder().encode(text);
  if (encoded.byteLength > maxBytes) {
    text = new TextDecoder().decode(encoded.slice(0, maxBytes));
    slice = text.split('\n');
  }
  const next = offset + slice.length;
  return {
    content: text,
    offset,
    count: slice.length,
    total: lines.length,
    truncated: next < lines.length || encoded.byteLength > maxBytes,
    nextCursor: next < lines.length ? String(next) : undefined,
    byteSize: new TextEncoder().encode(text).byteLength,
  };
}

export function createInstructionSnapshot(input: CompileInstructionsInput): InstructionSnapshot {
  return compileInstructions(input).snapshot;
}
