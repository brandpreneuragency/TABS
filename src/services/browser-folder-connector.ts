// Browser folder connector — uses the File System Access API when available.
//
// Modern browsers support the File System Access API, which allows web apps
// to access user-selected folders and files. The main limitation is that
// we don't have real filesystem paths; instead we work with handles.
// To work around this, we store the root handle and use a special path marker.

import type {
  FolderConnector,
  FolderConnectionState,
  FolderDirEntry,
  FolderMetadata,
} from './folder-connector';

const ROOT_MARKER = '__BROWSER_ROOT__';

/** Check if File System Access API is available. */
function isFileSystemAccessAvailable(): boolean {
  return 'showDirectoryPicker' in window;
}

/** Store for folder handles keyed by root path marker. */
const folderHandleCache = new Map<string, FileSystemDirectoryHandle>();

export class BrowserFolderConnector implements FolderConnector {
  private _rootPath: string | null = null;
  private _state: FolderConnectionState = isFileSystemAccessAvailable() ? 'available' : 'unsupported';
  private _onStateChange?: (state: FolderConnectionState) => void;

  get state(): FolderConnectionState {
    return this._state;
  }

  isAvailable(): boolean {
    return isFileSystemAccessAvailable();
  }

  set onStateChange(callback: ((state: FolderConnectionState) => void) | undefined) {
    this._onStateChange = callback;
  }

  private setState(state: FolderConnectionState): void {
    if (this._state !== state) {
      this._state = state;
      this._onStateChange?.(state);
    }
  }

  async connectFolder(): Promise<string | null> {
    if (!isFileSystemAccessAvailable()) {
      return null;
    }

    try {
      this.setState('connecting');
      const dirHandle = await window.showDirectoryPicker();
      this._rootPath = `${ROOT_MARKER}:${dirHandle.name}`;
      folderHandleCache.set(this._rootPath, dirHandle);
      this.setState('connected');
      return this._rootPath;
    } catch {
      this.setState('available');
      return null;
    }
  }

  private async getHandleAtPath(path: string): Promise<FileSystemDirectoryHandle | null> {
    if (!path.startsWith(ROOT_MARKER)) return null;

    // Extract root key (e.g., "__BROWSER_ROOT__:FolderName")
    const afterMarker = path.substring(ROOT_MARKER.length + 1); // Skip "__BROWSER_ROOT__:"
    const firstSlash = afterMarker.indexOf('/');
    const rootName = firstSlash === -1 ? afterMarker : afterMarker.substring(0, firstSlash);
    const rootKey = `${ROOT_MARKER}:${rootName}`;
    
    const cached = folderHandleCache.get(rootKey);
    if (!cached) return null;

    // Get path parts after the root name
    const parts = firstSlash === -1 ? [] : afterMarker.substring(firstSlash + 1).split('/').filter(Boolean);
    if (parts.length === 0) return cached;

    let current: FileSystemHandle = cached;
    for (const part of parts) {
      if (current.kind !== 'directory') return null;
      try {
        current = await (current as FileSystemDirectoryHandle).getDirectoryHandle(part);
      } catch {
        return null;
      }
    }

    return current.kind === 'directory' ? (current as FileSystemDirectoryHandle) : null;
  }

  async readDir(path: string): Promise<FolderDirEntry[]> {
    const handle = await this.getHandleAtPath(path);
    if (!handle) return [];

    try {
      const entries: FolderDirEntry[] = [];
      for await (const entry of handle.values()) {
        entries.push({
          name: entry.name,
          path: `${path}/${entry.name}`,
          kind: entry.kind,
        });
      }
      return entries;
    } catch {
      return [];
    }
  }

  async readTextFile(path: string): Promise<string> {
    const parentPath = path.substring(0, path.lastIndexOf('/'));
    const fileName = path.substring(path.lastIndexOf('/') + 1);

    const parentHandle = await this.getHandleAtPath(parentPath);
    if (!parentHandle) throw new Error('Parent directory not found.');

    try {
      const fileHandle = await parentHandle.getFileHandle(fileName);
      const file = await fileHandle.getFile();
      return await file.text();
    } catch (err) {
      throw new Error(`Failed to read file: ${getErrorMessage(err)}`);
    }
  }

