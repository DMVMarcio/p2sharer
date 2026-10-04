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
- **Package Manager**: Use the pnpm version pinned by `package.json` for all JavaScript dependency and script operations. Install with `pnpm install --frozen-lockfile`, run scripts with `pnpm run <script>`, and execute local CLIs with `pnpm exec <tool>`. Track `pnpm-lock.yaml` only; preserve native patches and explicit build-script permissions in `pnpm-workspace.yaml`.
- **Product Runtime**: P2Sharer is a Windows desktop application built with Tauri v2. React/Vite runs inside WebView2 and depends on the Rust host. Browser-only behavior is not a complete application check.
- **Mandatory Packaging Build**: For application code or asset changes, run `pnpm run tauri:build` and verify the native executable and installer bundle before reporting the task as validated or complete. This also applies when no commit is requested.
- **Frontend Build Scope**: `pnpm run build` validates TypeScript and Vite only; it does not replace the Tauri build. If native packaging is blocked, state the concrete failure and report the desktop build as unverified.
- **Canonical Build Directory**: Always build in the default `src-tauri/target/` directory. Never create or use alternate build directories or override Cargo's target directory to bypass a running executable or file lock. If P2Sharer is open or its executable is locked, present a user questionnaire asking the user to close the application, explain that this workspace rule requires it, and wait for the user's confirmation before retrying. Do not terminate the application automatically.

## 3. Git & Repository Baseline
- **Public Repository Safety**: Before staging, inspect all proposed paths, content, and file sizes. Never commit runtime/build logs, personal machine reports, private environment files, credentials, signing keys, generated outputs, or user media. Keep sanitized example templates and licensed application assets. Review AI memory for personal names, room identifiers, local paths, network measurements, and unnecessary machine identifiers; retain the technical lesson instead.
- **Author Privacy**: Use the contributor's verified GitHub `noreply` email for new commits. Preserve contributor attribution and do not invent an identity. Review both author and committer metadata when auditing historical exposure.
- **Infrastructure Privacy**: Audit IPv4/IPv6 literals, private hostnames, endpoints, URL credentials, and server logs in both current files and history. Replace private deployment identifiers with reserved documentation placeholders. Preserve required loopback bindings and reviewed public services; distinguish browser/version strings from addresses. Do not restore the removed optional deployment directory.
- Run `pnpm run check:repository`, then `pnpm run check:repository --staged` after staging, and `git diff --cached --check`. Inspect the complete staged diff. The hygiene check detects selected high-confidence patterns and is not a complete secret scanner. Scan proposed changes with Gitleaks using full redaction and review every finding; only dismiss demonstrably synthetic fixtures with a narrow explanation, never a blanket allowlist.
- For publication or suspected historical exposure, audit every reachable commit, remote branch, tag, and pull-request ref, not only HEAD. Rotate any real exposed credentials before removing them. Deleting a file or adding it to `.gitignore` does not purge history. Back up and validate a rewritten copy before requesting approval for remote history replacement. Never push backup/audit/Codex refs with `--mirror`. Check GitHub Actions logs/artifacts, releases, PRs, and forks before making the repository public.
- If `.git` does not exist in the workspace, run `git init` immediately.
- Before committing, ensure a stack-appropriate `.gitignore` is present.
- All commit messages must follow Conventional Commits in **English**.
- **Mandatory Task-End Commit**: After every task that changes project files, commit the completed task's changes before the final response, without waiting for another user request. Run the required validation first and report the commit hash and any remaining changes. Preserve unrelated pre-existing edits unless the user authorizes committing them; an explicit request to commit all pending changes includes those edits. Do not create empty commits for read-only tasks or push unless authorized.
- For stack-specific `.gitignore` rules, invoke `.agents/skills/git-workflow/SKILL.md`.

### Release maintenance
- Keep application versions synchronized with `pnpm run release:version <version>` and validate with `pnpm run release:check`. Tags must match the version exactly and published releases must never be rewritten.
- Build official signed releases from trusted tags through `.github/workflows/release.yml`; review and manually publish its draft. Ordinary main-branch pushes must not publish releases.
- Keep CI setup shared through `.github/actions/setup-build/action.yml`. Main-branch validation warms dependency caches; releases only restore compiled Rust dependencies. Preserve lockfile/compiler/native-tool-aware keys and always run locked installation, tests and builds regardless of cache hits. Never cache signing credentials or distributed installers.
- Main-branch CI runs frontend compilation and frontend/native regressions without generating installers. Keep installer generation and packaging validation in the release workflow. This CI split does not replace the mandatory local desktop packaging check for application changes.
- Forward Cargo-only build flags after Tauri's `--` separator (`pnpm run tauri:build -- --locked`); do not pass `--locked` as a Tauri option. For a failed unpublished release, dispatch the corrected workflow from main with the existing tag rather than rerunning the old workflow revision or rewriting the tag. Load shared CI actions from the workflow revision while keeping application code on the requested tag.
- Keep the public updater key stable across distributed versions. Store its private key and password only outside Git and in release-job secrets; do not generate production replacement keys automatically. Local packaging uses `pnpm run tauri:build`; signed packaging uses `pnpm run release:build` with process environment credentials.
- Validate canonical Base64 encoding of public updater keys before compilation; Node's permissive decoder alone does not match Tauri's strict decoder. An encoding-only repair must preserve the decoded cryptographic key and must never replace or regenerate the signing keypair.
- Preserve explicit user consent before installing an update, native media teardown and saved data. Updater/restart permissions belong only to the main window. Test a real installed-version upgrade in addition to unit regressions and desktop packaging.

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

## Test Maintenance
- Run frontend regressions with `pnpm test` and native regressions with `pnpm run test:native --release`. Keep the production desktop packaging check for application changes.
- Preserve tests that execute real production behavior or meaningful invariants. Remove stale harnesses, temporary diagnostics and tests that only validate locally copied implementation models.
- Make automatic tests independent of personal checkout paths, installed applications, GPU vendors, cameras, displays and audio devices. Use isolated fixtures and software rendering where appropriate.
- Mark live hardware checks explicitly ignored with prerequisites and document named opt-in commands. Never silently return from a test and report a pass without exercising its assertions. Do not use machine-specific FPS or wall-clock performance as universal acceptance criteria.
- Keep generated diagnostic outputs ignored and private infrastructure, room credentials and personal machine profiles out of fixtures and shared documentation.

## 6. Subagent Schema & Orchestration Standard
- Whenever authoring or updating subagents in `.agents/subagents/`, never create raw markdown without configuration.
- Strictly adhere to the YAML frontmatter schema (defining `name`, `description`, `tools`, `skills`, `subagent: true`, `mainAgent`, `model`, and `commandExecutionPolicy`) specified in `.agents/skills/subagent-management/SKILL.md`.
