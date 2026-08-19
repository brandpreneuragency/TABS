# TABS Work-OS Harness Implementation Plan

Status: Build-ready plan

Date: 2026-08-19

Primary runtime: Windows Tauri desktop

Development preview: Vite browser mode

## 1. Decisions

This plan uses the following product decisions.

| Decision | Choice |
|---|---|
| Primary outcome | Cross-feature work |
| Run model | Interactive and background runs |
| Coding depth | Integrated coding tools |
| Existing AI data | Clean replacement |
| Plan depth | Build-ready implementation plan |

## 2. Executive Summary

TABS will become a local Work-OS harness.

The agent will complete work across Documents, Tasks, CRM, Forms, files, and bounded shell commands.

React will display and control runs. React components will not own agent execution.

A TypeScript runtime service will own the model loop, run state, tools, policy, and recovery.

Tauri will own privileged filesystem, shell, keychain, notification, and lifecycle operations.

Dexie will store runs, messages, events, approvals, tool attempts, artifacts, and operation receipts.

Runs will continue when the sidebar closes or the main window hides to the tray.

Interrupted runs will recover after application restart. TABS will not run after the process fully exits.

The first release will run one job at a time. Additional jobs will remain in a durable queue.

The first complete workflow will connect Forms, CRM, Tasks, and Documents.

## 3. Product Position

### 3.1 Product statement

TABS is a local agent workspace for completing work across documents, tasks, CRM, forms, and repositories.

### 3.2 Main difference

Coding agents optimize work around repositories and terminals.

TABS will optimize work around structured local business data and documents.

Shell access will support the product. Shell access will not define the product.

### 3.3 First user

The first user is a solo operator or small team owner.

This user manages leads, follow-ups, documents, tasks, forms, and local project files.

## 4. Scope

### 4.1 First release scope

- Durable local runs
- Interactive and delegated run modes
- One active run and a durable queue
- Run pause, resume, cancel, retry, and review
- Durable user steering at safe turn boundaries
- Model-driven tool selection
- Per-tool policy decisions
- Persisted approvals
- Structured run plans and progress
- Context references instead of full workspace dumps
- Documents, Tasks, CRM, and Forms tools
- Existing file, search, and shell tools
- Web search as a model tool
- Global instructions, workspace instructions, agent profiles, and skills
- Context compaction and bounded tool results
- Run history, event history, artifacts, and change summaries
- Startup recovery and safe interruption handling
- Windows Tauri support
- Safe browser preview degradation

### 4.2 Explicit non-goals

- Hosted TABS services
- VPS execution
- Cloud synchronization
- Execution after the TABS process exits
- Execution while the computer is off
- A Windows service
- Claude Code feature parity
- MCP support in the first release
- Subagents in the first release
- Multiple concurrent active runs
- Semantic vector search in the first release
- Automatic destructive operations
- Production browser support
- Mobile support
- Attachment to existing interactive terminal sessions

## 5. Background Run Definition

"Background" has a precise meaning in this plan.

A run continues in these cases:

- The assistant sidebar is closed.
- The user changes the active TABS module.
- The main window is hidden to the tray.
- The user views another run.

A run does not continue in these cases:

- The user quits TABS from the tray.
- TABS crashes.
- Windows stops the process.
- The computer shuts down.

TABS will persist enough state to recover interrupted runs after the next start.

## 6. First Perfected Workflow

### 6.1 Workflow name

Submission follow-up workflow

### 6.2 User goal

Review a form submission and prepare the full follow-up work.

### 6.3 Workflow steps

1. The user opens a form submission.
2. The user starts a run from the assistant sidebar.
3. TABS captures the selected submission as a context reference.
4. The agent reads the submission and linked form schema.
5. The agent reads CRM records created or linked during submission ingestion.
6. The agent creates a missing CRM record only for a valid non-spam submission.
7. The agent presents a short execution plan.
8. The user approves the plan and allowed mutation scopes.
9. The agent updates the linked CRM records when needed.
10. The agent adds a CRM note with source references.
11. The agent creates a follow-up task with a due date.
12. The agent drafts a follow-up document in the selected workspace.
13. The agent reports each change and links each artifact.
14. The user can open every changed record from the run result.

### 6.4 Required failure behavior

- A duplicate CRM record must not appear after restart.
- A repeated task must not appear after retry.
- A stale CRM record must stop the related update.
- A rejected operation must not run.
- A cancelled run must stop before the next operation.
- An interrupted shell command must require review.
- A document conflict must preserve the user's current content.
- Existing ingestion links must remain the source of truth.

The golden fixture uses a non-spam submission with linked CRM records.

Spam submissions stop before CRM, task, or document mutations.

## 7. Current Baseline

The current implementation is a useful prototype. It is not a safe harness base.

### 7.1 Existing strengths

- `src/hooks/useAgentLoop.ts` contains a bounded model and tool loop.
- `src/services/aiTools.ts` defines six filesystem and shell tools.
- Tauri provides native file, search, shell, terminal, and keychain operations.
- Provider settings support local bring-your-own-key use.
- TABS already has Documents, Tasks, CRM, Forms, Settings, and Terminal modules.
- CRM and Forms already use service boundaries in many paths.
- The main window hides instead of closing.

### 7.2 Blocking defects

- Tool continuation does not preserve assistant `tool_calls`.
- Tool result messages use the wrong tool call field.
- Approval identifiers do not match their UI message identifiers.
- Approval promises exist only in memory.
- Task context is built and then discarded.
- Task chat does not use the tool loop.
- CRM and Forms AI is mock behavior.
- Active tool roots can change during a run.
- Run state does not survive restart.
- Tool side effects have no durable attempt journal.
- Streaming updates can finish out of order.
- Web search runs before the model chooses it.
- Shell commands are not isolated from the wider machine.
- Tauri filesystem and HTTP scopes are broad.
- Current chat, task AI, and agent loop paths lack focused tests.

### 7.3 Domain risks that block safe writes

- Task mutations can leave Dexie and task files inconsistent.
- Task updates do not always persist `updatedAt`.
- Task AI writes bypass normal task actions.
- CRM activity updates can leave Zustand state stale.
- CRM deletion relationships are incomplete.
- Submission ingestion is not transactional.
- Forms rules can retain references to removed fields.
- Agent file writes can leave the editor and tree stale.
- Dirty document transitions do not use one safe command.

## 8. Architecture Principles

1. The runtime is a service, not a React hook.
2. The repository is the source of truth for run state.
3. Zustand stores only UI projections and local view state.
4. Every run captures stable context at creation.
5. Every tool has a schema, handler, risk class, and policy rule.
6. Domain tools call domain commands. They never write Dexie directly.
7. Model text cannot grant permissions.
8. Secrets never enter prompts, tool results, events, or logs.
9. Mutation tools use expected versions or content hashes.
10. Interrupted mutations never receive blind automatic retries.
11. Tool results have size and time limits.
12. Runs produce inspectable events and change summaries.
13. Browser preview can lose features without unsafe fallbacks.
14. The first implementation uses existing dependencies where possible.
15. TABS remains local-only.

## 9. Target Architecture

```text
React clients
  Assistant Sidebar
  Run Center
  Approval Cards
  Domain Context Launchers
          |
          v
Agent Client API
  createRun
  submitInput
  pauseRun
  resumeRun
  cancelRun
  answerApproval
  subscribe
          |
          v
Agent Runtime Service
  Durable Scheduler
  Run State Machine
  Prompt Compiler
  Context Manager
  Provider Adapter
  Tool Registry
  Policy Engine
  Recovery Manager
          |
          +----------------------+
          |                      |
          v                      v
Agent Repository           Tool Handlers
  Dexie                      Domain Commands
  Runs                       Desktop Adapter
  Events                     Web Search Adapter
  Messages                          |
  Tool Attempts                     v
  Approvals                   Tauri Commands
  Artifacts                   Filesystem
  Receipts                    Shell
                               Keychain
                               Notifications
```

## 10. Runtime Boundary Decision

The first runtime will use TypeScript under `src/services/agent/`.

This decision keeps the runtime close to existing domain services and Dexie data.

The runtime will not import React or use hooks.

React will call a narrow client API and subscribe to persisted run updates.

Tauri will continue to execute privileged native work.

A Rust-native worker can follow later if renderer independence becomes necessary.

## 11. Expected File Structure

The final names can change during implementation. The boundaries must remain.

```text
src/
  types/
    agent.ts
  services/
    agent/
      agentClient.ts
      agentRuntime.ts
      agentScheduler.ts
      runExecutor.ts
      runRepository.ts
      runStateMachine.ts
      promptCompiler.ts
      contextManager.ts
      policyEngine.ts
      toolRegistry.ts
      recoveryManager.ts
      artifactStore.ts
      redaction.ts
      providers/
        providerAdapter.ts
        openAICompatibleAdapter.ts
      lifecycle/
        desktopLifecycleAdapter.ts
      tools/
        systemTools.ts
        documentTools.ts
        taskTools.ts
        crmTools.ts
        formTools.ts
        fileTools.ts
        shellTools.ts
        webTools.ts
    documents/
      documentCommands.ts
    tasks/
      taskService.ts
      taskProjectionWorker.ts
    domainEvents.ts
    terminalService.ts
  stores/
    agentUiStore.ts
  components/
    agent/
      AgentSidebar.tsx
      RunCenter.tsx
      RunTimeline.tsx
      RunComposer.tsx
      RunPlanCard.tsx
      ApprovalCard.tsx
      ToolEventCard.tsx
      RunResultCard.tsx
      ContextReferenceList.tsx
  i18n/
    en.ts
    tr.ts
src-tauri/
  src/
    commands/
      lifecycle.rs
    agent_tools/
      scope.rs
      fs_ops.rs
      search.rs
      shell.rs
      process.rs
```

Existing service names can remain when they already provide the required boundary.

## 12. Core Data Contracts

### 12.1 Run record

Each run stores these fields.

```ts
interface AgentRun {
  id: string;
  parentRunId?: string;
  title: string;
  goal: string;
  status: AgentRunStatus;
  mode: 'guided' | 'delegated' | 'read_only';
  contextRefs: AgentContextRef[];
  providerSnapshot: ProviderSnapshot;
  profileSnapshot: AgentProfileSnapshot;
  instructionSnapshot: InstructionSnapshot;
  policySnapshot: AgentPolicySnapshot;
  policyRevision: number;
  toolRegistryVersion: string;
  toolRegistryHash: string;
  appVersion: string;
  nextSequence: number;
  activeTurn: number;
  executionEpoch: number;
  queuePriority: number;
  workerOwnerId?: string;
  workerLeaseExpiresAt?: number;
  archivedAt?: number;
  pendingInputCount: number;
  pauseRequestedAt?: number;
  cancelRequestedAt?: number;
  workspaceScope?: WorkspaceScopeSnapshot;
  maxTurns: number;
  maxDurationMs: number;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  interruptionReason?: string;
  finalSummary?: string;
}
```

