import { useState, useRef, useCallback, useEffect } from 'react';
import type { DragEvent as ReactDragEvent, KeyboardEvent as ReactKeyboardEvent, ChangeEvent } from 'react';
import { Reply, Zap, Plus, X, Square, Brain, User, File, Folder, Shield } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useUIStore } from '../../stores/uiStore';
import { useActionsStore } from '../../stores/actionsStore';
import { useChatStore } from '../../stores/chatStore';
import { useAIStore } from '../../stores/aiStore';
import { useStreamingChat } from '../../hooks/useStreamingChat';
import { useWorkspaceStore, flattenTree, findNodeByFullPath } from '../../stores/workspaceStore';
import type { TreeNode } from '../../stores/workspaceStore';
import { readBinaryFile, basename, getExt } from '../../services/fs-adapter';
import { isImageFile } from '../../utils/fileType';
import { db } from '../../services/db';
import { usePlaceholder } from '../../utils/placeholders';
import {
  ComposerCard,
  ComposerIconButton,
  ComposerRow,
  ComposerSendButton,
  ComposerTextarea,
} from '../ui/Composer';
import { AttachmentPreviewItem, AttachmentPreviewList } from '../ui/AttachmentPreview';
import { ReasoningDropup } from './ReasoningDropup';
import type { Attachment, ChatMessage, QuickPrompt } from '../../types';

interface ChatInputProps {
  mode: 'writer' | 'task';
  threadId: string;
  workspaceId: string | null;
  taskId?: string | null;
  settingsTab?: string | null;
  replyToMessage?: ChatMessage | null;
  onClearReply?: () => void;
}

/** Max height for the chat input box, expressed as 50vw in pixels. */
function maxHeightVw(): number {
  return Math.round(window.innerWidth * 0.5);
}
const MAX_FILE_BYTES = 4 * 1024 * 1024;
/** Vision-friendly image MIME types sent as multimodal image_url parts. */
const IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/svg+xml',
]);

/** Convert raw bytes to a base64 string (chunked to avoid call-stack limits). */
function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function imageMimeFromPath(path: string): string {
  const ext = getExt(path);
  const sub = ext === 'jpg' ? 'jpeg' : ext || 'png';
  return `image/${sub}`;
}

/** Detect an active @-mention immediately preceding the caret. Returns the
 *  query substring and the index of the `@` (or null when none is active). */
function detectMention(text: string, caret: number): { query: string; start: number } | null {
  let i = caret - 1;
  while (i >= 0) {
    const ch = text[i];
    if (/\s/.test(ch)) return null;
    if (ch === '@') {
      const before = i - 1;
      if (before < 0 || /\s/.test(text[before])) {
        return { query: text.slice(i + 1, caret), start: i };
      }
      return null;
    }
    i--;
  }
  return null;
}

interface PromptOption extends QuickPrompt {
  builtin?: boolean;
}

const TASK_BUILT_INS: PromptOption[] = [
  {
    id: 'builtin_task_summarize',
    title: 'Summarize Task',
    prompt: 'Summarize this task with status, blockers, and next steps.',
    scope: 'task',
    createdAt: 0,
    builtin: true,
  },
  {
    id: 'builtin_task_subtasks',
    title: 'Create Subtasks',
    prompt: 'Create actionable subtasks from this task context.',
    scope: 'task',
    createdAt: 0,
    builtin: true,
  },
  {
    id: 'builtin_task_next_steps',
    title: 'Next Steps',
    prompt: 'List the next concrete steps in priority order.',
    scope: 'task',
    createdAt: 0,
    builtin: true,
  },
  {
    id: 'builtin_task_update_details',
    title: 'Update Details',
    prompt: 'Propose updates for title, notes, dates, and status based on this context.',
    scope: 'task',
    createdAt: 0,
    builtin: true,
  },
  {
    id: 'builtin_task_split',
    title: 'Split Into Tasks',
    prompt: 'Split this work into smaller tasks and subtasks with clear ownership.',
    scope: 'task',
    createdAt: 0,
    builtin: true,
  },
];

