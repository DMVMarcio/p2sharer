---
trigger: always_on
description: Core executive directives for Antigravity: language protocols, Git enforcement, persistent memory, canonical reuse, and subagent schemas.
---

# Workspace Agent Core Kernel

You are the technical maintainer and continuous architect of this project. Enforce architectural consistency, traceability, and persistent memory across sessions using the following non-negotiable directives:

## 1. Dual-Channel Language Protocol
- **Interactive Chat**: Always mirror the user's conversational language (e.g., respond in Portuguese if addressed in Portuguese).
- **Workspace Artifacts**: All code, comments, commit messages, task files, documentation, and files under `.agents/` must be written **strictly in English** (except explicit i18n/l10n files).

## 2. Desktop Runtime & Build Validation
- **Product Runtime**: P2Sharer is a Windows desktop application built with Tauri v2. React/Vite runs inside WebView2 and depends on the Rust host. Browser-only behavior is not a complete application check.
- **Mandatory Packaging Build**: For application code or asset changes, run `npm run tauri:build` and verify the native executable and installer bundle before reporting the task as validated or complete. This also applies when no commit is requested.
- **Frontend Build Scope**: `npm run build` validates TypeScript and Vite only; it does not replace the Tauri build. If native packaging is blocked, state the concrete failure and report the desktop build as unverified.

## 3. Git & Repository Baseline
- If `.git` does not exist in the workspace, run `git init` immediately.
- Before committing, ensure a stack-appropriate `.gitignore` is present.
- All commit messages must follow Conventional Commits in **English**.
- **Mandatory Task-End Commit**: After every task that changes project files, commit the completed task's changes before the final response, without waiting for another user request. Run the required validation first and report the commit hash and any remaining changes. Preserve unrelated pre-existing edits unless the user authorizes committing them; an explicit request to commit all pending changes includes those edits. Do not create empty commits for read-only tasks or push unless authorized.
- For stack-specific `.gitignore` rules, invoke `.agents/skills/git-workflow/SKILL.md`.

## 4. Persistent Memory & User Directives
- **Knowledge Index**: Consult `.agents/knowledge.md` at the start of interactions. If missing, trigger `.agents/skills/project-audit/SKILL.md` to bootstrap it.
- **User Directives**: Whenever the user expresses a preference, convention, or architectural choice (directly or indirectly), persist it immediately in `.agents/knowledge.md` under `## 4. User Guidelines & Preferences` as an English tagged directive (e.g., `[UI]`, `[Backend]`).
- **Dense Subsystems**: Document complex modules in `.agents/knowledge/<module>.md` and link them in the central index; do not bloat `knowledge.md` with raw source code.

## 5. Canonical Reuse & Native Design
- **Application-Wide UI Standard**: Every new or modified surface must reuse the existing canonical components and CSS recipes, including the main window, settings, activity apps, and PiP. Standardization applies to all controls, not only selects. Use shared theme, typography, spacing, radius, scrollbar, and motion tokens; preserve accessible labels, keyboard interaction, visible focus, and disabled/read-only states. Consult the control catalog in `.agents/knowledge/frontend-ui-state.md` before implementing UI.
- **Buttons & Text Fields**: Reuse `.btn` and its semantic/size variants, `.text-input` / `.text-input-sm`, and existing specialized icon-button recipes. Use `EmojiComposerInput` for emoji-aware rich composition. Preserve native input semantics and shared selection-aware text editing rather than recreating editing behavior per screen.
- **Canonical Select Controls**: Native browser `<select>` controls are prohibited in application UI. Use `src/components/common/Select.tsx` for all selection fields, including settings, media pickers, and activity toolbars. Keep themed tokens and narrow scrollbars, viewport-aware portal positioning, keyboard navigation and typeahead, and the shared 320 ms enter / 260 ms exit animation with inert retained exit content. Respect reduced motion.
- **No Browser Input History**: Set `autoComplete="off"` on application inputs, textareas, and forms to prevent Chromium/WebView2 from presenting previously entered values. Apply this to new fields as well as existing shared controls.
- **Menus & Editing Actions**: Use `ContextMenu` / `useContextMenu` for contextual actions and share action builders with corresponding dots menus. Use the shared text-editing actions for inputs and rich editors. Do not introduce native browser context menus or independent feature popups. Keep portal boundaries, viewport clamping, dismissal, focus return, and noninteractive exit content consistent.
- **Tooltips & Dialogs**: Use `Tooltip` / `TooltipButton` and `ModalDialog` with the existing modal lifecycle. Browser `title` tooltips are prohibited. Preserve portal positioning, accessible descriptions, dialog focus trapping/restoration, and Escape handling that closes the active child popup before its parent dialog.
- **Switches, Sliders & Media Controls**: Reuse `.modern-switch` / `.switch-slider`, the existing themed range recipes, `MediaSeekBar`, and shared stream-control styles as appropriate. Retain checkbox/range semantics, keyboard support, value labels, and the established compact geometry; extend the shared recipe when a new variant is required.
- **Emoji, Feedback & Shared Content**: Reuse `EmojiPickerPopover`, `EmojiPicker`, `EmojiGlyph`, `EmojiText`, `ChatMessageContent`, `ToastContainer`, `ActivityToast`, and other existing common components for their respective roles. Keep loading, empty, error, and success states consistent with the existing application patterns.
- **Smooth Motion Across Control Families**: Reuse each family's existing animation and presence lifecycle instead of adding arbitrary timings. Menus and dropdowns use the shared 320 ms enter / 260 ms exit tokens; dialogs retain their own established enter/exit durations. Keep exiting overlays mounted but inert until their animation finishes, avoid clipping and layout jumps, and honor reduced-motion preferences.
- **Useful UI Copy & Compact Layout**: Omit labels that only restate obvious functionality or context (for example, "Shared editing" inside a shared notepad). Include explanatory copy only when it helps users make a decision or understand meaningful state. Consolidate related actions into existing toolbars instead of creating extra rows for redundant text and a few controls.
- Prior to creating new visual components (Web, Desktop, Mobile, Mods) or backend utility functions, audit existing project implementations.
- Never produce disposable, inline, or unmodular elements.
- For design token rules, native host integration, and backend patterns, follow `.agents/skills/canonical-design/SKILL.md`.

## 6. Subagent Schema & Orchestration Standard
- Whenever authoring or updating subagents in `.agents/subagents/`, never create raw markdown without configuration.
- Strictly adhere to the YAML frontmatter schema (defining `name`, `description`, `tools`, `skills`, `subagent: true`, `mainAgent`, `model`, and `commandExecutionPolicy`) specified in `.agents/skills/subagent-management/SKILL.md`.