The run stores provider identifiers. It never stores provider secrets.

### 12.2 Run status

```ts
type AgentRunStatus =
  | 'queued'
  | 'planning'
  | 'awaiting_approval'
  | 'running'
  | 'cancelling'
  | 'paused'
  | 'interrupted'
  | 'needs_review'
  | 'completed'
  | 'failed'
  | 'cancelled';
```

### 12.3 Context reference

```ts
interface AgentContextRef {
  kind: 'workspace' | 'document' | 'task' | 'crm' | 'form' | 'submission' | 'file';
  id: string;
  label: string;
  revision?: string;
  scope?: Record<string, string>;
}
```

A context reference identifies data. It does not contain the full data payload.

### 12.4 Workspace scope snapshot

```ts
interface WorkspaceScopeSnapshot {
  workspaceId: string;
  rootPath: string;
  rootRevision: string;
  nativeScopeId?: string;
}
```

The runtime captures this snapshot before the run enters the queue.

The model never receives `rootPath` or `nativeScopeId`.

### 12.5 Tool definition

```ts
interface AgentToolDefinition<TArgs, TResult> {
  name: string;
  version: string;
  description: string;
  inputSchema: JsonSchema;
  risk: ToolRiskClass;
  sideEffect: 'none' | 'reversible' | 'irreversible' | 'external';
  supportsRetry: boolean;
  timeoutMs: number;
  maxResultBytes: number;
  normalizeArgs(args: TArgs): TArgs;
  resolveResourceKeys(context: ToolExecutionContext, args: TArgs): string[];
  buildEffectPayload(args: TArgs): unknown;
  validateGrant(grant: AgentPolicyGrant, args: TArgs): boolean;
  execute(context: ToolExecutionContext, args: TArgs): Promise<TResult>;
}
```

### 12.6 Tool result envelope

```ts
interface AgentToolResult {
  ok: boolean;
  summary: string;
  data?: unknown;
  artifacts?: AgentArtifactRef[];
  changes?: AgentChange[];
  error?: AgentToolError;
  observedRevision?: string;
}
```

Tools return structured data. The runtime serializes a bounded model view.

### 12.7 Tool risk classes

```ts
type ToolRiskClass =
  | 'local_read'
  | 'network_read'
  | 'local_create'
  | 'local_update'
  | 'local_delete'
  | 'process_execute'
  | 'external_write'
  | 'secret_access';
```

The model never receives a `secret_access` tool.

### 12.8 Durable message

```ts
interface AgentMessage {
  id: string;
  runId: string;
  messageIndex: number;
  turn: number;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: unknown;
  assistantToolCalls?: ProviderToolCall[];
  providerToolCallId?: string;
  state: 'pending' | 'complete' | 'compacted';
  streamVersion: number;
  consumedAtTurn?: number;
  createdAt: number;
}
```

User steering input remains pending until the executor consumes it.

Assistant tool calls keep their complete provider protocol payload.

### 12.9 Provider snapshot and attempt

```ts
interface ProviderSnapshot {
  providerId: string;
  adapter: 'openai_compatible';
  adapterVersion: string;
  baseUrl: string;
  modelId: string;
  credentialAccount: string;
  reasoning: string;
  capabilities: ModelCapabilities;
  contextWindow: number;
  maxOutputTokens: number;
}

interface AgentProviderAttempt {
  id: string;
  runId: string;
  executionEpoch: number;
  turn: number;
  attempt: number;
  status: 'started' | 'streaming' | 'completed' | 'failed' | 'interrupted';
  requestHash: string;
  startedAt: number;
  finishedAt?: number;
  finishReason?: string;
  safeRetry: boolean;
}
```

The snapshot excludes credentials. `credentialAccount` is only a keychain reference.

### 12.10 Tool attempt

```ts
interface AgentToolCall {
  id: string;
  runId: string;
  turn: number;
  toolIndex: number;
  providerToolCallId: string;
  operationId: string;
  effectFingerprint: string;
  toolName: string;
  toolVersion: string;
  normalizedArgs: unknown;
  resourceKeys: string[];
  status:
    | 'requested'
    | 'awaiting_approval'
    | 'approved'
    | 'executing'
    | 'succeeded'
    | 'failed'
    | 'denied'
    | 'interrupted';
  startedAt?: number;
  finishedAt?: number;
  resultArtifactIds: string[];
  errorCode?: string;
  createdAt: number;
}
```

The runtime writes all tool calls from one complete assistant turn before execution.

`operationId` uses only `runId`, immutable `turn`, and `toolIndex`.

The runtime never executes tool fragments from an incomplete provider stream.

### 12.11 Tool execution attempt

```ts
interface AgentToolExecutionAttempt {
  id: string;
  runId: string;
  toolCallId: string;
  operationId: string;
  executionEpoch: number;
  attempt: number;
  status: 'started' | 'succeeded' | 'failed' | 'interrupted';
  startedAt: number;
  finishedAt?: number;
  errorCode?: string;
}
```

Recovery creates another execution attempt for the same logical tool call.

Recovery always reuses the original `operationId`.

### 12.12 Operation receipt

```ts
interface AgentOperationReceipt {
  id: string;
  operationId: string;
  effectFingerprint: string;
  domain: string;
  resourceKeys: string[];
  status: 'committed' | 'rejected';
  resultSummary: string;
  resultData?: unknown;
  committedAt: number;
}
```

The domain transaction writes the receipt and mutation together.

The runtime checks successful fingerprints before a later turn repeats an effect.

Tools can mark a repeated effect as intentional only through a new approval.

### 12.13 Policy grant

```ts
interface AgentPolicyGrant {
  id: string;
  runId: string;
  policyRevision: number;
  toolName: string;
  toolVersion: string;
  resourcePatterns: string[];
  argumentConstraints: Record<string, unknown>;
  resourceRevisions: Record<string, string>;
  commandDigest?: string;
  maxUses: number;
  usedCount: number;
  expiresAt: number;
}
```

Resource keys use stable forms such as `task:<id>` and `crm:lead:<id>`.

File keys use `workspace:<id>:path:<normalized-relative-path>`.

Create grants use the parent resource key.

Shell grants match one normalized command digest and working directory.

### 12.14 Approval record

```ts
interface AgentApproval {
  id: string;
  runId: string;
  toolCallId?: string;
  planId?: string;
  policyRevision: number;
  risk: ToolRiskClass;
  toolName?: string;
  resourceKeys: string[];
  resourceRevisions: Record<string, string>;
  redactedArgs?: unknown;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled';
  requestedAt: number;
  decidedAt?: number;
  expiresAt: number;
}
```

## 13. Run State Machine

The state machine must reject invalid transitions.

| From | Event | To |
|---|---|---|
| New | Queue | `queued` |
| `queued` | Worker claims run | `planning` or `running` |
| `queued` | User pauses | `paused` |
| `queued` | User cancels | `cancelled` |
| `planning` | Plan needs approval | `awaiting_approval` |
| `planning` | Read-only plan accepted | `running` |
| `planning` | User submits input | `queued` |
| `planning` | User pauses | `paused` |
| `planning` | User cancels | `cancelled` |
| `planning` | Provider interruption | `interrupted` |
| `awaiting_approval` | User approves | `running` |
| `awaiting_approval` | User rejects plan | `paused` or `cancelled` |
| `awaiting_approval` | User rejects tool | `running` |
| `awaiting_approval` | User submits input | `queued` |
| `awaiting_approval` | User pauses | `paused` |
| `awaiting_approval` | User cancels | `cancelled` |
| `running` | Tool needs approval | `awaiting_approval` |
| `running` | User submits input | `running` |
| `running` | Pause reaches safe boundary | `paused` |
| `running` | User cancels provider or read work | `cancelled` |
| `running` | User cancels during a mutation | `cancelling` |
| `running` | Provider or process interruption | `interrupted` |
| `cancelling` | Mutation outcome is known | `cancelled` |
| `cancelling` | Mutation outcome is unknown | `needs_review` |
| `paused` | User resumes | `queued` |
| `paused` | User submits input | `queued` |
| `paused` | User cancels | `cancelled` |
| `interrupted` | Recovery is safe | `queued` |
| `interrupted` | Mutation outcome is unknown | `needs_review` |
| `interrupted` | User cancels safe interrupted work | `cancelled` |
| `needs_review` | User resolves outcome | `queued` or `cancelled` |
| `running` | Goal finishes | `completed` |
| `planning` or `running` | Terminal error | `failed` |

Terminal states are `completed`, `failed`, and `cancelled`.

Pause and cancel requests wait for the current mutation boundary.

A safe boundary exists between provider calls and tool executions.

Provider work and read tools can abort without an unknown side effect.

Terminal-state input creates a child run. It does not reopen the old run.

Archive uses `archivedAt`. Archive does not change the run status.

Retry on a terminal run creates a child run with a new `id` and `executionEpoch`.

Safe recovery resumes the same run and increments `executionEpoch`.

## 14. Command And Event Protocol

### 14.1 Client commands

- `run.create`
- `run.queue`
- `run.input.submit`
- `run.pause`
- `run.resume`
- `run.cancel`
- `run.retry`
- `approval.answer`
- `review.resolve`
- `run.rename`
- `run.archive`
- `run.unarchive`
- `run.queue.prioritize`

### 14.2 Persisted events

- `run.created`
- `run.queued`
- `run.started`
- `user.input_received`
- `user.input_scheduled`
- `run.status_changed`
- `plan.created`
- `plan.updated`
- `approval.requested`
- `approval.answered`
- `approval.invalidated`
- `model.requested`
- `model.stream_started`
- `model.stream_completed`
- `model.failed`
- `tool.requested`
- `tool.started`
- `tool.completed`
- `tool.failed`
- `tool.interrupted`
- `artifact.created`
- `context.compacted`
- `run.paused`
- `run.resumed`
- `run.cancelled`
- `run.completed`
- `run.failed`
- `run.interrupted`

### 14.3 Interactive input rules

User input is a durable message and event.

