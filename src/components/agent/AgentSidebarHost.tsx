import { useCallback, useEffect, useMemo, useState } from 'react';
import { getDefaultAgentClient, type AgentClient } from '../../services/agent/agentClient';
import { buildQueuedAgentRun } from '../../services/agent/buildQueuedAgentRun';
import { useAIStore } from '../../stores/aiStore';
import { useAgentUiStore } from '../../stores/agentUiStore';
import { useUIStore } from '../../stores/uiStore';
import type { AgentApproval, AgentArtifact, AgentEvent, AgentRun, AgentToolCall } from '../../types/agent';
import { AgentSidebar } from './AgentSidebar';
import type { AgentUiActions } from './agentUiTypes';
import { captureCurrentContext } from './captureCurrentContext';
import { navigateAgentResource } from './navigateAgentResource';
import { planFromEvents } from './runPresentation';

function uniqueStrings(values: Array<string | undefined>): string[] {
  const seen = new Map<string, true>();
  const result: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.set(value, true);
    result.push(value);
  }
  return result;
}

interface AgentSidebarHostProps {
  client?: AgentClient;
}

export function AgentSidebarHost({ client }: AgentSidebarHostProps) {
  const agentClient = client ?? getDefaultAgentClient();
  const selectedRunId = useAgentUiStore((state) => state.selectedRunId);
  const setSelectedRunId = useAgentUiStore((state) => state.setSelectedRunId);
  const setLastFocusedRunId = useAgentUiStore((state) => state.setLastFocusedRunId);
  const setMode = useAgentUiStore((state) => state.setMode);
  const showToast = useUIStore((state) => state.showToast);
  const providerConfigs = useAIStore((state) => state.providerConfigs);

  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [approvals, setApprovals] = useState<AgentApproval[]>([]);
  const [artifacts, setArtifacts] = useState<AgentArtifact[]>([]);
  const [toolCalls, setToolCalls] = useState<AgentToolCall[]>([]);
  const [error, setError] = useState<string | null>(null);

  const providers = useMemo(
    () => providerConfigs.map((config) => ({
      id: config.id,
      name: config.name,
      models: uniqueStrings([
        ...(config.models ?? []).map((model) => model.id),
        ...config.customModels,
        config.selectedModel,
      ]),
    })),
    [providerConfigs],
  );

  const refresh = useCallback(async () => {
    try {
      const list = await agentClient.listRuns();
      setRuns(list);
      if (!selectedRunId) {
        setEvents([]);
        setApprovals([]);
        setArtifacts([]);
        setToolCalls([]);
        return;
      }
      const [nextEvents, nextApprovals, nextArtifacts, nextToolCalls] = await Promise.all([
        agentClient.getEvents(selectedRunId),
        agentClient.getApprovals(selectedRunId),
        agentClient.getArtifacts(selectedRunId),
        agentClient.getToolCalls(selectedRunId),
      ]);
      setEvents(nextEvents);
      setApprovals(nextApprovals);
      setArtifacts(nextArtifacts);
      setToolCalls(nextToolCalls);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [agentClient, selectedRunId]);

  useEffect(() => {
    const immediate = window.setTimeout(() => {
      void refresh();
    }, 0);
    const timer = window.setInterval(() => {
      void refresh();
    }, 2000);
    return () => {
      window.clearTimeout(immediate);
      window.clearInterval(timer);
    };
  }, [refresh]);

  const withError = useCallback(async (work: () => Promise<unknown>) => {
    try {
      await work();
      await refresh();
      setError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      showToast(message, 'error');
    }
  }, [refresh, showToast]);

  const actions: AgentUiActions = {
    create: async (input) => {
      const provider = providerConfigs.find((item) => item.id === input.providerId);
      const run = buildQueuedAgentRun(input, provider);
      await withError(async () => {
        const created = await agentClient.create(run);
        setSelectedRunId(created.id);
        setLastFocusedRunId(created.id);
      });
    },
    submitInput: (runId, content) => withError(() => agentClient.submitInput(runId, { content })),
    pause: (runId) => withError(() => agentClient.pause(runId)),
    resume: (runId) => withError(() => agentClient.resume(runId)),
    cancel: (runId) => withError(() => agentClient.cancel(runId, false)),
    retry: async (runId) => {
      await withError(async () => {
        const child = await agentClient.retry(runId);
        setSelectedRunId(child.id);
        setLastFocusedRunId(child.id);
      });
    },
    archive: (runId) => withError(() => agentClient.archive(runId)),
    queue: (runId) => withError(() => agentClient.queue(runId)),
    prioritizeQueue: (runId) => withError(() => agentClient.prioritizeQueue(runId)),
    answerApproval: (approval, decision, rejectedPlanAction) => (
      withError(() => agentClient.answerApproval(approval, decision, rejectedPlanAction))
    ),
    resolveReview: (runId, outcome) => withError(() => agentClient.resolveReview(runId, outcome)),
    switchToGuided: async () => {
      setMode('guided');
    },
    openResource: (ref) => {
      navigateAgentResource(ref);
    },
    captureCurrentContext,
  };

  return (
    <AgentSidebar
      runs={runs}
      events={events}
      approvals={approvals}
      artifacts={artifacts}
      toolCalls={toolCalls}
      plan={planFromEvents(events)}
      error={error}
      providers={providers}
      actions={actions}
    />
  );
}
