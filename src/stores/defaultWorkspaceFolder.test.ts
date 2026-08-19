import { describe, expect, it } from 'vitest';
import {
  isGeneratedWorkspaceName,
  normalizeDefaultWorkspaceFolder,
  workspaceNeedsDefaultFolder,
} from './defaultWorkspaceFolder';

describe('normalizeDefaultWorkspaceFolder', () => {
  it('returns null for empty or non-string values', () => {
    expect(normalizeDefaultWorkspaceFolder(null)).toBeNull();
    expect(normalizeDefaultWorkspaceFolder(undefined)).toBeNull();
    expect(normalizeDefaultWorkspaceFolder('')).toBeNull();
    expect(normalizeDefaultWorkspaceFolder('   ')).toBeNull();
    expect(normalizeDefaultWorkspaceFolder(0)).toBeNull();
  });

  it('trims and normalizes slashes', () => {
    expect(normalizeDefaultWorkspaceFolder('  C:\\Notes\\Vault  ')).toBe('C:/Notes/Vault');
    expect(normalizeDefaultWorkspaceFolder('/home/user/notes')).toBe('/home/user/notes');
  });
});

describe('isGeneratedWorkspaceName', () => {
  it('matches only the auto-generated Workspace N titles', () => {
    expect(isGeneratedWorkspaceName('Workspace 1')).toBe(true);
    expect(isGeneratedWorkspaceName('Workspace 12')).toBe(true);
    expect(isGeneratedWorkspaceName('Notes')).toBe(false);
    expect(isGeneratedWorkspaceName('Workspace')).toBe(false);
    expect(isGeneratedWorkspaceName('Workspace 1 copy')).toBe(false);
  });
});

describe('workspaceNeedsDefaultFolder', () => {
  it('applies only when a default is set and nothing is connected', () => {
    expect(workspaceNeedsDefaultFolder([], [], 'C:/Notes')).toBe(true);
    expect(workspaceNeedsDefaultFolder([], [], null)).toBe(false);
    expect(workspaceNeedsDefaultFolder([{ path: 'C:/Other' }], [], 'C:/Notes')).toBe(false);
    expect(workspaceNeedsDefaultFolder([], [{ path: 'C:/Other' }], 'C:/Notes')).toBe(false);
  });
});
