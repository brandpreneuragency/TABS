import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import TextAlign from '@tiptap/extension-text-align';
import { TextStyle } from '@tiptap/extension-text-style';
import Color from '@tiptap/extension-color';
import Highlight from '@tiptap/extension-highlight';
import Link from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
import Placeholder from '@tiptap/extension-placeholder';
import Typography from '@tiptap/extension-typography';
import FontFamily from '@tiptap/extension-font-family';
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import { Extension } from '@tiptap/core';
import { UndoRedo } from '@tiptap/extensions/undo-redo';
import { Fragment, Slice } from '@tiptap/pm/model';
import type { EditorView } from '@tiptap/pm/view';
import { ClearFormattingOnEnter } from './ClearFormattingOnEnter';
import { InlineTextPreset } from './InlineTextPreset';
import { useAutoSave } from '../../hooks/useAutoSave';
import { useUIStore } from '../../stores/uiStore';
import { getEditorStateCache } from '../../stores/workspaceStore';
import type { Editor } from '@tiptap/react';
import type { Content } from '@tiptap/core';
import {
  canReuseCachedEditorState,
  replaceEditorDocument,
  resolveEditorHistoryShortcut,
} from './editorHistory';

// Cache full ProseMirror editor states per file path so undo/redo history,
// selection, and scroll position survive file swaps in the same session.
// The cache is owned by workspaceStore so it can clear entries on save/discard.

// History extension with NO built-in keyboard shortcuts.
// Undo/redo are dispatched from a document keydown listener so they stay
// scoped to the documents editor workspace.
const CustomHistory = UndoRedo.extend({
  addKeyboardShortcuts() {
    return {};
  },
});

// Select-all stays in the keymap so it only runs while the editor is focused.
// Undo/redo are handled on document keydown in TipTapEditor so they cannot
// leak into the AI sidebar, file tree, or other workspaces.
const EditorShortcuts = Extension.create({
  name: 'editorShortcuts',
  priority: 150,

  addKeyboardShortcuts() {
    return {
      'Mod-a': () => this.editor.commands.selectAll(),
    };
  },
});

function sanitizePastedHTML(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll<HTMLElement>('[style]').forEach((el) => {
    el.style.removeProperty('color');
    el.style.removeProperty('background-color');
    el.style.removeProperty('background');
    if (!el.getAttribute('style')) el.removeAttribute('style');
  });
  doc.querySelectorAll('font[color]').forEach((el) => el.removeAttribute('color'));
  doc.querySelectorAll('mark').forEach((mark) => {
    const frag = document.createDocumentFragment();
    while (mark.firstChild) frag.appendChild(mark.firstChild);
    mark.parentNode?.replaceChild(frag, mark);
  });
  return doc.body.innerHTML;
}

function normalizeCopiedParagraphs(slice: Slice, view: EditorView): Slice {
  const paragraph = view.state.schema.nodes.paragraph;
  const hardBreak = view.state.schema.nodes.hardBreak;

  if (!paragraph || !hardBreak || slice.content.childCount <= 1) {
    return slice;
  }

  const topLevelNodes = Array.from({ length: slice.content.childCount }, (_, index) => slice.content.child(index));

  if (topLevelNodes.some((node) => node.type !== paragraph)) {
    return slice;
  }

  let mergedContent = Fragment.empty;

  topLevelNodes.forEach((node, index) => {
    if (index > 0) {
      mergedContent = mergedContent.append(Fragment.from(hardBreak.create()));
    }

    if (node.content.size > 0) {
      mergedContent = mergedContent.append(node.content);
    }
  });

  return new Slice(Fragment.from(paragraph.create(null, mergedContent)), slice.openStart, slice.openEnd);
}

interface TipTapEditorProps {
  fileId: string | null;
  workspaceId: string | null;
  initialContent: string;
  onEditorReady?: (editor: Editor) => void;
  editable?: boolean;
  title?: string;
  onTitleChange?: (title: string) => void;
}