Input never interrupts a tool during its execution.

The executor reads pending input before the next provider request.

Input during `running` is queued for the next safe turn boundary.

Input during `planning` restarts planning with the new input.

Input during `awaiting_approval` invalidates that approval and queues the run.

Input during `paused` queues the run with the new input.

Input on a terminal run creates a child run linked by `parentRunId`.

The child run receives the parent summary and selected context references.

### 14.4 Command rules

`run.queue.prioritize` works only on `queued` runs.

`run.retry` works only on terminal runs and creates a child run.

`run.archive` and `run.unarchive` only change `archivedAt`.

Policy becomes immutable after the first mutation approval.

Switching to guided mode before that point increments `policyRevision`.

Every event gets a run-local sequence number.

The repository writes the event and projection change in one transaction.

## 15. Persistence Design

### 15.1 Main Dexie tables

Database version 13 will add the new harness tables.

The version 13 schema must list every retained version 12 table.

```ts
this.version(13).stores({
  workspaces: 'id, name, updatedAt, order',
  chatMessages: 'id, threadId, mode, agentId, timestamp, settingsTab, workspaceId',
  chatThreads: 'id, mode, updatedAt, workspaceId, taskId, settingsTab',
  agents: 'id, name, isDefault, scope',
  providerConfigs: 'id, provider, isActive',
  settings: 'key',
  quickPrompts: 'id, createdAt, scope, groupId, order',
  actionGroups: 'id, scope, order',
  tasks: 'id, title, updatedAt, order, projectId, status, parentId',
  projects: 'id, name',
  taskComments: 'id, taskId, createdAt',
  taskAIChangeBatches: 'id, taskId, createdAt, expiresAt',
  agentRuns:
    'id, status, createdAt, updatedAt, queuePriority, archivedAt, parentRunId, [status+queuePriority]',
  agentEvents: 'id, runId, &[runId+sequence], type, createdAt',
  agentMessages: 'id, runId, &[runId+messageIndex], role, createdAt',
  agentProviderAttempts:
    'id, runId, status, turn, startedAt, &[runId+executionEpoch+turn+attempt]',
  agentToolCalls:
    'id, runId, &operationId, effectFingerprint, status, toolName, createdAt',
  agentToolAttempts:
    'id, runId, toolCallId, operationId, status, &[toolCallId+executionEpoch+attempt]',
  agentApprovals: 'id, runId, toolCallId, status, createdAt',
  agentPolicyGrants: 'id, runId, policyRevision, toolName, expiresAt',
  agentArtifacts: 'id, runId, kind, createdAt',
  agentProfiles: 'id, name, isDefault, updatedAt',
  agentOperationReceipts: 'id, &operationId, effectFingerprint, domain, committedAt',
  agentRuntimeLeases: 'id, ownerId, expiresAt',
  taskProjectionJobs:
    'id, taskId, projectionKey, sourceOperationId, status, nextAttemptAt, createdAt, &[sourceOperationId+projectionKey], [status+nextAttemptAt]',
});
```

The upgrade creates default profiles. It does not change old AI records.

### 15.2 CRM and Forms database

Database version 2 will add `agentOperationReceipts`.

CRM and Forms commands will write receipts inside their own mutation transactions.

The version 2 schema must repeat every version 1 table.

```ts
this.version(2).stores({
  crmLeads:
    'id, status, stage, contactId, companyId, ownerId, source, sourceFormId, createdAt, updatedAt, lastActivityAt',
  crmContacts: 'id, email, companyId, createdAt, updatedAt, lastActivityAt',
  crmCompanies: 'id, name, industry, ownerId, createdAt, updatedAt, lastActivityAt',
  crmDeals: 'id, stage, leadId, contactId, companyId, ownerId, createdAt, updatedAt',
  crmActivities:
    'id, type, leadId, contactId, companyId, dealId, formId, submissionId, taskId, createdAt',
  crmNotes: 'id, leadId, contactId, companyId, dealId, createdAt, updatedAt',
  crmTaskLinks: 'id, taskId, leadId, contactId, companyId, dealId, createdAt',
  crmSavedViews: 'id, entity, isDefault, createdAt, updatedAt',
  crmPipelineStages: 'id, key, order',
  forms: 'id, status, name, createdAt, updatedAt',
  formSubmissions:
    'id, formId, status, sourceDomain, leadId, contactId, companyId, createdAt',
  formTemplates: 'id, name, category, createdAt, updatedAt',
  formWebhooks: 'id, formId, enabled, createdAt, updatedAt',
  crmSettings: 'key',
  agentOperationReceipts: 'id, &operationId, effectFingerprint, domain, committedAt',
});
```

### 15.3 Required transaction boundaries

- Run projection and event append use one main database transaction.
- Provider attempt start and event append use one main database transaction.
- A complete assistant turn stores messages and tool calls before execution.
- Each execution start adds a new attempt without changing `operationId`.
- Policy grant consumption and tool approval use one main database transaction.
- Main-domain mutations include their receipt in the domain transaction.
- Companion-domain mutations include their receipt in the companion transaction.
- Companion completion then updates the main tool attempt.
- Recovery queries the companion receipt after an interrupted completion update.
- Worker claim and lease renewal use one main database transaction.
- Task mutations enqueue a projection job in the same main transaction.

### 15.4 Event rules

- Events are append-only.
- Events contain redacted data.
- Events do not contain API keys.
- Large tool output goes to artifacts.
- Event summaries stay small.
- Message content stores the exact provider protocol shape.
- Provider tool identifiers remain part of the stored assistant message.
- Runtime operation identifiers stay stable across safe recovery.

### 15.5 Streaming persistence

The runtime will not write every token to Dexie.

It will keep current stream text in memory and checkpoint at a fixed interval.

Each checkpoint must have a monotonic sequence or version.

The final write must reject older pending checkpoints.

### 15.6 Storage limits

- Tool output has a byte limit.
- Shell output has a byte limit.
- Artifact records have a size warning threshold.
- Old streaming checkpoints are removed after completion.
- Run deletion removes related events, messages, tools, approvals, and artifacts.
- Run deletion does not remove committed domain operation receipts.
- Storage settings show current harness usage.

### 15.7 Task projection job

```ts
interface TaskProjectionJob {
  id: string;
  sourceOperationId: string;
  taskId?: string;
  projectId?: string;
  projectionKey: string;
  kind: 'write_task' | 'write_project_index' | 'remove_path';
  desiredRevision: string;
  targetPath: string;
  stalePaths: string[];
  serializedContent?: string;
  contentHash?: string;
  status: 'queued' | 'running' | 'retry_wait' | 'succeeded' | 'superseded' | 'failed';
  attempt: number;
  maxAttempts: number;
  nextAttemptAt: number;
  lastError?: string;
  createdAt: number;
  finishedAt?: number;
}
```

All target paths are relative to the app-local `TASKS` projection root.

Rust resolves the root with `app.path().app_local_data_dir()?.join("TASKS")`.

The frontend cannot supply or replace this projection root.

The domain transaction stores the exact serialized content and required stale paths.

A mutation can create several jobs with one shared `sourceOperationId`.

`[sourceOperationId+projectionKey]` uniquely identifies each projection effect.

The worker skips a queued job when a newer job has the same `projectionKey`.

Writes use a temporary file and rename before stale paths are removed.

The worker retries five times with bounded backoff.

Project moves and renames enqueue task files and both project indexes.

A final failure keeps Dexie as the source of truth and shows a projection warning.

Agent tool success can report `projection_pending`. It does not wait for file projection.

## 16. Provider Layer

### 16.1 Provider adapter contract

The runtime will call a provider adapter interface.

The first adapter will support OpenAI-compatible chat completion streams.

The adapter must preserve full assistant tool calls and tool result identifiers.

### 16.2 Capability checks

Each model will have explicit capability values.

- Streaming support
- Tool support
- Vision support
- Reasoning support
- Context window
- Maximum output

Unknown tool support will not default to enabled.

Unknown context limits use a conservative 16,000-token limit.

### 16.3 Request snapshot

Every model request records these safe fields.

- Provider identifier
- Model identifier
- Adapter version
- Tool registry version
- Message count
- Estimated input tokens
- Output tokens when available
- Finish reason
- Duration
- Provider request identifier when available

### 16.4 Retry policy

- Retry transient provider failures at most two times.
- Use bounded exponential backoff.
- Do not retry authentication failures.
- Do not retry invalid request failures.
- Pause after repeated rate limits.
- Resume after network recovery only when the run remains safe.
- Retry only before a complete assistant turn is durably accepted.
- Discard all tool fragments from failed or incomplete streams.
- Keep every retry under one turn and a new provider attempt identifier.

### 16.5 Delayed run compatibility

The snapshot freezes the adapter, base URL, model, reasoning, and capability values.

Recovery verifies the provider, credential account, model, tool versions, and workspace scope.

Missing credentials move the run to `needs_review`.

Unavailable models move the run to `needs_review`.

Unavailable tool versions move the run to `needs_review`.

An application migration can map an old tool version only through a tested adapter.

### 16.6 Secret handling

Provider keys remain in secure storage.

The runtime resolves a key only when it starts a provider request.

Redaction runs before every event, log, artifact summary, and error display.

Moving provider HTTP requests into Rust is a later hardening option.

## 17. Prompt Compiler

### 17.1 Prompt order

The compiler will use this priority order.

1. Immutable TABS safety instructions
2. Frozen run policy
3. Global user instructions
4. Workspace `AGENTS.md` instructions
5. Selected agent profile
6. Selected skill instructions
7. Current run goal
8. Compact context reference summary

Higher items win when instructions conflict.

### 17.2 Prompt rules

- Do not insert the full workspace.
- Do not insert full CRM tables.
- Do not insert all tasks.
- Do not insert hidden settings.
- Do not insert secrets.
- Tell the model to use tools for current data.
- Include stable resource identifiers.
- Include the allowed tool list.
- Include remaining run limits.

### 17.3 Instruction snapshots

The run stores the compiled instruction snapshot and source hashes.

Instruction file changes do not alter a run after it starts.

## 18. Agent Profiles And Skills

### 18.1 Agent profiles

The new profile model replaces writer and task personas.

A profile contains these values.

- Name
- Description
- System instructions
- Preferred provider and model
- Preferred reasoning level
- Default run mode
- Allowed tool groups
- Default skills

Profiles cannot contain secrets.

### 18.2 Initial profiles

