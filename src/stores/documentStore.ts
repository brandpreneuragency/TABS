// Document store. Local-first using Dexie (Tauri desktop).
// Documents stored in IndexedDB, editor content as TipTap JSON.

import { create } from 'zustand';
import { nanoid } from 'nanoid';
import type { Document, FileViewerItem } from '../types';
import { db } from '../services/db';
import { useUIStore } from './uiStore';
import { parseByExt } from '../services/fileFormat';
import { parseDocx } from '../services/docxFormat';
import { isTextFile, isImageFile, isDocxFile } from '../utils/fileType';
import { readTextFile, readBinaryFile } from '../services/fs-adapter';
import type { TreeNode } from './fileSystemStore';
import { decodeDataUrlBytes, decodeDataUrlText } from '../utils/fileData';

const toast = (msg: string) => useUIStore.getState().showToast(msg, 'error');

interface DocumentStore {
  documents: Document[];
  activeDocumentId: string | null;
  isLoaded: boolean;

  loadDocuments: () => Promise<void>;
  createDocument: (title?: string) => Promise<Document>;
  updateDocument: (id: string, updates: Partial<Document>) => Promise<void>;
  deleteDocument: (id: string) => Promise<void>;
  setActiveDocument: (id: string) => void;
  duplicateDocument: (id: string) => Promise<Document>;
  getActiveDocument: () => Document | null;
  openFileFromViewer: (file: FileViewerItem) => Promise<Document | null>;
  // Tauri-only methods for desktop build
  openFileAsDocument: (node: TreeNode) => Promise<Document | null>;
  openFileFromTree: (node: TreeNode, forceNewTab?: boolean) => Promise<Document | null>;
  openFileByPath: (path: string) => Promise<Document | null>;
  renameDocumentBySourcePath: (oldPath: string, newPath: string, newTitle: string) => Promise<void>;
  deleteDocumentsBySourcePaths: (paths: string[]) => Promise<void>;
}

function emptyDocumentShell(title: string, order: number, colorIndex: number = 0): Document {
  const now = Date.now();
  return {
    id: nanoid(8),
    title,
    content: '',
    createdAt: now,
    updatedAt: now,
    order,
    colorIndex,
  };
}

function generateTempTitle(docs: Document[]): string {
  const existingNumbers = new Set<number>();
  for (const doc of docs) {
    const match = doc.title.match(/^(\d+)_Temp$/);
    if (match) {
      existingNumbers.add(parseInt(match[1], 10));
    }
  }
  let next = 1;
  while (existingNumbers.has(next)) {
    next++;
  }
  return `${next}_Temp`;
}

