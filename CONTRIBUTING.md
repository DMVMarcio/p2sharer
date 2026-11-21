# Contributing to P2Sharer

Thank you for your interest in contributing to P2Sharer.

## Getting Started

P2Sharer is a Windows desktop application built with **Tauri v2** and **Rust**, paired with a **React / TypeScript / Vite** frontend and an optional web/signaling workspace under `apps/`.

### Prerequisites

- **Node.js 22.14+** and **pnpm 10.30.1** (`corepack enable && corepack install`)
- **Rust toolchain** and **Microsoft Visual Studio C++ Build Tools**
- **CMake** and **NASM** (for native media dependencies)

Install workspace dependencies with:

```powershell
pnpm install --frozen-lockfile
```

## Development Workflow

- Run the desktop app in development mode:
  ```powershell
  pnpm run tauri:dev
  ```
- Run the web workspace locally (see [web workspace instructions](docs/web.md)):
  ```powershell
  pnpm run web:dev
  ```

## Validation & Quality Checks

Run the checks relevant to the areas you changed before opening a pull request:

- **Frontend tests:** `pnpm test`
- **Frontend typecheck and production bundle:** `pnpm run build`
- **Web workspace build and server tests:** `pnpm run web:build` and `pnpm run test:web`
- **Native Rust tests (Windows):** `pnpm run test:native --release`
- **Full desktop build & installers:** `pnpm run tauri:build`
- **Repository hygiene:** `pnpm run check:repository --staged` and `git diff --cached --check`

### Important Conventions

- **Localization:** Any user-facing copy must be translated across all 13 supported locale catalogs in `src/i18n/locales/`.
- **Commits:** Use [Conventional Commits](https://www.conventionalcommits.org/) in English.
- **Privacy & Security:** Never commit runtime logs, private room codes, personal credentials, local paths, or unredacted network captures.
- **Documentation & Licensing:** All contributions are licensed under the [MIT License](LICENSE).

## Reporting Bugs & Suggesting Features

- For bugs or feature requests, open an issue using the repository's [issue templates](.github/ISSUE_TEMPLATE).
- For security vulnerabilities, please follow our [Security Policy](SECURITY.md) instead of opening a public issue.