- General Operator
- Follow-up Operator
- Task Planner
- Document Editor
- CRM Analyst
- Repository Assistant

### 18.3 Skills

Workspace skills will use this structure.

```text
.tabs/
  skills/
    follow-up/
      skill.json
      SKILL.md
      references/
```

`skill.json` contains identifiers and tool requirements.

`SKILL.md` contains the operating instructions.

The runtime loads only selected skills.

The first release will not execute code from a skill package.

### 18.4 Workspace instructions

The runtime will read root `AGENTS.md` when a run has a connected workspace.

Nested instruction discovery can follow after the first release.

Old `.tabs/writerinstructions.md` and `.tabs/taskinstructions.md` files will not load.

TABS will not delete those user files.

## 19. Context Manager

### 19.1 Context strategy

The model receives references and compact summaries first.

The model reads current data through tools.

This avoids stale and excessive prompt data.

### 19.2 Context budget

Reserve model context for these groups.

| Group | Target share |
|---|---|
| System, policy, profile, skills | 15 percent |
| Recent conversation | 30 percent |
| Tool results | 35 percent |
| Current user input and output reserve | 20 percent |

The percentages are defaults. Model limits can adjust them.

The preflight estimate uses `ceil(UTF-8 bytes / 3)` when no tokenizer exists.

The runtime sends requests below 80 percent of the configured context limit.

Provider usage replaces the estimate after a completed request when available.

### 19.3 Compaction

Compaction starts before the request reaches the model limit.

The runtime stores the summary, source sequence range, and compiler version.

The summary must retain these facts.

- User goal
- Approved plan
- Decisions
- Created and changed resource identifiers
- Unresolved errors
- Pending approvals
- Important tool results
- Current next step

### 19.4 Tool result control

- List tools support pagination.
- Search tools return bounded matches.
- Read tools support ranges.
- Large data becomes an artifact.
- The model receives an artifact summary and identifier.
- The model can request another bounded artifact section.

### 19.5 No embeddings in the first release

Structured domain queries are sufficient for the first workflows.

Semantic retrieval can follow after tool and context evaluation data exists.

## 20. Policy And Permissions

### 20.1 Replace Ask and Bypass

The old thread-wide Ask and Bypass modes will be removed.

The new modes are `read_only`, `guided`, and `delegated`.

### 20.2 Default policy

| Risk class | Read-only | Guided | Delegated |
|---|---|---|---|
| Local read | Allow | Allow | Allow |
| Network read | Ask once | Ask once | Approved run scope |
| Local create | Deny | Ask | Approved plan scope |
| Local update | Deny | Ask | Approved plan scope |
| Local delete | Deny | Always ask | Always ask |
| Process execute | Deny | Always ask | Command grant required |
| External write | Deny | Always ask | Always ask |
| Secret access | Deny | Deny | Deny |

### 20.3 Delegated plan approval

Delegated mode starts with a plan approval.

The approval lists expected tools, resource scopes, and operation counts.

The runtime permits only operations inside that approved envelope.

Any scope expansion creates another approval.

### 20.4 Approval record

An approval stores these fields.

- Run identifier
- Tool call identifier or plan identifier
- Risk class
- Tool name
- Human-readable action summary
- Structured arguments after redaction
- Resource scope
- Decision
- Decision time
- Decision source
- Expiration time

### 20.5 Approval behavior

- Approval survives restart.
- Rejection returns a structured result to the model.
- Cancellation resolves all pending approvals.
- Approval expires when its underlying resource revision changes.
- Global permanent grants are not part of the first release.
- Destructive grants apply to one operation only.

Approval creation captures a revision for every mutable resource key.

Create approvals capture parent revisions and derived expected-absence keys.

The policy engine re-reads revisions immediately before grant consumption.

The domain command checks the same revisions inside its mutation transaction.

A mismatch expires the approval and its related grants.

The runtime then requests a new approval with current revisions.

### 20.6 Policy matching algorithm

The policy engine uses this exact order.

1. Validate the tool arguments.
2. Normalize strings, identifiers, dates, commands, and paths.
3. Resolve stable resource keys through the tool definition.
4. Apply the run mode's deny rules.
5. Find a grant with the exact tool name and version.
6. Match every resource key against an approved pattern.
7. Apply the tool-specific argument constraints.
8. Check policy revision, expiration, and remaining uses.
9. Consume one use in the same transaction as tool approval.
10. Return allow, ask, or deny.

Resource patterns support exact values and one trailing `/**` prefix form.

The model cannot supply resource patterns or grant constraints.

The policy compiler creates grants from the approved plan card.

Tool-specific constraints use these fixed fields.

- `allowedFields`
- `parentResourceKeys`
- `pathPrefixes`
- `maxItems`
- `commandDigest`
- `workingDirectoryKey`

Read-only mode creates no mutation grants.

Guided mode creates one-use grants after each approval.

Delegated mode creates bounded grants from the approved plan.

Network Ask Once creates one run grant for one search provider.

That network grant has five uses by default.

Shell approval creates one use for one command digest and working directory.

## 21. Tool Registry

### 21.1 Registry rules

- Tool names are stable and versioned.
- Tool schemas use strict object fields.
- Unknown fields fail validation.
- Handlers receive a frozen run context.
- Handlers receive cancellation signals.
- Handlers return structured errors.
- Handlers do not access React state.
- Handlers do not read the active UI selection.
- Handlers use run-owned context references.

The first release executes tool calls sequentially in assistant message order.

A cancelled run skips every tool that has not started.

A tool error returns a structured result unless the run becomes unsafe.

### 21.2 Tool error codes

- `not_found`
- `validation_failed`
- `permission_denied`
- `approval_rejected`
- `stale_revision`
- `conflict`
- `timeout`
- `cancelled`
- `unavailable`
- `rate_limited`
- `interrupted`
- `internal_error`

Errors shown to the model must remain actionable and safe.

## 22. Domain Tool Catalog

### 22.1 System tools

| Tool | Risk | Purpose |
|---|---|---|
| `run_plan_set` | Local read | Store or replace the run plan |
| `run_plan_step_update` | Local read | Update one plan step |
| `artifact_read` | Local read | Read a bounded artifact section |

Plan tools change run metadata. They do not change user domain data.

### 22.2 Documents and workspaces

| Tool | Risk | Purpose |
|---|---|---|
| `workspace_list` | Local read | List available workspaces |
| `workspace_get` | Local read | Read workspace metadata and active document reference |
| `document_read` | Local read | Read a bounded document view and revision |
| `document_create` | Local create | Create a document or local draft |
| `document_update` | Local update | Apply a checked document update |
| `document_search` | Local read | Search document text and metadata |

Document writes must use an expected revision.

Document writes must preserve dirty editor content.

The workspace store must receive the resulting change event.

### 22.3 Tasks

| Tool | Risk | Purpose |
|---|---|---|
| `task_list` | Local read | Query tasks with bounded filters |
| `task_get` | Local read | Read a task, subtasks, comments, and revision |
| `task_create` | Local create | Create a task or subtask |
| `task_update` | Local update | Update allowed task fields |
| `task_comment_add` | Local create | Add a task comment |
| `task_soft_delete` | Local delete | Move a task to trash |
| `project_list` | Local read | List projects |

Task tools must use one task service.

The service must update Dexie and task file projections safely.

### 22.4 CRM

| Tool | Risk | Purpose |
|---|---|---|
| `crm_search` | Local read | Search leads, contacts, companies, and deals |
| `crm_entity_get` | Local read | Read an entity and related timeline |
| `crm_contact_create` | Local create | Create a contact with duplicate checks |
| `crm_company_create` | Local create | Create a company with duplicate checks |
| `crm_lead_create` | Local create | Create a lead with source links |
| `crm_entity_update` | Local update | Update allowed entity fields |
| `crm_deal_stage_set` | Local update | Change a deal stage through domain rules |
| `crm_note_add` | Local create | Add a note with run provenance |
| `crm_task_link_create` | Local create | Link a TABS task to a CRM entity |

CRM mutation tools must use expected `updatedAt` values.

CRM creation tools must use stable operation identifiers.

### 22.5 Forms and submissions

| Tool | Risk | Purpose |
|---|---|---|
| `form_list` | Local read | List forms with safe metadata |
| `form_get` | Local read | Read a form schema and revision |
| `submission_list` | Local read | Query form submissions |
| `submission_get` | Local read | Read one submission and source metadata |
| `form_validate` | Local read | Validate fields, steps, and logic references |

Form builder mutation tools can follow after the golden workflow passes.

Form publish and delete tools are outside the first release.

### 22.6 Files and coding

| Tool | Risk | Purpose |
|---|---|---|
| `file_read` | Local read | Read a bounded workspace file range |
| `file_write` | Local create or update | Write with an expected content hash |
| `file_edit` | Local update | Apply a checked text replacement |
| `glob` | Local read | Find files inside the run workspace |
| `grep` | Local read | Search bounded file content |
| `shell_exec` | Process execute | Run an approved bounded command |
| `git_status` | Local read | Read repository status without changing Git |
| `git_diff` | Local read | Read bounded Git differences |

Git write operations will use `shell_exec` and explicit approval.

`file_read` returns the editor buffer when the target file is open and dirty.

`file_write` and `file_edit` check workspace state before native file access.

Open files use the document command boundary and expected editor revision.

Closed files use expected disk hashes.

### 22.7 Web search

| Tool | Risk | Purpose |
|---|---|---|
| `web_search` | Network read | Search the web when the model needs current data |

Web search will no longer run before every message.

The tool result will include source titles, URLs, excerpts, and provider metadata.

### 22.8 First release argument contracts

All schemas set `additionalProperties` to `false`.

| Tool group | Required argument shape |
|---|---|
| List tools | `{ filters, cursor?, limit }`, with `limit` from 1 through 100 |
| Entity reads | `{ id, revision?, section?, cursor?, limit? }` |
| `document_create` | `{ workspaceId, title, target, content, expectedWorkspaceRevision }` |
| `document_update` | `{ workspaceId, documentId, expectedRevision, edit }` |
| `task_create` | `{ projectId?, parentId?, title, content?, date?, importance?, assignees? }` |
| `task_update` | `{ taskId, expectedUpdatedAt, updates }` |
| `task_comment_add` | `{ taskId, expectedUpdatedAt, text }` |
| `task_soft_delete` | `{ taskId, expectedUpdatedAt, reason }` |
| CRM creates | `{ values }` with tool-specific required duplicate fields |
| `crm_entity_update` | `{ entityType, entityId, expectedUpdatedAt, updates }` |
| `crm_deal_stage_set` | `{ dealId, expectedUpdatedAt, fromStage, toStage }` |
| `crm_note_add` | `{ entityType, entityId, expectedUpdatedAt, text }` |
| `crm_task_link_create` | `{ taskId, entityType, entityId, expectedUpdatedAt }` |
| `file_write` | `{ path, expectedHash, content }` |
| `file_edit` | `{ path, expectedHash, oldText, newText, replaceAll }` |
| `shell_exec` | `{ command, workingDirectoryKey, timeoutMs }` |
| `web_search` | `{ query, provider, maxResults }` |

