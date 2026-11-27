---
name: code-structure
description: Enforces the project's folder structure, file anatomy (the internal order of components, hooks, routes, services, tests), separation of concerns, and folder growth rules. Use before creating, moving, splitting, or substantially growing any file or folder.
---

# Skill: Code Structure, File Anatomy & Growth


## Scope
This skill prevents three recurring failures of AI-written code:
1. **Misplaced files**: a file is put wherever is convenient instead of where the project's structure says it belongs.
2. **Inconsistent anatomy**: a new file is composed differently from its siblings of the same kind (different internal order, naming, exports, colocation).
3. **Unbounded growth**: monolith files and flat folders keep growing because nobody stops to split or group them.

The verified facts for this project live in `.agents/knowledge/project-structure.md` (folder map, anatomy per file kind, naming, layer boundaries, size budgets). This skill defines how to apply and maintain them. Read that file before creating, moving, or splitting files.

---

## 1. Placement Check (Before Creating or Moving a File)
1. Locate the target in the folder map of `.agents/knowledge/project-structure.md`.
2. Open 2–3 existing siblings of the same kind (same folder, same role) and mirror them: file name casing, suffixes (`.service.ts`, `use*.ts`, `*.routes.ts`), colocated files (styles, tests, types, stories), and export style.
3. Ask: **"Where would the next five files like this one go?"** If the honest answer is "into the same flat folder, next to unrelated files", apply the growth rules (Section 4) before adding the file.
4. If no recorded rule covers the case, follow the closest existing pattern and record the decision in `project-structure.md` (verified structure only, never a task log).

---

## 2. File Anatomy (Internal Composition)
Every file kind has a canonical internal order recorded in `project-structure.md`. Match it when creating a file and when adding code to an existing one. Do not reorder untouched files outside the task's scope.

Default anatomies, used **only** when the project has no established pattern:
- **UI component** (React, Vue, Svelte, …): imports → types/props → local constants → state → derived state/memos → hooks/composables and effects → event handlers → guards/early returns → markup. In Vue SFCs: `<script setup>` (same order) → `<template>` → `<style>`.
- **Hook / composable**: parameters → internal state → derived values → effects/watchers → actions → a return object with a stable shape.
- **Route / controller / handler**: input parsing and validation → authorization → one call to a use case/service → mapping the result to the response → error mapping. No business rules and no direct queries.
- **Use case / service**: injected dependencies → public operations → private helpers. One responsibility per file.
- **Repository / data access**: queries and persistence mapping only; no HTTP, UI, or business decisions.
- **Test**: fixtures and setup → one observable behavior per test (arrange → act → assert).

---

## 3. Separation of Concerns (Thin Edges, Thick Core)
- **Components render.** State machines, data fetching, form logic, and business rules go to hooks/composables; pure functions go to utils; network calls go to the API client/service layer.
- **Routes orchestrate.** Business rules live in use cases/services, persistence in repositories/models, validation in schemas.
- **Split triggers** (any one is enough):
  - The file exceeds the size budget recorded in `project-structure.md` (defaults: ~250 lines for components/hooks, ~150 for route handlers, ~400 for services).
  - The file has more than one reason to change (e.g., layout + data fetching + a business rule).
  - A component accumulates more than ~5 state variables or ~3 effects, or a route handler contains a query or a business rule.
  - A block is duplicated, or would be useful in a second place.
- Split along the project's **existing** layers. Do not introduce a new architectural style (e.g., Clean Architecture in a simple MVC project) without the user's approval.

