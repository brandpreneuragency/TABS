/** @deprecated Replaced by Workspace. Kept temporarily for migration. */
export interface Document {
  id: string;
  title: string;
  content: string; // TipTap JSON serialized
  createdAt: number;
  updatedAt: number;
  order: number;
  sourcePath?: string;
  isDirty?: boolean;
  colorIndex?: number; // 0-5 for rainbow colors
}

/** A file currently open in a workspace's editor. */
export interface WorkspaceFile {
  /** Absolute disk path (forward slashes). */
  path: string;
  /** Display name (filename with extension). */
  name: string;
  /** TipTap JSON serialized as string. */
  content: string;
  /** Has unsaved changes vs disk. */
  isDirty: boolean;
}

/** A workspace — the new tab entity. Each workspace has at most one connected
 *  folder (AI agent root), one file open in the editor at a time, and its own
 *  chat history. `connectedFolders` is kept as an array for compatibility;
 *  length is enforced to ≤ 1 at connect/load time. */
export interface Workspace {
  id: string;
  /** Tab label (folder name or custom name). */
  name: string;
  /** Per-workspace connected folders (max one; isolated from other workspaces). */
  connectedFolders: ConnectedFolderRef[];
  /** Which folder's tree is currently shown (the single attached folder). */
  activeFolderId: string | null;
  /** The file open in the editor (null = empty workspace). */
  currentFile: WorkspaceFile | null;
  /** Per-workspace tree expansion state (display paths). */
  expandedPaths: string[];
  /** Per-workspace tree selection (display path). */
  selectedTreePath: string | null;
  createdAt: number;
  updatedAt: number;
  order: number;
  /** 0-5 rainbow color. */
  colorIndex?: number;
}

/** Lightweight folder reference stored inside a Workspace.
 *  The full TreeNode is rebuilt on load (not persisted). */
export interface ConnectedFolderRef {
  id: string;
  /** Absolute path of the folder root. */
  path: string;
}

export interface Attachment {
  name: string;
  /** Present for image attachments and for file-picker attachments without a
   *  workspace path (base64 data URL). Path-based file/folder attachments are
   *  read fresh at send time and may omit this. */
  dataUrl?: string;
  mimeType: string;
  /** Attachment flavour. `undefined` is treated as a legacy image attachment. */
  kind?: 'image' | 'file' | 'folder';
  /** Absolute workspace path for file/folder (and image) attachments. */
  path?: string;
  /** Workspace-relative path used for the chip label and inline @token. */
  displayPath?: string;
}

export interface ChatThreadMeta {
  id: string;
  mode: 'writer' | 'task';
  /** @deprecated Use workspaceId instead. */
  documentId?: string;
  /** Workspace this thread belongs to (replaces documentId). */
  workspaceId?: string;
  taskId?: string;
  /** Identifier for the Settings sub-tab (e.g. "models", "actions"). When
   *  set, the thread is scoped to the Settings AI sidebar instead of a
   *  document or task. */
  settingsTab?: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** AI tool permission mode for this thread. Defaults to 'ask' on read. */
  permissionMode?: 'ask' | 'bypass';
}

export interface MessageUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** A single tool call rendered as a chat bubble (frontend-synthetic). Distinct
 *  from OpenAI's `role: 'tool'` which carries the *result* of a call. */
export interface ToolCallPayload {
  /** Stable id matching the OpenAI `tool_call_id` once dispatched. */
  toolCallId: string;
  name: string;
  /** Pretty-printed arguments (JSON). */
  args: string;
  /** 'pending' = awaiting approval (ask mode); 'approved'/'rejected' = resolved;
   *  'done' = executed (bypass or after approval). */
  status: 'pending' | 'approved' | 'rejected' | 'done';
  /** Short human summary of the result, shown once executed. */
  resultSummary?: string;
  /** True when the call errored/rejected and halted the loop. */
  isError?: boolean;
}

