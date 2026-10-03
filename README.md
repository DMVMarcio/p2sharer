# P2Sharer

P2Sharer is a Windows desktop application built with Tauri v2, Rust, React, TypeScript, and Vite.

## Prerequisites

- Node.js 22.14 or newer and pnpm 10.30.1 (pinned in package.json). With Corepack available, run `corepack enable` and `corepack install` from this directory.
- Rust, Microsoft Visual Studio C++ build tools, CMake, and NASM for native builds. The Tauri launcher discovers standalone or Visual Studio-bundled CMake when necessary.

## Install and run

Install the locked dependencies with `pnpm install --frozen-lockfile`. Start the desktop application with `pnpm run tauri:dev`.

- `pnpm run dev`: Vite frontend development server on port 1420.
- `pnpm run build`: TypeScript and Vite frontend validation.
- `pnpm run tauri:build`: full frontend and native production build, including Windows installers.
- `pnpm test`: frontend unit tests.
- `pnpm run test:native --release`: portable native library and integration checks on Windows.

See [test maintenance and manual hardware checks](test/README.md) for scope and explicit opt-in commands.

The product runs inside Tauri/WebView2. A browser preview does not validate native application behavior. Production artifacts are written to `src-tauri/target/release/p2sharer.exe` and `src-tauri/target/release/bundle/`. Always use the default target directory.

## Dependency maintenance

Use `pnpm add <package>`, `pnpm add -D <package>`, and `pnpm exec <tool>`. Commit `pnpm-lock.yaml` after dependency changes. Pass script arguments directly after the script name (for example, `pnpm run tauri:dev --release --no-watch`); do not insert the extra argument separator used by the previous package manager. CI and clean installations should use `pnpm install --frozen-lockfile`.

The Trystero core patch is applied by pnpm through `patchedDependencies` in `pnpm-workspace.yaml`; esbuild is explicitly permitted to run its installation script. Update patches with `pnpm patch @trystero-p2p/core@0.25.3` and `pnpm patch-commit <directory>`, then commit the patch, configuration, and lockfile together. MQTT is explicitly declared for application imports; esbuild and Trystero core are explicit development dependencies for tests. Do not rely on incidental dependency hoisting.

## Repository safety

Run `pnpm run check:repository` before staging and `pnpm run check:repository --staged` before committing. Review the complete staged diff and use Gitleaks with full redaction for secret scanning. The built-in hygiene check covers selected patterns; it does not replace a dedicated scanner or manual review.

Keep private environment files, diagnostic logs, personal machine reports, credentials, signing keys, and generated build output outside Git. Environment examples contain placeholders only. Preserve required application assets, third-party licenses, dependency patches, and lockfiles. Use GitHub `noreply` author addresses. Removing a file from the current tree does not remove it from older commits.

## Recommended IDE setup

[VS Code](https://code.visualstudio.com/) with [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) and [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer).
