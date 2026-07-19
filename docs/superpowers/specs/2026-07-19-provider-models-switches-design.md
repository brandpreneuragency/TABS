# Provider Models Switches & Custom Model Remove

**Date:** 2026-07-19  
**Status:** Approved for planning  
**Scope:** Settings → Models → provider detail (models list + provider header)

## Problem

In the provider models UI (`ProviderModelsTab` / `ProviderDetailPanel`):

1. Per-model enable switches use accent/panel tokens that do not match the requested off/on palette.
2. There is no one-click control to enable or disable every model for the selected provider.
3. Custom models can be added, but cannot be removed from the models table UI (store already has `removeModelFromProvider`).

## Decisions

| Topic | Decision |
| --- | --- |
| Switch colors | Off → `var(--c-background-1)`; On → `var(--c-accent-1)` |
| Master switch semantics | **A:** Checked only when every model is enabled; unchecked if any model is hidden. Click enables all or disables all for that provider. |
| Master switch placement | Next to provider title in `ProviderDetailPanel` header |
| Custom model remove | Icon button on custom rows only; delete immediately (no confirmation) |
| Approach | Extend existing `ModelSwitch`, panel, tab, and store helpers — no new shared bulk component |

## Design

### 1. Per-model switch styling

Update `ModelSwitch` so its track background is:

- `checked === false` → `var(--c-background-1)`
- `checked === true` → `var(--c-accent-1)`

Knob, size, and interaction stay as today. This component is the single visual source for both per-model and master switches.

### 2. Master enable/disable switch (provider header)

In `ProviderDetailPanel` header, place a `ModelSwitch` immediately after the provider name (before status badge / meta).

**Derived state**

- `modelCount = provider.models?.length ?? 0`
- `allEnabled = modelCount > 0 && every model is not in `hiddenModels` for `${provider.id}:${model.id}``
- Switch `checked={allEnabled}`
- When `modelCount === 0`, switch is unchecked and disabled (no-op)

**On change**

- If turning on: ensure every provider model key is **removed** from `hiddenModels`
- If turning off: ensure every provider model key is **present** in `hiddenModels`
- Leave keys for other providers untouched

Prefer a small store helper (e.g. `setProviderModelsHidden(providerId, hidden: boolean)` or bulk update via existing `setHiddenModels`) so the update is atomic and persists through the same secure-storage path as today.

Wire from `ModelsContent` → `ProviderDetailPanel` the same way other model mutations are wired.

**A11y / copy**

- Add EN + TR strings, e.g. enable-all / disable-all for this provider.
- `aria-label` reflects the action relative to current state.

### 3. Remove custom model button

In `ProviderModelsTab` model rows:

- When `model.custom === true`, show a remove icon button (e.g. `Trash2` / `X`) in the trailing actions area (near expand / enabled column — keep layout coherent; reserve width so non-custom rows do not shift oddly).
- On click: call `onRemoveCustomModel(provider.id, model.id)` with **no** confirmation.
- Catalog (non-custom) rows do not show the button.

`removeModelFromProvider` already:

- Drops the model from `models` and `customModels`
- Adjusts `selectedModel` if needed

Also clear that model’s entry from `hiddenModels` when removing (if not already handled) so stale keys do not linger.

Wire through `ModelsContent` → `ProviderDetailPanel` → `ProviderModelsTab`.

**A11y / copy**

- EN + TR: remove custom model label (include model name where useful).

### 4. Out of scope

- Indeterminate/mixed master-switch visual
- Confirmation dialog for custom remove
- Changing sync/import behavior for catalog models
- Provider delete / reset flows
- Enabling models across multiple providers at once

## Data flow

```
ModelsContent
  ├─ setModelHidden / setHiddenModels (or new bulk helper)
  ├─ removeModelFromProvider (+ optional hiddenModels cleanup)
  └─ ProviderDetailPanel
        ├─ header ModelSwitch → bulk enable/disable
        └─ ProviderModelsTab
              ├─ per-row ModelSwitch → setModelHidden
              └─ custom-only remove → removeModelFromProvider
```

## Testing

- `ModelSwitch`: visual/token change covered indirectly; keep unit behavior (toggle callback) intact.
- `ProviderDetailPanel`: master switch checked only when all models enabled; click enables all / disables all; empty models list disabled.
- `ProviderModelsTab`: remove button only for `custom: true`; click invokes remove callback; non-custom rows have no remove control.
- `aiStore` (if new helper or hidden cleanup): bulk hide/show preserves other providers’ keys; remove clears model + related hidden key.

## Acceptance criteria

1. Model enable switches use `--c-background-1` off and `--c-accent-1` on.
2. Provider title row has a master switch that turns all models for that provider on or off with semantics **A**.
3. Custom model rows have a remove icon that deletes immediately via existing store action.
4. EN and TR strings updated for new controls.
5. Relevant Vitest coverage updated/added; `npm run check` passes for the touched frontend paths.
