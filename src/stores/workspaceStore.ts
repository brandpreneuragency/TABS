// Workspace store — the core of the workspace pivot.
//
// Each workspace is a tab with its own isolated connected folders, one file
// open in the editor at a time, and its own chat history. Clicking a file in
// the tree swaps the editor content (with an unsaved-changes prompt when
// needed). Middle-click opens a new workspace.
//
// Replaces documentStore.ts. Absorbs folder-management state from
// fileSystemStore.ts (connectedFolders, activeFolderId, rootNode all become
// per-workspace).

import { create } from 'zustand';
import { nanoid } from 'nanoid';
import type { Workspace, WorkspaceFile, ConnectedFolderRef, FileViewerItem } from '../types';
import { db } from '../services/db';
import { useUIStore } from './uiStore';
import { parseByExt } from '../services/fileFormat';
import { parseDocx } from '../services/docxFormat';
import { writeEditorContent } from '../services/writeEditorFile';
import { isTextFile, isImageFile, isPdfFile, isDocxFile } from '../utils/fileType';
import { bytesToDataUrl, decodeDataUrlBytes, decodeDataUrlText, mimeTypeFromPath } from '../utils/fileData';
import {
  openFolderDialog,
  readDir,
  readTextFile,
  readBinaryFile,
  writeTextFile,
  mkdir,
  remove as fsRemove,
  rename as fsRename,
  exists as fsExists,
  basename,
  joinPath,
  isNativeFsAvailable,
  pickSaveTabsPath,
} from '../services/fs-adapter';
import { getFolderConnector } from '../services/runtime';
import {
  DEFAULT_WORKSPACE_FOLDER_SETTING_KEY,
  isGeneratedWorkspaceName,
  normalizeDefaultWorkspaceFolder,
  workspaceNeedsDefaultFolder,
} from './defaultWorkspaceFolder';

// ── Re-export tree types so consumers can import from workspaceStore ──
export type TreeNode = {
  name: string;
  path: string;
  fullPath: string;
  kind: 'file' | 'directory';
  children?: TreeNode[];
};

export interface ConnectedFolder {
  id: string;
  path: string;
  rootNode: TreeNode | null;
}

const toast = (msg: string) => useUIStore.getState().showToast(msg, 'error');

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

async function readDefaultFolderFromDb(): Promise<string | null> {
  try {
    const row = await db.settings.get(DEFAULT_WORKSPACE_FOLDER_SETTING_KEY);
    return normalizeDefaultWorkspaceFolder(row?.value);
  } catch {
    return null;
  }
}

// ── Tree-building utilities (moved from fileSystemStore) ──

function sortNodes(nodes: TreeNode[]): TreeNode[] {
  return [...nodes].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
}

async function buildChildren(
  parentFullPath: string,
  parentDisplayPath: string
): Promise<TreeNode[]> {
  const entries = await readDir(parentFullPath);
  return sortNodes(
    entries.map((e) => ({
      name: e.name,
      path: joinPath(parentDisplayPath, e.name),
      fullPath: e.path,
      kind: e.kind,
    }))
  );
}

export function findNodeByFullPath(node: TreeNode | null, fullPath: string): TreeNode | null {
  if (!node) return null;
  if (node.fullPath === fullPath) return node;
  if (node.children) {
    for (const child of node.children) {
      const found = findNodeByFullPath(child, fullPath);
      if (found) return found;
    }
  }
  return null;
}

function setChildrenAtPath(node: TreeNode, fullPath: string, children: TreeNode[]): TreeNode {
  if (node.fullPath === fullPath) return { ...node, children };
  if (!node.children) return node;
  return {
    ...node,
    children: node.children.map((c) => setChildrenAtPath(c, fullPath, children)),
  };
}

function mergeChildrenWithExistingSubtrees(
  nextChildren: TreeNode[],
  existingChildren?: TreeNode[]
): TreeNode[] {
  if (!existingChildren || existingChildren.length === 0) return sortNodes(nextChildren);
  const existingByFullPath = new Map(existingChildren.map((c) => [c.fullPath, c]));
  const merged = nextChildren.map((next) => {
    const existing = existingByFullPath.get(next.fullPath);
    if (!existing) return next;
    if (next.kind !== 'directory' || existing.kind !== 'directory') return next;
    if (existing.children === undefined) return next;
    return { ...next, children: existing.children };
  });
  return sortNodes(merged);
}

const MAX_SUBTREE_INDEX_DEPTH = 48;

async function loadSubtree(
  node: TreeNode,
  depth = 0
): Promise<{ node: TreeNode; changed: boolean }> {
  if (node.kind !== 'directory') return { node, changed: false };
  if (depth >= MAX_SUBTREE_INDEX_DEPTH) {
    if (node.children !== undefined) return { node, changed: false };
    return { node: { ...node, children: [] }, changed: true };
  }
  let changed = false;
  let children = node.children;
  if (children === undefined) {
    try {
      children = await buildChildren(node.fullPath, node.path);
      changed = true;
    } catch {
      return { node: { ...node, children: [] }, changed: true };
    }
  }
  const loadedChildren: TreeNode[] = [];
  for (const child of children) {
    if (child.kind !== 'directory') {
      loadedChildren.push(child);
      continue;
    }
    try {
      const loaded = await loadSubtree(child, depth + 1);
      loadedChildren.push(loaded.node);
      if (loaded.changed) changed = true;
    } catch {
      if (child.children === undefined) {
        loadedChildren.push({ ...child, children: [] });
        changed = true;
      } else {
        loadedChildren.push(child);
      }
    }
  }
  if (!changed) return { node, changed: false };
  return { node: { ...node, children: sortNodes(loadedChildren) }, changed: true };
}

function normalizePathSlashes(fullPath: string): string {
  return fullPath.replace(/\\/g, '/');
}

function getParentFullPath(fullPath: string): string {
  const norm = normalizePathSlashes(fullPath);
  const idx = norm.lastIndexOf('/');
  return idx === -1 ? norm : norm.slice(0, idx);
}

