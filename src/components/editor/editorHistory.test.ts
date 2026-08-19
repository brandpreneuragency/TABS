import { describe, expect, it, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { UndoRedo } from '@tiptap/extensions/undo-redo';
import {
  replaceEditorDocument,
  resolveEditorHistoryShortcut,
} from './editorHistory';

function key(
  init: Partial<{
    key: string;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
  }> = {},
) {
  return {
    key: 'z',
    ctrlKey: true,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...init,
  };
}

describe('resolveEditorHistoryShortcut', () => {
  it('applies undo/redo only when focus is inside the editor workspace', () => {
    const root = document.createElement('div');
    const button = document.createElement('button');
    root.appendChild(button);

    expect(resolveEditorHistoryShortcut(key(), button, root, null)).toBe('undo');
    expect(
      resolveEditorHistoryShortcut(key({ key: 'y' }), button, root, null),
    ).toBe('redo');
    expect(
      resolveEditorHistoryShortcut(key({ shiftKey: true }), button, root, null),
    ).toBe('redo');
  });

  it('applies undo when the ProseMirror editor itself is focused', () => {
    const root = document.createElement('div');
    const editorDom = document.createElement('div');
    editorDom.contentEditable = 'true';
    root.appendChild(editorDom);

    expect(resolveEditorHistoryShortcut(key(), editorDom, root, editorDom)).toBe(
      'undo',
    );
  });

  it('lets native undo run in text fields inside the editor workspace', () => {
    const root = document.createElement('div');
    const textarea = document.createElement('textarea');
    const title = document.createElement('input');
    title.type = 'text';
    root.append(textarea, title);

    expect(resolveEditorHistoryShortcut(key(), textarea, root, null)).toBe(
      'ignore',
    );
    expect(resolveEditorHistoryShortcut(key(), title, root, null)).toBe(
      'ignore',
    );
  });

  it('does not undo the document when focus is in another workspace region', () => {
    const editorRoot = document.createElement('div');
    const sidebar = document.createElement('div');
    const chat = document.createElement('textarea');
    const otherButton = document.createElement('button');
    sidebar.append(chat, otherButton);

    expect(resolveEditorHistoryShortcut(key(), chat, editorRoot, null)).toBe(
      'ignore',
    );
    expect(
      resolveEditorHistoryShortcut(key(), otherButton, editorRoot, null),
    ).toBe('block');
  });

  it('ignores unrelated keys', () => {
    const root = document.createElement('div');
    const button = document.createElement('button');
    root.appendChild(button);

    expect(resolveEditorHistoryShortcut(key({ key: 's' }), button, root, null)).toBe(
      'ignore',
    );
    expect(
      resolveEditorHistoryShortcut(key({ ctrlKey: false }), button, root, null),
    ).toBe('ignore');
  });
});

describe('replaceEditorDocument', () => {
  const editors: Editor[] = [];

  afterEach(() => {
    while (editors.length) {
      editors.pop()?.destroy();
    }
  });

  function makeEditor(html: string) {
    const editor = new Editor({
      extensions: [
        StarterKit.configure({ undoRedo: false }),
        UndoRedo,
      ],
      content: html,
    });
    editors.push(editor);
    return editor;
  }

  it('does not let undo restore a previous workspace document', () => {
    const editor = makeEditor('<p>Workspace A</p>');
    editor.commands.insertContent(' edited');
    expect(editor.getText()).toContain('Workspace A');
    expect(editor.can().undo()).toBe(true);

    replaceEditorDocument(editor, '<p>Workspace B</p>');

    expect(editor.getText().trim()).toBe('Workspace B');
    expect(editor.can().undo()).toBe(false);

    editor.commands.undo();
    expect(editor.getText().trim()).toBe('Workspace B');
  });

  it('keeps undo local after editing the newly loaded document', () => {
    const editor = makeEditor('<p>Workspace A</p>');
    editor.commands.insertContent(' from A');

    replaceEditorDocument(editor, '<p>Workspace B</p>');
    editor.commands.insertContent(' from B');
    expect(editor.getText()).toContain('from B');

    editor.commands.undo();
    expect(editor.getText().trim()).toBe('Workspace B');
    expect(editor.getText()).not.toContain('from A');
  });
});
