# TABS

Local-first writing, tasks, and CRM with an integrated AI assistant. Built with React, TipTap, and Tauri.

**Primary runtime:** Windows desktop via Tauri. User documents, tasks, CRM data, settings, agents, and AI-provider credentials stay on the machine. There is no hosted TABS web app, VPS backend, Hermes gateway, or remote filesystem.

Vite/browser mode is a **development preview only** — not a supported production runtime.

## Features

- **Chrome-style tabs** — Multiple documents open simultaneously, auto-saved to IndexedDB
- **Rich text editor** — Full formatting toolbar (bold, italic, headings, alignment, lists, links, images, color)
- **Local folders** — Open folders and files via Tauri filesystem commands
- **Auto-save** — Debounced saves to IndexedDB; sessions restore as left
- **AI Assistant sidebar** — Resizable panel with streaming chat (OpenAI, Gemini, OpenRouter, Anthropic)
- **Custom agents & quick prompts** — Local agents with system prompts; reusable prompts
- **Tasks & CRM** — Task manager, projects, CRM, and forms alongside documents
- **Local terminal** — Embedded terminal panel in the desktop shell
- **Export** — DOCX, PDF, and TXT via the hamburger menu
- **i18n** — English and Turkish
- **Updater** — Tauri desktop updater

## Getting Started

### Desktop (primary)

```bash
npm install
npm run tauri:dev
```

### Browser development preview

```bash
npm run dev
```

Open [http://localhost:1421](http://localhost:1421). Folder access uses the browser File System Access API where available; native terminal and full desktop features require Tauri.

### Production package

```bash
npm run tauri:build
```

## Architecture notes

- React UI must not import `@tauri-apps/*` directly in feature components. Use `src/services/runtime.ts`, `fs-adapter.ts`, and the `FolderConnector` adapters.
- Tauri runtime → `TauriFolderConnector`; browser preview → `BrowserFolderConnector`. No remote connector.
- Persistence: Dexie (IndexedDB) for app state; local disk for documents opened from folders.

## Adding an AI Provider

1. Open **Settings** → **Tools**
2. Select a provider, paste your API key, choose a model, and save
3. The provider is ready to use in the AI sidebar

### Provider Notes

| Provider | CORS | Notes |
|----------|------|-------|
| OpenAI | ✅ Direct | Works in browser preview |
| Google Gemini | ✅ Direct | Works in browser preview |
| OpenRouter | ✅ Direct | Access to 100+ models with one key |
| Anthropic | ❌ Requires proxy | Run `node proxy.mjs` first (browser preview) |

### Anthropic Proxy

Anthropic's API does not allow direct browser requests. For the Vite preview:

```bash
node proxy.mjs
```

Then in Settings, set the Anthropic base URL to `http://localhost:3001/anthropic`.

Alternatively, use **OpenRouter** with an Anthropic Claude model.

## Tech Stack

- **React 19 + Vite + TypeScript 5**
- **TipTap** — ProseMirror-based rich text editor
- **Tauri 2** — desktop shell (primary product)
- **Dexie.js** — IndexedDB wrapper for persistence
- **Zustand** — Lightweight state management
- **Lucide React** — Icon library

## Agent / contributor guide

See [AGENTS.md](./AGENTS.md) for runtime rules, repository map, and verification gates.
