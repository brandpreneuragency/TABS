import type { AgentContextRef } from '../../types/agent';
import { useCrmStore } from '../../stores/crmStore';
import { useFormsStore } from '../../stores/formsStore';
import { useTaskStore } from '../../stores/taskStore';
import { useUIStore } from '../../stores/uiStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { useAgentUiStore } from '../../stores/agentUiStore';

function pushRef(refs: AgentContextRef[], ref: AgentContextRef | null): void {
  if (ref) refs.push(ref);
}

export function captureCurrentContext(): AgentContextRef[] {
  const ui = useUIStore.getState();
  const refs: AgentContextRef[] = [];

  if (ui.crmMode && ui.activeCRMPage === 'forms') {
    const forms = useFormsStore.getState();
    const form = forms.forms.find((item) => item.id === forms.activeFormId);
    const submission = forms.submissions.find((item) => item.id === forms.activeSubmissionId);
    if (forms.activeSubmissionId) {
      pushRef(refs, {
        kind: 'submission',
        id: forms.activeSubmissionId,
        label: submission?.id ?? forms.activeSubmissionId,
      });
    }
    if (forms.activeFormId) {
      pushRef(refs, {
        kind: 'form',
        id: forms.activeFormId,
        label: form?.name ?? forms.activeFormId,
      });
    }
    return refs;
  }

  if (ui.crmMode) {
    const crm = useCrmStore.getState();
    const lead = crm.leads.find((item) => item.id === crm.activeLeadId);
    if (crm.activeLeadId) {
      pushRef(refs, {
        kind: 'crm',
        id: crm.activeLeadId,
        label: lead?.title ?? crm.activeLeadId,
      });
    }
    return refs;
  }

  if (ui.taskMode) {
    const tasks = useTaskStore.getState();
    const task = tasks.tasks.find((item) => item.id === tasks.activeTaskId);
    if (tasks.activeTaskId) {
      pushRef(refs, {
        kind: 'task',
        id: tasks.activeTaskId,
        label: task?.title ?? tasks.activeTaskId,
      });
    }
    return refs;
  }

  const workspace = useWorkspaceStore.getState();
  const active = workspace.workspaces.find((item) => item.id === workspace.activeWorkspaceId);
  if (workspace.activeWorkspaceId) {
    pushRef(refs, {
      kind: 'workspace',
      id: workspace.activeWorkspaceId,
      label: active?.name ?? workspace.activeWorkspaceId,
    });
  }
  const currentFile = active?.currentFile;
  if (currentFile) {
    pushRef(refs, {
      kind: 'document',
      id: currentFile.path,
      label: currentFile.name,
      revision: currentFile.isDirty ? 'dirty' : undefined,
    });
  }
  return refs;
}

export function openAgentComposer(refs: AgentContextRef[]): void {
  const store = useAgentUiStore.getState();
  store.setPendingContextRefs(refs);
  store.setSelectedRunId(null);
  store.setViewMode('run');
  useUIStore.getState().setAssistantWrapperOpen(true);
}