Use these exact nested mutation shapes.

```ts
type DocumentCreateTarget =
  | { kind: 'draft' }
  | { kind: 'file'; relativePath: string; expectedState: 'absent' };

type DocumentEdit =
  | { kind: 'replace_all'; content: string }
  | {
      kind: 'replace_text';
      oldText: string;
      newText: string;
      replaceAll: boolean;
      expectedMatchCount: number;
    };

interface DocumentCreateArgs {
  workspaceId: string;
  title: string;
  target: DocumentCreateTarget;
  content: string;
  expectedWorkspaceRevision: string;
}

interface DocumentUpdateArgs {
  workspaceId: string;
  documentId: string;
  expectedRevision: string;
  edit: DocumentEdit;
}

interface TaskCreateArgs {
  projectId?: string | null;
  parentId?: string;
  title: string;
  content?: string;
  date?: string;
  importance?: 'low' | 'medium' | 'high';
  assignees?: string[];
}

interface TaskUpdateArgs {
  taskId: string;
  expectedUpdatedAt: number;
  updates: {
    title?: string;
    content?: string;
    status?: 'pending' | 'in_progress' | 'completed';
    importance?: 'low' | 'medium' | 'high';
    date?: string;
    projectId?: string | null;
    assignees?: string[];
  };
}

interface CRMContactCreateValues {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  jobTitle?: string;
  companyId?: string;
  lifecycleStatus?: string;
  tags?: string[];
  notes?: string;
}

interface CRMCompanyCreateValues {
  name: string;
  website?: string;
  industry?: string;
  size?: string;
  city?: string;
  country?: string;
  ownerId?: string;
  tags?: string[];
  notes?: string;
}

interface CRMLeadCreateValues {
  title: string;
  contactId: string;
  companyId?: string;
  status?: 'new' | 'contacted' | 'qualified' | 'proposal' | 'won' | 'lost' | 'spam';
  stage?: 'new' | 'contacted' | 'qualified' | 'proposal' | 'won' | 'lost' | 'spam';
  score?: number;
  ownerId?: string;
  tags?: string[];
  source?: string;
  sourceFormId?: string;
  sourceSubmissionId?: string;
  sourcePageUrl?: string;
}

interface CRMContactCreateArgs {
  values: CRMContactCreateValues;
}

interface CRMCompanyCreateArgs {
  values: CRMCompanyCreateValues;
}

interface CRMLeadCreateArgs {
  values: CRMLeadCreateValues;
}

type CRMEntityUpdateArgs =
  | {
      entityType: 'contact';
      entityId: string;
      expectedUpdatedAt: string;
      updates: Partial<CRMContactCreateValues>;
    }
  | {
      entityType: 'company';
      entityId: string;
      expectedUpdatedAt: string;
      updates: Partial<CRMCompanyCreateValues>;
    }
  | {
      entityType: 'lead';
      entityId: string;
      expectedUpdatedAt: string;
      updates: Partial<CRMLeadCreateValues>;
    };

interface CRMDealStageSetArgs {
  dealId: string;
  expectedUpdatedAt: string;
  fromStage: 'new' | 'contacted' | 'qualified' | 'proposal' | 'won' | 'lost' | 'spam';
  toStage: 'new' | 'contacted' | 'qualified' | 'proposal' | 'won' | 'lost' | 'spam';
}

interface CRMNoteAddArgs {
  entityType: 'lead' | 'contact' | 'company' | 'deal';
  entityId: string;
  expectedUpdatedAt: string;
  text: string;
}

interface CRMTaskLinkCreateArgs {
  taskId: string;
  entityType: 'lead' | 'contact' | 'company' | 'deal';
  entityId: string;
  expectedUpdatedAt: string;
}

type ExpectedFileHash = `sha256:${string}` | 'absent';

interface FileWriteArgs {
  path: string;
  expectedHash: ExpectedFileHash;
  content: string;
}

interface FileEditArgs {
  path: string;
  expectedHash: `sha256:${string}`;
  oldText: string;
  newText: string;
  replaceAll: boolean;
  expectedMatchCount: number;
}
```

Each tool gets a hand-written JSON schema matching its TypeScript shape.

Every nested object sets `additionalProperties` to `false`.

Every update object uses `minProperties: 1`.

Task titles use the existing 80-character limit.

Dates use the existing `YYYY-MM-DD` task format.

Scores use the range from zero through 100.

Paths must be non-empty normalized relative paths without parent components.

`document_update.edit` supports `replace_all` and checked `replace_text` operations.

`document_create.target` is either a local draft or an absent relative file path.

File creation never overwrites an existing path.

An existing path returns `conflict` and its current revision.

Task update fields use an allowlist from the task service.

CRM update fields use an allowlist for each entity type.

Create tools derive expected-absence keys from normalized duplicate-check fields.

Contact creation requires a non-empty email and uses its lowercase trimmed value.

Company creation uses a trimmed, whitespace-collapsed, lowercase company name.

A form-origin lead uses `sourceSubmissionId` as its duplicate key.

Another lead requires `contactId` and uses it with the normalized title.

The registry tests every schema and resource resolver with fixed fixtures.

## 23. Domain Command Requirements

### 23.1 Documents

- Create one command for safe document switching.
- Return explicit save outcomes.
- Add content revisions or hashes.
- Reconcile agent writes with workspace state.
- Notify the editor after external file changes.
- Reject stale writes.
- Keep draft identity tied to one workspace.

### 23.2 Tasks

- Add a task service between stores and Dexie.
- Put create, update, comment, and soft-delete rules in that service.
- Persist `updatedAt` on every effective mutation.
- Use transactions for related records.
- Keep task Markdown projections consistent.
- Enqueue durable task projection jobs inside task transactions.
- Retry failed projection jobs with a bounded worker.
- Remove direct task AI table writes.

### 23.3 CRM

- Add expected-version checks.
- Wrap related entity and activity writes in transactions.
- Return final records after activity timestamp changes.
- Define duplicate checks for contacts, companies, and leads.
- Refresh store projections after service mutations.

### 23.4 Forms

- Make submission ingestion transactional.
- Keep CRM and Forms projections in sync.
- Centralize field, step, and logic validation.
- Keep hosted embed work outside this harness plan.

### 23.5 Domain change events

All domain commands emit one event after a successful commit.

```ts
interface DomainChangeEvent {
  domain: 'documents' | 'tasks' | 'crm' | 'forms';
  entityType: string;
  entityId: string;
  operation: 'created' | 'updated' | 'deleted';
  revision: string;
  operationId?: string;
}
```

`domainEvents.ts` owns subscriptions.

Stores subscribe once during application initialization.

Stores update one entity or reload the smallest affected query.

Agent tools never update Zustand directly.

### 23.6 Cross-database workflow rule

CRM task links and TABS tasks cannot share one transaction.

The run treats task creation and CRM linking as two receipt-backed saga steps.

Recovery resumes the missing second step without creating another task.

A reconciliation query reports task links whose task no longer exists.

## 24. Mutation Safety And Idempotency

### 24.1 Operation identifiers

Every mutation receives a runtime-generated `operationId` after turn persistence.

Domain commands store a receipt in the same transaction as the mutation.

Repeated calls return the stored outcome instead of repeating the mutation.

The runtime also computes a canonical effect fingerprint.

The fingerprint includes tool version, resource keys, and `buildEffectPayload()` output.

The effect payload excludes expected revisions, input hashes, timeouts, cursors, and limits.

Create payloads contain normalized business fields and target parent keys.

Update payloads contain changed fields and desired values.

File payloads contain the target path and desired output content hash.

A later matching effect returns the prior result or requests repeat approval.

### 24.2 Main database mutations

Task and local metadata receipts use the main Dexie database.

The receipt and domain change must use one Dexie transaction.

### 24.3 CRM and Forms mutations

CRM and Forms receipts use the companion database.

The receipt and domain change must use one companion database transaction.

### 24.4 Filesystem mutations

Filesystem writes cannot share a transaction with Dexie.

Each write records the expected input hash and expected output hash.

Recovery checks the current hash before deciding the outcome.

Unknown outcomes move the run to `needs_review`.

### 24.5 Shell commands

Shell commands are not idempotent by default.

An interrupted shell attempt always moves the run to `needs_review`.

TABS never starts that command again automatically.

## 25. Scheduler And Recovery

### 25.1 Scheduler

- Run one active job at a time.
- Sort by descending `queuePriority`, then ascending `createdAt`.
- Let users move a run to the front.
- Stop claiming jobs when the runtime is paused.
- Persist the worker claim before execution.
- Release the claim after every terminal state.

The runtime creates one random `ownerId` at startup.

It renews a 15-second worker lease every five seconds.

Claiming a run updates the lease and run claim in one transaction.

Another runtime can claim work only after the prior lease expires.

Prioritizing a run assigns the current maximum priority plus one.

```ts
interface AgentRuntimeLease {
  id: 'scheduler';
  ownerId: string;
  mode: 'active' | 'quiescing';
  reason?: 'shutdown' | 'update';
  requestId?: string;
  expiresAt: number;
}
```

### 25.2 Startup recovery

The runtime scans non-terminal runs during application start.

It applies these rules.

| Last durable state | Recovery action |
|---|---|
| Queued | Keep queued |
| Waiting for approval | Restore approval UI |
| Provider request started | Mark interrupted, then retry safely |
| Read tool started | Mark interrupted, then retry safely |
| Receipt-backed mutation started | Inspect receipt |
| Filesystem write started | Compare hashes |
| Shell command started | Require review |
| External write started | Require review |

Recovery increments `executionEpoch` before another provider or tool attempt.

Recovery also verifies provider, tool, credential, and workspace compatibility.

### 25.3 Sleep and network loss

- Detect stream failure after resume.
- Persist the interruption reason.
- Retry only safe work.
- Keep approvals open.
- Do not reset run policy.