export function TipTapEditor({
  fileId,
  workspaceId,
  initialContent,
  onEditorReady,
  editable = true,
  title,
  onTitleChange,
}: TipTapEditorProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const previousFileIdRef = useRef<string | null>(null);
  const editorStateCache = getEditorStateCache();
  const setSelectedText = useUIStore((s) => s.setSelectedText);
  const editorFontFamily = useUIStore((s) => s.editorFontFamily);
  const editorFontSize = useUIStore((s) => s.editorFontSize);

  const extensions = useMemo(
    () => [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        link: false,
        underline: false,
        undoRedo: false,
      }),
      CustomHistory,
      Underline,
      TextAlign.configure({ types: ['heading', 'paragraph'], alignments: ['left', 'center', 'right', 'justify'] }),
      TextStyle,
      InlineTextPreset,
      Color,
      FontFamily.configure({ types: ['textStyle'] }),
      Highlight.configure({ multicolor: true }),
      Link.configure({ openOnClick: false }),
      Image,
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
      TaskList,
      TaskItem.configure({ nested: true }),
      Placeholder.configure({ placeholder: 'Start writing...' }),
      Typography,
      ClearFormattingOnEnter,
      EditorShortcuts,
    ],
    []
  );

  const editorProps = useMemo(
    () => ({
      attributes: {
        class: 'tiptap-editor',
      },
      transformCopied: (slice: Slice, view: EditorView) => normalizeCopiedParagraphs(slice, view),
      transformPastedHTML: sanitizePastedHTML,
    }),
    []
  );

  const coreExtensionOptions = useMemo(
    () => ({
      clipboardTextSerializer: {
        blockSeparator: '\n',
      },
    }),
    []
  );

  const handleSelectionUpdate = useCallback(
    ({ editor: e }: { editor: Editor }) => {
      const { from, to } = e.state.selection;
      if (from !== to) {
        const text = e.state.doc.textBetween(from, to, ' ');
        const current = useUIStore.getState().selectedText;
        if (current?.text === text && current.from === from && current.to === to) return;
        setSelectedText({ text, from, to });
      } else {
        if (useUIStore.getState().selectedText === null) return;
        setSelectedText(null);
      }
    },
    [setSelectedText]
  );

  const editor = useEditor({
    coreExtensionOptions,
    extensions,
    content: '',
    editorProps,
    onSelectionUpdate: handleSelectionUpdate,
    shouldRerenderOnTransaction: false,
  });

  useEffect(() => {
    if (editor && onEditorReady) onEditorReady(editor);
  }, [editor, onEditorReady]);

  useEffect(() => {
    if (!editor) return;
    editor.setEditable(editable);
  }, [editor, editable]);

  useEffect(() => {
    // Apply font styles via wrapper DOM (not editor.view) so React Compiler
    // immutability rules do not treat this as mutating the useEditor return value.
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const el = wrapper.querySelector('.ProseMirror') as HTMLElement | null;
    if (el) {
      el.style.fontFamily = editorFontFamily;
      el.classList.remove('font-size-14', 'font-size-16');
      if (editorFontSize !== 12) el.classList.add(`font-size-${editorFontSize}`);
    }
    // Sync font-size class to the wrapper so the title input inherits the correct sizing
    wrapper.classList.remove('font-size-14', 'font-size-16');
    if (editorFontSize !== 12) wrapper.classList.add(`font-size-${editorFontSize}`);
  }, [editor, editorFontFamily, editorFontSize]);

  // Load content when file changes, preserving full editor state (including
  // undo/redo history) per file path for the lifetime of the session.
  // Only reuse a cached EditorState when it belongs to THIS editor instance
  // (same plugin object identity). States cached from a destroyed instance
  // (e.g. after remount) must not be passed to updateState — that leaves the
  // new view unable to render subsequent setContent calls.
  // Uncached loads use a fresh history stack so undo cannot walk into another
  // workspace's document.
  useEffect(() => {
    if (!editor) return;
    try {
      const prevId = previousFileIdRef.current;
      if (prevId && prevId !== fileId) {
        editorStateCache.set(prevId, editor.state);
      }

      const cached = fileId ? editorStateCache.get(fileId) : undefined;
      if (cached) {
        if (canReuseCachedEditorState(cached, editor.state)) {
          editor.view.updateState(cached);
        } else {
          replaceEditorDocument(editor, cached.doc);
          editorStateCache.delete(fileId!);
        }
      } else {
        const parsed = initialContent
          ? (JSON.parse(initialContent) as Content)
          : null;
        replaceEditorDocument(editor, parsed);
      }
      previousFileIdRef.current = fileId;
    } catch {
      replaceEditorDocument(editor, null);
    }
  }, [editor, fileId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Ctrl/Cmd+Z and Ctrl/Cmd+Y only affect this documents editor while focus is
  // inside its workspace. Other panels keep native undo or are blocked so the
  // unfocused editor is not mutated by document-global native undo.
  useEffect(() => {
    if (!editor) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const editorRoot =
        wrapperRef.current?.closest('#editor-column') ?? wrapperRef.current;
      const action = resolveEditorHistoryShortcut(
        e,
        e.target,
        editorRoot,
        editor.view.dom,
      );
      if (action === 'ignore' || action === 'block') return;
      e.preventDefault();
      if (!editor.isEditable) return;
      if (action === 'undo') editor.commands.undo();
      else editor.commands.redo();
    };
    const onBeforeInput = (e: Event) => {
      const inputType = (e as InputEvent).inputType;
      if (inputType !== 'historyUndo' && inputType !== 'historyRedo') return;
      const active = document.activeElement;
      const editorDom = editor.view.dom;
      if (active && (active === editorDom || editorDom.contains(active))) return;
      e.preventDefault();
    };
    document.addEventListener('keydown', onKeyDown);
    editor.view.dom.addEventListener('beforeinput', onBeforeInput);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      editor.view.dom.removeEventListener('beforeinput', onBeforeInput);
    };
  }, [editor]);

  // Save the current file's editor state when the editor unmounts (e.g.
  // switching to Settings/CRM/Task mode) so undo/redo survives those trips too.
  useEffect(() => {
    return () => {
      const currentId = previousFileIdRef.current;
      if (currentId && editor) {
        editorStateCache.set(currentId, editor.state);
      }
    };
  }, [editor]);

  useAutoSave(editor ?? null, workspaceId);

  const showTitleInput = false; // toggle to true to re-enable the h1 title field

  return (
    <div ref={wrapperRef} className="w-full">
      {showTitleInput && (
        <input
          type="text"
          className="doc-title-field"
          value={title ?? ''}
          onChange={(e) => onTitleChange?.(e.target.value)}
          placeholder="Untitled"
        />
      )}
      <EditorContent editor={editor} />
    </div>
  );
}
