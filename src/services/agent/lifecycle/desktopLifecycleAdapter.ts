// ---------------------------------------------------------------------------
// TABS Work-OS Harness — Desktop lifecycle adapter
// Plan 25.4 / 25.5 / 27.5. Tray Quit, quiescing, update install, notifications.
// React must not import @tauri-apps directly; this adapter owns that boundary.
// ---------------------------------------------------------------------------

import { isTauriRuntime } from '../../runtime';

export type LifecycleInvoker = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

export type LifecycleEvent<T> = { payload: T };

export type LifecycleListen = (
  event: string,
  handler: (event: LifecycleEvent<unknown>) => void,
) => Promise<() => void>;

export type LifecycleKind = 'shutdown' | 'update';
export type QuitChoice = 'pause' | 'cancel';
export type QuitOutcome = 'pause' | 'cancel' | 'unknown';
export type MutationWaitOutcome = 'settled' | 'unknown';
export type RunNotificationKind = 'approval' | 'review' | 'completed' | 'failed';

export const SHUTDOWN_REQUESTED_EVENT = 'tabs://shutdown-requested';

export const DESKTOP_STARTUP_ORDER = [
  'open_and_migrate_databases',
  'complete_credential_migrations',
  'load_application_state',
  'register_domain_event_subscribers',
  'reregister_native_workspace_scopes',
  'run_recovery_classification',
  'acquire_scheduler_lease',
  'mark_harness_client_ready',
  'start_runtime',
] as const;

export type DesktopStartupStage = (typeof DESKTOP_STARTUP_ORDER)[number];

/** Plan 27.5 Vite browser preview restrictions. */
export const BROWSER_LIFECYCLE_DEGRADATION = {
  desktopNotifications: 'disabled',
  hiddenWindowBackgroundWork: 'not_supported',
  durableRestartRecovery: 'not_supported_after_tab_close',
  fileTools: 'current_live_folder_handle_only',
  shellAndGitTools: 'disabled',
  secureCredentials: 'session_only_development_storage',
} as const;

export class BrowserLifecycleUnavailableError extends Error {
  readonly capability: string;
  readonly degradation: string;

  constructor(capability: string, degradation: string) {
    super(`${capability} is unavailable in the Vite browser preview (${degradation}).`);
    this.name = 'BrowserLifecycleUnavailableError';
    this.capability = capability;
    this.degradation = degradation;
  }
}

export class MutationOutcomeUnknownError extends Error {
  constructor() {
    super('prepareForRestart rejected because a mutation outcome is unknown.');
    this.name = 'MutationOutcomeUnknownError';
  }
}

export interface MutationWaitResult {
  outcome: MutationWaitOutcome;
  startedMutations: number;
}

export interface PreparedLifecycle {
  requestToken: string;
  requestId: string;
  outcome: QuitOutcome;
}

export interface DesktopLifecycleScheduler {
  beginQuiescing(reason: LifecycleKind, requestId: string): Promise<unknown>;
  endQuiescing(): Promise<unknown>;
}

export interface DesktopLifecycleRuntime {
  abortProviderAndReads(): Promise<void>;
  pauseAll(): Promise<void>;
  cancelAll(): Promise<void>;
}

export interface DesktopLifecycleMutations {
  waitForStarted(): Promise<MutationWaitResult>;
}

export interface StartupBarrierLike {
  run(): Promise<{
    ready: boolean;
    schedulerMayClaim: boolean;
    completedSteps: readonly string[];
  }>;
}

export interface DesktopLifecycleDependencies {
  isDesktop?: () => boolean;
  invoke?: LifecycleInvoker;
  listen?: LifecycleListen;
  scheduler?: DesktopLifecycleScheduler;
  runtime?: DesktopLifecycleRuntime;
  mutations?: DesktopLifecycleMutations;
  checkpoint?: () => Promise<void>;
}

export function resolveQuitOutcome(input: {
  choice: QuitChoice;
  mutationOutcome: MutationWaitOutcome;
}): QuitOutcome {
  if (input.mutationOutcome === 'unknown') return 'unknown';
  return input.choice;
}

function shutdownRequestId(payload: unknown): string | undefined {
  if (typeof payload === 'string' && payload.length > 0) return payload;
  if (payload && typeof payload === 'object' && 'requestId' in payload) {
    const value = (payload as { requestId?: unknown }).requestId;
    if (typeof value === 'string' && value.length > 0) return value;
  }
  if (payload && typeof payload === 'object' && 'request_id' in payload) {
    const value = (payload as { request_id?: unknown }).request_id;
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

async function defaultInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauriRuntime()) {
    throw new BrowserLifecycleUnavailableError(
      command,
      BROWSER_LIFECYCLE_DEGRADATION.hiddenWindowBackgroundWork,
    );
  }
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, args);
}

export class DesktopLifecycleAdapter {
  private readonly isDesktopFn: () => boolean;
  private readonly invokeCommand: LifecycleInvoker;
  private readonly listenFn?: LifecycleListen;
  private readonly scheduler?: DesktopLifecycleScheduler;
  private readonly runtime?: DesktopLifecycleRuntime;
  private readonly mutations?: DesktopLifecycleMutations;
  private readonly checkpointFn?: () => Promise<void>;
  private runtimeStarted = false;

  constructor(dependencies: DesktopLifecycleDependencies = {}) {
    this.isDesktopFn = dependencies.isDesktop ?? isTauriRuntime;
    this.invokeCommand = dependencies.invoke ?? defaultInvoke;
    this.listenFn = dependencies.listen;
    this.scheduler = dependencies.scheduler;
    this.runtime = dependencies.runtime;
    this.mutations = dependencies.mutations;
    this.checkpointFn = dependencies.checkpoint;
  }

