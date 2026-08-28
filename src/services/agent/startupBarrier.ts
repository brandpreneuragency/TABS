// ---------------------------------------------------------------------------
// TABS Work-OS Harness — Exact eight-step application startup barrier
// Plan 25.5. The scheduler cannot claim work before step seven.
// ---------------------------------------------------------------------------

import { crmFormsDb } from '../../data/crmFormsDb';
import { db } from '../db';
import { subscribeToDomainChanges } from '../domainEvents';
import type { AgentScheduler } from './agentScheduler';
import { migrateHarnessCredentialsAndPreferences } from './credentialMigration';
import type { RecoveryManager } from './recoveryManager';

export interface NativeScopeReregistrar {
  reregister(input: { runId: string; workspaceId: string; rootPath: string }): Promise<string>;
}

export const STARTUP_BARRIER_STEPS = [
  'open_and_migrate_databases',
  'complete_credential_migrations',
  'load_application_state',
  'register_domain_event_subscribers',
  'reregister_native_workspace_scopes',
  'run_recovery_classification',
  'acquire_scheduler_lease',
  'mark_harness_client_ready',
] as const;

export type StartupBarrierStep = (typeof STARTUP_BARRIER_STEPS)[number];

export interface StartupBarrierHooks {
  /** 1. Open and migrate both Dexie databases. */
  openAndMigrateDatabases: () => Promise<void>;
  /** 2. Complete safe credential migrations. */
  completeCredentialMigrations: () => Promise<void>;
  /** 3. Load provider, workspace, task, CRM, Forms, and settings state. */
  loadApplicationState: () => Promise<void>;
  /** 4. Register domain event subscribers. */
  registerDomainEventSubscribers: () => Promise<void>;
  /** 5. Re-register required native workspace scopes. */
  reregisterNativeWorkspaceScopes: () => Promise<void>;
  /** 6. Run recovery classification. */
  runRecoveryClassification: () => Promise<void>;
  /** 7. Acquire the scheduler lease. */
  acquireSchedulerLease: () => Promise<void>;
  /** 8. Mark the harness client ready. */
  markHarnessClientReady: () => Promise<void>;
}

export interface StartupBarrierResult {
  completedSteps: StartupBarrierStep[];
  ready: boolean;
  schedulerMayClaim: boolean;
}

export interface StartupBarrierOptions {
  hooks: StartupBarrierHooks;
}

/**
 * Application startup uses this exact order.
 *
 * 1. Open and migrate both Dexie databases.
 * 2. Complete safe credential migrations.
 * 3. Load provider, workspace, task, CRM, Forms, and settings state.
 * 4. Register domain event subscribers.
 * 5. Re-register required native workspace scopes.
 * 6. Run recovery classification.
 * 7. Acquire the scheduler lease.
 * 8. Mark the harness client ready.
 *
 * The scheduler cannot claim work before step seven.
 */
export class StartupBarrier {
  private readonly hooks: StartupBarrierHooks;
  private readonly completed: StartupBarrierStep[] = [];
  private ready = false;
  private schedulerMayClaim = false;

  constructor(options: StartupBarrierOptions) {
    this.hooks = options.hooks;
  }

  get completedSteps(): readonly StartupBarrierStep[] {
    return this.completed;
  }

  get isReady(): boolean {
    return this.ready;
  }

  get canSchedulerClaim(): boolean {
    return this.schedulerMayClaim;
  }

  async run(): Promise<StartupBarrierResult> {
    this.completed.length = 0;
    this.ready = false;
    this.schedulerMayClaim = false;

    await this.step('open_and_migrate_databases', this.hooks.openAndMigrateDatabases);
    await this.step('complete_credential_migrations', this.hooks.completeCredentialMigrations);
    await this.step('load_application_state', this.hooks.loadApplicationState);
    await this.step('register_domain_event_subscribers', this.hooks.registerDomainEventSubscribers);
    await this.step('reregister_native_workspace_scopes', this.hooks.reregisterNativeWorkspaceScopes);
    await this.step('run_recovery_classification', this.hooks.runRecoveryClassification);
    await this.step('acquire_scheduler_lease', this.hooks.acquireSchedulerLease);
    this.schedulerMayClaim = true;
    await this.step('mark_harness_client_ready', this.hooks.markHarnessClientReady);
    this.ready = true;

    return {
      completedSteps: [...this.completed],
      ready: this.ready,
      schedulerMayClaim: this.schedulerMayClaim,
    };
  }

  private async step(name: StartupBarrierStep, hook: () => Promise<void>): Promise<void> {
    await hook();
    this.completed.push(name);
  }
}

export interface DesktopStartupBarrierDependencies {
  scheduler: AgentScheduler;
  recovery: RecoveryManager;
  nativeScopes?: NativeScopeReregistrar;
  loadApplicationState?: () => Promise<void>;
}

/** Wires the eight-step barrier to desktop Dexie, credentials, and recovery. */
export function createDesktopStartupHooks(
  dependencies: DesktopStartupBarrierDependencies,
): StartupBarrierHooks {
  return {
    async openAndMigrateDatabases() {
      await db.open();
      await crmFormsDb.open();
    },
    async completeCredentialMigrations() {
      await migrateHarnessCredentialsAndPreferences();
    },
    async loadApplicationState() {
      await dependencies.loadApplicationState?.();
    },
    async registerDomainEventSubscribers() {
      subscribeToDomainChanges(() => undefined);
    },
    async reregisterNativeWorkspaceScopes() {
      if (!dependencies.nativeScopes) return;
      const runs = await dependencies.recovery.listNonTerminalRuns();
      for (const run of runs) {
        const scope = run.workspaceScope;
        if (!scope) continue;
        await dependencies.nativeScopes.reregister({
          runId: run.id,
          workspaceId: scope.workspaceId,
          rootPath: scope.rootPath,
        });
      }
    },
    async runRecoveryClassification() {
      await dependencies.scheduler.discardExpiredQuiescingLease();
      await dependencies.recovery.recoverAll();
    },
    async acquireSchedulerLease() {
      const lease = await dependencies.scheduler.acquireLease();
      if (!lease) {
        throw new Error('Scheduler lease was not acquired; another owner still holds it.');
      }
    },
    async markHarnessClientReady() {
      return;
    },
  };
}
