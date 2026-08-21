// Legacy writer/task instruction files may remain in user workspaces under `.tabs/`.
// TABS no longer reads or writes them. New harness runs use AGENTS.md and agent profiles.

export const LEGACY_INSTRUCTION_FILES = [
  'writerinstructions.md',
  'taskinstructions.md',
] as const;
