# AGENTS.md — TABS Repository Guide

## Purpose and precedence

This file applies to the entire repository. It defines the default working rules for coding agents; a more specific `AGENTS.md` in a subdirectory overrides it for that subtree.

Follow instructions in this order:

1. The user's current request and explicit approvals.
2. Named plans or specs the user points to for the current task.
3. This file.
4. Existing repository conventions.

Do not revive deleted Hermes, VPS, `server/`, `deploy/`, or hosted-web requirements from git history unless the user explicitly asks to restore them.

## Product source of truth

TABS is a **local desktop application** built with Tauri.

- User data, documents, tasks, CRM data, settings, agents, and AI-provider credentials are handled locally.
- There is **no** hosted TABS web application, VPS filesystem, Hermes Gateway, remote session service, Docker deployment, Caddy configuration, or server-side TABS API.
- **Vite/browser mode** (`npm run dev`) is a development preview only — not a supported production runtime.
- Production packaging and day-to-day use target the Windows Tauri desktop app.

Keep the React UI separate from Tauri service adapters. Feature code should go through `src/services/` (runtime, folder connectors, FS adapter, HTTP helpers) rather than importing `@tauri-apps/*` directly in components.

## Required start-up checks

Before editing:

1. Run `git status --short` and inspect relevant diffs. This repository may contain substantial user WIP.
2. Read every file you intend to change and search all references to affected symbols, selectors, commands, persisted keys, and types.
3. Identify which runtime is in scope: Tauri desktop (primary) or browser/Vite (dev preview only).
4. Confirm acceptance criteria and verification commands for the active scope.

Use `rg` for repository searches. Do not infer system behavior from a single component.

## Repository map

- `src/components/<area>/`: React feature and shared UI components.
- `src/stores/`: Zustand state and persisted application state.
- `src/services/`: runtime adapters, persistence, AI providers, filesystem access, search.
- `src/hooks/`: shared React behavior.
- `src/types/`: cross-feature TypeScript contracts.
- `src/i18n/`: English and Turkish UI strings.
- `src/styles/` and feature CSS files: tokens, shell layout, and scoped feature styles.
- `src-tauri/src/`: Rust desktop commands, AI tools, tray, and terminal backend.
- `src-tauri/capabilities/`: Tauri permission scopes.

Generated or runtime data is not source: `node_modules/`, `dist/`, `src-tauri/target/`, and `src-tauri/TASKS/`.

Do **not** reintroduce `server/`, `deploy/`, Hermes clients/stores, remote folder connectors, or `tabsApi` unless explicitly requested.

## Runtime and architecture rules

- Primary runtime: Tauri desktop → `TauriFolderConnector`.
- Dev preview: browser → `BrowserFolderConnector` (File System Access API). No remote connector fallback.
- Keep runtime detection in `src/services/runtime.ts` and FS access behind `src/services/fs-adapter.ts` / `FolderConnector`.
- Browser-only features must degrade safely when native APIs are unavailable.
- Tauri command changes must stay aligned across Rust registration, frontend invocation, and `src-tauri/capabilities/default.json`.
- Preserve stable component identity for editors, AI sidebar chat, forms, and selections.
- Put shared state invariants in Zustand actions. Use narrow selectors in large components.
- Follow existing Dexie patterns for persisted settings; migrate or delete obsolete keys deliberately (e.g. ignore/delete stale `chatMode`).

Shell workspace modes are local only: Documents, Tasks, CRM (including Forms), Settings, plus Terminal. The AI Assistant sidebar’s `SidebarTab = 'chat'` is the local multi-provider assistant — not a Hermes workspace.

## Implementation conventions

### TypeScript and React

- Strict TypeScript is enabled. Do not hide errors with `any`, `@ts-expect-error` without cause, or broad casts.
- Prefer small, explicit types and pure helpers for logic that can be unit tested.
- Keep feature components in their existing area and shared primitives under `src/components/ui/`.
- Preserve accessibility: semantic controls, keyboard behavior, visible focus, accurate labels.
- Add or update Vitest tests for non-trivial logic and regressions (`*.test.ts` / `*.test.tsx` under `src/`).
- When user-facing copy changes, update both `src/i18n/en.ts` and `src/i18n/tr.ts` unless intentionally unlocalized.

### Styling

- Reuse tokens from `src/styles/tokens.css` and existing feature classes before adding new values.
- Keep structural styles in scoped feature CSS; inline styles only for dynamic geometry or CSS variables.
- Audit `min-width: 0`, `min-height: 0`, overflow ownership, and responsive behavior when changing nested layouts.
- Remove obsolete selectors when their final use is removed, but do not perform unrelated global CSS cleanup.

### Rust and Tauri

- Keep commands focused and return actionable errors without leaking sensitive data.
- Update capability scopes narrowly; never broaden filesystem, shell, or HTTP permissions merely to make a failing call pass.
- Run Rust formatting and compile checks when Rust or Tauri configuration changes.
- Distinguish the local debug executable from the installed application when diagnosing desktop behavior.

## Security

- Never print API keys, access tokens, secure-storage values, or `.env` contents in commands, logs, tests, diffs, or chat.
- Provider credentials and local data stay on the user’s machine; do not add cloud sync or remote credential bridges unless explicitly requested.

## Scope and repository safety

- Make the smallest coherent change that satisfies the active request.
- Preserve unrelated modifications and untracked files.
- Do not add or upgrade dependencies unless the task requires it and no existing dependency fits.
- Do not commit or push unless the user explicitly asks.
- Never run destructive Git commands (`git reset --hard`, `git clean -fd`, bulk `git restore`, force-push) without explicit authorization.
- Do not weaken TypeScript, ESLint, tests, or Tauri capabilities to make a check pass.

## Verification

Frontend/full code gate:

```powershell
npm run check
```

For Rust or Tauri changes, from `src-tauri/`:

```powershell
cargo fmt --check
cargo check
```

Use `npm run tauri:build` when packaging is part of acceptance. Report browser preview and Tauri desktop results separately. Never claim a command passed unless it was actually run.

## Handoff format

End implementation work with:

- Summary and files changed
- Behavior and migration notes
- Commands run and exact results
- Remaining risks or unverified paths
