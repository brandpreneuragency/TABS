import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgentSidebar } from './AgentSidebar';
import type { AgentUiActions } from './agentUiTypes';
import { useAgentUiStore } from '../../stores/agentUiStore';
import type {
  AgentApproval,
  AgentArtifact,
  AgentContextRef,
  AgentEvent,
  AgentRun,
  AgentToolCall,
  ProviderSnapshot,
} from '../../types/agent';
import type { AgentRunPlan } from '../../services/agent/policyEngine';
import en from '../../i18n/en';
import tr from '../../i18n/tr';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
  initReactI18next: {
    type: '3rdParty',
    init: () => undefined,
  },
}));

const providerSnapshot: ProviderSnapshot = {
  providerId: 'openai',
  adapter: 'openai_compatible',
  adapterVersion: '1.0.0',
  baseUrl: 'https://example.test',
  modelId: 'gpt',
  credentialAccount: 'providerApiKey_openai',
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

function makeRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: 'run-1',
    title: 'Follow up',
    goal: 'Follow up the lead',
    status: 'running',
    mode: 'guided',
    contextRefs: [{ kind: 'task', id: 'task-1', label: 'Call Ada' }],
    providerSnapshot,
    profileSnapshot: {
      name: 'general',
      description: 'general',
      systemInstructions: '',
      defaultMode: 'guided',
      allowedToolGroups: [],
      defaultSkills: [],
    },
    instructionSnapshot: {
      safetyInstructionsHash: 's',
      policyHash: 'p',
      skillHashes: [],
      compiledContent: '',
      compiledContentHash: 'c',
    },
    policySnapshot: { revision: 1, mode: 'guided', rulesHash: 'r' },
    policyRevision: 1,
    toolRegistryVersion: '1.0.0',
    toolRegistryHash: 'hash',
    appVersion: 'dev',
    nextSequence: 1,
    activeTurn: 1,
    executionEpoch: 0,
    queuePriority: 0,
    pendingInputCount: 0,
    maxTurns: 25,
    maxDurationMs: 1_000,
    createdAt: 1_000,
    updatedAt: 2_000,
    startedAt: 1_500,
    ...overrides,
  };
}

function makeActions(overrides: Partial<AgentUiActions> = {}): AgentUiActions {
  return {
    create: vi.fn(),
    submitInput: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    cancel: vi.fn(),
    retry: vi.fn(),
    archive: vi.fn(),
    queue: vi.fn(),
    prioritizeQueue: vi.fn(),
    answerApproval: vi.fn(),
    resolveReview: vi.fn(),
    switchToGuided: vi.fn(),
    openResource: vi.fn(),
    captureCurrentContext: vi.fn((): AgentContextRef[] => [{ kind: 'task', id: 'task-1', label: 'Call Ada' }]),
    ...overrides,
  };
}

const plan: AgentRunPlan = {
  id: 'plan-1',
  runId: 'run-1',
  goal: 'Follow up the lead',
  steps: [{ id: 's1', title: 'Draft note', status: 'pending' }],
  expectedChanges: ['CRM note'],
  toolGroups: ['crm'],
  resourceScope: ['crm:lead-1'],
  estimatedOperationCount: 2,
  risks: ['Writes CRM data'],
  revision: '1',
};

function renderSidebar(options: {
  runs?: AgentRun[];
  events?: AgentEvent[];
  approvals?: AgentApproval[];
  artifacts?: AgentArtifact[];
  toolCalls?: AgentToolCall[];
  plan?: AgentRunPlan | null;
  error?: string | null;
  actions?: AgentUiActions;
} = {}) {
  const actions = options.actions ?? makeActions();
  const result = render(
    <AgentSidebar
      runs={options.runs ?? []}
      events={options.events ?? []}
      approvals={options.approvals ?? []}
      artifacts={options.artifacts ?? []}
      toolCalls={options.toolCalls ?? []}
      plan={options.plan ?? null}
      error={options.error ?? null}
      providers={[{ id: 'openai', name: 'OpenAI', models: ['gpt'] }]}
      actions={actions}
    />,
  );
  return { ...result, actions };
}