export function ChatInput({ mode, threadId, workspaceId, taskId, settingsTab, replyToMessage, onClearReply }: ChatInputProps) {
  const { t } = useTranslation();
  const accentColor = 'var(--c-accent-2)';
  const [value, setValue] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const queryAIPlaceholder = usePlaceholder('queryAI');

  // Dropdown states
  const [actionsDropdownOpen, setActionsDropdownOpen] = useState(false);
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [agentDropdownOpen, setAgentDropdownOpen] = useState(false);
  const [quickPrompts, setQuickPrompts] = useState<QuickPrompt[]>([]);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const modelRef = useRef<HTMLDivElement>(null);
  const agentRef = useRef<HTMLDivElement>(null);
  const userHeightRef = useRef<number>(0);
  const mentionRef = useRef<HTMLDivElement>(null);
  const indexedNodesRef = useRef<TreeNode[] | null>(null);
  const indexedFolderRef = useRef<string | null>(null);

  const { getActiveRootNode, getActiveFolderId, ensureSubtreeLoaded, activeWorkspaceId } = useWorkspaceStore();
  const rootNode = getActiveRootNode();
  const activeFolderId = getActiveFolderId();

  const [dragOver, setDragOver] = useState(false);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionStart, setMentionStart] = useState<number | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [indexedNodes, setIndexedNodes] = useState<TreeNode[]>([]);
  const [indexedFolderId, setIndexedFolderId] = useState<string | null>(null);

  // Filter the indexed workspace tree by the active @-mention query.
  const filtered = indexedNodes.length
    ? indexedNodes
        .filter((n) => {
          const q = mentionQuery.toLowerCase();
          return q === '' || (n.path + ' ' + n.name).toLowerCase().includes(q);
        })
        .slice(0, 50)
    : [];
  const indexing = mentionOpen && indexedFolderId !== activeFolderId;

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [workspaceId, taskId]);

  const { selectedText } = useUIStore();
  const { isStreaming } = useChatStore();
  const {
    getActiveAgent,
    getAgentsByScope,
    activeAgentId,
    activeTaskAgentId,
    setActiveAgent,
    providerConfigs,
    activeProviderId,
    setActiveProvider,
    setActiveModel,
    isModelHidden,
  } = useAIStore();
  const { openSettings } = useUIStore();
  const { sendMessage, stopStreaming } = useStreamingChat(threadId, mode, workspaceId ?? undefined, taskId ?? undefined, settingsTab ?? undefined);

  const activeAgent = getActiveAgent(mode);
  const scopedAgents = getAgentsByScope(mode);
  const activeScopedId = mode === 'task' ? activeTaskAgentId : activeAgentId;
  const activeConfig = providerConfigs.find((config) => config.id === activeProviderId);
  const activeModelName = activeConfig?.models?.find((m) => m.id === activeConfig.selectedModel)?.name;
  const modelLabel = activeConfig ? (activeModelName || activeConfig.selectedModel || t('sidebar.noModel')) : t('sidebar.noModel');
  const actionsLabel = t('chat.actions');
  // Whether the active model advertises tool support (defaults to true).
  const toolsSupported = activeConfig?.models?.find((m) => m.id === activeConfig.selectedModel)?.supportsTools ?? true;

  // Outside-click dismissal for dropdowns
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (actionsRef.current && !actionsRef.current.contains(e.target as Node)) setActionsDropdownOpen(false);
      if (modelRef.current && !modelRef.current.contains(e.target as Node)) setModelDropdownOpen(false);
      if (agentRef.current && !agentRef.current.contains(e.target as Node)) setAgentDropdownOpen(false);
      if (mentionRef.current && !mentionRef.current.contains(e.target as Node)) {
        setMentionOpen(false);
        setMentionStart(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Load quick prompts when actions dropdown opens
  useEffect(() => {
    if (actionsDropdownOpen) {
      db.quickPrompts
        .where('scope')
        .equals(mode)
        .reverse()
        .sortBy('createdAt')
        .then(setQuickPrompts);
    }
  }, [actionsDropdownOpen, mode]);

  // Handle quick prompt selection from other components
  useEffect(() => {
    const handler = (e: Event) => {
      const prompt = (e as CustomEvent<string>).detail;
      setValue(prompt);
      textareaRef.current?.focus();
    };
    window.addEventListener('quickPromptSelected', handler);
    return () => window.removeEventListener('quickPromptSelected', handler);
  }, []);

  const handleSend = useCallback(async () => {
    const trimmed = value.trim();
    if ((!trimmed && attachments.length === 0) || isStreaming) return;
    const toSend = attachments.slice();
    const replyData = replyToMessage
      ? {
          id: replyToMessage.id,
          role: (replyToMessage.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
          content: replyToMessage.content.slice(0, 200),
          sender: replyToMessage.role === 'user' ? 'You' : 'Assistant',
        }
      : undefined;
    setValue('');
    setAttachments([]);
    onClearReply?.();
    userHeightRef.current = 0;
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
    try {
      await sendMessage(
        trimmed,
        selectedText?.text,
        selectedText?.from,
        selectedText?.to,
        toSend.length ? toSend : undefined,
        true,
        replyData
      );
    } catch (err) {
      console.error('Chat error:', err);
    }
  }, [value, attachments, isStreaming, sendMessage, selectedText, replyToMessage, onClearReply]);

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionIndex((i) => Math.min(i + 1, Math.max(filtered.length - 1, 0)));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (filtered[mentionIndex]) selectMention(filtered[mentionIndex]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMentionOpen(false);
        setMentionStart(null);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInput = () => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    const max = maxHeightVw();
    const base = Math.max(ta.scrollHeight, userHeightRef.current || 0);
    ta.style.height = `${Math.min(Math.max(base, 32), max)}px`;
  };

  const handleResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const ta = textareaRef.current;
    if (!ta) return;
    const startY = e.clientY;
    const startHeight = ta.offsetHeight;
    const max = maxHeightVw();

    const onMove = (ev: MouseEvent) => {
      // Dragging the handle up (negative delta) grows the box upward.
      const next = Math.min(Math.max(startHeight - (ev.clientY - startY), 32), max);
      userHeightRef.current = next;
      ta.style.height = `${next}px`;
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    const toast = (msg: string) => useUIStore.getState().showToast(msg, 'error');
    for (const file of files) {
      if (file.size > MAX_FILE_BYTES) {
        toast(`"${file.name}" is too large (max ${Math.round(MAX_FILE_BYTES / (1024 * 1024))} MB).`);
        continue;
      }
      if (file.size === 0) {
        toast(`"${file.name}" is empty.`);
        continue;
      }

      const mimeType =
        file.type ||
        (isImageFile(file.name) ? imageMimeFromPath(file.name) : 'application/octet-stream');
      const asImage =
        IMAGE_MIME_TYPES.has(mimeType) ||
        (mimeType.startsWith('image/') && isImageFile(file.name));

      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        if (asImage) {
          addAttachment({
            name: file.name,
            dataUrl,
            mimeType,
            kind: 'image',
          });
        } else {
          addAttachment({
            name: file.name,
            dataUrl,
            mimeType,
            kind: 'file',
          });
        }
      };
      reader.onerror = () => {
        toast(`Failed to read "${file.name}".`);
      };
      reader.readAsDataURL(file);
    }
  };

  const addAttachment = (att: Attachment) => {
    setAttachments((prev) => {
      if (att.path && prev.some((p) => p.path === att.path)) return prev;
      if (!att.path && prev.some((p) => p.name === att.name && p.dataUrl === att.dataUrl)) return prev;
      return [...prev, att];
    });
  };

  const removeAttachment = (index: number) => {
    setAttachments((prev) => {
      const att = prev[index];
      if (att) {
        const token = '@' + att.name;
        setValue((v) => (v.includes(token) ? v.replace(token, '') : v));
      }
      return prev.filter((_, i) => i !== index);
    });
  };

  const insertTokenAtCaret = (token: string) => {
    const ta = textareaRef.current;
    const current = ta ? ta.value : value;
    const caret = ta ? ta.selectionStart ?? current.length : current.length;
    const before = current.slice(0, caret);
    const after = current.slice(caret);
    const needsLeadingSpace = before.length > 0 && !/\s$/.test(before);
    const insertText = (needsLeadingSpace ? ' ' : '') + token + ' ';
    const newValue = before + insertText + after;
    setValue(newValue);
    requestAnimationFrame(() => {
      const ta2 = textareaRef.current;
      if (ta2) {
        const pos = before.length + insertText.length;
        ta2.focus();
        ta2.setSelectionRange(pos, pos);
        handleInput();
      }
    });
  };

  const attachDroppedPath = async (
    fullPath: string,
    kind: 'file' | 'directory',
    displayPath?: string,
  ) => {
    const resolvedKind: 'file' | 'folder' = kind === 'directory' ? 'folder' : 'file';
    const name = basename(fullPath);
    if (resolvedKind === 'file' && isImageFile(fullPath)) {
      try {
        const bytes = await readBinaryFile(fullPath);
        const mime = imageMimeFromPath(fullPath);
        const dataUrl = `data:${mime};base64,${uint8ToBase64(bytes)}`;
        addAttachment({ name, dataUrl, mimeType: mime, kind: 'image' });
      } catch {
        /* ignore unreadable images */
      }
      return;
    }
    const disp =
      displayPath || (rootNode ? findNodeByFullPath(rootNode, fullPath)?.path : undefined) || name;
    insertTokenAtCaret('@' + name);
    addAttachment({
      name,
      kind: resolvedKind,
      path: fullPath,
      displayPath: disp,
      mimeType: resolvedKind === 'folder' ? 'folder' : 'text/plain',
    });
  };

  const handleDragOver = (e: ReactDragEvent<HTMLDivElement>) => {
    const types = e.dataTransfer.types;
    if (types.includes('application/x-tabs-tree-node') || types.includes('text/plain')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      setDragOver(true);
    }
  };

  const handleDragLeave = (e: ReactDragEvent<HTMLDivElement>) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setDragOver(false);
  };

  const handleDrop = (e: ReactDragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const raw = e.dataTransfer.getData('application/x-tabs-tree-node');
    let fullPath: string | undefined;
    let kind: 'file' | 'directory' | undefined;
    let displayPath: string | undefined;
    if (raw) {
      try {
        const payload = JSON.parse(raw) as { fullPath: string; kind: string; path: string };
        fullPath = payload.fullPath;
        kind = payload.kind as 'file' | 'directory';
        displayPath = payload.path;
      } catch {
        /* fall through to text/plain */
      }
    }
    if (!fullPath) {
      const text = e.dataTransfer.getData('text/plain');
      if (!text) return;
      fullPath = text;
      const node = rootNode ? findNodeByFullPath(rootNode, fullPath) : null;
      if (node) {
        kind = node.kind;
        displayPath = node.path;
      }
    }
    if (fullPath && kind) {
      void attachDroppedPath(fullPath, kind, displayPath);
    }
  };

  const handleChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    const next = e.target.value;
    setValue(next);
    handleInput();
    const caret = e.target.selectionStart ?? next.length;
    const m = detectMention(next, caret);
    if (m) {
      setMentionStart(m.start);
      setMentionQuery(m.query);
      setMentionIndex(0);
      setMentionOpen(true);
    } else {
      setMentionOpen(false);
      setMentionStart(null);
    }
  };

  const selectMention = (node: TreeNode) => {
    if (mentionStart === null) return;
    const ta = textareaRef.current;
    const caret = ta ? ta.selectionStart ?? value.length : value.length;
    const start = mentionStart;
    const before = value.slice(0, start);
    const after = value.slice(caret);
    const token = '@' + node.name;
    const needsTrailingSpace = after.length > 0 && !/^\s/.test(after);
    const inserted = token + (needsTrailingSpace ? ' ' : '');
    const newValue = before + inserted + after;
    setValue(newValue);
    addAttachment({
      name: node.name,
      kind: node.kind === 'directory' ? 'folder' : 'file',
      path: node.fullPath,
      displayPath: node.path,
      mimeType: node.kind === 'directory' ? 'folder' : 'text/plain',
    });
    setMentionOpen(false);
    setMentionStart(null);
    requestAnimationFrame(() => {
      const ta2 = textareaRef.current;
      if (ta2) {
        const pos = before.length + inserted.length;
        ta2.focus();
        ta2.setSelectionRange(pos, pos);
        handleInput();
      }
    });
  };

  useEffect(() => {
    if (!mentionOpen) return;
    if (indexedFolderId === activeFolderId && indexedNodesRef.current) return;
    if (!rootNode || !activeWorkspaceId) return;
    let cancelled = false;
    ensureSubtreeLoaded(activeWorkspaceId, rootNode.fullPath)
      .then(() => {
        if (cancelled) return;
        indexedNodesRef.current = flattenTree(useWorkspaceStore.getState().getActiveRootNode());
        indexedFolderRef.current = activeFolderId;
        setIndexedNodes(indexedNodesRef.current);
        setIndexedFolderId(activeFolderId);
      })
      .catch(() => {
        if (cancelled) return;
        setIndexedFolderId(activeFolderId);
      });
    return () => {
      cancelled = true;
    };
  }, [mentionOpen, activeFolderId, indexedFolderId, rootNode, ensureSubtreeLoaded, activeWorkspaceId]);

  const canSend = (value.trim().length > 0 || attachments.length > 0) && !isStreaming;
  const promptOptions: PromptOption[] = mode === 'task' ? [...TASK_BUILT_INS, ...quickPrompts] : quickPrompts;

  return (
    <div style={{ flexShrink: 0, padding: 0, height: 'fit-content' }}>
      {selectedText && (
        <div style={{ marginBottom: 8, fontSize: 'var(--fs-xs)', color: accentColor, background: 'var(--c-background-4)', borderRadius: 6, padding: '6px 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="med">{t('chat.context')}</span>
          <span className="trunc italic subtle">
            {selectedText.text.slice(0, 60)}{selectedText.text.length > 60 ? '...' : ''}
          </span>
        </div>
      )}

      {replyToMessage && (
        <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8, background: 'var(--c-background-4)', borderRadius: 8, padding: '6px 10px', fontSize: 'var(--fs-sm)', border: '1px solid var(--c-border-1)' }}>
          <Reply size={12} style={{ color: accentColor, flexShrink: 0 }} />
          <div style={{ display: 'flex', alignItems: 'stretch', gap: 6, flex: 1, overflow: 'hidden' }}>
            <div style={{ width: 2, borderRadius: 1, background: accentColor, flexShrink: 0 }} />
            <div style={{ overflow: 'hidden', minWidth: 0 }}>
              <div className="semibold" style={{ fontSize: 'var(--fs-sm)', color: accentColor, marginBottom: 1 }}>
                {replyToMessage.role === 'user' ? 'You' : 'Assistant'}
              </div>
              <div className="subtle trunc" style={{ fontSize: 'var(--fs-sm)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {replyToMessage.content.slice(0, 120)}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClearReply}
            className="btn-icon shrink-0"
            title="Cancel reply"
            style={{ width: 'var(--control-height-sm)', height: 'var(--control-height-sm)' }}
          >
            <X size={10} />
          </button>
        </div>
      )}

      <ComposerCard
        id="chat-input-card"
        className={dragOver ? 'composer-dropzone composer-dropzone--active' : 'composer-dropzone'}
        data-drag-over={dragOver ? true : undefined}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div
          className="composer-resize-handle"
          onMouseDown={handleResizeStart}
          title="Drag up to expand"
        />
        {attachments.length > 0 && (
          <AttachmentPreviewList>
            {attachments.map((att, i) => (
              <AttachmentPreviewItem
                key={`${att.path || att.name}-${i}`}
                item={{
                  name: att.name,
                  kind: att.kind,
                  dataUrl: att.dataUrl,
                  mimeType: att.mimeType,
                  displayPath: att.displayPath,
                }}
                onRemove={() => removeAttachment(i)}
                removeTitle={
                  att.kind === 'file' || att.kind === 'folder'
                    ? t('chat.removeFileAttachment')
                    : t('chat.removeAttachment')
                }
              />
            ))}
          </AttachmentPreviewList>
        )}

        <ComposerTextarea
          id="chat-input"
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder={queryAIPlaceholder || t('chat.askPlaceholder', { name: activeAgent.name })}
          rows={1}
          style={{ padding: '18px 18px 0' }}
        />

        {mentionOpen && (
          <div ref={mentionRef} className="drop chat-mention-dropup" style={{ left: 12, right: 12, bottom: '100%', marginBottom: 4, maxHeight: 240, overflowY: 'auto' }}>
            {indexing ? (
              <div className="subtle" style={{ padding: '8px 12px', fontSize: 'var(--fs-base)' }}>{t('chat.indexing')}</div>
            ) : filtered.length === 0 ? (
              <div className="subtle" style={{ padding: '8px 12px', fontSize: 'var(--fs-base)' }}>{t('chat.noMatches')}</div>
            ) : (
              filtered.map((node, idx) => (
                <button
                  type="button"
                  key={node.fullPath}
                  onClick={() => selectMention(node)}
                  className={`drop-item${idx === mentionIndex ? ' header-dropdown-item--active' : ''}`}
                  style={{ fontSize: 'var(--fs-base)' }}
                  onMouseEnter={() => setMentionIndex(idx)}
                >
                  {node.kind === 'directory' ? (
                    <Folder size={13} className="composer-chip-icon" />
                  ) : (
                    <File size={13} className="composer-chip-icon" />
                  )}
                  <span className="trunc med">{node.path}</span>
                </button>
              ))
            )}
          </div>
        )}

        <ComposerRow className="chat-input-bottom-row">
          <div className="chat-input-bottom-col chat-input-bottom-col--left">
            <div className="chat-input-bottom-col chat-input-bottom-col--tools">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                aria-label={t('chat.attachFile')}
                style={{ display: 'none' }}
                onChange={handleFileChange}
              />
              <ComposerIconButton
                onClick={() => fileInputRef.current?.click()}
                className="composer-attach-button"
                title={t('chat.attachFile')}
              >
                <Plus size={14} />
              </ComposerIconButton>

              <div ref={actionsRef} className="relative">
                <ComposerIconButton
                  onClick={() => setActionsDropdownOpen((v) => !v)}
                  className="chat-input-dropup-btn"
                  title={t('chat.actions')}
                  aria-label={actionsLabel}
                  aria-haspopup="menu"
                  aria-expanded={actionsDropdownOpen}
                >
                  <Zap size={14} className="chat-input-dropup-icon" />
                </ComposerIconButton>
                {actionsDropdownOpen && (
                  <div className="drop" style={{ left: 0, bottom: '100%', marginBottom: 4, minWidth: 192 }}>
                    {promptOptions.length === 0 ? (
                      <div className="subtle" style={{ padding: '8px 12px', fontSize: 'var(--fs-base)' }}>{t('chat.noActions')}</div>
                    ) : (
                      promptOptions.map((qp) => (
                        <button
                          type="button"
                          key={qp.id}
                          onClick={() => {
                            window.dispatchEvent(new CustomEvent('quickPromptSelected', { detail: qp.prompt }));
                            setActionsDropdownOpen(false);
                          }}
                          className="drop-item"
                        >
                          <Zap size={11} style={{ color: accentColor, flexShrink: 0 }} />
                          <span className="trunc med">{qp.title}</span>
                        </button>
                      ))
                    )}
                    <div style={{ borderTop: '1px solid var(--c-border-1)', marginTop: 0, paddingTop: 0 }}>
                      <button
                        type="button"
                        onClick={() => {
                          useActionsStore.getState().setScope(mode);
                          openSettings('actions');
                          setActionsDropdownOpen(false);
                        }}
                        className="drop-item drop-item--brand"
                      >
                        {t('chat.manageActions')}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div ref={agentRef} className="chat-input-bottom-col chat-input-bottom-col--agent">
              <button
                type="button"
                onClick={() => { setAgentDropdownOpen((v) => !v); setModelDropdownOpen(false); }}
                className="chat-input-dropup-btn"
                data-active="true"
                style={{ color: accentColor }}
                aria-label={activeAgent.name}
                aria-haspopup="menu"
                aria-expanded={agentDropdownOpen}
              >
                <User size={12} className="chat-input-dropup-icon" />
                <span className="trunc med chat-input-dropup-label">{activeAgent.name}</span>
              </button>
              {agentDropdownOpen && (
                <div className="drop" style={{ left: 0, bottom: '100%', marginBottom: 4, minWidth: 180 }}>
                  {scopedAgents.map((agent) => (
                    <button
                      type="button"
                      key={agent.id}
                      onClick={() => { setActiveAgent(agent.id, mode); setAgentDropdownOpen(false); }}
                      className={`drop-item${agent.id === activeScopedId ? ' header-dropdown-item--active' : ''}`}
                      style={{ fontSize: 'var(--fs-base)' }}
                    >
                      <span className="trunc med">{agent.name}</span>
                    </button>
                  ))}
                  <div style={{ borderTop: '1px solid var(--c-border-1)', marginTop: 0, paddingTop: 0 }}>
                    <button
                      type="button"
                      onClick={() => { openSettings('agents'); setAgentDropdownOpen(false); }}
                      className="drop-item drop-item--brand"
                    >
                      {mode === 'task' ? '+ Manage Task Profiles' : t('sidebar.manageWriters')}
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div ref={modelRef} className="chat-input-bottom-col chat-input-bottom-col--model">
              <button
                type="button"
                onClick={() => { setModelDropdownOpen((v) => !v); setAgentDropdownOpen(false); }}
                className="chat-input-dropup-btn"
                data-active="true"
                style={{ color: accentColor }}
                aria-label={modelLabel}
                aria-haspopup="menu"
                aria-expanded={modelDropdownOpen}
              >
                <Brain size={12} className="chat-input-dropup-icon" />
                <span className="trunc med chat-input-dropup-label">{modelLabel}</span>
              </button>
              {modelDropdownOpen && (
                <div className="drop" style={{ left: 0, bottom: '100%', marginBottom: 4, minWidth: 180 }}>
                  {providerConfigs.length === 0 && (
                    <div className="subtle" style={{ padding: '14px 12px', fontSize: 'var(--fs-base)' }}>{t('sidebar.noProviders')}</div>
                  )}
                  {providerConfigs.filter((config) => config.status === 'connected').flatMap((config) => {
                    const visibleModels = (config.models ?? []).filter((m) => !isModelHidden(config.id, m.id));
                    return visibleModels.map((model) => (
                      <button
                        type="button"
                        key={`${config.id}:${model.id}`}
                        onClick={() => { setActiveProvider(config.id); setActiveModel(config.id, model.id); setModelDropdownOpen(false); }}
                        className={`drop-item${config.id === activeProviderId && config.selectedModel === model.id ? ' header-dropdown-item--active' : ''}`}
                        style={{ fontSize: 'var(--fs-base)' }}
                      >
                        <span className="med">{config.name} / {model.name}</span>
                      </button>
                    ));
                  })}
                  <div style={{ borderTop: '1px solid var(--c-border-1)', marginTop: 0, paddingTop: 0 }}>
                    <button
                      type="button"
                      onClick={() => { openSettings('tools'); setModelDropdownOpen(false); }}
                      className="drop-item drop-item--brand"
                    >
                      {t('sidebar.manageModels')}
                    </button>
                  </div>
                </div>
              )}
            </div>

            <ReasoningDropup />

            <PermissionModeControl
              threadId={threadId}
              chatMode={mode}
              workspaceId={workspaceId}
              taskId={taskId}
              settingsTab={settingsTab}
              disabled={!toolsSupported}
              title={
                toolsSupported
                  ? undefined
                  : t('chat.tools.disabledTooltip')
              }
            />
          </div>

          {/* Right side: send button */}
          <div className="chat-input-bottom-col chat-input-bottom-col--send">
            {isStreaming ? (
              <ComposerIconButton
                onClick={stopStreaming}
                className="shrink-0"
                title={t('chat.stop')}
              >
                <Square size={12} fill="currentColor" style={{ color: 'var(--c-text-2)' }} />
              </ComposerIconButton>
            ) : (
              <ComposerSendButton onClick={handleSend} disabled={!canSend} title={t('chat.send')} />
            )}
          </div>
        </ComposerRow>
      </ComposerCard>
    </div>
  );
}

/** Dropup control for the AI tool permission mode (Ask & Approve / Bypass). */
function PermissionModeControl({
  threadId,
  chatMode,
  workspaceId,
  taskId,
  settingsTab,
  disabled,
  title,
}: {
  threadId: string;
  chatMode: 'writer' | 'task';
  workspaceId: string | null;
  taskId?: string | null;
  settingsTab?: string | null;
  disabled?: boolean;
  title?: string;
}) {
  const { t } = useTranslation();
  const accentColor = 'var(--c-accent-2)';
  const [open, setOpen] = useState(false);
  const [creatingThread, setCreatingThread] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const activeThreadId = useChatStore((s) => s.activeThreadId);
  const currentThreadId = activeThreadId ?? threadId;
  const permissionMode = useChatStore(
    (s) => s.threads.find((th) => th.id === currentThreadId)?.permissionMode ?? 'ask',
  );
  const newChat = useChatStore((s) => s.newChat);
  const setPermissionMode = useChatStore((s) => s.setPermissionMode);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handlePermissionModeChange = useCallback(async (nextMode: 'ask' | 'bypass') => {
    if (disabled || creatingThread) return;

    let nextThreadId = useChatStore.getState().activeThreadId ?? threadId;
    if (!nextThreadId) {
      setCreatingThread(true);
      try {
        await newChat({
          mode: chatMode,
          workspaceId: workspaceId ?? undefined,
          taskId: taskId ?? undefined,
          settingsTab: settingsTab ?? undefined,
        });
        nextThreadId = useChatStore.getState().activeThreadId ?? '';
      } finally {
        setCreatingThread(false);
      }
    }

    if (!nextThreadId) return;
    setPermissionMode(nextThreadId, nextMode);
    setOpen(false);
  }, [chatMode, creatingThread, disabled, workspaceId, newChat, setPermissionMode, settingsTab, taskId, threadId]);
  const currentLabel =
    permissionMode === 'bypass' ? t('chat.tools.bypass') : t('chat.tools.askApprove');
  const CurrentIcon = permissionMode === 'bypass' ? Zap : Shield;

  return (
    <div
      ref={ref}
      className="chat-input-bottom-col chat-input-bottom-col--model"
      title={title}
    >
      <button
        type="button"
        disabled={disabled || creatingThread}
        onClick={() => setOpen((v) => !v)}
        className="chat-input-dropup-btn"
        data-active="true"
        style={{
          color: accentColor,
          opacity: disabled || creatingThread ? 0.5 : 1,
          cursor: disabled || creatingThread ? 'not-allowed' : 'pointer',
        }}
        aria-label={currentLabel}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <CurrentIcon size={12} className="chat-input-dropup-icon" />
        <span className="trunc med chat-input-dropup-label">{currentLabel}</span>
      </button>
      {open && !disabled && (
        <div className="drop" style={{ left: 0, bottom: '100%', marginBottom: 4, minWidth: 160 }}>
          <button
            type="button"
            onClick={() => void handlePermissionModeChange('ask')}
            className={`drop-item${permissionMode === 'ask' ? ' header-dropdown-item--active' : ''}`}
            style={{ fontSize: 'var(--fs-base)' }}
          >
            <span className="med">{t('chat.tools.askApprove')}</span>
          </button>
          <button
            type="button"
            onClick={() => void handlePermissionModeChange('bypass')}
            className={`drop-item${permissionMode === 'bypass' ? ' header-dropdown-item--active' : ''}`}
            style={{ fontSize: 'var(--fs-base)' }}
          >
            <span className="med">{t('chat.tools.bypass')}</span>
          </button>
        </div>
      )}
    </div>
  );
}