export interface ChatMessage {
  id: string;
  threadId: string;
  mode: 'writer' | 'task';
  /** @deprecated Use workspaceId instead. */
  documentId?: string;
  /** Workspace this message belongs to (replaces documentId). */
  workspaceId?: string;
  taskId?: string;
  settingsTab?: string;
  agentId: string;
  role: 'user' | 'assistant' | 'tool_call' | 'system';
  content: string;
  /** Present on `role: 'tool_call'` bubbles. */
  toolCall?: ToolCallPayload;
  selectedText?: string;
  selectionFrom?: number;
  selectionTo?: number;
  suggestedText?: string;
  replyTo?: {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    sender: string;
  };
  attachments?: Attachment[];
  taskDraft?: TaskAIDraft;
  taskDraftStatus?: 'draft' | 'applied' | 'rejected' | 'invalid';
  timestamp: number;
  usage?: MessageUsage;
}

export interface Project {
  id: string;
  name: string;
  color: string;
  createdAt: number;
}

export type TaskStatus = 'pending' | 'in_progress' | 'completed';
export type TaskImportance = 'low' | 'medium' | 'high';

/** Maximum character count allowed for task titles. */
export const TASK_TITLE_MAX_LENGTH = 80;

export interface Task {
  id: string;
  title: string;
  content: string; // TipTap JSON serialized
  status: TaskStatus;
  importance: TaskImportance;
  date: string; // ISO date, e.g. "2026-04-28"
  projectId: string | null;
  assignees: string[];
  createdAt: number;
  updatedAt: number;
  sourcePath?: string;
  order: number;
  parentId?: string;              // references parent task id
  sourceChatMessageId?: string;   // optional audit trail
  deletedAt?: number;             // soft-delete timestamp
}

export interface TaskComment {
  id: string;
  taskId: string;
  sender?: string;         // display name of the commenter (e.g., "You"). UI falls back to "You".
  text: string;
  /**
   * For local-first: data URL of attached file (if any).
   * For server: this field is unused; files are handled via fileId/File.
   */
  attachmentDataUrl?: string;
  attachmentName?: string;
  attachmentMimeType?: string;
  attachmentSizeBytes?: number;
  attachmentPreviewDataUrl?: string;
  replyTo?: {
    id: string;
    text: string;
    sender: string;
  };
  createdAt: number;
}

export interface Agent {
  id: string;
  name: string;
  avatarUrl: string;
  systemPrompt: string;
  isDefault: boolean;
  scope: 'writer' | 'task';
}

export type AIProviderType = string;

export type ProviderStatus =
  | 'connected'
  | 'not_connected'
  | 'needs_key'
  | 'connection_failed'
  | 'sync_needed'
  | 'needs_setup';

export interface ModelCapability {
  vision: boolean;
  toolCalling: boolean;
  contextLength: string;
  speed: 'Slow' | 'Medium' | 'Fast' | 'Unknown';
  cost: 'Free' | 'Limited' | 'Paid' | 'External' | 'Unknown';
  reasoning: 'Low' | 'Medium' | 'High' | 'Unknown';
  endpointType: 'Native' | 'OpenRouter' | 'Custom' | 'Unknown';
  lastSynced?: string;
}

export interface ModelItem {
  id: string;
  name: string;
  enabled: boolean;
  description?: string;
  capabilities: ModelCapability;
  custom?: boolean;
  inputPricePerMillion?: number;
  outputPricePerMillion?: number;
  currency?: 'USD';
  /** Manual reasoning override; catalog resolution is used when absent. */
  reasoning?: ModelReasoning;
  /** Current picked reasoning value for this model (an option's `value`). */
  selectedReasoning?: string;
  /**
   * Whether this model supports the OpenAI-compatible `tools` / `tool_calls`
   * function-calling surface used by the embedded AI tools feature.
   * Defaults to `true` when unset.
   */
  supportsTools?: boolean;
}

export interface ReasoningOption {
  /** Shown in the dropup, e.g. "High". */
  label: string;
  /** Literal value sent to the API, e.g. "high". Empty string = off/omit. */
  value: string;
  /** Token budget for budget-based providers (Anthropic/Gemini). */
  budgetTokens?: number;
}

export interface ModelReasoning {
  /** How the value is injected into the request. */
  param: 'reasoning_effort' | 'reasoning' | 'thinking' | 'reasoning_enabled';
  /** Ordered options; options[0] is the off/none state. */
  options: ReasoningOption[];
  /** Set only when the user manually overrides. */
  source?: 'manual';
}

export interface AIProviderConfig {
  id: string;
  name: string;
  provider: string;
  apiKey: string;
  selectedModel: string;
  isActive: boolean;
  baseUrl: string;
  customModels: string[];
  status?: ProviderStatus;
  models?: ModelItem[];
  lastImportedAt?: number;
}

