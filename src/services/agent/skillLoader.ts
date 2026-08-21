// ---------------------------------------------------------------------------
// TABS Work-OS Harness — Skill package loader
// Loads selected `.tabs/skills/<name>` instruction packages. Never executes
// skill code. Manifests and tool requirements are validated before use.
// ---------------------------------------------------------------------------

export const SKILL_MANIFEST_NAME = 'skill.json';
export const SKILL_INSTRUCTIONS_NAME = 'SKILL.md';
export const SKILL_REFERENCES_DIR = 'references';

const FORBIDDEN_MANIFEST_KEYS = [
  'entry',
  'main',
  'execute',
  'module',
  'command',
  'runtime',
  'bin',
  'scripts',
] as const;

export type SkillLoadErrorCode =
  | 'missing_manifest'
  | 'missing_instructions'
  | 'invalid_manifest'
  | 'unmet_tools'
  | 'code_forbidden';

export class SkillLoadError extends Error {
  readonly name = 'SkillLoadError';
  readonly code: SkillLoadErrorCode;
  readonly skillName: string;

  constructor(code: SkillLoadErrorCode, skillName: string, message: string) {
    super(message);
    this.code = code;
    this.skillName = skillName;
  }
}

export interface SkillFileEntry {
  name: string;
  kind: 'file' | 'directory';
}

export interface SkillFileAccess {
  exists(path: string): Promise<boolean>;
  readText(path: string): Promise<string>;
  readDir(path: string): Promise<SkillFileEntry[]>;
}

export interface SkillManifest {
  name: string;
  version: string;
  description?: string;
  requiredTools: string[];
  requiredToolGroups: string[];
}

export interface LoadedSkillReference {
  path: string;
  content: string;
}

export interface LoadedSkill {
  name: string;
  manifest: SkillManifest;
  instructions: string;
  references: LoadedSkillReference[];
  sourceHash: string;
}

export interface LoadSelectedSkillsInput {
  workspaceRoot: string;
  skillNames: string[];
  availableTools: string[];
  availableToolGroups?: string[];
  fs: SkillFileAccess;
}

export function joinWorkspacePath(root: string, ...parts: string[]): string {
  const normalized = root.replace(/\\/g, '/').replace(/\/+$/, '');
  const segments = parts
    .flatMap((part) => part.replace(/\\/g, '/').split('/'))
    .filter((part) => part.length > 0 && part !== '.');
  return [normalized, ...segments].join('/');
}

export function skillPackagePath(workspaceRoot: string, skillName: string): string {
  return joinWorkspacePath(workspaceRoot, '.tabs', 'skills', skillName);
}

function hashSource(content: string): string {
  const bytes = new TextEncoder().encode(content);
  let hash = 5381;
  for (let index = 0; index < bytes.length; index++) {
    hash = ((hash << 5) + hash + bytes[index]) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringList(value: unknown, skillName: string, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.trim().length === 0)) {
    throw new SkillLoadError('invalid_manifest', skillName, `${field} must be an array of non-empty strings.`);
  }
  return value.map((entry) => entry.trim());
}

function parseManifest(skillName: string, raw: string): SkillManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new SkillLoadError('invalid_manifest', skillName, 'skill.json is not valid JSON.');
  }
  if (!isRecord(parsed)) {
    throw new SkillLoadError('invalid_manifest', skillName, 'skill.json must be an object.');
  }
  for (const key of FORBIDDEN_MANIFEST_KEYS) {
    if (key in parsed) {
      throw new SkillLoadError(
        'code_forbidden',
        skillName,
        `skill.json must not declare executable field "${key}".`,
      );
    }
  }
  const name = typeof parsed.name === 'string' ? parsed.name.trim() : '';
  const version = typeof parsed.version === 'string' ? parsed.version.trim() : '';
  if (!name || !version) {
    throw new SkillLoadError('invalid_manifest', skillName, 'skill.json requires name and version.');
  }
  if (name !== skillName) {
    throw new SkillLoadError(
      'invalid_manifest',
      skillName,
      `skill.json name "${name}" must match the package folder "${skillName}".`,
    );
  }
  return {
    name,
    version,
    description: typeof parsed.description === 'string' ? parsed.description : undefined,
    requiredTools: stringList(parsed.requiredTools, skillName, 'requiredTools'),
    requiredToolGroups: stringList(parsed.requiredToolGroups, skillName, 'requiredToolGroups'),
  };
}