### Page / Screen Decomposition
A page (screen, view, or route component) is a composition shell, not the place where every area's logic lives.
- **Trigger**: split a page once it has 2+ independent visual areas or passes the component budget. Split **by area** (form, filters, results table, details panel), not by code type (no `PageState.ts` / `PageHandlers.ts` dumps).
- **Shell**: the page file only composes the layout, calls the page hook (state shared by several areas: route params, filters, selection, page-level data), and renders the sections.
- **One section per area**: each area becomes a section component with its own hook for that area's state and logic (e.g., `LoginForm` + `useLoginForm`). The page hook must not become a god hook holding every area's logic.
- **State placement**: used by one section → that section's hook; shared by 2+ sections → the page hook; prop drilling deeper than ~3 levels or shared across pages → context/store, following the project's convention.
- **Where page-specific pieces live**: follow the convention recorded in `.agents/knowledge/project-structure.md` (Section 3, "Page-specific components & hooks"). Common conventions:
  - **Mirrored tree**: page `pages/auth/login` → its components in `components/pages/auth/login/`; everything in `components/` outside `pages/` is shared or general-purpose. Page-specific hooks/composables follow the framework's and project's own folder (e.g., `hooks/` in React, `composables/` in Nuxt), mirrored the same way when the project does so (e.g., `composables/pages/auth/login/`). Respect framework auto-import and scan rules: Nuxt, for example, auto-imports only top-level `composables/` files (plus `composables/*/index` files) unless `imports.dirs` is configured, so nested composables need explicit imports or that config.
  - **Colocated**: `pages/auth/login/components/` and `pages/auth/login/hooks/`.
  - If the project has no established convention yet, ask the user the first time a page needs page-specific pieces, then record the answer.
- **Promotion**: when a page-specific component or hook is needed by a second page, move it to the shared folder (in the right domain group) instead of importing it from another page's specific folder.

---

## 4. Folder Growth Rules
Flat folders are fine while small; they must be grouped as they grow. Check these triggers whenever you add a file to a folder:
- **Same-unit siblings**: two or more files share a base name (`youtube.jsx`, `youtube.ts`, `youtube.css`) → move that unit into its own folder (`youtube/`) when adding the next file of it.
- **Folder size**: a folder holds more than ~10–12 files belonging to different units → group them into subfolders by feature/domain (`apps/youtube/`, `apps/chess/`), not by file type.
- **Emerging category**: 3+ files share a domain prefix (`useChatInput`, `useChatScroll`, `useChatHistory`) → group them (`hooks/chat/`) or colocate them with the feature that uses them.
- **Single consumer**: a hook, component, or helper used by only one feature or page belongs to that feature or page (colocated, or in its mirrored page-specific folder, per the project's convention), not in a global shared folder.
- **Consistent units**: once units are grouped (`apps/<app>/`), every unit follows the same internal layout (e.g., `index` entry, view, logic, styles, tests).

*Example*: `apps/youtube.jsx, apps/youtube.ts, apps/youtube.css, apps/twitch.jsx, apps/twitch.ts, apps/notepad.jsx, apps/chess.jsx, …` → `apps/youtube/`, `apps/twitch/`, `apps/notepad/`, `apps/chess/`, each with the same internal layout.

**How to act when a trigger fires:**
- **Small and in scope** (about 5 files or fewer, only files the task already touches, imports updated mechanically): do it as part of the task.
- **Larger**: do not silently move dozens of files. Finish the task in the current layout, then explicitly propose the restructure to the user with the target tree.
- **Separate commit**: structural moves go in their own commit (`refactor(structure): ...`), using `git mv` and no content changes besides import paths, so history and review stay clean.
- **Afterwards**: update `project-structure.md`, agent target directories, and any path-based rules.

---

## 5. Layer Boundaries (Dependency Direction)
Respect the dependency direction recorded in `project-structure.md` (e.g., view → hooks → services → API client; route → use case → repository). Never import "upwards" (a service importing a component) or sideways into another feature's internals; go through the feature's public entry when the project uses one.

---

## 6. Extraction Procedure (Used by `project-audit`)
1. **Folder map**: list top-level and second-level folders. For each, write one line with its purpose, what belongs there, and how it is organized (by feature, by type, or flat).
2. **Anatomy**: for each file kind, sample 3–5 representative, recently maintained files and derive their internal order, naming, exports, and colocated files. When samples disagree, prefer the majority / most recent pattern and note the deviation.
3. **Conventions**: record naming rules, colocation, barrel/index usage, and layer boundaries.
4. **Budgets**: set size budgets from the project's current typical file sizes (not from the outliers).
5. **Debt**: list existing growth smells (oversized files, flat folders past the threshold) under "Known Structure Debt" and report them to the user. Do not fix them during the audit.
