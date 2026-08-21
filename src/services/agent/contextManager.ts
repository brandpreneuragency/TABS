// ---------------------------------------------------------------------------
// TABS Work-OS Harness — Basic context manager
// References and compact summaries first. The model never receives workspace
// rootPath or nativeScopeId. Token estimates use ceil(UTF-8 bytes / 3).
// ---------------------------------------------------------------------------

import type {
  AgentContextKind,
  AgentContextRef,
  AgentMessage,
  AgentRun,
  ProviderToolCall,
  WorkspaceScopeSnapshot,
} from '../../types/agent';
import { MAX_TOOL_RESULT_BYTES } from './helpers';
import type { OpenAIProtocolToolCall, ProviderProtocolMessage } from './providers/providerAdapter';
import { redactSecrets } from './redaction';

export const CONTEXT_USAGE_LIMIT = 0.8;

export const CONTEXT_KINDS: AgentContextKind[] = [
  'workspace',
  'document',
  'task',
  'crm',
  'form',
  'submission',
  'file',
];

export const CONTEXT_BUDGET_SHARES = {
  system: 0.15,
  conversation: 0.3,
  toolResults: 0.35,
  inputOutputReserve: 0.2,
} as const;

export function estimateUtf8Tokens(text: string): number {
  return Math.ceil(new TextEncoder().encode(text).length / 3);
}

export function contextTokenLimit(contextWindow: number): number {
  return Math.max(1, Math.floor(contextWindow * CONTEXT_USAGE_LIMIT));
}

/** Strips privileged filesystem fields before any model-visible payload. */
export function workspaceScopeForModel(
  scope: WorkspaceScopeSnapshot,
): { workspaceId: string; rootRevision: string } {
  return {
    workspaceId: scope.workspaceId,
    rootRevision: scope.rootRevision,
  };
}

export function contextRefForModel(ref: AgentContextRef): AgentContextRef {
  return {
    kind: ref.kind,
    id: ref.id,
    label: ref.label,
    revision: ref.revision,
    scope: ref.scope,
  };
}

/**
 * Freeze context identifiers when a run starts. Later UI selection changes
 * must not rewrite these references.
 */
export function captureContextRefs(refs: AgentContextRef[]): AgentContextRef[] {
  return Object.freeze(refs.map((ref) => Object.freeze(contextRefForModel(ref)))) as AgentContextRef[];
}

export function captureRunContext(input: {
  contextRefs?: AgentContextRef[];
  workspaceScope?: WorkspaceScopeSnapshot;
}): { contextRefs: AgentContextRef[]; workspaceScope?: WorkspaceScopeSnapshot } {
  return {
    contextRefs: captureContextRefs(input.contextRefs ?? []),
    workspaceScope: input.workspaceScope
      ? Object.freeze({
          workspaceId: input.workspaceScope.workspaceId,
          rootPath: input.workspaceScope.rootPath,
          rootRevision: input.workspaceScope.rootRevision,
          nativeScopeId: input.workspaceScope.nativeScopeId,
        }) as WorkspaceScopeSnapshot
      : undefined,
  };
}

export function frozenContextRef(
  refs: AgentContextRef[],
  kind: AgentContextKind,
  id?: string,
): AgentContextRef | undefined {
  if (id) return refs.find((ref) => ref.kind === kind && ref.id === id);
  return refs.find((ref) => ref.kind === kind);
}

export interface CompileContextInput {
  run: AgentRun;
  messages: AgentMessage[];
}

function asText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function toProtocolToolCalls(calls: ProviderToolCall[]): OpenAIProtocolToolCall[] {
  return calls.map((call) => ({
    id: call.id,
    type: 'function' as const,
    function: {
      name: call.name,
      arguments: call.arguments,
    },
  }));
}

function boundText(text: string, maxBytes: number): string {
  const encoded = new TextEncoder().encode(text);
  if (encoded.byteLength <= maxBytes) return text;
  const sliced = encoded.slice(0, Math.max(0, maxBytes - 32));
  return `${new TextDecoder().decode(sliced)}\n[truncated]`;
}

