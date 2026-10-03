# P2Sharer

P2Sharer is a Windows desktop app for sharing screens, application audio and cameras with other people in a room. Watch multiple streams, exchange messages and files, take notes together, and watch YouTube with synchronized playback.

**[Latest release](https://github.com/DMVMarcio/p2sharer/releases/latest)** · [All releases](https://github.com/DMVMarcio/p2sharer/releases)

Windows installers will be available on GitHub Releases as versions are published. Choose the `.exe` setup or `.msi` installer from the release's **Assets** section; the source-code archives are for development.

## What you can do

- Share a screen or individual window with audio, and add cameras as independent streams.
- Choose which streams to watch, switch between grid and spotlight views, and keep video visible in picture-in-picture windows.
- Control participant audio independently and select which applications contribute to shared audio.
- Chat, share images and transfer files with recipient consent.
- Use a collaborative notepad and synchronized YouTube queues, including saved playlists and player picture-in-picture.
- Point and draw on shared streams to explain something together.

Rooms use WebRTC connections between participants, with public services for discovering and connecting peers. Streaming quality depends on each participant's connection, hardware and capture settings.

## Get started

1. Install a published Windows release and open P2Sharer.
2. Choose a display name, create a room and share its invitation, or join with an invitation you received. Enter the room password if required.
3. Select a screen, window or camera to share. Choose other participants' streams to watch and open room apps when you want to collaborate.

## Development

P2Sharer uses Tauri v2 and Rust for the Windows host, with React, TypeScript and Vite for the interface. Development requires:

- Node.js 22.14 or newer and pnpm 10.30.1, pinned in `package.json`.
- Rust and Microsoft Visual Studio C++ build tools.
- CMake and NASM for native media dependencies. The launcher discovers standalone or Visual Studio-bundled CMake when it is not on PATH.

With Corepack available, run `corepack enable` and `corepack install` from the checkout. Then install dependencies and start the desktop app:

```powershell
pnpm install --frozen-lockfile
pnpm run tauri:dev
```

### Build and test

| Command | Purpose |
| --- | --- |
| `pnpm run tauri:dev` | Run the desktop application in development mode. |
| `pnpm run dev` | Run the Vite frontend development server. |
| `pnpm run build` | Check TypeScript and build the frontend. |
| `pnpm run tauri:build` | Build the production desktop executable and Windows installers. |
| `pnpm test` | Run frontend regression tests. |
| `pnpm run test:native --release` | Run native library and integration tests on Windows. |

The application runs inside Tauri/WebView2; a browser preview checks only the frontend. Native capture and desktop integration require the desktop runtime. See [test instructions](test/README.md) for manual hardware checks and benchmark scope.

Production output is written to `src-tauri/target/release/p2sharer.exe`, with installers under `src-tauri/target/release/bundle/`. Close the application before rebuilding and use the default Cargo target directory.

### Dependencies

Use `pnpm add <package>`, `pnpm add -D <package>` and `pnpm exec <tool>`. Commit `pnpm-lock.yaml` after dependency changes. Pass script options directly, for example `pnpm run tauri:dev --release --no-watch`.

Keep the Trystero dependency patches and installation-script permissions in `pnpm-workspace.yaml` aligned with dependency updates. Use `pnpm patch` and `pnpm patch-commit` when updating patches, and commit the patch, workspace configuration and lockfile together.

> **Development note:** P2Sharer is built entirely with AI, with careful human orchestration, review, analysis and manual testing throughout development.
