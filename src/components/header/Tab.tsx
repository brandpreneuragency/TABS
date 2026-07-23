import { useState, useRef, useEffect } from 'react';
import { X, FileText } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Document } from '../../types';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { useFileSystemStore } from '../../stores/fileSystemStore';
import { useDocumentStore } from '../../stores/documentStore';
import { writeEditorContent } from '../../services/writeEditorFile';
import { getDocumentTabMeta } from './documentTabUtils';
import { pickSaveTabsPath, joinPath } from '../../services/fs-adapter';

interface TabProps {
  doc: Document;
  isActive: boolean;
  onSelect: () => void;
  onClose: () => void;
  onRename: (newTitle: string) => void;
  charLimit: number;
  colorIndex?: number;
}

export function Tab({ doc, isActive, onSelect, onClose, onRename, charLimit }: TabProps) {
  const { t } = useTranslation();
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(doc.title);
  const [confirmClose, setConfirmClose] = useState(false);
  const { rootNode } = useFileSystemStore();
  const { updateDocument } = useDocumentStore();

  const handleSave = async () => {
    const editorJson = (() => {
      try { return JSON.parse(doc.content) as object; } catch { return { type: 'doc', content: [] }; }
    })();

    // CASE 1: file already has a path (opened from tree or saved before)
    if (doc.sourcePath) {
      try {
        await writeEditorContent(doc.sourcePath, editorJson);
        await updateDocument(doc.id, { isDirty: false });
        setConfirmClose(false);
        onClose();
      } catch (err) {
        console.warn('[Close Save] disk write failed:', err);
      }
      return;
    }

    // CASE 2: new/unsaved file -> show save dialog
    const base = doc.title || 'Untitled';
    const filters = [
      { name: t('tabs.markdownFile'), extensions: ['md'] },
      { name: t('tabs.textFile'), extensions: ['txt'] },
      { name: t('tabs.wordDocument'), extensions: ['docx'] },
    ];
    const suggestedName = `${base}.md`;
    const defaultDir = rootNode?.fullPath;
    try {
      const newPath = await pickSaveTabsPath(
        suggestedName,
        filters,
        defaultDir ? joinPath(defaultDir, suggestedName) : suggestedName
      );
      if (!newPath) return;
      await writeEditorContent(newPath, editorJson);
      setConfirmClose(false);
      onClose();
    } catch (err) {
      console.error(err);
    }
  };
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing) inputRef.current?.select();
  }, [isEditing]);

  const handleDoubleClick = () => {
    if (isActive) {
      setEditValue(doc.title);
      setIsEditing(true);
    }
  };

  const commitEdit = () => {
    if (editValue.trim() && editValue !== doc.title) {
      onRename(editValue.trim());
    }
    setIsEditing(false);
  };

  const isEmpty = !doc.content?.includes('"text":');
  const isCleanFile = !!doc.sourcePath && !doc.isDirty;
  const isReplaceable = isEmpty || isCleanFile;
  const { hasEdits } = getDocumentTabMeta(doc);

  return (
    <div
      id={`tab-doc-${isActive ? 'active' : 'passive'}-${doc.id}`}
      onClick={onSelect}
      onDoubleClick={handleDoubleClick}
      onMouseDown={(e) => {
        e.stopPropagation();
        if (e.button === 1) {
          e.preventDefault();
          if (hasEdits) { setConfirmClose(true); } else { onClose(); }
        }
      }}
      className={`group relative justify-start min-w-0 pl-3 pr-1 ${isActive ? 'tab-active' : 'tab-passive'}`}
    >
      <>
        {isEditing ? (
          <input
            ref={inputRef}
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitEdit();
              if (e.key === 'Escape') { setIsEditing(false); }
            }}
            onClick={(e) => e.stopPropagation()}
            title={t('tabs.renameTab')}
            placeholder={t('tabs.tabNamePlaceholder')}
            className="txt-xs med bg-transparent outline-none w-24" style={{ borderBottom: '1px solid var(--c-accent-center-panel)' }}
          />
        ) : (
          <>
            <FileText size={12} className="mr-1 flex-shrink-0" />
            <span className={`txt-xs med trunc${isReplaceable ? ' italic' : ''}`}>
              {(doc.title ?? '').slice(0, charLimit)}{(doc.title ?? '').length > charLimit ? '…' : ''}
            </span>
          </>
        )}

        <button
          type="button"
          title={t('tabs.closeTab')}
          onClick={(e) => {
            e.stopPropagation();
            if (hasEdits) { setConfirmClose(true); } else { onClose(); }
          }}
          className="tab-close"
        >
          <X size={12} />
        </button>
      </>

      {confirmClose && (
        <ConfirmDialog
          message={t('tabs.closeConfirm')}
          onConfirm={() => {
            setConfirmClose(false);
            onClose();
          }}
          onCancel={() => setConfirmClose(false)}
          onSave={handleSave}
        />
      )}
    </div>
  );
}
