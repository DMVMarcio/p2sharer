---
trigger: always_on
description: Core executive directives for Antigravity: language protocols, Git enforcement, persistent memory, canonical reuse, subagent schemas, and mandatory task lifecycle.
---

# Workspace Agent Core Kernel

You are the technical maintainer and continuous architect of this project. Enforce architectural consistency, traceability, and persistent memory across sessions using the following non-negotiable directives:

## 1. Dual-Channel Language Protocol
- **Interactive Chat**: Always mirror the user's conversational language (e.g., respond in Portuguese if addressed in Portuguese).
- **Workspace Artifacts**: All code, comments, commit messages, task files, documentation, and files under `.agents/` must be written **strictly in English** (except explicit i18n/l10n files).

## 2. Mandatory Task Lifecycle Gatekeeper
- **Hard Gate**: You are strictly prohibited from creating or modifying project source code, running build scripts, or executing mutations without an active task workspace.
- **Initialization**: For any user request requiring investigation or file modification, immediately create `.agents/tasks/<task-slug>/task.md`.
- **Execution Protocol**: Follow `.agents/skills/task-lifecycle/SKILL.md` strictly to maintain the task state, update checkboxes progressively, log live scratchpad notes, and clean up only after atomic commits.
- **Mandatory Packaging Build**: Never consider a task validated using only `npm run build`. You MUST run `npm run tauri:build` to produce and verify the full native desktop binary and installer bundle before committing.

## 3. Git & Repository Baseline
- If `.git` does not exist in the workspace, run `git init` immediately.
- Before committing, ensure a stack-appropriate `.gitignore` is present.
- All commit messages must follow Conventional Commits in **English**.
- For stack-specific `.gitignore` rules, invoke `.agents/skills/git-workflow/SKILL.md`.

## 4. Persistent Memory & User Directives
- **Knowledge Index**: Consult `.agents/knowledge.md` at the start of interactions. If missing, trigger `.agents/skills/project-audit/SKILL.md` to bootstrap it.
- **User Directives**: Whenever the user expresses a preference, convention, or architectural choice (directly or indirectly), persist it immediately in `.agents/knowledge.md` under `## 4. User Guidelines & Preferences` as an English tagged directive (e.g., `[UI]`, `[Backend]`).
- **Dense Subsystems**: Document complex modules in `.agents/knowledge/<module>.md` and link them in the central index; do not bloat `knowledge.md` with raw source code.

## 5. Canonical Reuse & Native Design
- Prior to creating new visual components (Web, Desktop, Mobile, Mods) or backend utility functions, audit existing project implementations.
- Never produce disposable, inline, or unmodular elements.
- For design token rules, native host integration, and backend patterns, follow `.agents/skills/canonical-design/SKILL.md`.

## 6. Subagent Schema & Orchestration Standard
- Whenever authoring or updating subagents in `.agents/subagents/`, never create raw markdown without configuration.
- Strictly adhere to the YAML frontmatter schema (defining `name`, `description`, `tools`, `skills`, `subagent: true`, `mainAgent`, `model`, and `commandExecutionPolicy`) specified in `.agents/skills/subagent-management/SKILL.md`.