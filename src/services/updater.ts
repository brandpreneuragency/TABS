// Tauri auto-updater integration.
//
// On startup (Tauri only) we check the configured update endpoint. If a
// newer version is published, we surface a toast with an "Update" action.
// Clicking it downloads, installs, and relaunches the app.
//
// The web build is a no-op — `isTauri()` is false in the browser, so
// the check is skipped and nothing is downloaded.
//
// To publish an update:
//   1. Bump `version` in package.json AND tauri.conf.json.
//   2. `npm run tauri:build` — this generates the .nsis/.msi bundles
//      and a `latest.json` manifest in `src-tauri/target/release/`.
//   3. Upload the bundles and `latest.json` to the endpoint configured
//      in `tauri.conf.json` -> plugins.updater.endpoints (GitHub
//      Releases, S3, or any HTTPS server).
//   4. Tag the release so the manifest URL resolves.

import { isTauri } from '@tauri-apps/api/core';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { desktopLifecycleAdapter } from './agent/lifecycle/desktopLifecycleAdapter';
import { useUIStore } from '../stores/uiStore';

export interface UpdateCheckResult {
  available: boolean;
  currentVersion: string;
  newVersion?: string;
  notes?: string;
}

let lastCheck: UpdateCheckResult | null = null;

/**
 * Check for updates. Safe to call from the browser — returns `available: false`.
 * Caches the last result so repeated calls in the same session are free.
 */
export async function checkForUpdate(
  options: { force?: boolean } = {},
): Promise<UpdateCheckResult> {
  if (!isTauri()) {
    return { available: false, currentVersion: '' };
  }
  if (lastCheck && !options.force) {
    return lastCheck;
  }

  try {
    const update = await check();
    const result: UpdateCheckResult = {
      available: !!update?.available,
      currentVersion: update?.currentVersion ?? '',
      newVersion: update?.available ? update.version : undefined,
      notes: typeof update?.body === 'string' ? update.body : undefined,
    };
    lastCheck = result;
    return result;
  } catch (err) {
    // Network errors, invalid manifest, etc. — don't spam the user.
    console.warn('[updater] Check failed:', err);
    return { available: false, currentVersion: '' };
  }
}

/**
 * Download and install the available update, then relaunch the app.
 * Must be called from a user gesture (button click) on Windows so the
 * installer UI can take focus.
 */
export async function applyUpdate(update: Update): Promise<void> {
  // Plan 25.4: acquire the quiescing barrier before download installation.
  const prepared = await desktopLifecycleAdapter.prepareForRestart();
  try {
    await desktopLifecycleAdapter.installUpdate(prepared.requestToken);
    await update.downloadAndInstall();
    await relaunch();
  } catch (error) {
    await desktopLifecycleAdapter.cancelUpdate(prepared.requestToken);
    throw error;
  }
}

/**
 * Convenience: run a check and, if an update is available, show a toast
 * with an "Update & restart" action. Intended to be called once on app
 * startup.
 */
export async function runStartupUpdateCheck(): Promise<void> {
  if (!isTauri()) return;
  try {
    const result = await checkForUpdate();
    if (!result.available) return;

    const versionLabel = result.newVersion ? ` v${result.newVersion}` : '';
    const showToastWithAction = useUIStore.getState().showToastWithAction;

    // We re-fetch the live `Update` handle inside the action so the
    // install uses a fresh manifest in case the user waited.
    showToastWithAction(
      `A new version of TABS${versionLabel} is available.`,
      'Update & restart',
      async () => {
        try {
          const live = await check();
          if (live?.available) {
            await applyUpdate(live);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Update failed.';
          useUIStore.getState().showToast(msg, 'error');
        }
      },
      'info',
    );
  } catch {
    // Swallow — startup checks must never crash the app.
  }
}
