import { createDocument, type Content, type Editor } from '@tiptap/core';
import type { Fragment, Node as ProseMirrorNode } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';

type EditorDocumentContent = Content | ProseMirrorNode | Fragment;

export type EditorHistoryShortcutAction = 'undo' | 'redo' | 'block' | 'ignore';

const TEXT_INPUT_TYPES = new Set([
  'text',
  'search',
  'email',
  'url',
  'tel',
  'password',
  'number',
  'date',
  'datetime-local',
  'month',
  'time',
  'week',
]);

function isHistoryShortcut(
  e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>,
): 'undo' | 'redo' | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  const key = e.key.toLowerCase();
  if (key === 'z' && !e.shiftKey) return 'undo';
  if (key === 'y' || (key === 'z' && e.shiftKey)) return 'redo';
  return null;
}

function isNativeTextEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLInputElement) {
    return TEXT_INPUT_TYPES.has(target.type);
  }
  return target.isContentEditable;
}

/**
 * Decide how Ctrl/Cmd+Z and Ctrl/Cmd+Y should behave.
 *
 * Undo/redo belong to the documents editor workspace only. Other panels
 * (AI sidebar, file tree, header) must not drive the document history, and
 * native text fields keep their own undo stacks.
 */
export function resolveEditorHistoryShortcut(
  e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>,
  target: EventTarget | null,
  editorRoot: ParentNode | null,
  editorDom: Node | null,
): EditorHistoryShortcutAction {
  const action = isHistoryShortcut(e);
  if (!action) return 'ignore';

  const inEditorDom =
    Boolean(editorDom) &&
    target instanceof Node &&
    (target === editorDom || editorDom!.contains(target));
  const inWorkspace =
    Boolean(editorRoot) &&
    target instanceof Node &&
    editorRoot!.contains(target);

  if (inEditorDom) return action;

  if (isNativeTextEditable(target)) return 'ignore';

  if (inWorkspace) return action;

  return 'block';
}

export function canReuseCachedEditorState(
  cached: EditorState,
  live: EditorState,
): boolean {
  const livePlugins = live.plugins;
  return (
    cached.plugins.length === livePlugins.length &&
    cached.plugins.every((plugin, i) => plugin === livePlugins[i])
  );
}

/**
 * Replace the editor document with a fresh history stack.
 * Used when switching workspace tabs / files so undo cannot walk back
 * into a different document.
 */
export function replaceEditorDocument(
  editor: Editor,
  content: EditorDocumentContent | null,
): void {
  const doc = content
    ? createDocument(content, editor.schema, editor.options.parseOptions)
    : editor.schema.topNodeType.createAndFill();

  if (!doc) return;

  editor.view.updateState(
    EditorState.create({
      doc,
      plugins: editor.state.plugins,
    }),
  );
}