describe('AgentSidebar', () => {
  beforeEach(() => {
    useAgentUiStore.getState().reset();
  });

  it('captures context and starts a run from the composer', async () => {
    const user = userEvent.setup();
    const { actions } = renderSidebar();

    await user.click(screen.getByRole('button', { name: 'agent.captureContext' }));
    expect(screen.getByText(/Call Ada/)).toBeInTheDocument();

    await user.type(screen.getByLabelText('agent.goal'), 'Create a follow-up');
    await user.click(screen.getByRole('button', { name: 'agent.startRun' }));

    expect(actions.create).toHaveBeenCalledWith(expect.objectContaining({
      goal: 'Create a follow-up',
      contextRefs: [{ kind: 'task', id: 'task-1', label: 'Call Ada' }],
    }));
  });

  it('approves a pending request with the keyboard', async () => {
    const user = userEvent.setup();
    const approval: AgentApproval = {
      id: 'appr-1',
      runId: 'run-1',
      policyRevision: 1,
      risk: 'local_update',
      toolName: 'crm_update_lead',
      resourceKeys: ['crm:lead-1'],
      resourceRevisions: {},
      status: 'pending',
      requestedAt: 1,
      expiresAt: 9_999,
    };
    useAgentUiStore.getState().setSelectedRunId('run-1');
    const { actions } = renderSidebar({
      runs: [makeRun({ status: 'awaiting_approval' })],
      approvals: [approval],
    });

    const approve = await screen.findByRole('button', { name: 'agent.approve' });
    expect(approve).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(actions.answerApproval).toHaveBeenCalledWith(approval, 'approved');
  });

  it('renders run status as text, not color alone', () => {
    useAgentUiStore.getState().setSelectedRunId('run-1');
    renderSidebar({ runs: [makeRun({ status: 'running' })] });
    const status = screen.getByText(/agent.statusRunning/);
    expect(status).toHaveAttribute('data-status', 'running');
  });

  it('switches runs while background work continues', async () => {
    const user = userEvent.setup();
    const running = makeRun({ id: 'run-1', goal: 'Background job', status: 'running' });
    const queued = makeRun({ id: 'run-2', goal: 'Queued job', status: 'queued' });
    renderSidebar({ runs: [running, queued] });

    await user.click(screen.getByRole('button', { name: 'agent.runCenter' }));
    expect(screen.getByText('Background job')).toBeInTheDocument();
    expect(screen.getByText('Queued job')).toBeInTheDocument();
    expect(document.querySelector('[data-status="running"]')).toHaveTextContent('agent.statusRunning');

    await user.click(screen.getByRole('button', { name: /Queued job/ }));
    expect(useAgentUiStore.getState().selectedRunId).toBe('run-2');
    expect(useAgentUiStore.getState().viewMode).toBe('run');
  });

  it('steers running, paused, and approval states', async () => {
    const user = userEvent.setup();
    const actions = makeActions();

    for (const status of ['running', 'paused', 'awaiting_approval'] as const) {
      useAgentUiStore.getState().reset();
      useAgentUiStore.getState().setSelectedRunId('run-1');
      const { unmount } = renderSidebar({
        runs: [makeRun({ status })],
        actions,
      });
      await user.type(screen.getByLabelText('agent.steering'), `note-${status}`);
      await user.click(screen.getByRole('button', { name: 'agent.sendSteering' }));
      expect(actions.submitInput).toHaveBeenCalledWith('run-1', `note-${status}`);
      unmount();
    }
  });

  it('exposes recovery card queue and cancel actions', async () => {
    const user = userEvent.setup();
    useAgentUiStore.getState().setSelectedRunId('run-1');
    const { actions } = renderSidebar({
      runs: [makeRun({ status: 'needs_review', interruptionReason: 'Unknown filesystem outcome' })],
    });

    expect(screen.getByText('Unknown filesystem outcome')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'agent.recoveryQueue' }));
    expect(actions.resolveReview).toHaveBeenCalledWith('run-1', 'queue');
    await user.click(screen.getByRole('button', { name: 'agent.recoveryCancel' }));
    expect(actions.resolveReview).toHaveBeenCalledWith('run-1', 'cancel');
  });

  it('navigates to a changed resource from the result card', async () => {
    const user = userEvent.setup();
    useAgentUiStore.getState().setSelectedRunId('run-1');
    const { actions } = renderSidebar({
      runs: [makeRun({ status: 'completed', finalSummary: 'Created the task' })],
      toolCalls: [{
        id: 'tc-1',
        runId: 'run-1',
        turn: 1,
        toolIndex: 0,
        providerToolCallId: 'ptc-1',
        operationId: 'run-1:t1:tc0',
        effectFingerprint: 'fp',
        toolName: 'task_create',
        toolVersion: '1.0.0',
        normalizedArgs: {},
        resourceKeys: ['task:task-1'],
        status: 'succeeded',
        resultArtifactIds: [],
        createdAt: 1,
      }],
    });

    await user.click(screen.getByRole('button', { name: /task:task-1/ }));
    expect(actions.openResource).toHaveBeenCalledWith({
      kind: 'task',
      id: 'task-1',
      label: 'task:task-1',
    });
  });

  it('shows empty and error states', () => {
    const { rerender, actions } = renderSidebar();
    expect(screen.getByText('agent.emptyTitle')).toBeInTheDocument();

    rerender(
      <AgentSidebar
        runs={[]}
        events={[]}
        approvals={[]}
        artifacts={[]}
        toolCalls={[]}
        plan={null}
        error="Provider unavailable"
        providers={[]}
        actions={actions}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Provider unavailable');
  });

  it('shows plan approval controls and English/Turkish key coverage', () => {
    useAgentUiStore.getState().setSelectedRunId('run-1');
    renderSidebar({
      runs: [makeRun({ status: 'awaiting_approval' })],
      plan,
    });
    const planCard = screen.getByRole('heading', { name: 'agent.planTitle' }).closest('section');
    expect(planCard).not.toBeNull();
    expect(within(planCard as HTMLElement).getByText('agent.switchGuided')).toBeInTheDocument();

    expect(Object.keys(en.agent).sort()).toEqual(Object.keys(tr.agent).sort());
    expect(Object.keys(en.agent).length).toBeGreaterThan(40);
  });
});