function systemPrompt(run: AgentRun): string {
  const lines = [
    redactSecrets(run.instructionSnapshot.compiledContent || run.profileSnapshot.systemInstructions),
    `Goal: ${redactSecrets(run.goal)}`,
    `Mode: ${run.mode}`,
  ];
  if (run.contextRefs.length > 0) {
    const refs = run.contextRefs
      .map((ref) => {
        const safe = contextRefForModel(ref);
        const revision = safe.revision ? `@${safe.revision}` : '';
        return `${safe.kind}:${safe.id}${revision} (${safe.label})`;
      })
      .join('; ');
    lines.push(`Context references: ${refs}`);
  }
  if (run.workspaceScope) {
    const visible = workspaceScopeForModel(run.workspaceScope);
    lines.push(`Workspace: ${visible.workspaceId} revision ${visible.rootRevision}`);
  }
  return lines.filter((line) => line.trim().length > 0).join('\n');
}

function toProtocolMessage(message: AgentMessage): ProviderProtocolMessage | undefined {
  if (message.state === 'pending') return undefined;
  const content = redactSecrets(asText(message.content));
  if (message.role === 'system') {
    return { role: 'system', content };
  }
  if (message.role === 'user') {
    return { role: 'user', content };
  }
  if (message.role === 'assistant') {
    const encoded: ProviderProtocolMessage = {
      role: 'assistant',
      content: content.length > 0 ? content : null,
    };
    if (message.assistantToolCalls && message.assistantToolCalls.length > 0) {
      encoded.tool_calls = toProtocolToolCalls(message.assistantToolCalls);
    }
    return encoded;
  }
  if (!message.providerToolCallId) return undefined;
  return {
    role: 'tool',
    content: boundText(content, MAX_TOOL_RESULT_BYTES),
    tool_call_id: message.providerToolCallId,
  };
}

/**
 * Assemble a provider request below 80% of the frozen context window.
 * Oldest tool results are dropped first, then oldest conversation turns,
 * preserving the system prompt and the latest user input.
 */
export function compileContextMessages(input: CompileContextInput): ProviderProtocolMessage[] {
  const system: ProviderProtocolMessage = { role: 'system', content: systemPrompt(input.run) };
  const conversation = input.messages
    .slice()
    .sort((left, right) => left.messageIndex - right.messageIndex)
    .map(toProtocolMessage)
    .filter((message): message is ProviderProtocolMessage => message != null);

  const limit = contextTokenLimit(input.run.providerSnapshot.contextWindow);
  const assembled: ProviderProtocolMessage[] = [system, ...conversation];
  if (estimateMessages(assembled) <= limit) return assembled;

  const droppableToolIndexes: number[] = [];
  for (let index = 1; index < assembled.length; index++) {
    if (assembled[index].role === 'tool') droppableToolIndexes.push(index);
  }
  const kept = assembled.slice();
  for (const index of droppableToolIndexes) {
    if (estimateMessages(compactHoles(kept)) <= limit) break;
    kept[index] = { role: 'tool', content: '{"ok":true,"summary":"omitted","truncated":true}', tool_call_id: kept[index].role === 'tool' ? kept[index].tool_call_id : '' };
  }

  let compacted = compactHoles(kept);
  if (estimateMessages(compacted) <= limit) return compacted;

  const latestUser = [...compacted].reverse().findIndex((message) => message.role === 'user');
  const latestUserIndex = latestUser === -1 ? compacted.length - 1 : compacted.length - 1 - latestUser;
  for (let index = 1; index < compacted.length; index++) {
    if (index === latestUserIndex) continue;
    if (compacted[index].role === 'system') continue;
    compacted = compacted.filter((_, itemIndex) => itemIndex !== index);
    index -= 1;
    if (estimateMessages(compacted) <= limit) return compacted;
  }
  return compacted;
}

function estimateMessages(messages: ProviderProtocolMessage[]): number {
  return estimateUtf8Tokens(JSON.stringify(messages));
}

function compactHoles(messages: ProviderProtocolMessage[]): ProviderProtocolMessage[] {
  return messages.filter((message) => {
    if (message.role !== 'tool') return true;
    return message.tool_call_id.length > 0;
  });
}

export function nextMessageIndex(messages: AgentMessage[]): number {
  return messages.reduce((maximum, message) => Math.max(maximum, message.messageIndex + 1), 0);
}

export function nextAssistantTurn(messages: AgentMessage[]): number {
  const last = messages
    .filter((message) => message.role === 'assistant' && message.state === 'complete')
    .reduce((maximum, message) => Math.max(maximum, message.turn), 0);
  return last + 1;
}
