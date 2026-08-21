// Instruction config files. Persisted to `.tabs/` under the active root folder
// using absolute paths via the Tauri fs adapter (Phase 3).
import { useWorkspaceStore } from '../stores/workspaceStore';
import {
  exists as fsExists,
  readTextFile,
  writeTextFile,
  mkdir,
  joinPath,
} from './fs-adapter';

const CONFIG_DIR = '.tabs';
const WRITER_INSTRUCTIONS_FILE = 'writerinstructions.md';
const TASK_INSTRUCTIONS_FILE = 'taskinstructions.md';

/** Kept on disk for the user. New harness runs must not load these files. */
export const LEGACY_INSTRUCTION_FILES = [
  WRITER_INSTRUCTIONS_FILE,
  TASK_INSTRUCTIONS_FILE,
] as const;

const DEFAULT_WRITER_INSTRUCTIONS = `# Writer Agent Instructions

## Core Behavior

1. **Reason Before Responding**: After every user input, think through the request carefully. If you determine that live web information would improve your response, use the web fetch tool on your own to gather relevant information before answering.

2. **Writing Excellence**: Help users improve their writing, suggest edits, and provide creative ideas. When suggesting text changes, provide the revised text clearly so it can be applied directly.

3. **Context Awareness**: Pay attention to selected text context when provided. Use it to give relevant, targeted suggestions.

4. **Clarity & Precision**: Be concise and actionable. Avoid unnecessary filler.`;

const DEFAULT_TASK_INSTRUCTIONS = `# Task Summarizing Agent Instructions

## Core Behavior

1. **Summarize Effectively**: When asked to summarize tasks, conversations, or project updates, extract the key points, decisions, and action items clearly.

2. **Structure Output**: Use headings, bullet points, and clear formatting to make summaries scannable and useful.

3. **Identify Dependencies**: Highlight any task dependencies, blockers, or critical path items when summarizing project status.

4. **Be Concise**: Focus on what matters. Omit redundant or trivial details.`;

function getConfigDir(): string | null {
  const rootNode = useWorkspaceStore.getState().getActiveRootNode();
  if (!rootNode) return null;
  return joinPath(rootNode.fullPath, CONFIG_DIR);
}

async function ensureConfigDir(): Promise<string | null> {
  const dir = getConfigDir();
  if (!dir) return null;
  try {
    if (!(await fsExists(dir))) {
      await mkdir(dir, true);
    }
    return dir;
  } catch {
    console.warn('[InstructionFiles] Failed to create config directory.');
    return null;
  }
}

export async function getWriterInstructions(): Promise<string | null> {
  const dir = await ensureConfigDir();
  if (!dir) return null;
  const filePath = joinPath(dir, WRITER_INSTRUCTIONS_FILE);
  try {
    if (!(await fsExists(filePath))) return null;
    return await readTextFile(filePath);
  } catch {
    return null;
  }
}

export async function getTaskInstructions(): Promise<string | null> {
  const dir = await ensureConfigDir();
  if (!dir) return null;
  const filePath = joinPath(dir, TASK_INSTRUCTIONS_FILE);
  try {
    if (!(await fsExists(filePath))) return null;
    return await readTextFile(filePath);
  } catch {
    return null;
  }
}

export async function initInstructionFiles(): Promise<void> {
  const dir = await ensureConfigDir();
  if (!dir) return;

  const writerPath = joinPath(dir, WRITER_INSTRUCTIONS_FILE);
  try {
    let existing = '';
    if (await fsExists(writerPath)) {
      existing = await readTextFile(writerPath);
    }
    if (!existing.trim()) {
      await writeTextFile(writerPath, DEFAULT_WRITER_INSTRUCTIONS);
    }
  } catch {
    console.warn('[InstructionFiles] Failed to initialize writer instructions.');
  }

  const taskPath = joinPath(dir, TASK_INSTRUCTIONS_FILE);
  try {
    let existing = '';
    if (await fsExists(taskPath)) {
      existing = await readTextFile(taskPath);
    }
    if (!existing.trim()) {
      await writeTextFile(taskPath, DEFAULT_TASK_INSTRUCTIONS);
    }
  } catch {
    console.warn('[InstructionFiles] Failed to initialize task instructions.');
  }
}

export { DEFAULT_WRITER_INSTRUCTIONS, DEFAULT_TASK_INSTRUCTIONS };
