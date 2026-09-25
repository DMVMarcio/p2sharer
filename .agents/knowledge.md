# Workspace Technical Knowledge Base: P2Sharer

## 1. Project Overview & Architecture
P2Sharer is a serverless, peer-to-peer screen and application audio sharing desktop application built on Tauri v2. It provides high-performance desktop/window streaming with hardware acceleration, native Windows WASAPI loopback audio capture with process-level filtering, and a resilient decentralized WebRTC mesh network with zero central media servers.

- **Ecosystem & Stack**:
  - **Host Framework**: Tauri v2 (`@tauri-apps/api: ^2`, `@tauri-apps/cli: ^2`, `tauri-plugin-opener: ^2`)
  - **Backend**: Rust 2021 edition (`src-tauri/`), Windows Win32 / Core Audio APIs (`windows: 0.58`), `xcap: 0.9.8`, `tokio: 1`, `tokio-tungstenite: 0.24`, `rayon: 1.10`, `sysinfo: 0.32`, `image: 0.25`
  - **Frontend**: React 18, TypeScript 5.6, Vite 6 (`src/`), Web Audio API, Lucide icons (`lucide: ^1.31.0`, `lucide-react`), Pako compression (`pako: ^3.0.1`)
  - **Networking & P2P**: Trystero (`@trystero-p2p/mqtt`, `@trystero-p2p/nostr`, `@trystero-p2p/torrent`, `trystero: ^0.25.3`), WebRTC mesh with multi-transport signaling failover
- **Primary Design Pattern**:
  - Event-driven, decoupled modular architecture.
  - Rust side: Asynchronous Tokio runtime, event-driven audio loopback, thread-safe broadcast channels for video streaming.
  - Frontend side: React 18 component tree (`components/`), specialized custom hooks (`hooks/`), central reactive state store (`core/state_store.ts` with `useStore`), and service coordinator (`services/room_service.ts`).
- **Core Entrypoints**:
  - Frontend: `src/main.tsx`, `src/App.tsx`
  - Backend Rust: `src-tauri/src/main.rs`, `src-tauri/src/lib.rs`
  - Shell / UI: `index.html`, `src/style.css`

---

## 2. Technical Sectors & Active Subagents
| Sector / Domain | Subagent (`.agents/subagents/`) | Dedicated Skill (`.agents/skills/`) | Scope / Target Files |
| :--- | :--- | :--- | :--- |
| **Workspace Orchestration** | `project-orchestrator.md` | `task-lifecycle/SKILL.md` | Whole repository, task triage & cross-domain coordination |
| **P2P Netcode & Signaling** | `p2p-specialist.md` | `p2p-protocol/SKILL.md` | `src/p2p/*` (SignalingManager, GroupRoomManager, MediaCoordinator, PeerTracker, IceConfig) |
| **Native Media Pipeline** | `native-media-specialist.md` | `native-media-pipeline/SKILL.md` | `src-tauri/src/*`, `src/audio/*`, `src/video/*` (WASAPI, xcap, WS bridge, resampler, process manager) |
| **UI, State & Components** | `ui-architect.md` | `canonical-design/SKILL.md` | `src/ui/*`, `src/core/*`, `index.html`, `src/style.css` (ModalController, HudController, ViewerRenderer, StateStore) |

---

## 3. Subsystem Architectural Deep Dives
- [P2P Networking, Signaling Failover & WebRTC Mesh](.agents/knowledge/p2p-architecture.md)
- [Native Media Pipeline: Audio Loopback, Video Capture & Web Bridges](.agents/knowledge/native-media-pipeline.md)
- [Frontend Architecture, Keyed DOM Reconciliation & State Management](.agents/knowledge/frontend-ui-state.md)

---

## 4. User Guidelines & Expressed Preferences
<!-- Tagged directives captured directly or indirectly from workspace rules and user instructions -->
- `[Protocol]` **Dual-Channel Language Protocol**: All interactive conversational chat must mirror the user's language (e.g. Portuguese). All code, commits, pull requests, task files, documentation, and `.agents/` artifacts must be written strictly in English.
- `[Task Lifecycle]` **Mandatory Gatekeeper**: Always create `.agents/tasks/<slug>/task.md` before writing code or running mutations. Maintain real-time checkboxes and atomic commits.
- `[Git]` **Conventional Commits**: Format commit messages strictly as `type(scope): subject` in English (`feat`, `fix`, `refactor`, `chore`, `docs`, `test`).
- `[UI]` **Canonical Reuse**: Search `src/ui/` and `src/style.css` before authoring new elements. Never create ad-hoc inline styles or unmodular UI components. Maintain dark/light theme tokens and accent colors.
- `[Video]` **Hardware Acceleration**: Preserve WebView2 GPU acceleration flags in `src-tauri/src/lib.rs` and SDP codec priority (H.264/AV1/VP9/VP8) in `MediaCoordinator`.
- `[Audio]` **Process Isolation & Sync**: Keep WASAPI loopback event-driven (<20us latency). Ensure ITU-R BS.775 downmixing and fractional 48kHz resampling phase continuity across streaming chunks.
- `[P2P]` **Ghost Peer Mitigation & Mesh Bridging**: Enforce strict direct WebRTC verification; quarantine BitTorrent PEX gossip rumors while actively bridging indirect peers via in-mesh data channels to form resilient full-mesh topologies.
- `[P2P]` **Signaling Synchronization**: Prevent premature client-side transport failovers; monitor MQTT brokers with active probe WebSockets and enforce a 6s startup grace period.
- `[Build]` **Full Desktop Packaging**: Always build and verify the full native desktop artifact using `npm run tauri:build`. While `npm run build` only bundles the web frontend (`dist/`), `npm run tauri:build` encapsulates it via `beforeBuildCommand` and compiles the complete release binary and Windows bundle.

---

## 5. Build, Test & Run Commands
- **Development Server**: `npm run dev` (Vite on port 1420)
- **Tauri App Dev**: `npm run tauri:dev` (runs `npm run dev` and starts Tauri window)
- **Frontend Typecheck & Build (Web Only)**: `npm run build` (`tsc && vite build`)
- **Full Production Desktop Build (Frontend + Rust Native Bundle)**: `npm run tauri:build` (invokes `beforeBuildCommand: "npm run build"`, compiles Rust in release mode, and outputs `p2sharer.exe` and bundles to `src-tauri/target/release/bundle/`)
- **Frontend Unit & Adversarial Tests**: `node --experimental-strip-types --test test/unit/*.test.ts` (137+ tests across 11 suites)
- **Backend Rust Tests**: `cargo test` inside `src-tauri/` (38+ tests)
- **Cargo Compilation Check**: `cargo check` inside `src-tauri/`