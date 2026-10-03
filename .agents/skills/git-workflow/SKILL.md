---
name: git-workflow
description: Governs repository initialization, stack-specific .gitignore creation, staging, and Conventional Commit execution. Use this skill when initializing Git, managing ignore files, or committing code changes.
---

# Skill: Git Workflow & Repository Management

## Scope
Governs repository initialization, `.gitignore` generation per technology stack, and atomic commit conventions.

## 1. Stack-Specific `.gitignore` Generation
Before running `git add` or committing, ensure `.gitignore` exists and covers the project category:

- **Web / Node.js / TypeScript**:
  `node_modules/`, `dist/`, `build/`, `.next/`, `coverage/`, `.env`, `.env.*.local`, `*.log`
- **Desktop & Native Systems (C++, C#, Rust, Go, Java/Kotlin)**:
  `bin/`, `obj/`, `target/`, `build/`, `cmake-build-*/`, `*.user`, `*.suo`, `.vs/`, crash dumps, local executables.
- **Mobile (Flutter, React Native, Android, iOS)**:
  `.gradle/`, `build/`, `Pods/`, `DerivedData/`, `*.apk`, `*.aab`, `*.ipa`, `*.keystore`, `.flutter-plugins`
- **CLI & Python/Backend**:
  `.venv/`, `env/`, `__pycache__/`, `*.pyc`, `*.sqlite3`, `.pytest_cache/`, secrets.
- **Game Mods & Host Software Plugins**:
  Base host/game binaries, third-party stock assets, engine dumps, savegames. Track **strictly** the plugin/mod source code, manifests, and custom assets.

## P2Sharer Package Manager
- Use the pnpm version pinned in `package.json`; validate installations with `pnpm install --frozen-lockfile`.
- Track `pnpm-lock.yaml`, `pnpm-workspace.yaml`, and native dependency patches. Do not add lockfiles from other package managers. Ignore `.pnpm-store/` if a project-local store is used.
- Validate application changes with `pnpm run tauri:build` before committing; `pnpm run build` covers only the frontend.

## 2. Commit Standards

### Public repository review
- Apply `.agents/rules/agent-persistence.md` repository safety checks before every commit.
- Include network identifiers in staged and historical audits: IPv4/IPv6 literals, private DNS names, URL user information, and server logs. Do not disclose real infrastructure addresses in reports or public agent memory. Keep required loopback bindings and public services after review; use reserved documentation addresses for examples.
- Use `pnpm run check:repository` and `pnpm run check:repository --staged`; inspect `git diff --cached` and run `git diff --cached --check`.
- Run `gitleaks git . --pre-commit --staged --redact=100 --no-banner` for staged secret detection. For a full historical review use `gitleaks git . --log-opts "--all --full-history" --redact=100 --no-banner`, together with an inventory of every commit tree and blob size. Keep reports outside the repository and do not print secret values.
- Do not stage ignored files with `git add -f`, commit personal reports, or bundle installers into Git. Review binary assets and licenses explicitly. Environment templates must contain placeholders only. Preserve pnpm/Cargo lockfiles, dependency patches, required application assets, and source licenses.
- Publication and history rewrites require a reviewed plan, a recoverable backup, validated branch tips, and explicit approval before replacing remote history. Include author/committer email privacy and GitHub-only metadata in the review.
- **Language**: Strictly English.
- **Convention**: Conventional Commits format (`type(scope): subject`).
  - `feat`: New feature or user-facing capability.
  - `fix`: Bug fix or error resolution.
  - `refactor`: Code reorganization without functional change.
  - `chore`: Tooling, configuration, dependencies, `.gitignore` updates.
  - `docs`: Documentation updates.
- **Cadence**: Commit atomically after completing logical units of work; do not accumulate untracked changes at the end of a session.