function validateToolRequirements(
  skillName: string,
  manifest: SkillManifest,
  availableTools: string[],
  availableToolGroups: string[],
): void {
  const tools = new Set(availableTools);
  const missingTools = manifest.requiredTools.filter((tool) => !tools.has(tool));
  if (missingTools.length > 0) {
    throw new SkillLoadError(
      'unmet_tools',
      skillName,
      `Skill ${skillName} requires unavailable tools: ${missingTools.join(', ')}.`,
    );
  }
  if (availableToolGroups.length === 0) return;
  const groups = new Set(availableToolGroups);
  const missingGroups = manifest.requiredToolGroups.filter((group) => !groups.has(group));
  if (missingGroups.length > 0) {
    throw new SkillLoadError(
      'unmet_tools',
      skillName,
      `Skill ${skillName} requires unavailable tool groups: ${missingGroups.join(', ')}.`,
    );
  }
}

async function loadMarkdownReferences(
  fs: SkillFileAccess,
  referencesDir: string,
): Promise<LoadedSkillReference[]> {
  let entries: SkillFileEntry[] = [];
  try {
    entries = await fs.readDir(referencesDir);
  } catch {
    return [];
  }
  if (entries.length === 0) return [];
  const files = entries
    .filter((entry) => entry.kind === 'file' && entry.name.toLowerCase().endsWith('.md'))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  const references: LoadedSkillReference[] = [];
  for (const name of files) {
    const path = joinWorkspacePath(referencesDir, name);
    references.push({
      path: `${SKILL_REFERENCES_DIR}/${name}`,
      content: await fs.readText(path),
    });
  }
  return references;
}

/**
 * Load only the named skill packages. Code, binaries, and non-markdown
 * reference files are ignored. This function never evals, imports, or runs
 * skill package files.
 */
export async function loadSelectedSkills(input: LoadSelectedSkillsInput): Promise<LoadedSkill[]> {
  const loaded: LoadedSkill[] = [];
  for (const skillName of input.skillNames) {
    const packageDir = skillPackagePath(input.workspaceRoot, skillName);
    const manifestPath = joinWorkspacePath(packageDir, SKILL_MANIFEST_NAME);
    const instructionsPath = joinWorkspacePath(packageDir, SKILL_INSTRUCTIONS_NAME);
    if (!(await input.fs.exists(manifestPath))) {
      throw new SkillLoadError('missing_manifest', skillName, `Missing ${SKILL_MANIFEST_NAME} for skill ${skillName}.`);
    }
    if (!(await input.fs.exists(instructionsPath))) {
      throw new SkillLoadError(
        'missing_instructions',
        skillName,
        `Missing ${SKILL_INSTRUCTIONS_NAME} for skill ${skillName}.`,
      );
    }
    const manifest = parseManifest(skillName, await input.fs.readText(manifestPath));
    validateToolRequirements(
      skillName,
      manifest,
      input.availableTools,
      input.availableToolGroups ?? [],
    );
    const instructions = await input.fs.readText(instructionsPath);
    const references = await loadMarkdownReferences(
      input.fs,
      joinWorkspacePath(packageDir, SKILL_REFERENCES_DIR),
    );
    const sourceHash = hashSource(JSON.stringify({
      manifest,
      instructions,
      references,
    }));
    loaded.push({
      name: skillName,
      manifest,
      instructions,
      references,
      sourceHash,
    });
  }
  return loaded;
}
