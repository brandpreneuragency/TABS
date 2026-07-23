// Folder connector service — bridge pattern.
//
// The web app is the primary experience. Folder connection is an optional
// desktop capability. When running in Tauri, the Tauri adapter provides real
// native folder access. In the browser, the connector reports "unsupported"
// and shows a message to open the desktop app.
//
// UI components must call only this interface. Never call Tauri APIs directly.

export type FolderConnectionState =
  | 'unsupported'   // browser — no native folder access
  | 'available'      // Tauri runtime detected, ready to connect
  | 'connecting'     // picker dialog open / folder is loading
  | 'connected'      // folder connected and tree loaded
  | 'error';         // permission lost or I/O error

export interface FolderConnector {
  /** Current connection capability & state. */
  readonly state: FolderConnectionState;

  /** Whether native folder access is available at all (Tauri detected). */
  isAvailable(): boolean;

  /** Show the native folder picker and connect to the chosen folder.
   *  Returns the absolute path of the connected folder, or null if
   *  the user cancelled or the runtime doesn't support it. */
  connectFolder(): Promise<string | null>;

  /** Read the root-level children of a connected folder. */
  readDir(path: string): Promise<FolderDirEntry[]>;

  /** Read a text file. */
  readTextFile(path: string): Promise<string>;

  /** Read a file's raw bytes (used for image attachments). */
  readBinaryFile(path: string): Promise<Uint8Array>;

  /** Write a text file (creates or overwrites). */
  writeTextFile(path: string, content: string): Promise<void>;

  /** Write raw bytes (creates or overwrites). Used for binary formats like .docx. */
  writeBinaryFile(path: string, content: Uint8Array): Promise<void>;

  /** Create a directory. */
  mkdir(path: string, recursive?: boolean): Promise<void>;

  /** Delete a file or directory. */
  remove(path: string, recursive?: boolean): Promise<void>;

  /** Rename / move a path. */
  rename(from: string, to: string): Promise<void>;

  /** Check whether a path exists on disk. */
  exists(path: string): Promise<boolean>;

  /** Get file/directory metadata. */
  getMetadata(path: string): Promise<FolderMetadata>;

  /** Present a Save As dialog. */
  pickSavePath(
    suggestedName: string,
    defaultPath?: string,
    filters?: { name: string; extensions: string[] }[],
  ): Promise<string | null>;

  /** Present an Open File dialog. */
  pickOpenFile(filters?: { name: string; extensions: string[] }[]): Promise<string | null>;

  /** State change callback for UI reactivity. */
  onStateChange?: (state: FolderConnectionState) => void;
}

export interface FolderDirEntry {
  name: string;
  path: string;
  kind: 'file' | 'directory';
}

export interface FolderMetadata {
  size: number;
  modifiedAt: Date | null;
  isDirectory: boolean;
  isFile: boolean;
}
