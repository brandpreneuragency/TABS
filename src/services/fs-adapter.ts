// Bridge between the TABS frontend and the platform's file system.
//
// All file I/O in the app flows through these functions so that:
//   1. fs/dialog call sites in stores and components are typed and uniform
//   2. Unit tests can mock this module to test behaviour without touching disk
//   3. The backend (Tauri native vs browser fallback) is chosen via the
//      FolderConnector service boundary
//
// Paths are stored with forward slashes everywhere; Tauri accepts both
// forward and backward slashes on Windows, so this is a lossless normalisation.
//
// IMPORTANT: In browser mode, folder operations gracefully return empty
// results or null instead of throwing. The UI layer checks the connector
// state to show appropriate messaging.

import { getFolderConnector, isTauriRuntime } from './runtime';

export interface FsDirEntry {
  name: string;
  /** Absolute path of the entry (forward slashes). */
  path: string;
  kind: 'file' | 'directory';
}

export interface FsMetadata {
  size: number;
  modifiedAt: Date | null;
  isDirectory: boolean;
  isFile: boolean;
}

// Path helpers -------------------------------------------------------------

function normalize(p: string): string {
  return p.replace(/\\/g, '/');
}

/** Join a parent path and a child name (OS paths with forward slashes). */
export function joinPath(parent: string, name: string): string {
  const norm = normalize(parent).replace(/\/+$/, '');
  return norm + '/' + name;
}

/** Browser File System Access API synthetic root prefix (see browser-folder-connector). */
const BROWSER_ROOT_PREFIX = '__BROWSER_ROOT__:';

export function basename(p: string): string {
  const norm = normalize(p);
  const base = norm.split('/').pop() ?? p;
  // Browser roots are stored as "__BROWSER_ROOT__:FolderName" with no slash.
  if (base.startsWith(BROWSER_ROOT_PREFIX)) {
    return base.slice(BROWSER_ROOT_PREFIX.length);
  }
  return base;
}

export function getExt(p: string): string {
  const m = normalize(p).match(/\.([^./]+)$/);
  return m ? m[1].toLowerCase() : '';
}

// Runtime check for callers that need a boolean before async init ---------

/** Returns true if native folder access is available (Tauri or File System Access API). */
export function isNativeFsAvailable(): boolean {
  if (isTauriRuntime()) return true;
  return 'showDirectoryPicker' in window;
}

// Dialog picks ---------------------------------------------------------

/** Show a native folder picker. Returns the absolute path, or null if the
 *  user cancelled or native access is unavailable. */
export async function openFolderDialog(): Promise<string | null> {
  const connector = await getFolderConnector();
  return connector.connectFolder();
}

/** Show a native file-open picker. Returns the absolute path, or null if the
 *  user cancelled or native access is unavailable. */
export async function openFileDialog(
  filters: { name: string; extensions: string[] }[] = []
): Promise<string | null> {
  const connector = await getFolderConnector();
  return connector.pickOpenFile(filters);
}

/** Show a native Save As dialog. `defaultPath` may be either a file name
 *  ("note.md") or a folder ("/path/to/folder") in which case the suggested
 *  file name is appended. */
export async function pickSaveTabsPath(
  suggestedName: string,
  filters: { name: string; extensions: string[] }[] = [{ name: 'All Files', extensions: ['*'] }],
  defaultPath?: string
): Promise<string | null> {
  const connector = await getFolderConnector();
  return connector.pickSavePath(suggestedName, defaultPath, filters);
}

// Directory and file I/O ---------------------------------------------------

/** List a directory's immediate children (non-recursive). */
export async function readDir(path: string): Promise<FsDirEntry[]> {
  const connector = await getFolderConnector();
  if (!connector.isAvailable()) return [];
  const entries = await connector.readDir(path);
  return entries.map((e) => ({
    name: e.name,
    path: e.path,
    kind: e.kind,
  }));
}

/** Read a UTF-8 text file. Throws if native FS is unavailable. */
export async function readTextFile(path: string): Promise<string> {
  const connector = await getFolderConnector();
  return connector.readTextFile(path);
}

/** Read a file's raw bytes. Throws if native FS is unavailable. */
export async function readBinaryFile(path: string): Promise<Uint8Array> {
  const connector = await getFolderConnector();
  return connector.readBinaryFile(path);
}

/** Write a UTF-8 text file. Creates the file if it does not exist;
 *  overwrites if it does. Throws if native FS is unavailable. */
export async function writeTextFile(path: string, content: string): Promise<void> {
  const connector = await getFolderConnector();
  await connector.writeTextFile(path, content);
}

/** Create a directory. */
export async function mkdir(path: string, recursive = false): Promise<void> {
  const connector = await getFolderConnector();
  await connector.mkdir(path, recursive);
}

/** Delete a file or directory. `recursive` must be true to delete a
 *  non-empty directory. */
export async function remove(path: string, recursive = false): Promise<void> {
  const connector = await getFolderConnector();
  await connector.remove(path, recursive);
}

/** Rename or move a file or directory (atomic, single call). */
export async function rename(from: string, to: string): Promise<void> {
  const connector = await getFolderConnector();
  await connector.rename(from, to);
}

/** Check whether a path exists on disk. Returns false in browser. */
export async function exists(path: string): Promise<boolean> {
  const connector = await getFolderConnector();
  if (!connector.isAvailable()) return false;
  return connector.exists(path);
}

/** Get file metadata (size, mtime, kind). Throws if native FS unavailable. */
export async function getMetadata(path: string): Promise<FsMetadata> {
  const connector = await getFolderConnector();
  const meta = await connector.getMetadata(path);
  return {
    size: meta.size,
    modifiedAt: meta.modifiedAt,
    isDirectory: meta.isDirectory,
    isFile: meta.isFile,
  };
}
