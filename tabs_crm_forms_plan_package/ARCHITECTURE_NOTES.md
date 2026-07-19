# TABS CRM + Forms — Architecture Notes (integration contract)

Read this before any CRM/Forms work. Produced by the architecture scanner + orchestrator.
Workspace: `c:\02_APPS\TABS` — branch `feature/crm-form-builder`.

---

## 1. Stack & conventions

- React 19, TypeScript (strict), Vite 8, Tauri 2, Zustand 5, Dexie 4, lucide-react, nanoid, file-saver, Tiptap.
- **No URL router.** "Modes" are Zustand booleans in `src/stores/uiStore.ts`.
- **No Zustand persist middleware.** Entities persist via Dexie (`src/services/db.ts` → IndexedDB). UI prefs persist via `db.settings.put({ key, value })`.
- Data flow: `React component → useXStore (Zustand) → service → Dexie → IndexedDB`.
- IDs: `nanoid()`. Dates: ISO strings (`createdAt`, `updatedAt`, `lastActivityAt`).

---

## 2. Mode switching (the crux)

`src/stores/uiStore.ts` holds `taskMode: boolean` and `pageMode: boolean`. They are **mutually exclusive**:

```ts
setTaskMode: (v) => { set({ taskMode: v, pageMode: false }); db.settings.put({key:'taskMode',value:v}); db.settings.put({key:'pageMode',value:false}); }
setPageMode: (v) => { set({ taskMode: false, pageMode: v }); ... }
```

`loadUISettings()` reads them back from `db.settings`. `App.tsx` line 130 picks center content:
`pageMode ? <PageTemplatePage/> : taskMode ? <TaskDetailPanel/> : <EditorWorkspace/>`.

### RECOMMENDED integration approach (preserves existing architecture)

**Do NOT replace `taskMode`/`pageMode` with an enum.** Mirror the existing boolean-flag pattern. Add two new mutually-exclusive flags and make ALL setters clear the others:

```ts
// add to UIStore interface + state + setters
crmMode: boolean;
formsMode: boolean;
setCrmMode: (v: boolean) => void;
setFormsMode: (v: boolean) => void;
// active sub-page within each module (owned by uiStore so the shell can switch panels)
activeCRMPage: 'dashboard' | 'leads' | 'contacts' | 'companies' | 'pipeline' | 'activities' | 'settings';
activeFormsPage: 'dashboard' | 'list' | 'builder' | 'submissions' | 'templates' | 'settings';
setActiveCRMPage: (p) => void;
setActiveFormsPage: (p) => void;
```

Setter mutual-exclusion contract (every mode setter clears the other three + persists):
- `setTaskMode(v)`: `set({ taskMode: v, pageMode: false, crmMode: false, formsMode: false })` + persist all four.
- `setPageMode(v)`: same pattern, clears task/crm/forms.
- `setCrmMode(v)`: `set({ crmMode: v, taskMode: false, pageMode: false, formsMode: false })` + persist.
- `setFormsMode(v)`: `set({ formsMode: v, taskMode: false, pageMode: false, crmMode: false })` + persist.

`loadUISettings()` must also load `crmMode`/`formsMode`/`activeCRMPage`/`activeFormsPage` from `db.settings` (default false / 'dashboard').