export const useDocumentStore = create<DocumentStore>((set, get) => ({
  documents: [],
  activeDocumentId: null,
  isLoaded: false,

  loadDocuments: async () => {
    try {
      const documents = await db.documents.toArray();
      if (documents.length === 0) {
        const first = await get().createDocument();
        set({ documents: [first], activeDocumentId: first.id, isLoaded: true });
        return;
      }
      // Backward compatibility: ensure title and colorIndex exist on old records
      const documentsWithColor = documents.map((doc, index) => ({
        ...doc,
        title: doc.title ?? 'Untitled',
        colorIndex: doc.colorIndex ?? (index % 6),
      }));
      const row = await db.settings.get('lastActiveDocumentId');
      const lastActiveId = row?.value as string | undefined;
      const activeId =
        (typeof lastActiveId === 'string' && documentsWithColor.find((d) => d.id === lastActiveId)
          ? lastActiveId
          : documentsWithColor[0].id) ?? documentsWithColor[0].id;
      set({ documents: documentsWithColor, activeDocumentId: activeId, isLoaded: true });
    } catch {
      set({ isLoaded: true });
    }
  },

  createDocument: async (title?: string) => {
    const docs = get().documents;

    // Generate a numbered temp title if none provided (e.g., "1_Temp", "2_Temp", ...)
    const finalTitle = title ?? generateTempTitle(docs);

    // Keep only one empty temp draft tab at a time.
    if (!title) {
      const tempEmptyIds = docs
        .filter((d) => /^\d+_Temp$/.test(d.title) && !d.sourcePath && !d.content?.includes('"text":'))
        .map((d) => d.id);

      if (tempEmptyIds.length > 0) {
        for (const id of tempEmptyIds) {
          await db.documents.delete(id).catch(() => undefined);
        }
        const filtered = docs.filter((d) => !tempEmptyIds.includes(d.id));
        const nextActiveId = filtered[filtered.length - 1]?.id ?? null;
        set({ documents: filtered, activeDocumentId: nextActiveId });
      }
    }

    // Cycle colors based on document count (modulo 6)
    const colorIndex = get().documents.length % 6;
    const shell = emptyDocumentShell(finalTitle, get().documents.length, colorIndex);
    await db.documents.add(shell);
    set((s) => ({
      documents: [...s.documents, shell],
      activeDocumentId: shell.id,
    }));
    return shell;
  },

  updateDocument: async (id, updates) => {
    const patch: DocumentUpdatePatch = { ...updates, updatedAt: Date.now() };
    // Optimistic local update so the editor doesn't flicker. Convert
    // `null` to `undefined` to match the `Document` shape (the client-side type
    // uses `undefined` to mean "no field").
    const optimistic: Partial<Document> = {};
    if (patch.title !== undefined) optimistic.title = patch.title;
    if (patch.content !== undefined) optimistic.content = patch.content;
    if (patch.sourcePath !== undefined && patch.sourcePath !== null) {
      optimistic.sourcePath = patch.sourcePath;
    }
    if (patch.isDirty !== undefined) optimistic.isDirty = patch.isDirty;
    optimistic.updatedAt = patch.updatedAt;
    set((s) => ({
      documents: s.documents.map((d) => (d.id === id ? { ...d, ...optimistic } : d)),
    }));
    try {
      await db.documents.update(id, {
        title: patch.title,
        content: patch.content,
        sourcePath: patch.sourcePath === undefined ? undefined : (patch.sourcePath ?? undefined),
        isDirty: patch.isDirty,
      });
    } catch {
      // Best-effort: refetch on failure.
      try {
        const documents = await db.documents.toArray();
        set({ documents });
      } catch {
        /* ignore */
      }
    }
  },

  deleteDocument: async (id) => {
    const closedDoc = get().documents.find((d) => d.id === id);
    const wasEmpty = !closedDoc?.content?.includes('"text":');
    try {
      await db.documents.delete(id);
    } catch (err) {
      console.warn('[documentStore] failed to delete document:', err);
    }
    const docs = get().documents.filter((d) => d.id !== id);
    let activeId = get().activeDocumentId;
    if (activeId === id) activeId = docs[docs.length - 1]?.id ?? null;
    if (docs.length === 0 && !wasEmpty) {
      const newDoc = await get().createDocument();
      set({ documents: [newDoc], activeDocumentId: newDoc.id });
      return;
    }
    set({ documents: docs, activeDocumentId: activeId });
  },

  setActiveDocument: (id) => {
    set({ activeDocumentId: id });
    // Selecting a normal document tab exits the special Settings doc view.
    useUIStore.getState().setActiveView('document');
    void db.settings.put({ key: 'lastActiveDocumentId', value: id }).catch(() => undefined);
  },

  duplicateDocument: async (id) => {
    const source = get().documents.find((d) => d.id === id);
    if (!source) throw new Error('Document not found');
    const colorIndex = get().documents.length % 6;
    const shell: Document = {
      ...source,
      id: nanoid(8),
      title: `${source.title} (copy)`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      order: get().documents.length,
      colorIndex,
    };
    await db.documents.add(shell);
    set((s) => ({
      documents: [...s.documents, shell],
      activeDocumentId: shell.id,
    }));
    return shell;
  },

  getActiveDocument: () => {
    const { documents, activeDocumentId } = get();
    return documents.find((d) => d.id === activeDocumentId) ?? null;
  },

  // ── File viewer (image / text via data URL) ──────────────────────────────
  openFileFromViewer: async (file) => {
    const { documents } = get();
    const ext = file.name.split('.').pop()?.toLowerCase() ?? '';

    if (file.dataUrl && isTextFile(file.name)) {
      let text: string;
      try {
        text = decodeDataUrlText(file.dataUrl);
      } catch {
        toast('Could not decode file content.');
        return null;
      }
      let json: object;
      try {
        json = parseByExt(text, ext);
      } catch {
        toast(`Could not parse file: ${file.name}`);
        return null;
      }
      const colorIndex = documents.length % 6;
      const shell: Document = {
        id: nanoid(8),
        title: file.name,
        content: JSON.stringify(json),
        sourcePath: file.path,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        order: documents.length,
        colorIndex,
      };
      await db.documents.add(shell);
      set((s) => ({
        documents: [...s.documents, shell],
        activeDocumentId: shell.id,
      }));
      return shell;
    }

    if (file.dataUrl && isDocxFile(file.name)) {
      let json: object;
      try {
        const bytes = decodeDataUrlBytes(file.dataUrl);
        json = await parseDocx(bytes);
      } catch {
        toast(`Could not parse Word document: ${file.name}`);
        return null;
      }
      const colorIndex = documents.length % 6;
      const shell: Document = {
        id: nanoid(8),
        title: file.name,
        content: JSON.stringify(json),
        sourcePath: file.path,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        order: documents.length,
        colorIndex,
      };
      await db.documents.add(shell);
      set((s) => ({
        documents: [...s.documents, shell],
        activeDocumentId: shell.id,
      }));
      return shell;
    }

    if (file.dataUrl && isImageFile(file.name)) {
      const content = {
        type: 'doc',
        content: [
          {
            type: 'image',
            attrs: { src: file.dataUrl },
          },
        ],
      };
      const colorIndex = documents.length % 6;
      const shell: Document = {
        id: nanoid(8),
        title: file.name,
        content: JSON.stringify(content),
        sourcePath: file.path,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        order: documents.length,
        colorIndex,
      };
      await db.documents.add(shell);
      set((s) => ({
        documents: [...s.documents, shell],
        activeDocumentId: shell.id,
      }));
      return shell;
    }

    toast(`Unsupported file type for editor: .${ext}`);
    return null;
  },

  // ── Tauri / Browser File System Access ──────────────────────────────────────────────
  openFileAsDocument: async (node) => {
    const { documents } = get();
    const ext = node.name.split('.').pop()?.toLowerCase() ?? '';

    // Check if already open
    const existing = documents.find((d) => d.sourcePath === node.fullPath);
    if (existing) {
      get().setActiveDocument(existing.id);
      return existing;
    }

    if (isDocxFile(node.name)) {
      try {
        const bytes = await readBinaryFile(node.fullPath);
        let json: object;
        try {
          json = await parseDocx(bytes);
        } catch {
          toast(`Could not parse Word document: ${node.name}`);
          return null;
        }

        const colorIndex = documents.length % 6;
        const shell: Document = {
          id: nanoid(8),
          title: node.name,
          content: JSON.stringify(json),
          sourcePath: node.fullPath,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          order: documents.length,
          colorIndex,
        };
        await db.documents.add(shell);
        set((s) => ({
          documents: [...s.documents, shell],
          activeDocumentId: shell.id,
        }));
        return shell;
      } catch {
        toast(`Could not read file: ${node.name}`);
        return null;
      }
    }

    if (isTextFile(node.name)) {
      try {
        const text = await readTextFile(node.fullPath);
        let json: object;
        try {
          json = parseByExt(text, ext);
        } catch {
          // Fallback to plain text if parsing fails
          json = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
        }

        const colorIndex = documents.length % 6;
        const shell: Document = {
          id: nanoid(8),
          title: node.name,
          content: JSON.stringify(json),
          sourcePath: node.fullPath,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          order: documents.length,
          colorIndex,
        };
        await db.documents.add(shell);
        set((s) => ({
          documents: [...s.documents, shell],
          activeDocumentId: shell.id,
        }));
        return shell;
      } catch {
        toast(`Could not read file: ${node.name}`);
        return null;
      }
    }

    toast(`Unsupported file type for editor: .${ext}`);
    return null;
  },

  openFileFromTree: async (node, forceNewTab = false) => {
    const { documents } = get();
    
    if (!forceNewTab) {
      const existing = documents.find((d) => d.sourcePath === node.fullPath);
      if (existing) {
        get().setActiveDocument(existing.id);
        return existing;
      }
    }

    return get().openFileAsDocument(node);
  },

  openFileByPath: async (path) => {
    const { documents } = get();
    const existing = documents.find((d) => d.sourcePath === path);
    if (existing) {
      get().setActiveDocument(existing.id);
      return existing;
    }

    // This is trickier because we only have a path, not a TreeNode.
    // For now, let's assume it's a text file and use the basename as title.
    const name = path.split('/').pop() ?? 'Untitled';
    const node: TreeNode = {
      name,
      path: name, // This might not be quite right for display path but it's a start
      fullPath: path,
      kind: 'file'
    };
    return get().openFileAsDocument(node);
  },

  renameDocumentBySourcePath: async (oldPath, newPath, newTitle) => {
    try {
      const doc = get().documents.find((d) => d.sourcePath === oldPath);
      if (doc) {
        await db.documents.update(doc.id, { sourcePath: newPath, title: newTitle });
      }
    } catch (err) {
      console.warn('[documentStore] failed to rename document by source path:', err);
    }
  },

  deleteDocumentsBySourcePaths: async (paths) => {
    try {
      const pathSet = new Set(paths);
      const toDelete = get().documents.filter((d) => d.sourcePath && pathSet.has(d.sourcePath));
      for (const doc of toDelete) {
        await get().deleteDocument(doc.id);
      }
    } catch (err) {
      console.warn('[documentStore] failed to delete documents by source paths:', err);
    }
  },
}));

interface DocumentUpdatePatch {
  title?: string;
  content?: string;
  sourcePath?: string | null;
  isDirty?: boolean;
  updatedAt: number;
}