  async readBinaryFile(path: string): Promise<Uint8Array> {
    const parentPath = path.substring(0, path.lastIndexOf('/'));
    const fileName = path.substring(path.lastIndexOf('/') + 1);

    const parentHandle = await this.getHandleAtPath(parentPath);
    if (!parentHandle) throw new Error('Parent directory not found.');

    try {
      const fileHandle = await parentHandle.getFileHandle(fileName);
      const file = await fileHandle.getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch (err) {
      throw new Error(`Failed to read file: ${getErrorMessage(err)}`);
    }
  }

  async writeTextFile(path: string, content: string): Promise<void> {
    const parentPath = path.substring(0, path.lastIndexOf('/'));
    const fileName = path.substring(path.lastIndexOf('/') + 1);

    const parentHandle = await this.getHandleAtPath(parentPath);
    if (!parentHandle) throw new Error('Parent directory not found.');

    try {
      const fileHandle = await parentHandle.getFileHandle(fileName, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(content);
      await writable.close();
    } catch (err) {
      throw new Error(`Failed to write file: ${getErrorMessage(err)}`);
    }
  }

  async writeBinaryFile(path: string, content: Uint8Array): Promise<void> {
    const parentPath = path.substring(0, path.lastIndexOf('/'));
    const fileName = path.substring(path.lastIndexOf('/') + 1);

    const parentHandle = await this.getHandleAtPath(parentPath);
    if (!parentHandle) throw new Error('Parent directory not found.');

    try {
      const fileHandle = await parentHandle.getFileHandle(fileName, { create: true });
      const writable = await fileHandle.createWritable();
      // Copy into a fresh ArrayBuffer-backed view (BlobPart / FileSystemWriteChunkType).
      const chunk = new Uint8Array(content.byteLength);
      chunk.set(content);
      await writable.write(chunk);
      await writable.close();
    } catch (err) {
      throw new Error(`Failed to write file: ${getErrorMessage(err)}`);
    }
  }

  async mkdir(path: string): Promise<void> {
    const parentPath = path.substring(0, path.lastIndexOf('/'));
    const dirName = path.substring(path.lastIndexOf('/') + 1);

    const parentHandle = await this.getHandleAtPath(parentPath);
    if (!parentHandle) throw new Error('Parent directory not found.');

    try {
      await parentHandle.getDirectoryHandle(dirName, { create: true });
    } catch (err) {
      throw new Error(`Failed to create directory: ${getErrorMessage(err)}`);
    }
  }

  async remove(path: string): Promise<void> {
    const parentPath = path.substring(0, path.lastIndexOf('/'));
    const name = path.substring(path.lastIndexOf('/') + 1);

    const parentHandle = await this.getHandleAtPath(parentPath);
    if (!parentHandle) throw new Error('Parent directory not found.');

    try {
      await parentHandle.removeEntry(name, { recursive: true });
    } catch (err) {
      throw new Error(`Failed to remove entry: ${getErrorMessage(err)}`);
    }
  }

  async rename(from: string, to: string): Promise<void> {
    const fromParentPath = from.substring(0, from.lastIndexOf('/'));
    const fromName = from.substring(from.lastIndexOf('/') + 1);

    const parentHandle = await this.getHandleAtPath(fromParentPath);
    if (!parentHandle) throw new Error('Parent directory not found.');

    try {
      const entry = await parentHandle.getFileHandle(fromName).catch(() =>
        parentHandle.getDirectoryHandle(fromName)
      );

      if (entry.kind === 'file') {
        const file = await (entry as FileSystemFileHandle).getFile();
        const content = await file.text();
        await this.writeTextFile(to, content);
        await parentHandle.removeEntry(fromName);
      } else {
        throw new Error('Directory rename not supported via File System Access API.');
      }
    } catch (err) {
      throw new Error(`Failed to rename: ${getErrorMessage(err)}`);
    }
  }

  async exists(path: string): Promise<boolean> {
    try {
      const parentPath = path.substring(0, path.lastIndexOf('/'));
      const name = path.substring(path.lastIndexOf('/') + 1);
      const parentHandle = await this.getHandleAtPath(parentPath);
      if (!parentHandle) return false;

      await parentHandle.getFileHandle(name).catch(() =>
        parentHandle.getDirectoryHandle(name)
      );
      return true;
    } catch {
      return false;
    }
  }

  async getMetadata(path: string): Promise<FolderMetadata> {
    const parentPath = path.substring(0, path.lastIndexOf('/'));
    const name = path.substring(path.lastIndexOf('/') + 1);

    const parentHandle = await this.getHandleAtPath(parentPath);
    if (!parentHandle) throw new Error('Parent directory not found.');

    try {
      let entry: FileSystemHandle;
      try {
        entry = await parentHandle.getFileHandle(name);
      } catch {
        entry = await parentHandle.getDirectoryHandle(name);
      }

      if (entry.kind === 'directory') {
        return {
          size: 0,
          modifiedAt: null,
          isDirectory: true,
          isFile: false,
        };
      }

      const file = await (entry as FileSystemFileHandle).getFile();
      return {
        size: file.size,
        modifiedAt: new Date(file.lastModified),
        isDirectory: false,
        isFile: true,
      };
    } catch (err) {
      throw new Error(`Failed to get metadata: ${getErrorMessage(err)}`);
    }
  }

  async pickSavePath(
    _suggestedName?: string, // eslint-disable-line @typescript-eslint/no-unused-vars
    _defaultPath?: string, // eslint-disable-line @typescript-eslint/no-unused-vars
    _filters?: { name: string; extensions: string[] }[], // eslint-disable-line @typescript-eslint/no-unused-vars
  ): Promise<string | null> {
    if (!isFileSystemAccessAvailable()) {
      return null;
    }

    try {
      const handle = await window.showSaveFilePicker();
      return handle.name;
    } catch {
      return null;
    }
  }

  async pickOpenFile(): Promise<string | null> {
    if (!isFileSystemAccessAvailable()) {
      return null;
    }

    try {
      const handles = await window.showOpenFilePicker();
      if (handles.length === 0) return null;
      return handles[0].name;
    } catch {
      return null;
    }
  }
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