function validateName(name: string, siblings: TreeNode[]): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'Name cannot be empty.';
  if (trimmed.includes('/') || trimmed.includes('\\')) return 'Name cannot contain / or \\.';
  if (siblings.some((s) => s.name.toLowerCase() === trimmed.toLowerCase())) {
    return `"${trimmed}" already exists.`;
  }
  return null;
}

function collectAllFullPaths(node: TreeNode): string[] {
  const paths = [node.fullPath];
  if (node.children) {
    for (const child of node.children) paths.push(...collectAllFullPaths(child));
  }
  return paths;
}

/** Flatten every descendant of `root` (excluding the root folder itself). */
export function flattenTree(root: TreeNode | null): TreeNode[] {
  if (!root) return [];
  const out: TreeNode[] = [];
  const walk = (node: TreeNode) => {
    if (!node.children) return;
    for (const child of node.children) {
      out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

// ── Editor state cache (keyed by file path) ──
// Moved here from TipTapEditor so the store can clear entries on save/discard.
import type { EditorState } from '@tiptap/pm/state';
const editorStateCache = new Map<string, EditorState>();
const EDITOR_CACHE_MAX = 50;

export function getEditorStateCache() {
  return editorStateCache;
}

export function clearEditorStateCache(path: string) {
  editorStateCache.delete(path);
}

// ── Untitled drafts (empty workspace buffer, IndexedDB only) ──
// When the user pastes/types into a workspace with no open disk file, content
// is kept under a stable virtual path so it can persist via Dexie and so each
// workspace has its own editor identity (new tabs start blank).
const DRAFT_PATH_PREFIX = '__draft__:';

/** Stable virtual path for a workspace's unsaved editor buffer. */
export function draftPathForWorkspace(workspaceId: string): string {
  return `${DRAFT_PATH_PREFIX}${workspaceId}`;
}

/** True when the path is an IndexedDB-only draft (not a real disk file). */
export function isDraftPath(path: string | null | undefined): boolean {
  return !!path && path.startsWith(DRAFT_PATH_PREFIX);
}

/** True when Save must open a file explorer (no real disk path yet). */
export function needsSaveAsDialog(path: string | null | undefined): boolean {
  if (!path || isDraftPath(path)) return true;
  const n = path.replace(/\\/g, '/');
  // Absolute Windows (C:/...) or POSIX (/...) path required for direct write.
  return !(n.startsWith('/') || /^[A-Za-z]:\//.test(n));
}

function evictEditorCacheIfNeeded() {
  if (editorStateCache.size <= EDITOR_CACHE_MAX) return;
  // Simple FIFO eviction: delete the first entry
  const firstKey = editorStateCache.keys().next().value;
  if (firstKey) editorStateCache.delete(firstKey);
}

// ── Store interface ──

interface WorkspaceStore {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  isLoaded: boolean;

  // Transient UI state for the active folder
  loading: boolean;
  error: string | null;
  folderCapability: 'unsupported' | 'available';
  /** Absolute path of the folder empty workspaces should open with. */
  defaultFolderPath: string | null;

  // ── Workspace lifecycle ──
  loadWorkspaces: () => Promise<void>;
  createWorkspace: (name?: string) => Promise<Workspace>;
  deleteWorkspace: (id: string) => Promise<void>;
  setActiveWorkspace: (id: string) => void;
  renameWorkspace: (id: string, name: string) => void;
  /** Reorder workspace tabs by a full list of workspace ids (left → right). */
  reorderWorkspaces: (orderedIds: string[]) => void;
  duplicateWorkspace: (id: string) => Promise<Workspace>;
  updateWorkspace: (id: string, updates: Partial<Workspace>) => void;

  // ── File operations within workspace ──
  swapFileInWorkspace: (workspaceId: string, node: TreeNode, opts?: { skipPrompt?: boolean }) => Promise<boolean>;
  saveCurrentFile: (workspaceId: string) => Promise<void>;
  saveAsCurrentFile: (workspaceId: string) => Promise<void>;
  updateFileContent: (workspaceId: string, content: string, isDirty: boolean) => void;
  closeCurrentFile: (workspaceId: string) => void;
  openFileFromViewer: (file: FileViewerItem) => Promise<void>;

  // ── Folder operations within workspace ──
  setDefaultFolderPath: (path: string | null) => Promise<void>;
  connectFolderInWorkspace: (
    workspaceId: string,
    fullPath?: string,
    opts?: { preserveName?: boolean },
  ) => Promise<ConnectedFolder | null>;
  disconnectFolderInWorkspace: (workspaceId: string, folderId: string) => void;
  setActiveFolderInWorkspace: (workspaceId: string, folderId: string) => void;
  refreshWorkspaceDir: (workspaceId: string, dirPath: string) => Promise<void>;
  ensureChildrenLoaded: (workspaceId: string, fullPath: string) => Promise<void>;
  ensureSubtreeLoaded: (workspaceId: string, fullPath: string) => Promise<void>;

  // ── File CRUD (delegated to fs-adapter, tree update is per-workspace) ──
  createFileInWorkspace: (workspaceId: string, parentFullPath: string, name: string) => Promise<void>;
  createDirectoryInWorkspace: (workspaceId: string, parentFullPath: string, name: string) => Promise<void>;
  renameInWorkspace: (workspaceId: string, fullPath: string, newName: string) => Promise<{ oldPath: string; newPath: string; kind: 'file' | 'directory' } | null>;
  removeInWorkspace: (workspaceId: string, fullPath: string) => Promise<string[]>;
  moveInWorkspace: (workspaceId: string, sourceFullPath: string, targetDirFullPath: string) => Promise<{ oldPaths: string[]; newBasePath: string } | null>;

  // ── Tree state (per-workspace) ──
  toggleExpandedPath: (workspaceId: string, path: string) => void;
  setExpandedPaths: (workspaceId: string, paths: string[]) => void;
  setSelectedTreePath: (workspaceId: string, path: string | null) => void;

  // ── Tauri shell integration ──
  openFileByPath: (path: string) => Promise<void>;

  // ── Helpers ──
  getActiveWorkspace: () => Workspace | null;
  /** Get the active folder's root node for the active workspace. */
  getActiveRootNode: () => TreeNode | null;
  /** Get the active workspace's connected folders (with rootNodes). */
  getActiveConnectedFolders: () => ConnectedFolder[];
  /** Get the active workspace's active folder ID. */
  getActiveFolderId: () => string | null;
}

// ── Helpers to rebuild ConnectedFolder[] from ConnectedFolderRef[] ──

async function rebuildFolderTree(ref: ConnectedFolderRef): Promise<ConnectedFolder | null> {
  try {
    if (!(await fsExists(ref.path))) return null;
    const name = basename(ref.path);
    const children = await buildChildren(ref.path, name);
    return {
      id: ref.id,
      path: ref.path,
      rootNode: { name, path: name, fullPath: ref.path, kind: 'directory', children },
    };
  } catch {
    return null;
  }
}

/** Convert a Workspace's ConnectedFolderRef[] to ConnectedFolder[] with rootNodes. */
async function rebuildAllFolders(
  refs: ConnectedFolderRef[]
): Promise<{ folders: ConnectedFolder[]; validRefs: ConnectedFolderRef[] }> {
  const folders: ConnectedFolder[] = [];
  const validRefs: ConnectedFolderRef[] = [];
  for (const ref of refs) {
    const folder = await rebuildFolderTree(ref);
    if (folder) {
      folders.push(folder);
      validRefs.push(ref);
    }
  }
  return { folders, validRefs };
}

// ── In-memory cache of rebuilt rootNodes, keyed by workspaceId ──
// We keep the full TreeNode trees in memory (not in Dexie) and reconstruct
// the ConnectedFolder[] on load. The Workspace object only persists
// ConnectedFolderRef[] (path + id) to keep the DB record small.
const folderTreeCache = new Map<string, ConnectedFolder[]>();

function getConnectedFolders(ws: Workspace): ConnectedFolder[] {
  return folderTreeCache.get(ws.id) ?? [];
}

function setConnectedFolders(wsId: string, folders: ConnectedFolder[]) {
  folderTreeCache.set(wsId, folders);
}

// ── Persist helper: writes the workspace to Dexie ──
async function persistWorkspace(ws: Workspace) {
  // Only persist the ref (path + id), not the full rootNode tree
  const refs: ConnectedFolderRef[] = getConnectedFolders(ws).map((f) => ({
    id: f.id,
    path: f.path,
  }));
  await db.workspaces.put({ ...ws, connectedFolders: refs });
}

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
  workspaces: [],
  activeWorkspaceId: null,
  isLoaded: false,
  loading: false,
  error: null,
  folderCapability: isNativeFsAvailable() ? 'available' : 'unsupported',
  defaultFolderPath: null,

  // ── Workspace lifecycle ──

  loadWorkspaces: async () => {
    try {
      const defaultFolderPath = await readDefaultFolderFromDb();
      set({ defaultFolderPath });

      const rawWorkspaces = await db.workspaces.toArray();
      if (rawWorkspaces.length === 0) {
        // Start fresh: create one workspace (picks up the default folder if set)
        const first = await get().createWorkspace();
        set({ workspaces: [first], activeWorkspaceId: first.id, isLoaded: true });
        return;
      }

      // Sort by order
      rawWorkspaces.sort((a, b) => a.order - b.order);

      // Rebuild folder trees for each workspace.
      // One folder per workspace: keep the active folder (or first) and drop extras.
      for (const ws of rawWorkspaces) {
        let refs = ws.connectedFolders;
        let migrated = false;

        // Strip browser synthetic root marker from tab titles saved by older builds.
        if (ws.name.startsWith('__BROWSER_ROOT__:')) {
          ws.name = ws.name.slice('__BROWSER_ROOT__:'.length);
          migrated = true;
        }

        if (refs.length > 1) {
          const keep =
            (ws.activeFolderId
              ? refs.find((r) => r.id === ws.activeFolderId)
              : undefined) ?? refs[0];
          refs = [keep];
          ws.connectedFolders = refs;
          ws.activeFolderId = keep.id;
          migrated = true;
        } else if (refs.length === 1 && !ws.activeFolderId) {
          ws.activeFolderId = refs[0].id;
          migrated = true;
        }

        const { folders, validRefs } = await rebuildAllFolders(refs);
        setConnectedFolders(ws.id, folders);
        // Update refs if some folders were removed (path no longer exists)
        if (validRefs.length !== refs.length || migrated) {
          ws.connectedFolders = validRefs;
          if (ws.activeFolderId && !validRefs.find((r) => r.id === ws.activeFolderId)) {
            ws.activeFolderId = validRefs[0]?.id ?? null;
          }
          await db.workspaces.put(ws);
        }

        if (workspaceNeedsDefaultFolder(folders, ws.connectedFolders, defaultFolderPath)) {
          const folder = await rebuildFolderTree({ id: '0', path: defaultFolderPath });
          if (folder) {
            setConnectedFolders(ws.id, [folder]);
            ws.connectedFolders = [{ id: folder.id, path: folder.path }];
            ws.activeFolderId = folder.id;
            if (isGeneratedWorkspaceName(ws.name)) {
              ws.name = basename(defaultFolderPath);
            }
            await db.workspaces.put(ws);
          }
        }
      }

      const row = await db.settings.get('lastActiveWorkspaceId');
      const lastActiveId = row?.value as string | undefined;
      const activeId =
        (typeof lastActiveId === 'string' && rawWorkspaces.find((w) => w.id === lastActiveId)
          ? lastActiveId
          : rawWorkspaces[0].id) ?? rawWorkspaces[0].id;

      set({ workspaces: rawWorkspaces, activeWorkspaceId: activeId, isLoaded: true });
    } catch {
      set({ isLoaded: true });
    }
  },

  createWorkspace: async (name?: string) => {
    const workspaces = get().workspaces;
    const colorIndex = workspaces.length % 6;

    // Generate a default name if none provided
    let finalName = name ?? '';
    if (!finalName) {
      const existingNumbers = new Set<number>();
      for (const ws of workspaces) {
        const match = ws.name.match(/^Workspace (\d+)$/);
        if (match) existingNumbers.add(parseInt(match[1], 10));
      }
      let next = 1;
      while (existingNumbers.has(next)) next++;
      finalName = `Workspace ${next}`;
    }

    const now = Date.now();
    const ws: Workspace = {
      id: nanoid(8),
      name: finalName,
      connectedFolders: [],
      activeFolderId: null,
      currentFile: null,
      expandedPaths: [],
      selectedTreePath: null,
      createdAt: now,
      updatedAt: now,
      order: workspaces.length,
      colorIndex,
    };

    setConnectedFolders(ws.id, []);
    await db.workspaces.put(ws);
    set((s) => ({
      workspaces: [...s.workspaces, ws],
      activeWorkspaceId: ws.id,
    }));
    void db.settings.put({ key: 'lastActiveWorkspaceId', value: ws.id });

    const defaultPath = get().defaultFolderPath ?? (await readDefaultFolderFromDb());
    if (defaultPath) {
      await get().connectFolderInWorkspace(ws.id, defaultPath);
    }

    return get().workspaces.find((w) => w.id === ws.id) ?? ws;
  },

  deleteWorkspace: async (id) => {
    try {
      await db.workspaces.delete(id);
    } catch (err) {
      console.warn('[workspaceStore] failed to delete workspace:', err);
    }
    // Cascade: delete associated chat threads and messages
    try {
      const threads = await db.chatThreads.where('workspaceId').equals(id).toArray();
      for (const thread of threads) {
        await db.chatMessages.where('threadId').equals(thread.id).delete();
      }
      await db.chatThreads.where('workspaceId').equals(id).delete();
    } catch (err) {
      console.warn('[workspaceStore] failed to delete associated chat:', err);
    }

    // Clean up folder tree cache and editor state cache
    folderTreeCache.delete(id);
    const ws = get().workspaces.find((w) => w.id === id);
    if (ws?.currentFile) clearEditorStateCache(ws.currentFile.path);

    const remaining = get().workspaces.filter((w) => w.id !== id);
    let activeId = get().activeWorkspaceId;
    if (activeId === id) activeId = remaining[remaining.length - 1]?.id ?? null;
    if (remaining.length === 0) {
      const newWs = await get().createWorkspace();
      set({ workspaces: [newWs], activeWorkspaceId: newWs.id });
      return;
    }
    set({ workspaces: remaining, activeWorkspaceId: activeId });
  },

  setActiveWorkspace: (id) => {
    set({ activeWorkspaceId: id });
    useUIStore.getState().setActiveView('document');
    void db.settings.put({ key: 'lastActiveWorkspaceId', value: id }).catch(() => undefined);
  },

  renameWorkspace: (id, name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    set((s) => ({
      workspaces: s.workspaces.map((w) =>
        w.id === id ? { ...w, name: trimmed, updatedAt: Date.now() } : w
      ),
    }));
    const ws = get().workspaces.find((w) => w.id === id);
    if (ws) void persistWorkspace(ws);
  },

  reorderWorkspaces: (orderedIds) => {
    const current = get().workspaces;
    if (orderedIds.length === 0 || current.length === 0) return;

    const byId = new Map(current.map((w) => [w.id, w]));
    const next: Workspace[] = [];
    const seen = new Set<string>();
    const now = Date.now();

    for (const id of orderedIds) {
      const ws = byId.get(id);
      if (!ws || seen.has(id)) continue;
      seen.add(id);
      next.push({ ...ws, order: next.length, updatedAt: now });
    }
    // Append any workspaces missing from orderedIds (safety net).
    for (const ws of current) {
      if (seen.has(ws.id)) continue;
      next.push({ ...ws, order: next.length, updatedAt: now });
    }

    // No-op if order unchanged.
    if (
      next.length === current.length &&
      next.every((w, i) => w.id === current[i]?.id && w.order === current[i]?.order)
    ) {
      return;
    }

    set({ workspaces: next });
    for (const ws of next) {
      void persistWorkspace(ws);
    }
  },

  duplicateWorkspace: async (id) => {
    const source = get().workspaces.find((w) => w.id === id);
    if (!source) throw new Error('Workspace not found');
    const colorIndex = get().workspaces.length % 6;
    const now = Date.now();
    const ws: Workspace = {
      ...source,
      id: nanoid(8),
      name: `${source.name} (copy)`,
      createdAt: now,
      updatedAt: now,
      order: get().workspaces.length,
      colorIndex,
    };
    // Copy folder tree cache
    setConnectedFolders(ws.id, getConnectedFolders(source).map((f) => ({ ...f })));
    await db.workspaces.put(ws);
    set((s) => ({
      workspaces: [...s.workspaces, ws],
      activeWorkspaceId: ws.id,
    }));
    return ws;
  },

  updateWorkspace: (id, updates) => {
    set((s) => ({
      workspaces: s.workspaces.map((w) =>
        w.id === id ? { ...w, ...updates, updatedAt: Date.now() } : w
      ),
    }));
    const ws = get().workspaces.find((w) => w.id === id);
    if (ws) void persistWorkspace(ws);
  },

  // ── File operations within workspace ──

  swapFileInWorkspace: async (workspaceId, node, opts) => {
    const ws = get().workspaces.find((w) => w.id === workspaceId);
    if (!ws) return false;

    // If skipPrompt is not set and current file is dirty, the caller should
    // have already handled the prompt. This function just does the swap.
    if (!opts?.skipPrompt && ws.currentFile?.isDirty) {
      // Return false to signal the caller that a prompt is needed.
      // The caller should handle the prompt and call again with skipPrompt.
      return false;
    }

    const fullPath = normalizePathSlashes(node.fullPath);

    // PDFs open in the side file viewer (not TipTap).
    if (isPdfFile(node.name)) {
      try {
        const bytes = await readBinaryFile(fullPath);
        const dataUrl = bytesToDataUrl(bytes, 'application/pdf');
        useUIStore.getState().openFileViewer({
          name: node.name,
          path: fullPath,
          dataUrl,
          mimeType: 'application/pdf',
          source: 'filesystem',
        });
        get().updateWorkspace(workspaceId, { selectedTreePath: node.path });
        return true;
      } catch {
        toast(`Could not read file: ${node.name}`);
        return false;
      }
    }

    if (!isTextFile(node.name) && !isImageFile(node.name) && !isDocxFile(node.name)) {
      toast(`Unsupported file type for editor: .${node.name.split('.').pop() ?? ''}`);
      return false;
    }

    try {
      let json: object;
      if (isImageFile(node.name)) {
        const bytes = await readBinaryFile(fullPath);
        const mime = mimeTypeFromPath(node.name);
        const dataUrl = bytesToDataUrl(bytes, mime);
        json = {
          type: 'doc',
          content: [{ type: 'image', attrs: { src: dataUrl } }],
        };
      } else if (isDocxFile(node.name)) {
        const bytes = await readBinaryFile(fullPath);
        try {
          json = await parseDocx(bytes);
        } catch {
          toast(`Could not parse Word document: ${node.name}`);
          return false;
        }
      } else {
        const ext = node.name.split('.').pop()?.toLowerCase() ?? '';
        const text = await readTextFile(fullPath);
        try {
          json = parseByExt(text, ext);
        } catch {
          json = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
        }
      }

      const newFile: WorkspaceFile = {
        path: fullPath,
        name: node.name,
        content: JSON.stringify(json),
        isDirty: false,
      };

      // Clear old file's editor state cache (content is on disk)
      if (ws.currentFile) clearEditorStateCache(ws.currentFile.path);

      get().updateWorkspace(workspaceId, {
        currentFile: newFile,
        selectedTreePath: node.path,
      });

      evictEditorCacheIfNeeded();
      return true;
    } catch {
      toast(`Could not read file: ${node.name}`);
      return false;
    }
  },

  saveCurrentFile: async (workspaceId) => {
    const ws = get().workspaces.find((w) => w.id === workspaceId);
    if (!ws?.currentFile) return;

    // No real disk path yet (draft / empty workspace / unconnected save):
    // always open the native Save explorer so the user can pick a location.
    if (needsSaveAsDialog(ws.currentFile.path)) {
      await get().saveAsCurrentFile(workspaceId);
      return;
    }

    const editorJson = (() => {
      try { return JSON.parse(ws.currentFile.content) as object; } catch { return { type: 'doc', content: [] }; }
    })();

    try {
      await writeEditorContent(ws.currentFile.path, editorJson);
      // Mark as clean
      set((s) => ({
        workspaces: s.workspaces.map((w) =>
          w.id === workspaceId && w.currentFile
            ? { ...w, currentFile: { ...w.currentFile, isDirty: false }, updatedAt: Date.now() }
            : w
        ),
      }));
      // Clear editor state cache (content is now on disk)
      clearEditorStateCache(ws.currentFile.path);
      const updated = get().workspaces.find((w) => w.id === workspaceId);
      if (updated) void persistWorkspace(updated);
    } catch (err) {
      console.warn('[Save] disk write failed:', err);
      // Fall back to Save As (e.g. path gone) so content is not stuck.
      try {
        await get().saveAsCurrentFile(workspaceId);
      } catch {
        toast(`Failed to save: ${getErrorMessage(err)}`);
      }
    }
  },

  saveAsCurrentFile: async (workspaceId) => {
    const ws = get().workspaces.find((w) => w.id === workspaceId);
    if (!ws?.currentFile) return;

    const editorJson = (() => {
      try { return JSON.parse(ws.currentFile.content) as object; } catch { return { type: 'doc', content: [] }; }
    })();

    const base = ws.currentFile.name.replace(/\.[^.]+$/, '') || 'Untitled';
    const filters = [
      { name: 'Markdown File', extensions: ['md', 'markdown'] },
      { name: 'Text File', extensions: ['txt'] },
      { name: 'Word Document', extensions: ['docx'] },
    ];
    const suggestedName = `${base}.md`;
    // Prefer the connected folder when present; still works with none —
    // the native dialog opens with just the suggested file name.
    const activeFolder = getConnectedFolders(ws).find((f) => f.id === ws.activeFolderId);
    const defaultDir = activeFolder?.rootNode?.fullPath;
    try {
      const newPath = await pickSaveTabsPath(
        suggestedName,
        filters,
        defaultDir ? joinPath(defaultDir, suggestedName) : suggestedName
      );
      if (!newPath) return; // user cancelled
      await writeEditorContent(newPath, editorJson);
      const newName = newPath.split(/[/\\]/).pop() ?? ws.currentFile.name;
      const prevPath = ws.currentFile.path;
      // Keep undo/selection when promoting a draft path to a real file path.
      if (prevPath !== newPath) {
        const cached = editorStateCache.get(prevPath);
        if (cached) {
          editorStateCache.set(newPath, cached);
          editorStateCache.delete(prevPath);
        }
      }
      set((s) => ({
        workspaces: s.workspaces.map((w) =>
          w.id === workspaceId && w.currentFile
            ? { ...w, currentFile: { ...w.currentFile, path: newPath, name: newName, isDirty: false }, updatedAt: Date.now() }
            : w
        ),
      }));
      const updated = get().workspaces.find((w) => w.id === workspaceId);
      if (updated) void persistWorkspace(updated);
    } catch (err) {
      console.warn('[SaveAs] failed:', err);
      toast(`Failed to save: ${getErrorMessage(err)}`);
    }
  },

  updateFileContent: (workspaceId, content, isDirty) => {
    set((s) => ({
      workspaces: s.workspaces.map((w) => {
        if (w.id !== workspaceId) return w;
        if (w.currentFile) {
          return {
            ...w,
            currentFile: { ...w.currentFile, content, isDirty },
            updatedAt: Date.now(),
          };
        }
        // Empty workspace: promote paste/type into an IndexedDB draft so
        // content survives app close. Path is stable per workspace so the
        // TipTap fileId does not change mid-edit.
        return {
          ...w,
          currentFile: {
            path: draftPathForWorkspace(workspaceId),
            name: 'Untitled',
            content,
            isDirty: true,
          },
          updatedAt: Date.now(),
        };
      }),
    }));
    // Persist to Dexie (best-effort, not on every keystroke — the caller
    // debounces via useAutoSave)
    const ws = get().workspaces.find((w) => w.id === workspaceId);
    if (ws) void persistWorkspace(ws);
  },

  closeCurrentFile: (workspaceId) => {
    const ws = get().workspaces.find((w) => w.id === workspaceId);
    if (ws?.currentFile) clearEditorStateCache(ws.currentFile.path);
    get().updateWorkspace(workspaceId, { currentFile: null, selectedTreePath: null });
  },

  openFileFromViewer: async (file) => {
    const activeWs = get().getActiveWorkspace();
    if (!activeWs) return;

    const ext = file.name.split('.').pop()?.toLowerCase() ?? '';

    if (file.dataUrl && isTextFile(file.name)) {
      let text: string;
      try {
        text = decodeDataUrlText(file.dataUrl);
      } catch {
        toast('Could not decode file content.');
        return;
      }
      let json: object;
      try {
        json = parseByExt(text, ext);
      } catch {
        toast(`Could not parse file: ${file.name}`);
        return;
      }
      const newFile: WorkspaceFile = {
        path: file.path ?? '',
        name: file.name,
        content: JSON.stringify(json),
        isDirty: false,
      };
      get().updateWorkspace(activeWs.id, { currentFile: newFile });
    } else if (file.dataUrl && isDocxFile(file.name)) {
      let json: object;
      try {
        const bytes = decodeDataUrlBytes(file.dataUrl);
        json = await parseDocx(bytes);
      } catch {
        toast(`Could not parse Word document: ${file.name}`);
        return;
      }
      const newFile: WorkspaceFile = {
        path: file.path ?? '',
        name: file.name,
        content: JSON.stringify(json),
        isDirty: false,
      };
      get().updateWorkspace(activeWs.id, { currentFile: newFile });
    } else if (file.dataUrl && isImageFile(file.name)) {
      const content = {
        type: 'doc',
        content: [{ type: 'image', attrs: { src: file.dataUrl } }],
      };
      const newFile: WorkspaceFile = {
        path: file.path ?? '',
        name: file.name,
        content: JSON.stringify(content),
        isDirty: false,
      };
      get().updateWorkspace(activeWs.id, { currentFile: newFile });
    } else {
      toast(`Unsupported file type for editor: .${ext}`);
    }
  },

  // ── Folder operations within workspace ──

  setDefaultFolderPath: async (path) => {
    const normalized = normalizeDefaultWorkspaceFolder(path);
    set({ defaultFolderPath: normalized });
    await db.settings.put({
      key: DEFAULT_WORKSPACE_FOLDER_SETTING_KEY,
      value: normalized ?? '',
    });
    if (!normalized) return;
    for (const ws of get().workspaces) {
      if (!workspaceNeedsDefaultFolder(getConnectedFolders(ws), ws.connectedFolders, normalized)) {
        continue;
      }
      await get().connectFolderInWorkspace(ws.id, normalized, {
        preserveName: !isGeneratedWorkspaceName(ws.name),
      });
    }
  },

  connectFolderInWorkspace: async (workspaceId, fullPath, opts) => {
    // fullPath is optional (e.g. re-open a known path). Native/browser pickers
    // leave it undefined and use openFolderDialog instead.
    if (!fullPath && !isNativeFsAvailable()) {
      const connector = await getFolderConnector();
      if (!connector.isAvailable()) {
        const message =
          'Folder access is not available in this browser. Use Chrome/Edge, or the TABS desktop app.';
        set({ error: message });
        toast(message);
        return null;
      }
    }

    const ws = get().workspaces.find((w) => w.id === workspaceId);
    if (!ws) return null;

    // One folder per workspace — no replace once a folder is attached.
    const existingFolders = getConnectedFolders(ws);
    if (existingFolders.length > 0 || ws.connectedFolders.length > 0) {
      return existingFolders[0] ?? null;
    }

    set({ loading: true, error: null });
    try {
      let resolvedPath = fullPath ?? undefined;
      if (!resolvedPath) {
        const picked = await openFolderDialog();
        if (!picked) {
          set({ loading: false });
          return null;
        }
        resolvedPath = picked;
      }

      const name = basename(resolvedPath);
      const children = await buildChildren(resolvedPath, name);
      const id = '0';
      const rootNode: TreeNode = { name, path: name, fullPath: resolvedPath, kind: 'directory', children };
      const newFolder: ConnectedFolder = { id, path: resolvedPath, rootNode };
      const newFolders = [newFolder];
      setConnectedFolders(workspaceId, newFolders);

      // Explicit picker connect always names the tab after the folder.
      // Default-folder apply keeps a custom tab title.
      const updates: Partial<Workspace> = {
        ...(opts?.preserveName ? {} : { name }),
        connectedFolders: newFolders.map((f) => ({ id: f.id, path: f.path })),
        activeFolderId: id,
        expandedPaths: [],
        selectedTreePath: null,
      };

      get().updateWorkspace(workspaceId, updates);
      set({ loading: false, error: null });
      return newFolder;
    } catch (err) {
      set({ loading: false, error: getErrorMessage(err) });
      toast(`Failed to connect folder: ${getErrorMessage(err)}`);
      return null;
    }
  },

  disconnectFolderInWorkspace: (workspaceId, folderId) => {
    const ws = get().workspaces.find((w) => w.id === workspaceId);
    if (!ws) return;
    const folders = getConnectedFolders(ws);
    const remaining = folders.filter((f) => f.id !== folderId);
    setConnectedFolders(workspaceId, remaining);

    const updates: Partial<Workspace> = {
      connectedFolders: remaining.map((f) => ({ id: f.id, path: f.path })),
    };
    if (ws.activeFolderId === folderId) {
      updates.activeFolderId = remaining[0]?.id ?? null;
    }
    get().updateWorkspace(workspaceId, updates);
  },

  setActiveFolderInWorkspace: (workspaceId, folderId) => {
    get().updateWorkspace(workspaceId, { activeFolderId: folderId });
  },

  refreshWorkspaceDir: async (workspaceId, dirPath) => {
    const ws = get().workspaces.find((w) => w.id === workspaceId);
    if (!ws) return;
    const folders = getConnectedFolders(ws);
    const activeFolder = folders.find((f) => f.id === ws.activeFolderId);
    if (!activeFolder?.rootNode) return;
    const node = findNodeByFullPath(activeFolder.rootNode, dirPath);
    if (!node || node.kind !== 'directory') return;
    const children = await buildChildren(node.fullPath, node.path);
    const merged = mergeChildrenWithExistingSubtrees(children, node.children);
    const updatedRootNode = setChildrenAtPath(activeFolder.rootNode, dirPath, merged);
    setConnectedFolders(workspaceId, folders.map((f) =>
      f.id === ws.activeFolderId ? { ...f, rootNode: updatedRootNode } : f
    ));
    // Trigger a re-render by updating the workspace's updatedAt
    set((s) => ({
      workspaces: s.workspaces.map((w) =>
        w.id === workspaceId ? { ...w, updatedAt: Date.now() } : w
      ),
    }));
  },

  ensureChildrenLoaded: async (workspaceId, fullPath) => {
    const ws = get().workspaces.find((w) => w.id === workspaceId);
    if (!ws) return;
    const folders = getConnectedFolders(ws);
    const activeFolder = folders.find((f) => f.id === ws.activeFolderId);
    if (!activeFolder?.rootNode) return;
    const node = findNodeByFullPath(activeFolder.rootNode, fullPath);
    if (!node || node.kind !== 'directory' || node.children !== undefined) return;
    const children = await buildChildren(node.fullPath, node.path);
    const updatedRootNode = setChildrenAtPath(activeFolder.rootNode, fullPath, children);
    setConnectedFolders(workspaceId, folders.map((f) =>
      f.id === ws.activeFolderId ? { ...f, rootNode: updatedRootNode } : f
    ));
    set((s) => ({
      workspaces: s.workspaces.map((w) =>
        w.id === workspaceId ? { ...w, updatedAt: Date.now() } : w
      ),
    }));
  },

  ensureSubtreeLoaded: async (workspaceId, fullPath) => {
    const ws = get().workspaces.find((w) => w.id === workspaceId);
    if (!ws) return;
    const folders = getConnectedFolders(ws);
    const activeFolder = folders.find((f) => f.id === ws.activeFolderId);
    if (!activeFolder?.rootNode) return;
    const node = findNodeByFullPath(activeFolder.rootNode, fullPath);
    if (!node || node.kind !== 'directory') return;

    const result = await loadSubtree(node);
    if (!result?.changed) return;

    const currentWs = get().workspaces.find((w) => w.id === workspaceId);
    if (!currentWs) return;
    const currentFolders = getConnectedFolders(currentWs);
    const currentActiveFolder = currentFolders.find((f) => f.id === currentWs.activeFolderId);
    if (!currentActiveFolder?.rootNode) return;

    const updatedRootNode =
      result.node.fullPath === currentActiveFolder.rootNode.fullPath
        ? result.node
        : setChildrenAtPath(currentActiveFolder.rootNode, fullPath, result.node.children ?? []);

    setConnectedFolders(workspaceId, currentFolders.map((f) =>
      f.id === currentWs.activeFolderId ? { ...f, rootNode: updatedRootNode } : f
    ));
    set((s) => ({
      workspaces: s.workspaces.map((w) =>
        w.id === workspaceId ? { ...w, updatedAt: Date.now() } : w
      ),
    }));
  },

  // ── File CRUD ──

  createFileInWorkspace: async (workspaceId, parentFullPath, name) => {
    const ws = get().workspaces.find((w) => w.id === workspaceId);
    if (!ws) return;
    const folders = getConnectedFolders(ws);
    const activeFolder = folders.find((f) => f.id === ws.activeFolderId);
    if (!activeFolder?.rootNode) return;
    const parent = findNodeByFullPath(activeFolder.rootNode, parentFullPath);
    if (!parent || parent.kind !== 'directory') return;
    const siblings = parent.children ?? [];
    const err = validateName(name, siblings);
    if (err) { toast(err); return; }
    const trimmed = name.trim();
    const newPath = joinPath(parentFullPath, trimmed);
    try {
      await writeTextFile(newPath, '');
    } catch (e) {
      toast(getErrorMessage(e));
      return;
    }
    await get().refreshWorkspaceDir(workspaceId, parentFullPath);
  },

  createDirectoryInWorkspace: async (workspaceId, parentFullPath, name) => {
    const ws = get().workspaces.find((w) => w.id === workspaceId);
    if (!ws) return;
    const folders = getConnectedFolders(ws);
    const activeFolder = folders.find((f) => f.id === ws.activeFolderId);
    if (!activeFolder?.rootNode) return;
    const parent = findNodeByFullPath(activeFolder.rootNode, parentFullPath);
    if (!parent || parent.kind !== 'directory') return;
    const siblings = parent.children ?? [];
    const err = validateName(name, siblings);
    if (err) { toast(err); return; }
    const trimmed = name.trim();
    const newPath = joinPath(parentFullPath, trimmed);
    try {
      await mkdir(newPath);
    } catch (e) {
      toast(getErrorMessage(e));
      return;
    }
    await get().refreshWorkspaceDir(workspaceId, parentFullPath);
  },

  renameInWorkspace: async (workspaceId, fullPath, newName) => {
    const ws = get().workspaces.find((w) => w.id === workspaceId);
    if (!ws) return null;
    const folders = getConnectedFolders(ws);
    const activeFolder = folders.find((f) => f.id === ws.activeFolderId);
    if (!activeFolder?.rootNode) return null;
    const node = findNodeByFullPath(activeFolder.rootNode, fullPath);
    if (!node) return null;
    const parentFullPath = getParentFullPath(fullPath);
    const parent = findNodeByFullPath(activeFolder.rootNode, parentFullPath);
    if (!parent || parent.kind !== 'directory') return null;
    const siblings = (parent.children ?? []).filter((s) => s.fullPath !== fullPath);
    const err = validateName(newName, siblings);
    if (err) { toast(err); return null; }
    const trimmed = newName.trim();
    const newPath = joinPath(parentFullPath, trimmed);
    try {
      await fsRename(fullPath, newPath);
    } catch (e) {
      toast(getErrorMessage(e));
      return null;
    }
    await get().refreshWorkspaceDir(workspaceId, parentFullPath);

    // Update currentFile if it was renamed
    if (ws.currentFile?.path === fullPath) {
      get().updateWorkspace(workspaceId, {
        currentFile: { ...ws.currentFile, path: newPath, name: trimmed },
      });
    }

    return { oldPath: fullPath, newPath, kind: node.kind };
  },

  removeInWorkspace: async (workspaceId, fullPath) => {
    const ws = get().workspaces.find((w) => w.id === workspaceId);
    if (!ws) return [];
    const folders = getConnectedFolders(ws);
    const activeFolder = folders.find((f) => f.id === ws.activeFolderId);
    if (!activeFolder?.rootNode) return [];
    const node = findNodeByFullPath(activeFolder.rootNode, fullPath);
    if (!node) return [];
    const parentFullPath = getParentFullPath(fullPath);
    const removedPaths = collectAllFullPaths(node);
    try {
      await fsRemove(fullPath, node.kind === 'directory');
    } catch (e) {
      toast(getErrorMessage(e));
      return [];
    }
    await get().refreshWorkspaceDir(workspaceId, parentFullPath);

    // Clear currentFile if it was deleted
    if (ws.currentFile && removedPaths.includes(ws.currentFile.path)) {
      clearEditorStateCache(ws.currentFile.path);
      get().updateWorkspace(workspaceId, { currentFile: null });
    }

    return removedPaths;
  },

  moveInWorkspace: async (workspaceId, sourceFullPath, targetDirFullPath) => {
    const ws = get().workspaces.find((w) => w.id === workspaceId);
    if (!ws) return null;
    const folders = getConnectedFolders(ws);
    const activeFolder = folders.find((f) => f.id === ws.activeFolderId);
    if (!activeFolder?.rootNode) return null;
    const node = findNodeByFullPath(activeFolder.rootNode, sourceFullPath);
    const targetDir = findNodeByFullPath(activeFolder.rootNode, targetDirFullPath);
    if (!node || !targetDir || targetDir.kind !== 'directory') return null;
    if (targetDirFullPath === sourceFullPath || targetDirFullPath.startsWith(sourceFullPath + '/')) return null;
    const sourceParentFullPath = getParentFullPath(sourceFullPath);
    if (sourceParentFullPath === targetDirFullPath) return null;
    const siblings = targetDir.children ?? [];
    const nameErr = validateName(node.name, siblings);
    if (nameErr) { toast(nameErr); return null; }
    const newPath = joinPath(targetDirFullPath, node.name);
    try {
      await fsRename(sourceFullPath, newPath);
    } catch (e) {
      toast(getErrorMessage(e));
      return null;
    }
    await get().refreshWorkspaceDir(workspaceId, sourceParentFullPath);
    await get().refreshWorkspaceDir(workspaceId, targetDirFullPath);

    // Update currentFile if it was moved
    if (ws.currentFile?.path === sourceFullPath) {
      get().updateWorkspace(workspaceId, {
        currentFile: { ...ws.currentFile, path: newPath },
      });
    }

    return { oldPaths: collectAllFullPaths(node), newBasePath: newPath };
  },

  // ── Tree state (per-workspace) ──

  toggleExpandedPath: (workspaceId, path) => {
    const ws = get().workspaces.find((w) => w.id === workspaceId);
    if (!ws) return;
    const current = ws.expandedPaths;
    const isExpanded = current.includes(path);
    let next: string[];
    if (isExpanded) {
      next = current.filter((p) => p !== path);
    } else {
      const parentPath = path.substring(0, path.lastIndexOf('/'));
      next = [...current.filter((p) => {
        const pParent = p.substring(0, p.lastIndexOf('/'));
        return pParent !== parentPath;
      }), path];
    }
    get().updateWorkspace(workspaceId, { expandedPaths: next });
  },

  setExpandedPaths: (workspaceId, paths) => {
    get().updateWorkspace(workspaceId, { expandedPaths: paths });
  },

  setSelectedTreePath: (workspaceId, path) => {
    get().updateWorkspace(workspaceId, { selectedTreePath: path });
  },

  // ── Tauri shell integration ──

  openFileByPath: async (path) => {
    // Windows Open With passes backslashes; app paths use forward slashes.
    const fullPath = normalizePathSlashes(path.trim());
    if (!fullPath) return;

    const name = basename(fullPath);
    const parentPath = getParentFullPath(fullPath);
    const workspaces = get().workspaces;

    const node: TreeNode = { name, path: name, fullPath, kind: 'file' };

    // Prefer a workspace that already has the parent folder connected.
    for (const ws of workspaces) {
      const folders = getConnectedFolders(ws);
      const matchingFolder = folders.find((f) => {
        const folderPath = normalizePathSlashes(f.path);
        return folderPath === parentPath || parentPath.startsWith(folderPath + '/');
      });
      if (matchingFolder) {
        get().setActiveWorkspace(ws.id);
        await get().swapFileInWorkspace(ws.id, node, { skipPrompt: true });
        return;
      }
    }

    // No matching workspace — create a new one and attach the parent folder
    // when the path has a parent directory (drive roots still open the file).
    const newWs = await get().createWorkspace();
    if (isNativeFsAvailable() && parentPath && parentPath !== fullPath) {
      await get().connectFolderInWorkspace(newWs.id, parentPath);
    }
    await get().swapFileInWorkspace(newWs.id, node, { skipPrompt: true });
  },

  // ── Helpers ──

  getActiveWorkspace: () => {
    const { workspaces, activeWorkspaceId } = get();
    return workspaces.find((w) => w.id === activeWorkspaceId) ?? null;
  },

  getActiveRootNode: () => {
    const ws = get().getActiveWorkspace();
    if (!ws) return null;
    const folders = getConnectedFolders(ws);
    const activeFolder = folders.find((f) => f.id === ws.activeFolderId);
    return activeFolder?.rootNode ?? null;
  },

  getActiveConnectedFolders: () => {
    const ws = get().getActiveWorkspace();
    if (!ws) return [];
    return getConnectedFolders(ws);
  },

  getActiveFolderId: () => {
    const ws = get().getActiveWorkspace();
    return ws?.activeFolderId ?? null;
  },
}));