**Why this approach:** it is the smallest symmetric extension of the existing flag system. Existing reads of `taskMode`/`pageMode` keep working unchanged. Lowest risk to Doc/Task modes (the user's hard constraint).

### LeftNarrowSidebar — module switcher (the real one)

`src/components/layout/LeftNarrowSidebar.tsx` renders `#nav-bar.nav-bar` with `.nav-section` groups and `.mode-btn` / `.nav-btn` buttons. Active state = `mode-btn--on` / `nav-btn--on`. Icons are lucide at `size={15}`. The middle `.nav-section` holds Documents (`FileText`), Tasks (`ClipboardList`), Page (`LayoutTemplate`).

**Add CRM and Forms buttons** in that middle `.nav-section`, after the Page button:
- CRM → lucide `Users` (or `Contact`/`Briefcase`) — `onClick: setCrmMode(true)` — active when `crmMode`.
- Forms → lucide `FormInput` (or `ClipboardList` is taken; use `SquarePen` or `FileInput`) — `onClick: setFormsMode(true)` — active when `formsMode`.

`SidebarNav.tsx` (Chat/Actions/Characters/Models) is a SEPARATE left-narrow tab switcher and is NOT the module switcher — do not add CRM/Forms there.

---

## 3. The 3-panel shell — `src/components/layout/AppLayout.tsx`

`.workspace` CSS grid (defined in `src/styles/layout.css`):

```
[.sidebar-panel: 36px rail = LeftNarrowSidebar]
  | [.task-list-panel: Panel 1, width clamp(260px, fileExplorerWidth vw, 420px)]
  | [LeftResizableHandle]
  | [.main-panel: #main-row → [#center-panel (Panel 2, minWidth 260) | .detail-panel → #ai-sidebar-panel (Panel 3, width clamp(320px, sidebarWidth vw, ...))]]
  | [RightNarrowSidebar]
```

Panel visibility today:
- Panel 1 shows when `!pageMode && !settingsPanelOpen && ((fileExplorerOpen && !taskMode) || (taskMode && taskListOpen))`.
- Panel 3 shows when `!pageMode && (aiSidebarOpen || fileViewerOpen)`.
- `pageMode` currently hides Panel 1 and Panel 3 (full-center template).

### CRM/Forms shell rules

For `crmMode` and `formsMode`, ALL THREE PANELS must show (the plan requires the full 3-panel layout on every CRM/Forms page):
- Panel 1 = module nav + list/filters (CRM nav / Forms nav depending on module + page).
- Panel 2 = active dashboard/detail/editor/builder.
- Panel 3 = `CRMAISidebar` (NEW, see §5).

In `AppLayout.tsx`, extend the visibility guards so that `crmMode || formsMode` forces Panel 1 and Panel 3 open (using the same `.task-list-panel` and `.detail-panel`/`#ai-sidebar-panel` classes and the same width formulas). Do NOT change widths or classes — reuse them exactly.

In `App.tsx`, swap the `leftPanel`, `editor` (Panel 2), and `sidebar` (Panel 3) props by mode:
- `crmMode` → Panel 1 `<CRMListPanel/>`, Panel 2 `<CRMWorkspace/>`, Panel 3 `<CRMAISidebar/>`.
- `formsMode` → Panel 1 `<FormsListPanel/>`, Panel 2 `<FormsWorkspace/>`, Panel 3 `<CRMAISidebar/>`.
- existing doc/task/page logic unchanged.

Recommended new shell components (owned by the Layout agent):
- `src/components/layout/CRMWorkspace.tsx` — switches Panel 2 content by `activeCRMPage`, imports page components from `src/components/crm/pages/*`.
- `src/components/layout/FormsWorkspace.tsx` — switches Panel 2 content by `activeFormsPage`, imports page components from `src/components/forms/pages/*`.
- `src/components/crm/CRMListPanel.tsx` — Panel 1 CRM nav + list (switches by `activeCRMPage`).
- `src/components/forms/FormsListPanel.tsx` — Panel 1 Forms nav + list.

---

## 4. Dexie persistence — `src/services/db.ts`

`TabsDB extends Dexie`, IndexedDB name `'ZenEditorDB'` (legacy id for existing installs), singleton `export const db = new TabsDB()`. Versioned via `this.version(N).stores({ tableName: 'indexed,fields,here' })`. Current version = **9**. Settings table is `'key'`-indexed KV: `db.settings.put({key, value})` / `db.settings.get(key)`.

### CRM/Forms persistence decision

The Data Model agent creates a **separate companion Dexie DB** (e.g. class `TabsCrmFormsDB extends Dexie`, name `'TabsCrmFormsDB'`) rather than editing `db.ts`, to avoid touching the existing DB and risking Doc/Task data. CRM/Forms tables: `crmLeads, crmContacts, crmCompanies, crmDeals, crmActivities, crmNotes, crmTaskLinks, crmSavedViews, forms, formSubmissions, formTemplates, formWebhooks` — indexed on `id` + key query fields. Seed only when empty.

**Downstream agents must NEVER import `db` (TabsDB) for CRM/Forms data.** Always go through `crmService` / `formsService` / `submissionService` / `embedService`, which abstract the companion DB.

(If a future agent prefers a single DB, adding `this.version(10).stores({...})` to `db.ts` with the CRM/Forms tables is the clean alternative — but it is NOT required for MVP and touching `db.ts` adds risk to existing modes.)

---

## 5. Doc-mode AI sidebar — the Panel 3 reference (`src/components/sidebar/AISidebar.tsx`)

Structure to mirror in `CRMAISidebar`:

```
#ai-sidebar.panel.flex.flex-col.h-full.w-full.overflow-h
  ├─ (optional) ConfirmDialog
  ├─ empty state: #chat-empty-state.panel-body.empty-state.chat-empty-state
  │     .chat-empty-state-icon (icon 32)
  │     .chat-empty-state-title
  │     .chat-empty-state-subtitle.subtle
  ├─ body: .panel-body.ai-scroll-host.flex-1.min-h-0  (ChatThread equivalent)
  └─ footer: .ai-sidebar-composer.panel-footer  (ChatInput equivalent / bottom input)
```

CSS lives in `src/components/sidebar/aiSidebar.css` + `src/styles/layout.css` (`@container detail-panel`) + `src/styles/panels.css` (`#ai-sidebar-panel`). Subheader component: `src/components/sidebar/RightPanelSubheader.tsx` (`.right-panel-subheader`, `.tbar-btn`).

### CRMAISidebar requirements (owned by the AI Sidebar agent)

- New file `src/components/sidebar/CRMAISidebar.tsx` — root uses the SAME `#ai-sidebar`/`.panel`/`.ai-sidebar-composer` classes so it is styling-linked to the doc sidebar.
- Agents selector with exactly four **CRM Agents** (NOT Writers): `Lead Qualifier`, `Follow-up Writer`, `Pipeline Analyst`, `Form Assistant`. Store definitions in `src/components/sidebar/CRMAgents.ts`.
- Receives active context via props (selected lead/contact/company/pipeline view/form/submission/embed state) — the Layout shell passes the current selection.
- Mutating AI actions follow **Suggest → Preview → Apply** (no destructive direct apply). UI for suggestions list, preview pane, and apply confirmation.
- Quick prompts per context.
- Bottom input area reusing `.ai-sidebar-composer` styling.
- New CSS only in `src/components/sidebar/crmAiSidebar.css` — do NOT edit existing `aiSidebar.css` or global CSS. Scope new classes with `crm-ai-*` prefix.

---

## 6. Task-mode panel patterns to mirror (Panel 1 list + Panel 2 detail)

`src/components/taskManager/`:
- `TaskListPanel.tsx` / `TaskListHeader.tsx` — Panel 1 list pattern: compact header, search/filter row, scrollable list of `.task-item` cards, `+ Add` quick-create at bottom.
- `TaskDetailPanel.tsx` — Panel 2 detail pattern: header (title/status/stage/edit), tabs row, two-column detail cards, bottom comment input (`TaskCommentInput`).
- CSS: `src/components/taskManager/taskList.css` — spacing, `.task-item` card styles, border radius, muted greys, empty states. CRM/Forms list/detail components MUST match these.

---

## 7. Design tokens & reusable styles

Defined in `src/index.css` + `src/styles/*.css`. Reuse BEFORE adding new ones:
- Colors: `--c-background-1`, `--c-background-2`, `--c-background-3`, `--c-border-1`, `--c-accent-center-panel`. **Note:** `--c-background-4` is only defined in the cyberpunk theme — if CRM/Forms needs a 4th surface, either reuse `--c-background-3` or add `--c-background-4` to the default `:root` (scoped addition only).
- Radius: `--radius-md` (≈8–10px). Match existing card radius.
- Layout: `--sidebar-width`, panel width formulas in `AppLayout.tsx` (do not change).
- Typography: `--fs-sm` etc. (see `src/index.css`).
- Reusable classes: `.panel`, `.panel-body`, `.task-list-panel`, `.task-item`, `.composer-*`, `.ai-sidebar-composer`, `.side-nav-tab`, `.mode-btn`, `.nav-btn`, `.empty-state`, `.subtle`, `.tbar-btn`.
- Reusable components: `src/components/ui/ConfirmDialog.tsx`, `src/components/ui/Toast.tsx`, `src/components/ui/Composer.tsx`, `src/components/ui/HeaderDropdown.tsx`, `src/components/ui/ModelSwitcher.tsx`, `src/components/pageTemplate/ReusablePageTemplate.tsx`.

CRM/Forms component class prefixes: `crm-*` and `forms-*` (per wireframe doc). Avoid generic global names.

---

## 8. File ownership map (avoids merge conflicts — all agents share ONE workspace)

| Owner | Files (MODIFY = existing, NEW = create) |
|---|---|
| Data Model agent | NEW `src/types/crm.ts`, `src/types/forms.ts`, `src/stores/crmStore.ts`, `src/stores/formsStore.ts`, `src/services/crmService.ts`, `src/services/formsService.ts`, `src/services/embedService.ts`, `src/services/submissionService.ts`, `src/utils/csvExport.ts`, `src/data/crmSeed.ts`, `src/data/formsSeed.ts`, companion Dexie db file |
| Layout agent | MODIFY `src/stores/uiStore.ts`, `src/components/layout/LeftNarrowSidebar.tsx`, `src/components/layout/AppLayout.tsx`, `src/App.tsx`. NEW `src/components/layout/CRMWorkspace.tsx`, `FormsWorkspace.tsx`, `src/components/crm/CRMListPanel.tsx`, `src/components/forms/FormsListPanel.tsx`, and STUB page files at `src/components/crm/pages/*.tsx` + `src/components/forms/pages/*.tsx` (placeholders that page agents overwrite) |
| AI Sidebar agent | NEW `src/components/sidebar/CRMAISidebar.tsx`, `src/components/sidebar/CRMAgents.ts`, `src/components/sidebar/crmAiSidebar.css` |
| CRM Pages agent | OVERWRITE `src/components/crm/pages/*.tsx` stubs with real implementations; NEW `src/components/crm/**/*.tsx` + `crm.css` as needed |
| Forms Pages agent | OVERWRITE `src/components/forms/pages/*.tsx` stubs; NEW `src/components/forms/**/*.tsx` (except `builder/*` owned by Form Builder agent) |
| Form Builder agent | NEW `src/components/forms/builder/**/*.tsx` + css |
| Embed/Submission agent | NEW `src/components/forms/embed/**/*.tsx`, snippet preview components; uses `embedService`/`submissionService` (already created by Data Model agent) |
| Responsive agent | NEW `src/components/crm/*.css`, `src/components/forms/*.css`, responsive media queries (runs LAST among builders) |
| Testing agent | runs `npm run build` / `lint`, fixes TS/build errors anywhere, produces final summary |

**Golden rules:** stay within your owned files; do not edit existing CSS or existing components unless explicitly listed; do not commit (the orchestrator handles commits between waves); do not run build/install (the Testing agent does, last).

---

## 9. The three required TODO comments (exact text — place per docs/03)

```ts
// CRM_FORMS_FILE_UPLOAD_TODO:
// File upload field UI/config is intentionally included,
// but live upload storage is not implemented yet.
// Future VPS agent must connect this to object storage or server storage,
// signed upload URLs, MIME/type validation, file size limits,
// virus/security checks, and submission attachment linking
// before enabling production file uploads.
```

```ts
// CRM_FORMS_PUBLIC_CAPTURE_TODO:
// The embed snippets are generated now, but production lead capture requires
// a public VPS/API endpoint. Future backend agent must implement public form
// rendering, allowed-domain validation, CORS policy, rate limiting, spam checks,
// submission persistence, duplicate matching, and CRM lead creation.
```

```ts
// CRM_FORMS_WEBHOOK_DELIVERY_TODO:
// Webhook settings are stored now, but delivery/retry/logging is deferred.
// Future backend agent must implement signed payloads, timeout handling,
// retry policy, webhook logs, failure states, and test-send action.
```

---

## 10. Duplicate-handling rule (lives in `submissionService`)

```
if submission.email matches an existing contact (by email) OR existing lead (via contact email):
    attach submission as an activity on the existing lead/contact
    update lastActivityAt
    do NOT create a duplicate contact
else:
    create Contact (+ Company if name present and not existing) + Lead
link submission → leadId / contactId / companyId
```

---

## 11. Responsive behavior (applies to every CRM/Forms page)

- Desktop: full 3-panel layout.
- Tablet: allow Panel 1 or Panel 3 collapse using existing toggle behavior (`LeftNarrowSidebar` toggle button already exists).
- Mobile: stacked navigation → detail → AI flow. Kanban uses horizontal scroll or a stage selector, not 6 squeezed columns.

---

## 12. Quick file reference (read these before coding)

- `src/App.tsx` — mode → center/Panel3 mapping (line ~130).
- `src/components/layout/AppLayout.tsx` — 3-panel shell + visibility guards.
- `src/components/layout/LeftNarrowSidebar.tsx` — module switcher.
- `src/stores/uiStore.ts` — all UI state + setters + `loadUISettings`.
- `src/services/db.ts` — Dexie `TabsDB` (do not use for CRM/Forms data; use the companion DB via services).
- `src/components/sidebar/AISidebar.tsx` — Panel 3 reference structure.
- `src/components/sidebar/RightPanelSubheader.tsx` — Panel 3 subheader.
- `src/components/taskManager/TaskListPanel.tsx` + `taskList.css` — Panel 1 list pattern.
- `src/components/taskManager/TaskDetailPanel.tsx` + `TaskCommentInput.tsx` — Panel 2 detail + bottom input pattern.
- `src/index.css` + `src/styles/layout.css` + `src/styles/panels.css` — tokens & panel classes.
