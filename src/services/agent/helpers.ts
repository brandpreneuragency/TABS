// ---------------------------------------------------------------------------
// TABS Work-OS Harness — Identifier, limit, and tool-version helpers
// Pure functions only — no side effects, no React, no Zustand.
// ---------------------------------------------------------------------------

import { nanoid } from 'nanoid';
import type { AgentToolDefinition } from '../../types/agent';

// ── Identifier generation ────────────────────────────────────────────────────

/** Generate a run-scoped opaque identifier (21-char nanoid). */
export function generateId(): string {
  return nanoid();
}

/**
 * Build a deterministic operation ID from run ID, immutable turn, and tool
 * index. The operation ID is stable across safe recovery and retries.
 *
 * Format: `${runId}:t${turn}:tc${toolIndex}`
 */
export function buildOperationId(
  runId: string,
  turn: number,
  toolIndex: number,
): string {
  return `${runId}:t${turn}:tc${toolIndex}`;
}

/**
 * Parse an operation ID back into its constituent parts.
 * Returns `undefined` if the format is invalid.
 */
export function parseOperationId(
  operationId: string,
): { runId: string; turn: number; toolIndex: number } | undefined {
  // Find `:tc` — the tool-index marker. It must appear at the end.
  const tcIdx = operationId.lastIndexOf(':tc');
  if (tcIdx === -1) return undefined;

  const toolIndexStr = operationId.slice(tcIdx + 3);
  const toolIndex = Number(toolIndexStr);
  if (!Number.isInteger(toolIndex) || toolIndex < 0) return undefined;

  // Find `:t` that appears BEFORE the `:tc` marker.
  // `:tc` contains `:t` at offset 0 inside it, so search only before tcIdx.
  const beforeTc = operationId.slice(0, tcIdx);
  const tIdx = beforeTc.lastIndexOf(':t');
  if (tIdx === -1) return undefined;

  const turnStr = beforeTc.slice(tIdx + 2);
  const turn = Number(turnStr);
  if (!Number.isInteger(turn) || turn < 0) return undefined;

  const runId = operationId.slice(0, tIdx);

  return { runId, turn, toolIndex };
}

// ── Limits ───────────────────────────────────────────────────────────────────

/** Maximum bytes of tool output kept in a tool result record. */
export const MAX_TOOL_RESULT_BYTES = 65_536;

/** Maximum bytes of shell output kept in a tool result record. */
export const MAX_SHELL_RESULT_BYTES = 131_072;

/** Warning threshold for artifact record size. */
export const ARTIFACT_SIZE_WARNING_BYTES = 1_048_576;

/** Default maximum turns for a new run. */
export const DEFAULT_MAX_TURNS = 200;

/** Default maximum duration in milliseconds (4 hours). */
export const DEFAULT_MAX_DURATION_MS = 4 * 60 * 60 * 1_000;

/** Maximum number of tool output artifact sections per read. */
export const MAX_ARTIFACT_READ_LIMIT = 100;

/** Conservative unknown context window (tokens). */
export const UNKNOWN_CONTEXT_WINDOW_TOKENS = 16_000;

/** Maximum list page size for list tools. */
export const MAX_LIST_PAGE_SIZE = 100;

/** Minimum list page size. */
export const MIN_LIST_PAGE_SIZE = 1;

// ── Tool version registry ────────────────────────────────────────────────────

/**
 * A lightweight, mutable tool-version registry.
 *
 * The runtime registers each tool definition at startup. The registry is
 * consulted during run creation to freeze a `toolRegistryVersion` and
 * `toolRegistryHash` on the run snapshot.
 */
export class ToolVersionRegistry {
  private readonly tools = new Map<string, AgentToolDefinition>();

  /** Register a tool definition. Overwrites a previous entry with the same name. */
  register(tool: AgentToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  /** Look up a tool by name. */
  get(name: string): AgentToolDefinition | undefined {
    return this.tools.get(name);
  }

  /** List all registered tool names in insertion order. */
  names(): string[] {
    return Array.from(this.tools.keys());
  }

  /** Number of registered tools. */
  get size(): number {
    return this.tools.size;
  }

  /**
   * Produce a stable version string for the current registry state.
   * Concatenates `name@version` pairs sorted by name.
   */
  versionString(): string {
    const entries = Array.from(this.tools.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, tool]) => `${name}@${tool.version}`);
    return entries.join(';');
  }

  /**
   * Produce a simple hash of the registry version string.
   * Uses a deterministic DJB2 variant so it is stable across runs.
   */
  hash(): string {
    const str = this.versionString();
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
    }
    // Convert to unsigned 32-bit hex.
    return (hash >>> 0).toString(16).padStart(8, '0');
  }
}