### 25.4 Quit and update behavior

Tray Quit will not call `app.exit(0)` directly.

Rust emits `tabs://shutdown-requested` with a unique request identifier.

The runtime checkpoints safe state and reports all active mutation attempts.

The UI offers Pause and Quit or Cancel Runs and Quit.

Preparing shutdown atomically changes the runtime lease to `quiescing`.

Quiescing stops new claims, provider turns, and tool starts.

The runtime aborts provider requests and read tools.

The runtime waits for a started mutation to reach a known durable boundary.

The frontend calls `complete_shutdown` with the request token after persistence finishes.

Rust keeps TABS open when the webview does not answer.

Updater code calls `prepareForRestart` before download installation.

`prepareForRestart` acquires the same durable quiescing barrier.

`prepareForRestart` rejects restart while a mutation outcome is unknown.

Update installation requires the current barrier request token.

Cancelling an update releases the barrier and returns the lease to `active`.

A process restart discards an expired quiescing lease during startup recovery.

All lifecycle events and commands use a desktop service adapter.

### 25.5 Startup barrier

Application startup uses this order.

1. Open and migrate both Dexie databases.
2. Complete safe credential migrations.
3. Load provider, workspace, task, CRM, Forms, and settings state.
4. Register domain event subscribers.
5. Re-register required native workspace scopes.
6. Run recovery classification.
7. Acquire the scheduler lease.
8. Mark the harness client ready.

The scheduler cannot claim work before step seven.

## 26. Cancellation And Time Limits

### 26.1 Cancellation

One run-level `AbortController` will cancel provider and JavaScript tools.

Tauri commands must receive their own cancellation identifiers.

Cancellation will resolve pending approvals and stop future steps.

### 26.2 Default limits

| Limit | Initial default |
|---|---|
| Active runs | 1 |
| Model turns | 25 |
| Run duration | 30 minutes |
| Read tool duration | 30 seconds |
| Web search duration | 30 seconds |
| Shell duration | 60 seconds |
| Shell maximum duration | 10 minutes |
| Tool result sent to model | 64 KB |
| Search matches | 200 |

Settings can lower safe limits. They cannot remove hard maximums.

## 27. Desktop Security Work

### 27.1 Filesystem tools

- Capture the canonical workspace root when the run starts.
- Pass a run scope identifier instead of an active UI root.
- Reject absolute model paths.
- Reject parent traversal.
- Recheck returned glob paths.
- Add result limits.
- Fix out-of-range read offsets.
- Add cancellation checks for long searches.

Native scope registration uses this protocol.

1. The runtime supplies the frozen run and workspace identifiers.
2. Rust canonicalizes the connected workspace root.
3. Rust creates an opaque random scope identifier.
4. Rust stores the scope and canonical root in managed process state.
5. Agent commands accept only that scope identifier and a relative path.
6. Recovery re-registers the persisted root after workspace verification.
7. A changed or unavailable root moves the run to `needs_review`.
8. Terminal or deleted runs revoke their native scopes.

This scope protects against model path escape.

It is not a boundary against a fully compromised TABS webview.

### 27.2 Shell tool

- Keep shell approval separate from file approval.
- Show the exact command and working directory.
- Set a restricted working directory.
- Use a bounded environment.
- Limit timeout and output size.
- Stream bounded output events.
- Kill the process tree on timeout or cancellation.
- Record exit status and truncation.
- Never call shell execution a complete sandbox.

### 27.3 Tauri capabilities

- Remove duplicate HTTP capability entries.
- Keep custom AI commands narrowly registered.
- Keep all capability changes aligned with command registration.

Custom provider URLs require wildcard HTTP access in the first release.

The runtime accepts provider URLs only from saved provider snapshots.

The model cannot supply request origins.

Connected user folders require the existing broad plugin filesystem scope.

Harness tools will not use that plugin scope. They use scoped Rust commands.

This broad webview scope remains a documented desktop risk.

Use this minimum CSP as the implementation target.

```text
default-src 'self' customprotocol: asset:;
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' asset: data: blob: https:;
font-src 'self' data:;
connect-src ipc: http://ipc.localhost http: https:;
object-src 'none';
frame-src 'self' asset: blob: data: https:;
base-uri 'none';
```

Desktop smoke tests must confirm Tiptap, images, PDF frames, Forms previews, providers, updates, and Tauri IPC.

### 27.4 Secrets

- Move search provider keys to secure storage.
- Remove provider key fields from Dexie records.
- Move webhook secrets to secure storage before any webhook execution.
- Redact known secret values from errors.
- Never expose secret list or read tools to the model.

### 27.5 Runtime feature matrix

| Capability | Tauri desktop | Vite browser preview |
|---|---|---|
| Domain reads and writes | Full | Available during the open tab |
| Provider requests | Full | Only when provider CORS permits |
| Durable restart recovery | Full | Not supported after tab close |
| Hidden-window background work | Full | Not supported |
| File tools | Captured native scope | Current live folder handle only |
| Shell and Git tools | Full policy path | Disabled |
| Desktop notifications | Supported | Disabled |
| Secure credentials | OS keychain | Session-only development storage |

Browser preview never falls back to unrestricted paths or remote services.

The first release does not control existing PTY terminal sessions.

The Terminal module remains a separate user interface feature.

## 28. User Experience

### 28.1 Assistant sidebar

The sidebar becomes a run client.

It contains these areas.

- Context references
- Goal composer
- Agent profile selector
- Run mode selector
- Provider and model selector
- Active plan
- Timeline
- Approval cards
- Result card
- Active-run steering composer

### 28.2 Run Center

The Run Center shows these groups.

- Active
- Waiting for approval
- Needs review
- Queued
- Completed
- Failed
- Cancelled

Each row shows status, goal, context, start time, duration, and latest step.

### 28.3 Start from context

Every main module can start a run with the current selection.

Examples include a task, CRM lead, form submission, document, or workspace folder.

The run stores the selected identifiers. It does not follow later UI selection changes.

### 28.4 Plan approval

The plan card shows these values.

- Goal
- Planned steps
- Expected changes
- Tool groups
- Resource scope
- Estimated operation count
- Important risks

The user can approve, reject, or switch to guided mode.

### 28.5 Timeline

The timeline distinguishes these event types.

- Model work
- Read operations
- Proposed changes
- Approved changes
- Rejected changes
- Errors
- Recovery events
- Final artifacts

Raw reasoning will not be required for normal use.

### 28.6 Change results

Each mutation result shows the changed resource and a short before-and-after summary.

Every created resource links to its TABS location.

### 28.7 Notifications

Desktop notifications will appear for these events.

- Approval required
- Review required
- Run completed
- Run failed

Notifications must not include sensitive record data by default.

### 28.8 Accessibility and localization

- All actions use semantic buttons.
- Approval controls support keyboard use.
- Status does not rely on color alone.
- Focus returns to the correct run after a dialog closes.
- New copy appears in `src/i18n/en.ts` and `src/i18n/tr.ts`.

## 29. Clean Replacement Strategy

### 29.1 Preserve

- Provider configurations
- Provider credentials
- Model settings after persistence fixes
- Workspaces and documents
- Tasks and projects
- CRM and Forms data
- Layout and theme settings
- Quick prompts and action groups as generic run starters

### 29.2 Do not migrate

- Old chat threads
- Old chat messages
- Writer personas
- Task personas
- Task AI change batches
- Mock CRM AI suggestions
- Thread-wide Ask or Bypass values
- Writer and task instruction file behavior
- Old global `systemInstructions`
- Old task `modelDefaults`

### 29.3 Database sequence

Version 13 adds new harness tables without removing old tables.

This supports development behind a feature flag.

Version 14 removes old AI tables after the new UI becomes default.

Version 14 clears old chat, persona, and task AI records.

Use this exact version 14 store change.

```ts
this.version(14).stores({
  chatMessages: null,
  chatThreads: null,
  agents: null,
  taskAIChangeBatches: null,
  workspaces: 'id, name, updatedAt, order',
  providerConfigs: 'id, provider, isActive',
  settings: 'key',
  quickPrompts: 'id, createdAt, scope, groupId, order',
  actionGroups: 'id, scope, order',
  tasks: 'id, title, updatedAt, order, projectId, status, parentId',
  projects: 'id, name',
  taskComments: 'id, taskId, createdAt',
  agentRuns:
    'id, status, createdAt, updatedAt, queuePriority, archivedAt, parentRunId, [status+queuePriority]',
  agentEvents: 'id, runId, &[runId+sequence], type, createdAt',
  agentMessages: 'id, runId, &[runId+messageIndex], role, createdAt',
  agentProviderAttempts:
    'id, runId, status, turn, startedAt, &[runId+executionEpoch+turn+attempt]',
  agentToolCalls:
    'id, runId, &operationId, effectFingerprint, status, toolName, createdAt',
  agentToolAttempts:
    'id, runId, toolCallId, operationId, status, &[toolCallId+executionEpoch+attempt]',
  agentApprovals: 'id, runId, toolCallId, status, createdAt',
  agentPolicyGrants: 'id, runId, policyRevision, toolName, expiresAt',
  agentArtifacts: 'id, runId, kind, createdAt',
  agentProfiles: 'id, name, isDefault, updatedAt',
  agentOperationReceipts: 'id, &operationId, effectFingerprint, domain, committedAt',
  agentRuntimeLeases: 'id, ownerId, expiresAt',
  taskProjectionJobs:
    'id, taskId, projectionKey, sourceOperationId, status, nextAttemptAt, createdAt, &[sourceOperationId+projectionKey], [status+nextAttemptAt]',
});
```

The upgrade maps quick prompt and action group scopes to `general`.

The upgrade deletes `systemInstructions`, `activeAgentId`, `activeTaskAgentId`, and `modelDefaults`.

### 29.4 Credential and preference migration

Run this migration during version 13 application initialization.

1. Move Exa, Tavily, Firecrawl, and Brave keys into secure storage.
2. Read each secure value back and compare it before deleting Dexie data.
3. Move any stored custom provider `apiKey` into its provider keychain account.
4. Keep old credential data when verification fails.
5. Disable the affected provider until the user resolves a failed migration.
6. Store a non-secret migration completion marker.
7. Move ordinary active provider and model preferences into Dexie settings.
8. Delete non-secret preference values from secure storage after verification.

New global harness instructions start empty.

### 29.5 External files

TABS will stop reading old writer and task instruction files.

TABS will not delete them from user workspaces.

