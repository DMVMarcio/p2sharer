# Workspace Technical Knowledge Base: P2Sharer

This file indexes current architecture and explicit standing user rules. It is not a transcript, feature specification, backlog, or changelog. Subsystem references describe implementation; they do not establish user mandates. Apply the memory policy in [agent-persistence.md](rules/agent-persistence.md) before adding anything.

## 1. Project Overview & Architecture
P2Sharer is a serverless, peer-to-peer screen and application audio sharing desktop application built on Tauri v2. It provides high-performance desktop/window streaming with hardware acceleration, native Windows WASAPI loopback audio capture with process-level filtering, and a resilient decentralized WebRTC mesh network with zero central media servers.

- **Ecosystem & Stack**:
  - **Host Framework**: Tauri v2 (`@tauri-apps/api: ^2`, `@tauri-apps/cli: ^2`, `tauri-plugin-opener: ^2`)
  - **Backend**: Rust 2021 edition (`src-tauri/`), Windows Win32 / Core Audio APIs (`windows: 0.58`), `xcap: 0.9.8`, `tokio: 1`, `tokio-tungstenite: 0.24`, `rayon: 1.10`, `sysinfo: 0.32`, `image: 0.25`
  - **Frontend**: React 19, TypeScript 5.6, Vite 6 (`src/`), Web Audio API, Lucide icons (`lucide: ^1.31.0`, `lucide-react`), Pako compression (`pako: ^3.0.1`)
  - **Networking & P2P**: Trystero (`@trystero-p2p/mqtt`, `@trystero-p2p/nostr`, `@trystero-p2p/torrent`, `trystero: ^0.25.3`), WebRTC mesh with multi-transport signaling failover
- **Primary Design Pattern**:
  - Event-driven, decoupled modular architecture.
  - Rust side: Asynchronous Tokio runtime, event-driven audio loopback, thread-safe broadcast channels for video streaming.
  - Frontend side: React 19 component tree (`components/`), specialized custom hooks (`hooks/`), central reactive state store (`core/state_store.ts` with `useStore`), and service coordinator (`services/room_service.ts`).
- **Core Entrypoints**:
  - Frontend: `src/main.tsx`, `src/App.tsx`
  - Backend Rust: `src-tauri/src/main.rs`, `src-tauri/src/lib.rs`
  - Shell / UI: `index.html`, `src/style.css`

---

## 2. Technical Sectors & Active Subagents
| Sector / Domain | Subagent (`.agents/subagents/`) | Dedicated Skill (`.agents/skills/`) | Scope / Target Files |
| :--- | :--- | :--- | :--- |
| **Workspace Orchestration** | `project-orchestrator.md` | `project-audit/SKILL.md`, `subagent-management/SKILL.md` | Whole repository, task triage & cross-domain coordination |
| **P2P Netcode & Signaling** | `p2p-specialist.md` | `p2p-protocol/SKILL.md` | `src/p2p/*` (SignalingManager, GroupRoomManager, MediaCoordinator, PeerTracker, IceConfig) |
| **Native Media Pipeline** | `native-media-specialist.md` | `native-media-pipeline/SKILL.md` | `src-tauri/src/*`, `src/audio/*`, `src/video/*` (WASAPI, xcap, WS bridge, resampler, process manager) |
| **UI, State & Components** | `ui-architect.md` | `canonical-design/SKILL.md` | `src/components/*`, `src/hooks/*`, `src/ui/*`, `src/core/*`, `index.html`, `src/style.css` (React views, hooks, StateStore) |

---

