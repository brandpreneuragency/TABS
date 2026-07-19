// Save the active workspace file to disk.
// Syncs TipTap editor JSON into the workspace store, then writes via saveCurrentFile.
// Empty workspaces with content are first promoted to an IndexedDB draft, then
// saveCurrentFile routes drafts through Save As.
import { useCallback } from 'react';
import type { Editor } from '@tiptap/react';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { useUIStore } from '../stores/uiStore';

export function useSaveDocument() {
  return useCallback(async (editor: Editor | null) => {
    if (!editor) return;

    const { activeWorkspaceId, workspaces, updateFileContent, saveCurrentFile } =
      useWorkspaceStore.getState();
    if (!activeWorkspaceId) return;

    const json = JSON.stringify(editor.getJSON());
    let ws = workspaces.find((w) => w.id === activeWorkspaceId);

    if (!ws?.currentFile) {
      if (editor.isEmpty) {
        useUIStore.getState().showToast('Open a file to save.', 'info');
        return;
      }
      // Paste/type before the autosave debounce — create the draft now.
      updateFileContent(activeWorkspaceId, json, true);
      ws = useWorkspaceStore.getState().workspaces.find((w) => w.id === activeWorkspaceId);
      if (!ws?.currentFile) return;
    } else {
      updateFileContent(activeWorkspaceId, json, true);
    }

    try {
      await saveCurrentFile(activeWorkspaceId);
      const after = useWorkspaceStore.getState().workspaces.find((w) => w.id === activeWorkspaceId);
      if (after?.currentFile && !after.currentFile.isDirty) {
        useUIStore.getState().showToast('Saved', 'info');
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to save';
      useUIStore.getState().showToast(message, 'error');
    }
  }, []);
}