### 29.6 Old code removal

Remove these paths after final cutover.

- `src/hooks/useAgentLoop.ts`
- Tool-loop sections in `src/hooks/useStreamingChat.ts`
- Legacy approval maps in `src/services/aiTools.ts`
- Old chat thread store behavior
- `src/stores/taskAIStore.ts`
- Unused task AI planner paths
- Mock CRM AI behavior
- Old agent persona forms and types

Keep provider settings code after moving it behind the new runtime interface.

## 30. Implementation Phases

Each phase has one required exit gate.

Do not start a later write phase before its safety gate passes.

### Phase 0: Contracts And Baseline

#### Objective

Freeze the harness contracts and protect the current app during development.

#### Work

- Add `src/types/agent.ts`.
- Define run, event, message, tool, approval, policy, artifact, and error types.
- Define active-run input and child-run retry contracts.
- Add a disabled harness feature setting.
- Add deterministic identifiers and run-local sequence helpers.
- Define the first tool names and versions.
- Add redaction test fixtures without real secrets.
- Record browser preview limitations.
- Record the one-active-run limit.

#### Tests

- Type-level contract tests where useful
- Sequence allocation tests
- Redaction tests
- Run limit validation tests

#### Exit gate

All new contracts compile. Current user behavior remains unchanged.

### Phase 1: Durable Repository And State Machine

#### Objective

Store complete run state before model execution begins.

#### Work

- Add exact main database version 13 tables.
- Add exact companion database version 2 tables.
- Add `fake-indexeddb` as a test-only dependency.
- Add verified search and provider credential migration.
- Repair active provider and model preference persistence.
- Add `runRepository.ts`.
- Add append-only event writes.
- Add transactional projection updates.
- Add the pure run state machine.
- Add provider attempts, logical tool calls, execution attempts, approvals, and policy grants.
- Add operation receipt and task projection job tables.
- Add worker leases and claims.
- Add artifact storage and cleanup.
- Add monotonic stream checkpoints.
- Add run archive and delete operations.

#### Tests

- Exact version 12 to version 13 migration
- Exact companion version 1 to version 2 migration
- Credential migration success, failure, and retry
- Preference migration and restart restoration
- Valid and invalid state transitions
- Event sequence uniqueness
- Transaction rollback
- Approval and policy grant persistence
- Provider, logical tool, and execution attempt persistence
- Stable operation identity across execution epochs
- Worker lease expiry and claim transfer
- Stale checkpoint rejection
- Related record cleanup

#### Exit gate

A synthetic run survives database reload with the same state and event order.

### Phase 2: Domain Command Safety

#### Objective

Create safe command boundaries before the agent can mutate user data.

#### Work

- Add a document command boundary.
- Add safe save outcomes and revision checks.
- Add native scope registration and revocation commands.
- Require relative scoped paths for agent document file commands.
- Reject document path collisions before writes.
- Add a task service with transactional task commands.
- Fix task `updatedAt` persistence.
- Add the durable task projection worker.
- Add projection supersession, retry, move, and rename behavior.
- Add CRM expected-version and transaction support.
- Add CRM duplicate checks needed by the golden workflow.
- Preserve existing submission-to-CRM link behavior.
- Make submission ingestion transactional.
- Centralize Forms validation used by agent reads.
- Add the domain change event bus and store subscribers.
- Add operation receipts to mutation commands.
- Add CRM task-link saga reconciliation.

#### Tests

- Dirty document conflict tests
- Native scope registration, escape, and restart tests
- Document create collision tests
- Task create, update, comment, and soft-delete tests
- Task idempotency and projection retry tests
- CRM duplicate, receipt, and stale-version tests
- CRM transaction tests
- Submission transaction rollback tests
- Forms validation tests
- Domain event projection tests
- CRM task-link saga recovery tests

#### Exit gate

Every golden workflow mutation uses one tested and receipt-aware domain command.

### Phase 3: Provider Adapter And Read-Only Kernel

#### Objective

Run a durable read-only model loop outside React.

#### Work

- Add the provider adapter interface.
- Add the OpenAI-compatible adapter.
- Preserve assistant tool call payloads exactly.
- Preserve `tool_call_id` on tool messages.
- Add explicit model capability checks.
- Add basic prompt compilation.
- Add `agentRuntime.ts` and `runExecutor.ts`.
- Capture and verify workspace scope snapshots during run creation.
- Add durable active-run input handling.
- Add cancellation and turn limits.
- Add bounded provider retry behavior.
- Use a fake provider for deterministic tests.

#### Tests

- Text completion
- One tool call
- Multiple tool calls in one turn
- Multiple model and tool turns
- Provider rejection of malformed messages
- Cancellation during stream
- Rate limit retry
- Authentication failure
- Turn cap
- Restart after interrupted provider request
- Steering input at each allowed state
- Child run creation after terminal input

#### Exit gate

A read-only run completes through the new runtime without React ownership.

### Phase 4: Tool Registry, Policy, And Approvals

#### Objective

Make every tool call pass through one durable policy path.

#### Work

- Add the tool registry.
- Add strict argument validation.
- Add the policy engine.
- Add read-only, guided, and delegated modes.
- Add plan approval envelopes.
- Add exact resource resolvers and grant matchers.
- Add transactional grant consumption.
- Add approval expiration and cancellation.
- Add structured tool errors.
- Add tool timeout and result limits.
- Add run plan tools.

#### Tests

- Tool registration conflicts
- Invalid arguments
- Denied tool calls
- Guided approvals
- Delegated scope approval
- Scope expansion approval
- Approval restart recovery
- Approval expiration after revision change
- Resource prefix, field allowlist, and use-count matching
- Exact shell command digest matching
- Result truncation
- Tool timeout

#### Exit gate

No registered tool can execute before policy returns an explicit allow decision.

### Phase 5: Read Tools And Context References

#### Objective

Let the model inspect current TABS data without prompt dumps.

#### Work

- Add context reference capture from each main module.
- Add workspace and document read tools.
- Add task and project read tools.
- Add CRM search and entity read tools.
- Add form and submission read tools.
- Add bounded artifact reads.
- Add pagination and search limits.
- Add source identifiers to all results.
- Add a read-only workflow from a selected submission.

#### Tests

- Context selection remains stable after UI navigation
- Read permissions
- Pagination
- Missing records
- Stale context references
- Result size limits
- Cross-domain read workflow

#### Exit gate

The agent can inspect the golden workflow data with read-only permissions.

### Phase 6: Mutation Tools And Golden Workflow

#### Objective

Complete the first cross-feature workflow safely.

#### Work

- Add CRM create, update, note, and task-link tools.
- Add task create, update, and comment tools.
- Add document create and update tools.
- Add idempotency receipts.
- Add expected-version checks.
- Add before-and-after change summaries.
- Add resource links to results.
- Add provenance fields where domain types permit them.
- Add recovery review for unknown outcomes.

#### Tests

- Full golden workflow with a fake provider
- Duplicate mutation replay
- Stale CRM update
- Stale task update
- Dirty document conflict
- Restart after each mutation boundary
- Rejected mutation
- Cancelled mutation sequence
- Unknown filesystem outcome review

#### Exit gate

Ten isolated golden runs each survive duplicate delivery and one restart without duplicate data.

### Phase 7: Scheduler, Recovery, And Desktop Lifecycle

#### Objective

Support background queues and restart recovery.

#### Work

- Add the one-worker scheduler.
- Add the exact application startup barrier.
- Start the runtime once after the barrier.
- Keep runtime ownership outside sidebar components.
- Restore queued and waiting runs at startup.
- Add safe automatic recovery rules.
- Add `needs_review` resolution actions.
- Add quit warnings and checkpoints.
- Add shutdown request and completion commands.
- Add updater `prepareForRestart` guards.
- Add desktop notifications.
- Add browser preview degradation messages.

#### Tests

- Sidebar unmount during run
- Module switch during run
- Hidden window run
- Two queued runs
- Startup recovery matrix
- Quit warning
- Update guard
- Unresponsive shutdown client behavior
- Worker lease expiry and recovery
- Quiescing barrier blocks new work until release or restart
- Offline and resume behavior
- Browser preview restrictions

#### Exit gate

A run continues with the sidebar closed and recovers safely after application restart.

### Phase 8: Harness User Interface

#### Objective

Replace chat-first UI with inspectable run controls.

#### Work

- Build the new Agent Sidebar.
- Build the Run Center.
- Build plan, approval, tool, recovery, and result cards.
- Add active-run steering input.
- Add context launch actions to each main module.
- Add run history filters.
- Add artifact and changed-resource links.
- Add pause, resume, cancel, retry, and archive actions.
- Add accessible focus behavior.
- Add English and Turkish copy.
- Keep the old UI behind the development flag until parity passes.

#### Tests

- Composer and context capture
- Approval keyboard flow
- Run status rendering
- Run switching during background work
- Steering during running, paused, and approval states
- Recovery card actions
- Resource navigation
- Empty and error states
- English and Turkish key coverage

#### Exit gate

Users can start, leave, inspect, control, and finish a run without the old chat UI.

### Phase 9: Instructions, Profiles, Skills, And Compaction

#### Objective

Add durable harness context without uncontrolled prompt growth.

#### Work

- Add the final prompt compiler order.
- Add global instructions.
- Add root `AGENTS.md` loading.
- Add new agent profiles.
- Add skill discovery and validation.
- Add selected skill loading.
- Add context budget calculation.
- Add deterministic compaction records.
- Add artifact section reads.
- Add usage reporting.

#### Tests

- Instruction precedence
- Instruction snapshot stability
- Missing and invalid skill files
- Skill tool requirement validation
- Context budget boundaries
- Compaction fact retention
- Resume from compacted context
- Secret exclusion

#### Exit gate

A long synthetic run stays within model limits and resumes with required facts intact.

### Phase 10: Coding Tools, Web Search, And Native Hardening

#### Objective

Keep useful coding features without turning TABS into a coding-agent clone.

#### Work

- Move existing file tools into the registry.
- Capture a fixed workspace root per run.
- Reuse the Phase 2 native scope service for coding tools.
- Add file hash preconditions.
- Fix Rust read, glob, and grep bounds.
- Add Git status and diff read tools.
- Harden shell limits and cancellation.
- Add shell output streaming.
- Convert web search into a registered tool.
- Audit Tauri capabilities and CSP.

#### Tests

