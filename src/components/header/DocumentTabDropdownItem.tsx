import { useEffect, useRef, useState } from 'react';
import { Pencil, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Document } from '../../types';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { useFileSystemStore } from '../../stores/fileSystemStore';
import { useDocumentStore } from '../../stores/documentStore';
import { writeEditorContent } from '../../services/writeEditorFile';
import { pickSaveTabsPath, joinPath } from '../../services/fs-adapter';
import { getDocumentTabMeta } from './documentTabUtils';

interface DocumentTabDropdownItemProps {
  doc: Document;
  isActive: boolean;
  onSelect: () => void;
  onClose: () => void;
  onRename: (newTitle: string) => void;
}

export function DocumentTabDropdownItem({
  doc,
  isActive,
  onSelect,
  onClose,
  onRename,
}: DocumentTabDropdownItemProps) {
  const { t } = useTranslation();
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(doc.title);
  const [confirmClose, setConfirmClose] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const { rootNode } = useFileSystemStore();
  const { updateDocument } = useDocumentStore();
  const { isReplaceable, hasEdits } = getDocumentTabMeta(doc);

  useEffect(() => {
    if (isEditing) inputRef.current?.select();
  }, [isEditing]);

  const commitEdit = () => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== doc.title) {
      onRename(trimmed);
    }
    setIsEditing(false);
  };

  const handleSave = async () => {
    const editorJson = (() => {
      try {
        return JSON.parse(doc.content) as object;
      } catch {
        return { type: 'doc', content: [] };
      }
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

    // CASE 2: new/unsaved document -> show save dialog
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

  return (
    <>
      <div
        id={`tab-${doc.id}`}
        onClick={onSelect}
        onDoubleClick={() => {
          if (isActive) {
            setEditValue(doc.title);
            setIsEditing(true);
          }
        }}
        className={`tabs-dropdown-item${isActive ? ' tabs-dropdown-item--active' : ''}`}
      >
        <span
          className={`tabs-doc-marker${hasEdits ? ' tabs-doc-marker--edited' : ' tabs-doc-marker--clean'}`}
          aria-hidden
        />

        {isEditing ? (
          <input
            ref={inputRef}
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitEdit();
              if (e.key === 'Escape') {
                setIsEditing(false);
              }
            }}
            onClick={(e) => e.stopPropagation()}
            title={t('tabs.renameTab')}
            placeholder={t('tabs.tabNamePlaceholder')}
            className="tabs-dropdown-rename-input trunc"
          />
        ) : (
          <span className={`trunc med${isReplaceable ? ' italic' : ''}`}>{doc.title}</span>
        )}

        <button
          type="button"
          title={t('tabs.renameTab')}
          className="tabs-dropdown-close"
          onClick={(e) => {
            e.stopPropagation();
            setEditValue(doc.title);
            setIsEditing(true);
          }}
        >
          <Pencil size={12} />
        </button>

        <button
          type="button"
          title={t('tabs.closeTab')}
          className="tabs-dropdown-close"
          onClick={(e) => {
            e.stopPropagation();
            if (hasEdits) {
              setConfirmClose(true);
            } else {
              onClose();
            }
          }}
        >
          <X size={12} />
        </button>
      </div>

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
    </>
  );
}
