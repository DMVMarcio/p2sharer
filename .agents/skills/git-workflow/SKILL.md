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

## 2. Commit Standards
- **Language**: Strictly English.
- **Convention**: Conventional Commits format (`type(scope): subject`).
  - `feat`: New feature or user-facing capability.
  - `fix`: Bug fix or error resolution.
  - `refactor`: Code reorganization without functional change.
  - `chore`: Tooling, configuration, dependencies, `.gitignore` updates.
  - `docs`: Documentation updates.
- **Cadence**: Commit atomically after completing logical units of work; do not accumulate untracked changes at the end of a session.