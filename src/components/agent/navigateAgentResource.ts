import type { AgentContextRef } from '../../types/agent';
import { useCrmStore } from '../../stores/crmStore';
import { useFormsStore } from '../../stores/formsStore';
import { useTaskStore } from '../../stores/taskStore';
import { useUIStore } from '../../stores/uiStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';

export function navigateAgentResource(ref: AgentContextRef): void {
  const ui = useUIStore.getState();

  if (ref.kind === 'task') {
    ui.setCrmMode(false);
    ui.setTaskMode(true);
    useTaskStore.getState().setActiveTask(ref.id);
    return;
  }

  if (ref.kind === 'crm') {
    ui.setTaskMode(false);
    ui.setCrmMode(true);
    ui.setActiveCRMPage('leads');
    useCrmStore.getState().setActiveLeadId(ref.id);
    return;
  }

  if (ref.kind === 'form') {
    ui.setTaskMode(false);
    ui.setCrmMode(true);
    ui.setActiveCRMPage('forms');
    ui.setActiveFormsPage('list');
    useFormsStore.getState().setActiveFormId(ref.id);
    return;
  }

  if (ref.kind === 'submission') {
    ui.setTaskMode(false);
    ui.setCrmMode(true);
    ui.setActiveCRMPage('forms');
    ui.setActiveFormsPage('submissions');
    useFormsStore.getState().setActiveSubmissionId(ref.id);
    return;
  }

  ui.setTaskMode(false);
  ui.setCrmMode(false);
  if (ref.kind === 'workspace') {
    useWorkspaceStore.getState().setActiveWorkspace(ref.id);
    return;
  }
  useUIStore.getState().setSelectedTreePath(ref.id);
}
