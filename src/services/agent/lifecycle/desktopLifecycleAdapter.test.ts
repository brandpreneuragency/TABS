import { describe, expect, it, vi } from 'vitest';

import {
  BROWSER_LIFECYCLE_DEGRADATION,
  BrowserLifecycleUnavailableError,
  DESKTOP_STARTUP_ORDER,
  MutationOutcomeUnknownError,
  SHUTDOWN_REQUESTED_EVENT,
  createDesktopLifecycleAdapter,
  resolveQuitOutcome,
  type LifecycleInvoker,
  type LifecycleListen,
} from './desktopLifecycleAdapter';

function createInvoke() {
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'request_restart') return 'restart-1';
    if (command === 'prepare_shutdown' || command === 'prepare_for_restart') {
      return String(args?.requestId ?? 'token');
    }
    return undefined;
  });
  return invoke as typeof invoke & LifecycleInvoker;
}

describe('desktopLifecycleAdapter browser degradation', () => {
  it('disables notifications and privileged lifecycle commands in the Vite preview', async () => {
    const invoke = createInvoke();
    const adapter = createDesktopLifecycleAdapter({
      isDesktop: () => false,
      invoke,
    });

    expect(adapter.browserDegradation()).toEqual(BROWSER_LIFECYCLE_DEGRADATION);
    await expect(adapter.notify('approval')).resolves.toEqual({
      delivered: false,
      reason: 'disabled',
    });
    await expect(adapter.prepareShutdown('req-1', 'pause')).rejects.toBeInstanceOf(
      BrowserLifecycleUnavailableError,
    );
    await expect(adapter.completeShutdown('token')).rejects.toBeInstanceOf(
      BrowserLifecycleUnavailableError,
    );
    await expect(adapter.prepareForRestart()).rejects.toBeInstanceOf(
      BrowserLifecycleUnavailableError,
    );
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('desktopLifecycleAdapter startup barrier', () => {
  it('starts the runtime only after every barrier stage finishes', async () => {
    const order: string[] = [];
    const adapter = createDesktopLifecycleAdapter({ isDesktop: () => true });
    const startRuntime = vi.fn(async () => {
      order.push('start_runtime');
    });

    await adapter.startAfterBarrier(
      {
        async run() {
          expect(adapter.runtimeHasStarted).toBe(false);
          expect(startRuntime).not.toHaveBeenCalled();
          order.push(
            'open_and_migrate_databases',
            'complete_credential_migrations',
            'load_application_state',
            'register_domain_event_subscribers',
            'reregister_native_workspace_scopes',
            'run_recovery_classification',
            'acquire_scheduler_lease',
            'mark_harness_client_ready',
          );
          return {
            ready: true,
            schedulerMayClaim: true,
            completedSteps: DESKTOP_STARTUP_ORDER.slice(0, 8),
          };
        },
      },
      startRuntime,
    );

    expect(order).toEqual([...DESKTOP_STARTUP_ORDER]);
    expect(adapter.runtimeHasStarted).toBe(true);
  });

  it('does not start the runtime when the barrier is incomplete', async () => {
    const startRuntime = vi.fn(async () => undefined);
    const adapter = createDesktopLifecycleAdapter({ isDesktop: () => true });

    await expect(
      adapter.startAfterBarrier(
        {
          async run() {
            return { ready: false, schedulerMayClaim: false, completedSteps: [] };
          },
        },
        startRuntime,
      ),
    ).rejects.toThrow('Startup barrier did not complete');
    expect(startRuntime).not.toHaveBeenCalled();
    expect(adapter.runtimeHasStarted).toBe(false);
  });
});

describe('desktopLifecycleAdapter quit and update', () => {
  it('prepares pause-and-quit with the durable quiescing barrier', async () => {
    const invoke = createInvoke();
    const beginQuiescing = vi.fn(async () => ({ mode: 'quiescing' }));
    const abortProviderAndReads = vi.fn(async () => undefined);
    const pauseAll = vi.fn(async () => undefined);
    const cancelAll = vi.fn(async () => undefined);
    const checkpoint = vi.fn(async () => undefined);
    const waitForStarted = vi.fn(async () => ({ outcome: 'settled' as const, startedMutations: 1 }));
    const adapter = createDesktopLifecycleAdapter({
      isDesktop: () => true,
      invoke,
      scheduler: { beginQuiescing, endQuiescing: vi.fn(async () => undefined) },
      runtime: { abortProviderAndReads, pauseAll, cancelAll },
      mutations: { waitForStarted },
      checkpoint,
    });

    const prepared = await adapter.prepareShutdown('req-quit', 'pause');
    expect(prepared).toEqual({
      requestToken: 'req-quit',
      requestId: 'req-quit',
      outcome: 'pause',
    });
    expect(pauseAll).toHaveBeenCalledOnce();
    expect(cancelAll).not.toHaveBeenCalled();
    expect(beginQuiescing).toHaveBeenCalledWith('shutdown', 'req-quit');
    expect(abortProviderAndReads).toHaveBeenCalledOnce();
    expect(waitForStarted).toHaveBeenCalledOnce();
    expect(checkpoint).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith('prepare_shutdown', { requestId: 'req-quit' });

    await adapter.completeShutdown(prepared.requestToken);
    expect(invoke).toHaveBeenCalledWith('complete_shutdown', { requestToken: 'req-quit' });
  });

  it('records cancel-and-quit and unknown mutation outcomes', async () => {
    expect(resolveQuitOutcome({ choice: 'pause', mutationOutcome: 'settled' })).toBe('pause');
    expect(resolveQuitOutcome({ choice: 'cancel', mutationOutcome: 'settled' })).toBe('cancel');
    expect(resolveQuitOutcome({ choice: 'pause', mutationOutcome: 'unknown' })).toBe('unknown');

    const invoke = createInvoke();
    const cancelAll = vi.fn(async () => undefined);
    const adapter = createDesktopLifecycleAdapter({
      isDesktop: () => true,
      invoke,
      runtime: {
        abortProviderAndReads: vi.fn(async () => undefined),
        pauseAll: vi.fn(async () => undefined),
        cancelAll,
      },
      mutations: {
        waitForStarted: vi.fn(async () => ({ outcome: 'unknown' as const, startedMutations: 1 })),
      },
    });

    const cancelled = await adapter.prepareShutdown('req-cancel', 'cancel');
    expect(cancelAll).toHaveBeenCalledOnce();
    expect(cancelled.outcome).toBe('unknown');
  });

  it('rejects update install while a mutation outcome is unknown and releases the barrier', async () => {
    const invoke = createInvoke();
    const endQuiescing = vi.fn(async () => ({ mode: 'active' }));
    const adapter = createDesktopLifecycleAdapter({
      isDesktop: () => true,
      invoke,
      scheduler: {
        beginQuiescing: vi.fn(async () => ({ mode: 'quiescing' })),
        endQuiescing,
      },
      runtime: {
        abortProviderAndReads: vi.fn(async () => undefined),
        pauseAll: vi.fn(async () => undefined),
        cancelAll: vi.fn(async () => undefined),
      },
      mutations: {
        waitForStarted: vi.fn(async () => ({ outcome: 'unknown' as const, startedMutations: 1 })),
      },
    });

    await expect(adapter.prepareForRestart()).rejects.toBeInstanceOf(MutationOutcomeUnknownError);
    expect(endQuiescing).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith('cancel_update', { requestToken: 'restart-1' });
    expect(invoke).not.toHaveBeenCalledWith('prepare_for_restart', expect.anything());
    expect(invoke).not.toHaveBeenCalledWith('install_update', expect.anything());
  });

  it('requires the restart token before update installation and can cancel', async () => {
    const invoke = createInvoke();
    const endQuiescing = vi.fn(async () => undefined);
    const adapter = createDesktopLifecycleAdapter({
      isDesktop: () => true,
      invoke,
      scheduler: {
        beginQuiescing: vi.fn(async () => ({ mode: 'quiescing' })),
        endQuiescing,
      },
      runtime: {
        abortProviderAndReads: vi.fn(async () => undefined),
        pauseAll: vi.fn(async () => undefined),
        cancelAll: vi.fn(async () => undefined),
      },
      checkpoint: vi.fn(async () => undefined),
    });

    const prepared = await adapter.prepareForRestart();
    expect(invoke).toHaveBeenCalledWith('request_restart');
    expect(invoke).toHaveBeenCalledWith('prepare_for_restart', { requestId: 'restart-1' });
    await adapter.installUpdate(prepared.requestToken);
    expect(invoke).toHaveBeenCalledWith('install_update', { requestToken: 'restart-1' });

    await adapter.cancelUpdate(prepared.requestToken);
    expect(endQuiescing).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith('cancel_update', { requestToken: 'restart-1' });
  });
});

describe('desktopLifecycleAdapter notifications and events', () => {
  it('sends approval, review, completion, and failure notifications without record data', async () => {
    const invoke = createInvoke();
    const adapter = createDesktopLifecycleAdapter({ isDesktop: () => true, invoke });

    for (const kind of ['approval', 'review', 'completed', 'failed'] as const) {
      await expect(adapter.notify(kind)).resolves.toEqual({ delivered: true });
      expect(invoke).toHaveBeenCalledWith('notify_run_event', { kind });
    }

    const notifyCalls = invoke.mock.calls.filter((call) => call[0] === 'notify_run_event');
    for (const [, args] of notifyCalls) {
      expect(args).toEqual({ kind: expect.any(String) });
      expect(args).not.toHaveProperty('goal');
      expect(args).not.toHaveProperty('title');
      expect(args).not.toHaveProperty('record');
      expect(args).not.toHaveProperty('email');
    }
  });

  it('forwards tray shutdown request identifiers', async () => {
    const handlers: Array<(event: { payload: unknown }) => void> = [];
    const listen: LifecycleListen = async (_event, handler) => {
      handlers.push(handler);
      return () => undefined;
    };
    const received: string[] = [];
    const adapter = createDesktopLifecycleAdapter({
      isDesktop: () => true,
      listen,
    });

    await adapter.subscribeShutdownRequested((requestId) => {
      received.push(requestId);
    });
    handlers[0]?.({ payload: 'req-from-tray' });
    expect(received).toEqual(['req-from-tray']);
    expect(SHUTDOWN_REQUESTED_EVENT).toBe('tabs://shutdown-requested');
  });
});
