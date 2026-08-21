import { useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { Search, Undo2, Redo2, ChevronUp, ChevronDown, Replace, ReplaceAll, Save, Rainbow } from 'lucide-react';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { useUIStore } from '../../stores/uiStore';

interface EditorTopBarProps {
  editor: Editor | null;
  onSave: (editor: Editor | null) => void;
  /** Current document file name for the inline title */
  fileName?: string;
  /** Callback when title is committed */
  onTitleCommit?: (newName: string) => void;
}

interface FindState {
  matches: number[];
  index: number;
}

interface DocSearchState {
  query: string;
  replaceText: string;
}

export function EditorTopBar({ editor, onSave, fileName, onTitleCommit }: EditorTopBarProps) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [replaceText, setReplaceText] = useState('');
  const [findState, setFindState] = useState<FindState>({ matches: [], index: 0 });
  const [searchStateByDoc, setSearchStateByDoc] = useState<Record<string, DocSearchState>>({});
  const findInputRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLDivElement>(null);
  const committedTitle = fileName ?? '';
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(committedTitle);
  const [syncedFileName, setSyncedFileName] = useState(fileName);
  const titleInputRef = useRef<HTMLInputElement>(null);

  if (fileName !== syncedFileName) {
    setSyncedFileName(fileName);
    setTitleDraft(committedTitle);
    setIsEditingTitle(false);
  }

  const activeWs = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === s.activeWorkspaceId) ?? null
  );
  const currentFile = activeWs?.currentFile ?? null;
  const rainbowMode = useUIStore((s) => s.rainbowMode);
  const toggleRainbowMode = useUIStore((s) => s.toggleRainbowMode);

  useEffect(() => {
    if (isEditingTitle) {
      setTimeout(() => {
        titleInputRef.current?.focus();
        titleInputRef.current?.select();
      }, 0);
    }
  }, [isEditingTitle]);

  const startEditingTitle = () => {
    setTitleDraft(fileName ?? '');
    setIsEditingTitle(true);
  };

  const commitTitle = () => {
    const next = titleDraft.trim();
    if (next && next !== fileName) {
      onTitleCommit?.(next);
    }
    setIsEditingTitle(false);
  };

  const cancelTitleEdit = () => {
    setTitleDraft(fileName ?? '');
    setIsEditingTitle(false);
  };

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setSearchOpen(false);
      }
    };
    if (searchOpen) {
      document.addEventListener('mousedown', onDocClick);
    }
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [searchOpen]);

  const computeMatches = (q: string): number[] => {
    if (!editor || !q) return [];
    const text = editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n', '\n');
    const lower = text.toLowerCase();
    const needle = q.toLowerCase();
    const positions: number[] = [];
    let from = 0;
    while (from <= lower.length - needle.length) {
      const idx = lower.indexOf(needle, from);
      if (idx === -1) break;
      positions.push(idx);
      from = idx + needle.length;
    }
    return positions;
  };

  useEffect(() => {
    if (searchOpen) {
      const saved = currentFile ? searchStateByDoc[currentFile.path] : undefined;
      const q = saved?.query ?? '';
      setQuery(q); // eslint-disable-line react-hooks/set-state-in-effect -- restore per-doc search UI when panel opens
      setReplaceText(saved?.replaceText ?? '');
      setFindState({ matches: computeMatches(q), index: 0 });
      setTimeout(() => findInputRef.current?.focus(), 0);
    } else {
      if (currentFile) {
        setSearchStateByDoc((prev) => ({
          ...prev,
          [currentFile.path]: { query, replaceText },
        }));
      }
      setFindState({ matches: [], index: 0 });
    }
  }, [searchOpen, currentFile?.path]);

  const updateQuery = (q: string) => {
    setQuery(q);
    setFindState({ matches: computeMatches(q), index: 0 });
  };

  const goNext = () => {
    if (findState.matches.length === 0) return;
    setFindState((s) => ({ ...s, index: (s.index + 1) % s.matches.length }));
  };

  const goPrev = () => {
    if (findState.matches.length === 0) return;
    setFindState((s) => ({
      ...s,
      index: (s.index - 1 + s.matches.length) % s.matches.length,
    }));
  };

  const replaceOne = () => {
    if (!editor || !query || findState.matches.length === 0) return;
    const { state } = editor;
    const { doc } = state;
    let charPos = 0;
    let targetFrom = -1;
    let targetTo = -1;
    doc.descendants((node, pos) => {
      if (targetFrom !== -1) return false;
      if (node.isText) {
        const nodeText = node.text ?? '';
        const start = charPos;
        const end = charPos + nodeText.length;
        if (start <= findState.matches[findState.index] && findState.matches[findState.index] < end) {
          const offset = findState.matches[findState.index] - start;
          targetFrom = pos + offset;
          targetTo = targetFrom + query.length;
          return false;
        }
        charPos = end;
      }
      return true;
    });
    if (targetFrom === -1) return;
    editor
      .chain()
      .focus()
      .insertContentAt({ from: targetFrom, to: targetTo }, replaceText)
      .run();
    setFindState((s) => ({
      matches: computeMatches(query),
      index: Math.min(s.index, computeMatches(query).length - 1),
    }));
  };

  const replaceAll = () => {
    if (!editor || !query) return;
    const text = editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n', '\n');
    const regex = new RegExp(escapeRegex(query), 'gi');
    const replaced = text.replace(regex, replaceText);
    if (replaced === text) return;
    editor.chain().focus().setContent(replaced).run();
    setFindState({ matches: [], index: 0 });
  };

  const handleUndo = () => {
    if (!editor) return;
    editor.chain().focus().undo().run();
  };

  const handleRedo = () => {
    if (!editor) return;
    editor.chain().focus().redo().run();
  };

  return (
    <div id="editor-topbar" className="editor-topbar">
      <div className="editor-topbar-col">
        <button
          id="editor-topbar-save"
          type="button"
          className="tbar-btn"
          onClick={() => {
            void onSave(editor);
          }}
          disabled={!editor}
          title="Save"
          aria-label="Save"
        >
          <Save size={14} />
        </button>
        <div className="editor-topbar-title-wrapper" style={{ flex: 1, minWidth: 0 }}>
          {isEditingTitle ? (
            <input
              ref={titleInputRef}
              className="ctrl-xs editor-topbar-title-input"
              value={titleDraft}
              title="File name"
              placeholder="File name"
              aria-label="Document title"
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitTitle();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  cancelTitleEdit();
                }
              }}
              spellCheck={false}
            />
          ) : (
            <button
              type="button"
              className="ctrl-xs editor-topbar-title"
              onClick={startEditingTitle}
              title={fileName || 'Untitled'}
            >
              {fileName || 'Untitled'}
            </button>
          )}
        </div>
      </div>
      <div className="editor-topbar-col editor-topbar-col--right">
        <button
          id="editor-topbar-rainbow"
          type="button"
          className={`tbar-btn${rainbowMode ? ' tbar-btn--on' : ''}`}
          onClick={toggleRainbowMode}
          title={rainbowMode ? 'Rainbow mode on' : 'Rainbow mode'}
          aria-label="Rainbow mode"
          aria-pressed={rainbowMode}
        >
          <Rainbow size={14} />
        </button>
        <div className="relative" ref={searchRef}>
          <button
            id="editor-topbar-find"
            type="button"
            className={`tbar-btn${searchOpen ? ' tbar-btn--on' : ''}`}
            onClick={() => setSearchOpen((v) => !v)}
            title="Find & Replace"
          >
            <Search size={14} />
          </button>

          {searchOpen && (
            <div className="editor-topbar-search">
              <input
                ref={findInputRef}
                className="ctrl-xs editor-topbar-search-input"
                placeholder="Find"
                value={query}
                onChange={(e) => updateQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    if (e.shiftKey) goPrev(); else goNext();
                  } else if (e.key === 'Escape') {
                    setSearchOpen(false);
                  }
                }}
              />
              <input
                className="ctrl-xs editor-topbar-search-input"
                placeholder="Replace"
                value={replaceText}
                onChange={(e) => setReplaceText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    replaceOne();
                  } else if (e.key === 'Escape') {
                    setSearchOpen(false);
                  }
                }}
              />
              <div className="editor-topbar-search-footer">
                <span className="meta editor-topbar-search-count">
                  {query
                    ? findState.matches.length === 0
                      ? '0/0'
                      : `${findState.index + 1}/${findState.matches.length}`
                    : ''}
                </span>
                <div className="editor-topbar-search-actions">
                  <button
                    type="button"
                    className="tbar-btn"
                    onClick={goPrev}
                    disabled={findState.matches.length === 0}
                    title="Previous match"
                  >
                    <ChevronUp size={13} />
                  </button>
                  <button
                    type="button"
                    className="tbar-btn"
                    onClick={goNext}
                    disabled={findState.matches.length === 0}
                    title="Next match"
                  >
                    <ChevronDown size={13} />
                  </button>
                  <button
                    type="button"
                    className="tbar-btn"
                    onClick={replaceOne}
                    disabled={findState.matches.length === 0}
                    title="Replace current"
                  >
                    <Replace size={13} />
                  </button>
                  <button
                    type="button"
                    className="tbar-btn"
                    onClick={replaceAll}
                    disabled={findState.matches.length === 0}
                    title="Replace all"
                  >
                    <ReplaceAll size={13} />
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
        <button
          id="editor-topbar-undo"
          type="button"
          className="tbar-btn"
          onClick={handleUndo}
          disabled={!editor || !editor.can().undo()}
          title="Undo (Ctrl+Z)"
        >
          <Undo2 size={13} />
        </button>
        <button
          id="editor-topbar-redo"
          type="button"
          className="tbar-btn"
          onClick={handleRedo}
          disabled={!editor || !editor.can().redo()}
          title="Redo (Ctrl+Y)"
        >
          <Redo2 size={13} />
        </button>
      </div>
    </div>
  );
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