## 3. Subsystem Architectural Deep Dives
- [Release Versioning, Signing and GitHub Distribution](../docs/releases.md)
- [Public Repository Safety and Historical Audits](knowledge/repository-publication.md)
- [P2P Networking, Signaling Failover & WebRTC Mesh](knowledge/p2p-architecture.md)
- [LAN and Virtual LAN WebRTC Mesh](knowledge/lan-mesh.md)
- [Native Media Pipeline: Audio Loopback, Video Capture & Web Bridges](knowledge/native-media-pipeline.md)
- [Native NVENC Encoding, Settings, Validation and Transport Limits](knowledge/native-nvenc.md)
- [Opt-in Sender/Receiver Media Diagnostics](../docs/media-diagnostics.md)
- [Frontend Architecture, React Media Rendering & State Management](knowledge/frontend-ui-state.md)
- [Multiple Screen/Camera Sessions and Viewer Compositions](knowledge/multiple-media-streams.md)
- [P2P Message Authorization and Threat Model](knowledge/peer-security.md)
- [Room Apps: Modular Instances and Synchronized State](knowledge/room-apps.md)
- [Consent-Based Chat File Transfer](knowledge/chat-file-transfer.md)
- [English and Brazilian Portuguese Localization](knowledge/localization.md)

---

## 4. Explicit Standing User Rules

Record only instructions explicitly intended to govern future work. Do not infer rules from individual feature requests, bug fixes, wording, or layout changes. For example, "every button must be circular" is a standing rule; "move this button" and "add a chat sound" are task requests. The circular-button example does not itself establish a design rule for this project.

- `[Memory]` Keep knowledge limited to explicit standing rules and useful verified architecture. Do not record every request, inferred preference, task approval, completed-work report, or incidental UI detail.
- `[Package Manager]` Use pinned pnpm for dependencies, scripts, local tools, and Tauri hooks; keep the tracked lockfile and tool instructions consistent.
- `[Desktop Builds]` Use the default `src-tauri/target/` directory. If the application locks the executable, ask the user to close it and wait for confirmation. Never terminate it automatically or bypass the lock with another target directory.
- `[Git]` Commit completed task changes after required validation, using English Conventional Commits. Preserve unrelated edits and report the commit hash and remaining changes. Push only when authorized.
- `[Canonical UI]` Reuse shared components, CSS recipes, and design tokens across application surfaces. The standard covers all control families. Selection fields use the canonical `Select`, and contextual actions and tooltips use the application implementations.
- `[Text Input History]` Disable Chromium/WebView2 input-history suggestions with `autoComplete="off"` on application inputs and forms.
- `[Frontend Maintenance]` Prefer React state, events, and refs over independent DOM renderers; retain native DOM APIs at actual media, editor, geometry, and accessibility boundaries.
- `[External Repositories]` Repositories inspected as references remain read-only unless their modification is explicitly authorized.
- `[Test Maintenance]` Keep tests that exercise production behavior or meaningful invariants. Do not create a test for every request or freeze incidental appearance through source matching. Automatic checks must not depend on personal paths or physical devices; hardware diagnostics are explicit opt-in checks.

## 5. Build, Test & Run Commands

Use pnpm 10.30.1 and Node.js 22.14+ as pinned in `package.json`. Install with `pnpm install --frozen-lockfile`. Pass script arguments directly after the script name.

| Command | Purpose |
| --- | --- |
| `pnpm run dev` | Vite frontend aid on port 1420 |
| `pnpm run tauri:dev` | Interactive Windows desktop runtime |
| `pnpm run build` | TypeScript and Vite only |
| `pnpm run test` | Frontend behavior and invariant regressions |
| `pnpm run test:native --release` | Windows library and integration regressions; hardware checks opt-in |
| `pnpm run tauri:build` | Production desktop executable and installer bundles |
| `pnpm run check:repository` | Repository hygiene before staging |

For application code or assets, finish with the Tauri packaging build and inspect `src-tauri/target/release/p2sharer.exe` and `src-tauri/target/release/bundle/`. Documentation and test-only maintenance do not change the product binary.

Native integration tests rebuild the application binary with `tauri/custom-protocol`; run the frontend build first so a clean checkout has embedded `dist` assets, then run native tests before final packaging. `tools/tauri.mjs` and the native test runner share CMake discovery. Native JPEG compilation requires MSVC, CMake, and NASM; the recipients of a packaged application do not need them. See [test instructions](../test/README.md) and [release instructions](../docs/releases.md).
