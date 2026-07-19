import { useEffect, useRef } from 'react';
import type { Editor } from '@tiptap/react';
import { useWorkspaceStore } from '../stores/workspaceStore';

export function useAutoSave(
  editor: Editor | null,
  workspaceId: string | null,
) {
  const updateFileContent = useWorkspaceStore((s) => s.updateFileContent);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!editor || !workspaceId) return;

    const handleUpdate = () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        const json = JSON.stringify(editor.getJSON());
        const ws = useWorkspaceStore.getState().workspaces.find((w) => w.id === workspaceId);
        if (!ws) return;

        const file = ws.currentFile;
        // Empty workspace: first non-empty edit becomes an IndexedDB draft.
        if (!file) {
          if (editor.isEmpty) return;
          updateFileContent(workspaceId, json, true);
          return;
        }

        // Skip if content is unchanged — avoids false dirty from non-edit updates
        if (file.content === json) return;
        updateFileContent(workspaceId, json, true);
      }, 300);
    };

    editor.on('update', handleUpdate);
    return () => {
      editor.off('update', handleUpdate);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [editor, workspaceId, updateFileContent]);
}