  isDesktop(): boolean {
    return this.isDesktopFn();
  }

  get runtimeHasStarted(): boolean {
    return this.runtimeStarted;
  }

  browserDegradation(): typeof BROWSER_LIFECYCLE_DEGRADATION {
    return BROWSER_LIFECYCLE_DEGRADATION;
  }

  /**
   * Plan 25.5 then start_runtime. The scheduler must not claim work before
   * the barrier finishes, and the runtime must not start before that either.
   */
  async startAfterBarrier(
    barrier: StartupBarrierLike,
    startRuntime: () => Promise<void>,
  ): Promise<{ completedSteps: string[]; desktop: boolean }> {
    if (this.runtimeStarted) {
      throw new Error('Harness runtime has already started.');
    }
    const result = await barrier.run();
    if (!result.ready || !result.schedulerMayClaim) {
      throw new Error('Startup barrier did not complete; runtime was not started.');
    }
    await startRuntime();
    this.runtimeStarted = true;
    return {
      completedSteps: [...result.completedSteps, 'start_runtime'],
      desktop: this.isDesktop(),
    };
  }

  async subscribeShutdownRequested(
    handler: (requestId: string) => void,
  ): Promise<() => void> {
    if (!this.isDesktop()) return () => undefined;
    const listen = this.listenFn ?? (await this.loadListen());
    return listen(SHUTDOWN_REQUESTED_EVENT, (event) => {
      const requestId = shutdownRequestId(event.payload);
      if (requestId) handler(requestId);
    });
  }

  async prepareShutdown(
    requestId: string,
    choice: QuitChoice,
  ): Promise<PreparedLifecycle> {
    this.requireDesktop('Quit and hidden-window shutdown');
    if (choice === 'pause') await this.runtime?.pauseAll();
    else await this.runtime?.cancelAll();
    await this.quiesce('shutdown', requestId);
    await this.runtime?.abortProviderAndReads();
    const wait = await this.waitForMutations();
    await this.checkpointFn?.();
    const requestToken = await this.invokeCommand<string>('prepare_shutdown', { requestId });
    return {
      requestToken,
      requestId,
      outcome: resolveQuitOutcome({ choice, mutationOutcome: wait.outcome }),
    };
  }

  async completeShutdown(requestToken: string): Promise<void> {
    this.requireDesktop('complete_shutdown');
    await this.invokeCommand('complete_shutdown', { requestToken });
  }

  async prepareForRestart(): Promise<PreparedLifecycle> {
    this.requireDesktop('Update restart');
    const requestId = await this.invokeCommand<string>('request_restart');
    try {
      await this.quiesce('update', requestId);
      await this.runtime?.abortProviderAndReads();
      const wait = await this.waitForMutations();
      if (wait.outcome === 'unknown') {
        await this.releaseUpdate(requestId);
        throw new MutationOutcomeUnknownError();
      }
      await this.checkpointFn?.();
      const requestToken = await this.invokeCommand<string>('prepare_for_restart', { requestId });
      return { requestToken, requestId, outcome: 'pause' };
    } catch (error) {
      if (error instanceof MutationOutcomeUnknownError) throw error;
      await this.releaseUpdate(requestId);
      throw error;
    }
  }

  async installUpdate(requestToken: string): Promise<void> {
    this.requireDesktop('Update installation');
    await this.invokeCommand('install_update', { requestToken });
  }

  async cancelUpdate(requestToken: string): Promise<void> {
    await this.releaseUpdate(requestToken);
  }

  async notify(
    kind: RunNotificationKind,
  ): Promise<{ delivered: boolean; reason?: string }> {
    if (!this.isDesktop()) {
      return {
        delivered: false,
        reason: BROWSER_LIFECYCLE_DEGRADATION.desktopNotifications,
      };
    }
    await this.invokeCommand('notify_run_event', { kind });
    return { delivered: true };
  }

  private async quiesce(reason: LifecycleKind, requestId: string): Promise<void> {
    await this.scheduler?.beginQuiescing(reason, requestId);
  }

  private async waitForMutations(): Promise<MutationWaitResult> {
    if (!this.mutations) return { outcome: 'settled', startedMutations: 0 };
    return this.mutations.waitForStarted();
  }

  private async releaseUpdate(requestToken: string): Promise<void> {
    await this.scheduler?.endQuiescing();
    try {
      await this.invokeCommand('cancel_update', { requestToken });
    } catch {
      // Token may already be consumed or never prepared.
    }
  }

  private requireDesktop(capability: string): void {
    if (this.isDesktop()) return;
    throw new BrowserLifecycleUnavailableError(
      capability,
      capability === 'Update restart' || capability === 'Update installation'
        ? BROWSER_LIFECYCLE_DEGRADATION.durableRestartRecovery
        : BROWSER_LIFECYCLE_DEGRADATION.hiddenWindowBackgroundWork,
    );
  }

  private async loadListen(): Promise<LifecycleListen> {
    const { listen } = await import('@tauri-apps/api/event');
    return listen;
  }
}

export function createDesktopLifecycleAdapter(
  dependencies: DesktopLifecycleDependencies = {},
): DesktopLifecycleAdapter {
  return new DesktopLifecycleAdapter(dependencies);
}

export const desktopLifecycleAdapter = createDesktopLifecycleAdapter();
