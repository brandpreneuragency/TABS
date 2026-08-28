import { isTauriRuntime } from '../../runtime';

export interface NativeScopeRegistration {
  runId: string;
  workspaceId: string;
  rootPath: string;
}

export type NativeCommandInvoker = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

export interface NativeScopeAdapter {
  register(input: NativeScopeRegistration): Promise<string>;
  reregister(input: NativeScopeRegistration): Promise<string>;
  revoke(scopeId: string): Promise<boolean>;
}

export class NativeWorkspaceScopesUnavailableError extends Error {
  constructor() {
    super('Native workspace scopes are unavailable outside the Tauri desktop runtime');
    this.name = 'NativeWorkspaceScopesUnavailableError';
  }
}

async function desktopInvoke<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (!isTauriRuntime()) {
    throw new NativeWorkspaceScopesUnavailableError();
  }
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, args);
}

export function createNativeScopeAdapter(
  invokeCommand: NativeCommandInvoker = desktopInvoke,
): NativeScopeAdapter {
  const registrationArgs = (input: NativeScopeRegistration) => ({
    runId: input.runId,
    workspaceId: input.workspaceId,
    workspaceRoot: input.rootPath,
  });

  return {
    register(input) {
      return invokeCommand<string>('agent_scope_register', registrationArgs(input));
    },
    reregister(input) {
      return invokeCommand<string>('agent_scope_reregister', registrationArgs(input));
    },
    revoke(scopeId) {
      return invokeCommand<boolean>('agent_scope_revoke', { scopeId });
    },
  };
}

export const nativeScopeAdapter = createNativeScopeAdapter();
