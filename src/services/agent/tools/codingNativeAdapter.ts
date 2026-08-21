import { isTauriRuntime } from '../../runtime';
import { NativeWorkspaceScopesUnavailableError, type NativeCommandInvoker } from './nativeScopeAdapter';

export interface NativeFileTextResult {
  exists: boolean;
  content: string;
}

export interface NativeFileReadResult {
  content: string;
  lineCount: number;
  truncated: boolean;
}

export interface NativeFileWriteResult {
  bytesWritten: number;
}

export interface NativeFileEditResult {
  replacements: number;
}

export interface NativeGlobResult {
  paths: string[];
  truncated: boolean;
  cancelled: boolean;
}

export interface NativeGrepMatch {
  path: string;
  line: number;
  text: string;
}

export interface NativeGrepResult {
  matches: NativeGrepMatch[];
  truncated: boolean;
  cancelled: boolean;
}

export interface NativeShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  truncated: boolean;
  cancelled: boolean;
}

export interface NativeGitResult {
  output: string;
  truncated: boolean;
}

export interface CodingNativeAdapter {
  fileText(scopeId: string, path: string): Promise<NativeFileTextResult>;
  fileRead(input: {
    scopeId: string;
    path: string;
    offset?: number;
    limit?: number;
    cancelId?: string;
  }): Promise<NativeFileReadResult>;
  fileWrite(scopeId: string, path: string, content: string): Promise<NativeFileWriteResult>;
  fileEdit(input: {
    scopeId: string;
    path: string;
    oldText: string;
    newText: string;
    replaceAll: boolean;
    expectedMatchCount?: number;
  }): Promise<NativeFileEditResult>;
  glob(input: {
    scopeId: string;
    pattern: string;
    path?: string;
    cancelId?: string;
    maxResults?: number;
  }): Promise<NativeGlobResult>;
  grep(input: {
    scopeId: string;
    pattern: string;
    path?: string;
    glob?: string;
    caseInsensitive?: boolean;
    cancelId?: string;
    maxResults?: number;
  }): Promise<NativeGrepResult>;
  shellExec(input: {
    scopeId: string;
    command: string;
    workingDirectory: string;
    timeoutMs: number;
    cancelId?: string;
    maxOutputBytes?: number;
  }): Promise<NativeShellResult>;
  gitStatus(scopeId: string, path?: string, cancelId?: string): Promise<NativeGitResult>;
  gitDiff(scopeId: string, path?: string, cancelId?: string): Promise<NativeGitResult>;
  cancel(cancelId: string): Promise<boolean>;
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

function renameRead(result: {
  content: string;
  line_count?: number;
  lineCount?: number;
  truncated?: boolean;
}): NativeFileReadResult {
  return {
    content: result.content,
    lineCount: result.lineCount ?? result.line_count ?? 0,
    truncated: result.truncated === true,
  };
}

export function createCodingNativeAdapter(
  invokeCommand: NativeCommandInvoker = desktopInvoke,
): CodingNativeAdapter {
  return {
    fileText(scopeId, path) {
      return invokeCommand<NativeFileTextResult>('ai_file_text', { scopeId, path });
    },
    async fileRead(input) {
      const result = await invokeCommand<{
        content: string;
        line_count?: number;
        lineCount?: number;
        truncated?: boolean;
      }>('ai_file_read', {
        scopeId: input.scopeId,
        path: input.path,
        offset: input.offset,
        limit: input.limit,
        cancelId: input.cancelId,
      });
      return renameRead(result);
    },
    fileWrite(scopeId, path, content) {
      return invokeCommand<NativeFileWriteResult>('ai_file_write', { scopeId, path, content });
    },
    fileEdit(input) {
      return invokeCommand<NativeFileEditResult>('ai_file_edit', {
        scopeId: input.scopeId,
        path: input.path,
        old: input.oldText,
        new: input.newText,
        replaceAll: input.replaceAll,
        expectedMatchCount: input.expectedMatchCount,
      });
    },
    glob(input) {
      return invokeCommand<NativeGlobResult>('ai_glob', {
        scopeId: input.scopeId,
        pattern: input.pattern,
        path: input.path,
        cancelId: input.cancelId,
        maxResults: input.maxResults,
      });
    },
    grep(input) {
      return invokeCommand<NativeGrepResult>('ai_grep', {
        scopeId: input.scopeId,
        pattern: input.pattern,
        path: input.path,
        glob: input.glob,
        caseInsensitive: input.caseInsensitive,
        cancelId: input.cancelId,
        maxResults: input.maxResults,
      });
    },
    shellExec(input) {
      return invokeCommand<NativeShellResult>('ai_shell_exec', {
        scopeId: input.scopeId,
        cmd: input.command,
        workingDirectory: input.workingDirectory,
        timeoutMs: input.timeoutMs,
        cancelId: input.cancelId,
        maxOutputBytes: input.maxOutputBytes,
      });
    },
    gitStatus(scopeId, path, cancelId) {
      return invokeCommand<NativeGitResult>('ai_git_status', { scopeId, path, cancelId });
    },
    gitDiff(scopeId, path, cancelId) {
      return invokeCommand<NativeGitResult>('ai_git_diff', { scopeId, path, cancelId });
    },
    cancel(cancelId) {
      return invokeCommand<boolean>('ai_tool_cancel', { cancelId });
    },
  };
}

export const codingNativeAdapter = createCodingNativeAdapter();
