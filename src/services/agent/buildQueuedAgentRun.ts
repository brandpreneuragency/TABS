import type {
  AgentContextRef,
  AgentProfileSnapshot,
  AgentRun,
  InstructionSnapshot,
  ProviderSnapshot,
} from '../../types/agent';
import { captureContextRefs } from './contextManager';
import { generateId } from './helpers';
import { compileInstructions, snapshotAgentProfile } from './promptCompiler';

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

  const profileSnapshot: AgentProfileSnapshot = snapshotAgentProfile(input.profileName, {
    preferredProviderId: providerSnapshot.providerId,
    preferredModelId: providerSnapshot.modelId,
    defaultMode: input.mode,
  });

  const policySnapshot = { revision: 1, mode: input.mode, rulesHash: 'pending' };
  const contextRefs = captureContextRefs(input.contextRefs);
  const instructionSnapshot: InstructionSnapshot = compileInstructions({
    goal: input.goal,
    mode: input.mode,
    policy: policySnapshot,
    profile: profileSnapshot,
    contextRefs,
    remainingTurns: 25,
    remainingDurationMs: 30 * 60 * 1000,
  }).snapshot;

  return {
    id: generateId(),
    title: input.goal.slice(0, 80),
    goal: input.goal,
    status: 'queued',
    mode: input.mode,
    contextRefs,
    providerSnapshot,
    profileSnapshot,
    instructionSnapshot,
    policySnapshot,
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