/** Connection-form draft kept per provider inside the model management modal. */
export interface ProviderConnectionDraft {
  baseUrl: string;
  apiKey: string;
}

export interface AppSettings {
  key: string;
  value: string | number | boolean | Record<string, unknown>;
}

/** Scope for custom quick-actions (Settings → Actions and run starters). */
export type ActionScope = 'general';

export interface QuickPrompt {
  id: string;
  title: string;
  prompt: string;
  scope: ActionScope;
  createdAt: number;
  /** Folder/group the action belongs to (undefined = top-level / ungrouped). */
  groupId?: string;
  /** Sort order within a group (or top-level). Undefined treated as createdAt. */
  order?: number;
  /** Optional icon name (lucide) shown next to the action title. */
  icon?: string;
}

/** A folder that groups actions (QuickPrompts) of a given scope. */
export interface ActionGroup {
  id: string;
  name: string;
  scope: ActionScope;
  /** Sort order among groups of the same scope. */
  order: number;
  createdAt: number;
}

export interface StreamChunk {
  content: string;
  done: boolean;
}

export interface ChatPayload {
  messages: { role: 'user' | 'assistant' | 'system'; content: string }[];
  config: AIProviderConfig;
}

export interface FileViewerItem {
  name: string;
  dataUrl?: string;
  path?: string;
  mimeType?: string;
  size?: string;
  source: 'task-comment' | 'filesystem' | 'chat-attachment';
  /** Stable identity within the source, used when viewer actions need exact-item matching. */
  sourceId?: string;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export type SearchProvider = 'tavily' | 'firecrawl' | 'brave' | 'exa';

export interface SearchConfig {
  exaKey: string;
  tavilyKey: string;
  firecrawlKey: string;
  braveKey: string;
  enabled: boolean;
  searchProvider: SearchProvider;
}

export type TaskAIContextScope = 'active_task';

export type TaskAIOperation =
  | {
      id: string;
      type: 'create_task';
      title: string;
      parentId?: string;
      status?: TaskStatus;
      importance?: TaskImportance;
      date?: string;
      projectId?: string | null;
      content?: string;
      assignees?: string[];
    }
  | {
      id: string;
      type: 'update_task';
      taskId: string;
      updates: Partial<Pick<Task, 'title' | 'status' | 'importance' | 'date' | 'projectId' | 'content' | 'assignees'>>;
    }
  | {
      id: string;
      type: 'soft_delete_task';
      taskId: string;
      reason?: string;
    }
  | {
      id: string;
      type: 'restore_task';
      taskId: string;
    }
  | {
      id: string;
      type: 'add_comment';
      taskId: string;
      text: string;
    }
  | {
      id: string;
      type: 'delete_comment';
      commentId: string;
      taskId: string;
    };

export interface TaskAIDraftValidation {
  errors: string[];
  warnings: string[];
  duplicateSubtasks: string[];
  staleTaskIds: string[];
}

export interface TaskAIDraft {
  id: string;
  taskId: string;
  scope: TaskAIContextScope;
  assistantMessage: string;
  summary: string;
  operations: TaskAIOperation[];
  createdAt: number;
  baselineUpdatedAt: Record<string, number>;
  needsScopeConfirmation?: string;
  validation: TaskAIDraftValidation;
}

export interface TaskAIChangeBatch {
  id: string;
  taskId: string;
  summary: string;
  operations: TaskAIOperation[];
  inverseOperations: TaskAIOperation[];
  createdAt: number;
  expiresAt: number;
  undoneAt?: number;
  appliedByMessageId?: string;
}

// ---------------------------------------------------------------------------
// Task-specific model defaults
// ---------------------------------------------------------------------------

export type TaskModelDefaultKey =
  | 'general_chat'
  | 'writing'
  | 'task_management'
  | 'app_management'
  | 'coding'
  | 'deep_reasoning'
  | 'fast_cheap'
  | 'long_context'
  | 'vision'
  | 'structured_output'
  | 'tool_use'
  | 'fallback';

export interface TaskModelDefault {
  taskKey: TaskModelDefaultKey;
  providerId: string;
  modelId: string;
}

// Pricing metadata (optional, only when available)
export interface ModelPricing {
  inputPricePerMillion?: number;
  outputPricePerMillion?: number;
  currency?: 'USD';
}
