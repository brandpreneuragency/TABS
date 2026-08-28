import { describe, expect, it, vi } from 'vitest';

import {
  createNativeScopeAdapter,
  NativeWorkspaceScopesUnavailableError,
} from './nativeScopeAdapter';

const registration = {
  runId: 'run-1',
  workspaceId: 'workspace-1',
  rootPath: 'C:/Users/Test/workspace',
};

describe('nativeScopeAdapter', () => {
  it('registers a root once and returns only the opaque scope ID', async () => {
    const invoke = vi.fn().mockResolvedValue('opaque-scope');
    const adapter = createNativeScopeAdapter(invoke);

    await expect(adapter.register(registration)).resolves.toBe('opaque-scope');
    expect(invoke).toHaveBeenCalledWith('agent_scope_register', {
      runId: 'run-1',
      workspaceId: 'workspace-1',
      workspaceRoot: 'C:/Users/Test/workspace',
    });
  });

  it('uses the explicit restart re-registration command', async () => {
    const invoke = vi.fn().mockResolvedValue('fresh-opaque-scope');
    const adapter = createNativeScopeAdapter(invoke);

    await expect(adapter.reregister(registration)).resolves.toBe('fresh-opaque-scope');
    expect(invoke).toHaveBeenCalledWith('agent_scope_reregister', {
      runId: 'run-1',
      workspaceId: 'workspace-1',
      workspaceRoot: 'C:/Users/Test/workspace',
    });
  });

  it('revokes by opaque scope ID', async () => {
    const invoke = vi.fn().mockResolvedValue(true);
    const adapter = createNativeScopeAdapter(invoke);

    await expect(adapter.revoke('opaque-scope')).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith('agent_scope_revoke', {
      scopeId: 'opaque-scope',
    });
  });

  it('preserves an unavailable-root registration failure', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('WorkspaceRootUnavailable'));
    const adapter = createNativeScopeAdapter(invoke);

    await expect(adapter.register(registration)).rejects.toThrow('WorkspaceRootUnavailable');
  });

  it('fails closed when the native runtime is unavailable', async () => {
    const adapter = createNativeScopeAdapter();
    await expect(adapter.register(registration)).rejects.toBeInstanceOf(
      NativeWorkspaceScopesUnavailableError,
    );
  });
});