- Path traversal rejection
- Glob escape rejection
- Out-of-range reads
- Search cancellation
- File stale-hash rejection
- Shell timeout
- Shell cancellation
- Shell output truncation
- Interrupted shell recovery
- Web search policy and errors
- Secret redaction
- Rust command tests
- Scope restart rehydration
- CSP desktop smoke matrix

#### Exit gate

Coding tools operate only inside captured scope and follow the same durable policy path.

### Phase 11: Cutover, Cleanup, And Release

#### Objective

Make the harness the only AI execution path.

#### Work

- Enable the harness by default.
- Remove old chat and persona UI.
- Remove the old loop and approval map.
- Remove mock CRM AI.
- Remove dormant task AI paths.
- Add Dexie version 14 cleanup.
- Stop reading old writer and task instruction files.
- Remove obsolete selectors and CSS after their final use disappears.
- Run the complete evaluation suite.
- Run desktop packaging checks.
- Update user documentation.

#### Tests

- Version 13 to version 14 migration
- Clean install
- Existing install with old AI records
- Provider and credential preservation
- Search credential migration failure and recovery
- Golden workflow desktop test
- Full regression checks

#### Exit gate

No production component imports the old agent loop, old chat store, or old AI dispatcher.

## 31. Test Strategy

### 31.1 Pure unit tests

- State transitions
- Policy decisions
- Tool argument validation
- Prompt order
- Context budgets
- Compaction
- Redaction
- Recovery classification
- Idempotency decisions

### 31.2 Service integration tests

- Run repository transactions
- Provider protocol
- Tool registry execution
- Domain command transactions
- Operation receipts
- Artifact storage
- Scheduler behavior

Pure executor tests can use an in-memory repository fake.

Repository, transaction, reload, and migration tests must use real Dexie.

Those tests must use the `fake-indexeddb` test dependency.

### 31.3 Fault injection tests

Stop execution after each durable boundary.

Important boundaries include these points.

- Before provider request
- During provider stream
- After tool request persistence
- Before tool execution
- After mutation commit
- Before tool result persistence
- After tool result persistence
- Before next provider request

Each test restarts the runtime and checks the final state.

### 31.4 Deterministic provider scenarios

Create a fake provider with scripted turns.

Scenarios must include these cases.

- Text-only completion
- Read tool use
- Multiple parallel tool requests
- Mutation approval
- Rejection
- Invalid tool arguments
- Repeated tool call
- Context compaction
- Provider timeout
- Rate limit
- Malformed stream

Add these package scripts.

```json
{
  "test:agent": "vitest run src/services/agent src/services/tasks src/services/documents",
  "test:agent-evals": "vitest run src/services/agent/evals"
}
```

### 31.5 Rust tests

- Path sandbox
- Glob sandbox
- Read bounds
- Search limits
- Shell timeout
- Shell process-tree cancellation
- Output limits
- Scope capture
- Scope restart rehydration

### 31.6 UI tests

- Run composer
- Plan approval
- Tool approval
- Timeline states
- Background run switching
- Recovery review
- Result navigation
- Keyboard and focus behavior
- Active-run steering behavior

### 31.7 Manual desktop matrix

| Scenario | Required result |
|---|---|
| Close sidebar during run | Run continues |
| Hide window during run | Run continues |
| Restart during provider call | Run resumes safely |
| Restart during task creation | No duplicate task |
| Restart during CRM creation | No duplicate CRM record |
| Restart during file write | Hash check decides or requests review |
| Restart during shell command | Run requests review |
| Reject approval | Tool does not run |
| Change selected workspace | Run keeps original scope |
| Disconnect network | Run pauses or retries safely |
| Send input during a tool | Input waits for the next turn boundary |
| Quit during a mutation | TABS waits for a known outcome or review record |
| Open an ingested submission | Agent uses its linked CRM records |

## 32. Verification Commands

Run these commands after each frontend phase.

```powershell
npm run typecheck
npm run lint
npm run test
npm run test:agent
npm run test:agent-evals
npm run build
```

Run the full frontend gate before each phase merge.

```powershell
npm run check
```

Run these commands after Rust or Tauri changes.

```powershell
cd src-tauri
cargo fmt --check
cargo check
cargo test
```

Run desktop packaging before release.

```powershell
npm run tauri:build
```

Report browser preview and Tauri desktop results separately.

## 33. Release Acceptance Criteria

The first Work-OS harness release is complete only when all criteria pass.

### 33.1 Product behavior

- Users can start runs from Documents, Tasks, CRM, and Forms.
- Runs retain their original context after UI navigation.
- The golden workflow completes across four domains.
- Users can close the sidebar while work continues.
- Users can inspect all run steps and changes.
- Users can steer active runs at safe turn boundaries.
- Users can pause, resume, cancel, retry, and archive runs.
- Queued runs execute in order.

### 33.2 Durability

- Every active operation has a durable attempt record.
- Every approval survives restart.
- Every mutation uses a receipt or recovery check.
- Interrupted shell commands never retry automatically.
- The recovery matrix passes.

### 33.3 Safety

- No denied operation executes.
- No destructive operation runs without direct approval.
- No secure-storage credential appears in captured requests, events, logs, or artifacts.
- File tools reject scope escape attempts.
- Stale domain changes fail with a clear conflict.
- Document conflicts preserve current user content.

### 33.4 Context

- Preflight requests stay below 80 percent of the configured model limit.
- Compaction preserves decisions, changes, and pending work.
- Tool results stay within configured limits.
- The runtime does not send full domain tables by default.

### 33.5 Clean replacement

- Old chats do not appear in the new interface.
- Old personas do not appear in the new interface.
- Old instruction files do not affect new runs.
- Provider settings and credentials still work.
- No production path uses the old loop.

### 33.6 Quality gates

- `npm run check` passes.
- `npm run test:agent-evals` passes.
- `cargo fmt --check` passes.
- `cargo check` passes.
- `cargo test` passes.
- `npm run tauri:build` passes.
- The manual desktop matrix passes.

## 34. Evaluation Suite

The evaluation suite uses local fixtures and fake provider scripts.

It must not send production data to test providers.

Run it with `npm run test:agent-evals`.

### 34.1 Core scenarios

- Submission to CRM, task, and document
- Meeting notes to tasks and CRM note
- CRM lead summary with no writes
- Task project cleanup proposal
- Document edit with a stale revision
- Repository read and test command
- Web research with source links

### 34.2 Required evaluation results

- Ten isolated golden runs start from the same reset fixture.
- Each isolated run injects duplicate delivery and one restart fault.
- Each isolated run produces exactly one expected mutation set.
- All denied tools remain unexecuted.
- All changed resources appear in final summaries.
- All restart fault cases reach the expected state.
- All long-run scenarios stay below model limits.
- All secret fixtures remain redacted.

The secret test captures these sinks.

- Provider request bodies
- Agent events
- Agent messages
- Tool results
- Artifacts
- Application logger calls
- User-visible runtime errors

## 35. Rollout Strategy

### Stage 1: Developer-only foundation

Keep the feature disabled by default.

Use fake providers and read-only tools.

### Stage 2: Internal read-only use

Enable the harness for read-only domain work.

Keep all mutations on the old UI path or disabled.

### Stage 3: Guided mutations

Enable tested domain mutations with per-operation approvals.

Run the golden workflow daily with local fixtures.

### Stage 4: Delegated background runs

Enable plan-scoped approvals and the durable queue.

Keep destructive actions on direct approval.

### Stage 5: Unreleased cutover candidate

Make the new sidebar and Run Center the default.

Run version 14 migration tests and remove old AI code in this candidate.

Do not publish a production release from this stage.

### Stage 6: Harness release

Publish only after old production paths are absent and all gates pass.

## 36. Main Risks And Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Webview process stops | Active run interrupts | Durable events and startup recovery |
| Two Dexie databases | No cross-database transaction | Domain-local receipts and ordered workflow steps |
| Filesystem has no Dexie transaction | Unknown write outcome | Input and output hashes plus review state |
| Shell is not a full sandbox | Machine-wide side effects | Explicit approval, limits, process control, clear warnings |
| Model repeats a mutation | Duplicate data | Operation receipts, fingerprints, and repeat approval |
| UI selection changes | Wrong target data | Frozen context references |
| Domain state is stale | Lost user updates | Expected revisions and conflict errors |
| Prompt grows without limit | Provider failure | Budgets, compaction, and bounded results |
| Provider protocol differences | Tool loop failures | Adapter contract and protocol fixtures |
| Large local event history | Storage growth | Artifacts, cleanup, usage display, and archive controls |
| Capability hardening breaks file access | Desktop regression | Narrow staged changes and Tauri tests |
| Old and new AI paths diverge | Duplicate maintenance | Short parallel period and fixed cutover gate |

## 37. Deferred Roadmap

These features can follow after the first release proves the runtime.

### 37.1 Second release candidates

- Scheduled runs
- Repeating local workflows
- Multiple active workers
- Form builder mutation tools
- Safe settings mutation tools
- Native provider adapters
- Better document patch formats
- Run templates
- User-defined policy presets
- Nested `AGENTS.md` discovery
- Skill marketplace import

### 37.2 Later platform candidates

- MCP client support
- Subagents
- CLI client
- Local SDK
- Rust-native worker
- Semantic retrieval
- Visual workflow builder
- Windows autostart
- Local workflow triggers

These candidates do not change the first release architecture.

## 38. Critical Path

The critical path is strict.

```text
Contracts
  -> Durable repository
  -> Domain command safety
  -> Read-only runtime
  -> Policy and approvals
  -> Domain read tools
  -> Domain mutation tools
  -> Golden workflow
  -> Recovery and scheduler
  -> New UI
  -> Context and skills
  -> Coding tool hardening
  -> Cutover
```

Do not build advanced skills, MCP, or subagents before the golden workflow passes.

Do not enable delegated writes before receipt and recovery tests pass.

Do not remove the old AI path before the new desktop matrix passes.

## 39. Definition Of Done

TABS is a Work-OS harness when these statements are true.

1. The runtime can execute without an open assistant component.
2. The runtime can recover a non-terminal run after restart.
3. The model can choose tools across TABS domains.
4. Every tool call passes through durable policy.
5. Every mutation is inspectable and conflict-aware.
6. Every run has a durable event and artifact history.
7. Context comes from tools and references, not workspace dumps.
8. The golden cross-feature workflow works without duplicates.
9. Coding tools use the same policy and recovery system.
10. The old chat-first agent implementation is removed.

At that point, chat is one client of the runtime. It is no longer the runtime itself.
