import type {
  AgentContextRef,
  AgentProfileSnapshot,
  AgentRun,
  InstructionSnapshot,
  ProviderSnapshot,
} from '../../types/agent';
import { generateId } from './helpers';
import { captureContextRefs } from './contextManager';

export interface AgentUiCreateInput {
  goal: string;
  mode: AgentRun['mode'];
  profileName: string;
  providerId: string;
  modelId: string;
  contextRefs: AgentContextRef[];
}

export interface ProviderDraft {
  id: string;
  name: string;
  baseUrl: string;
  selectedModel: string;
}

export function buildQueuedAgentRun(
  input: AgentUiCreateInput,
  provider?: ProviderDraft,
  now = Date.now(),
): AgentRun {
  const providerSnapshot: ProviderSnapshot = {
    providerId: provider?.id || input.providerId || 'none',
    adapter: 'openai_compatible',
    adapterVersion: '1.0.0',
    baseUrl: provider?.baseUrl || '',
    modelId: input.modelId || provider?.selectedModel || '',
    credentialAccount: provider ? `providerApiKey_${provider.id}` : 'providerApiKey_none',
    reasoning: 'default',
    capabilities: {
      streaming: true,
      toolCalling: true,
      vision: false,
      reasoning: false,
      contextWindow: 128000,
      maxOutputTokens: 8192,
    },
    contextWindow: 128000,
    maxOutputTokens: 8192,
  };

  const profileSnapshot: AgentProfileSnapshot = {
    name: input.profileName,
    description: input.profileName,
    systemInstructions: '',
    preferredProviderId: providerSnapshot.providerId,
    preferredModelId: providerSnapshot.modelId,
    defaultMode: input.mode,
    allowedToolGroups: ['documents', 'tasks', 'crm', 'forms'],
    defaultSkills: [],
  };

  const instructionSnapshot: InstructionSnapshot = {
    safetyInstructionsHash: 'pending',
    policyHash: 'pending',
    skillHashes: [],
    compiledContent: '',
    compiledContentHash: 'pending',
  };

  return {
    id: generateId(),
    title: input.goal.slice(0, 80),
    goal: input.goal,
    status: 'queued',
    mode: input.mode,
    contextRefs: captureContextRefs(input.contextRefs),
    providerSnapshot,
    profileSnapshot,
    instructionSnapshot,
    policySnapshot: { revision: 1, mode: input.mode, rulesHash: 'pending' },
    policyRevision: 1,
    toolRegistryVersion: '1.0.0',
    toolRegistryHash: 'pending',
    appVersion: 'dev',
    nextSequence: 0,
    activeTurn: 0,
    executionEpoch: 0,
    queuePriority: 0,
    pendingInputCount: 0,
    maxTurns: 25,
    maxDurationMs: 30 * 60 * 1000,
    createdAt: now,
    updatedAt: now,
  };
}
