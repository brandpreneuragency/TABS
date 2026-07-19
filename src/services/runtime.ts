// Runtime detector — selects the correct folder connector adapter.
//
// Call `getFolderConnector()` to get the singleton connector for the
// current runtime. This is the ONLY place that imports @tauri-apps/api/core
// for the purpose of adapter selection. UI code should never import
// @tauri-apps directly.
//
// Local-only: Tauri desktop → native FS; browser → File System Access API.

import type { FolderConnector } from './folder-connector';
import { BrowserFolderConnector } from './browser-folder-connector';

let _connector: FolderConnector | null = null;

/** True if currently running inside a Tauri webview. */
export function isTauriRuntime(): boolean {
  // The Tauri runtime injects `window.__TAURI_INTERNALS__` (or the
  // `isTauri()` helper from @tauri-apps/api/core).  We check for the
  // internals flag directly so this module does not need to await a
  // dynamic import — `isTauri()` from @tauri-apps/api/core is safe to
  // call synchronously in Tauri 2.
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) return true;
  return false;
}

/** Lazy-initialise and return the folder connector for the current runtime. */
export async function getFolderConnector(): Promise<FolderConnector> {
  if (_connector) return _connector;

  if (isTauriRuntime()) {
    // Dynamic import so the browser bundle never pulls in Tauri plugins.
    const { TauriFolderConnector } = await import('./tauri-folder-connector');
    _connector = new TauriFolderConnector();
  } else {
    _connector = new BrowserFolderConnector();
  }

  return _connector;
}

/** Synchronous access — returns null before the first async init. */
export function getCachedFolderConnector(): FolderConnector | null {
  return _connector;
}
