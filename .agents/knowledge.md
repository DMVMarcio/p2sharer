# Workspace Technical Knowledge Base: P2Sharer

This file indexes current architecture and explicit standing user rules. It is not a transcript, feature specification, backlog, or changelog. Subsystem references describe implementation; they do not establish user mandates. Apply the memory policy in [agent-persistence.md](rules/agent-persistence.md) before adding anything.

## 1. Project Overview & Architecture
P2Sharer is a Windows desktop space for connecting, creating and exploring together through peer-to-peer connections. Its purpose is to make the most of P2P across an expanding range of shared experiences and tools. See the [product overview](../docs/product-overview.md) for canonical positioning, current capabilities, implementation references and the distinction between available features and future plans.

The Tauri v2 host combines native Windows integration with a React interface and a decentralized WebRTC mesh for shared media and app state. Public services support Internet peer discovery and external content; P2P does not mean that every feature works without external services.

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
- [Product Purpose, Current Capabilities and Implementation References](../docs/product-overview.md)
- [Web Workspace, Browser Runtime and HTTP Backend](../docs/web.md)
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
- [Shared Browser: Host-Owned WebViews, Input and Media](knowledge/shared-browser.md)
- [Native TCP/UDP Port Tunnels](knowledge/port-tunnels.md)
- [Virtual IPv4 Network and Privileged Adapter Lifecycle](knowledge/virtual-network.md)
- [Consent-Based Chat File Transfer](knowledge/chat-file-transfer.md)
- [Profile Images, Native Processing and Hash-Based Transfer Consent](knowledge/profile-images.md)
- [Application and Installer Localization](knowledge/localization.md)

---

## 4. Explicit Standing User Rules

Record only instructions explicitly intended to govern future work. Do not infer rules from individual feature requests, bug fixes, wording, or layout changes. For example, "every button must be circular" is a standing rule; "move this button" and "add a chat sound" are task requests. The circular-button example does not itself establish a design rule for this project.

- `[Memory]` Keep knowledge limited to explicit standing rules and useful verified architecture. Do not record every request, inferred preference, task approval, completed-work report, or incidental UI detail.
- `[Package Manager]` Use pinned pnpm for dependencies, scripts, local tools, and Tauri hooks; keep the tracked lockfile and tool instructions consistent.
- `[Desktop Builds]` Use the default `src-tauri/target/` directory. Identify running processes by executable path. An installed copy outside the workspace does not block builds; ask for closure only when a workspace build/test process or confirmed output lock blocks the build. Wait for confirmation; never terminate it or use another target directory.
- `[Interactive Verification]` The user performs interactive application checks on their computer. Do not launch or automate the app for verification unless explicitly requested; select automated checks by the central validation matrix.
- `[Release Notes]` Update upcoming release notes in the same task for every meaningful user-visible change. Focus strictly on practical benefits and resolved problems for the end user; group related work into unified entries, omit repetitive points, incidental UI walkthroughs (e.g. click paths or layout minutiae), trivial adjustments, and technical maintenance. Translate entries into all 13 supported languages; preserve published notes and do not bump versions automatically for each task.
- `[Git]` Commit completed task changes after required validation, using English Conventional Commits. Preserve unrelated edits and report the commit hash and remaining changes. Push only when authorized.
- `[Canonical UI]` Reuse shared components, CSS recipes, and design tokens across application surfaces. The standard covers all control families. Selection fields use the canonical `Select`, and contextual actions and tooltips use the application implementations.
- `[Room App Terminology]` Refer to room apps as "apps", not "activities", in user-facing copy.
- `[Localization]` Translate every new or modified user-facing string into all 13 supported app languages, including accessibility labels and native dialog text. Update installer translations where supported. Preserve interpolation and correct plurals; English fallback does not count as a translation. Distribute one multilingual NSIS EXE and one English MSI; the app detects its language independently. Do not generate separate installers per language.
- `[Visual Direction]` Preserve the current comfortable, distinctive interface in future UI work: theme-derived surfaces, subtle depth and restrained borders, readable layer separation, balanced spacing, and short complete transitions. Extend the existing design rather than introducing generic Material-style replacements; preserve keyboard focus and accessibility.
- `[Text Input History]` Disable Chromium/WebView2 input-history suggestions with `autoComplete="off"` on application inputs and forms.
- `[Frontend Maintenance]` Prefer React state, events, and refs over independent DOM renderers; retain native DOM APIs at actual media, editor, geometry, and accessibility boundaries.
- `[External Repositories]` Repositories inspected as references remain read-only unless their modification is explicitly authorized.
- `[Validation Scope]` Match checks to actual impact: documentation/agent edits need review only; every application change, including CSS and copy, must generate the final executable and installers with `pnpm run tauri:build`. Presentation-only changes need no behavior tests; behavior changes need relevant regressions; native tests apply only to affected native behavior/contracts. Avoid unrelated suites and repeat checks only after relevant changes, failures or new evidence.
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
| `pnpm run check:repository --staged` | Proposed commit hygiene |
| `pnpm run check:repository` | Full tracked-tree hygiene for audits |

Choose checks with the [central validation matrix](rules/agent-persistence.md#2-desktop-runtime--build-validation). Every application change requires final `pnpm run tauri:build`, including frontend presentation changes; those changes need no Rust regressions. Inspect `src-tauri/target/release/p2sharer.exe` and `src-tauri/target/release/bundle/`. Stop after applicable checks pass.

When selected for the task, native integration tests rebuild the application binary with `tauri/custom-protocol`; run the frontend build first so a clean checkout has embedded `dist` assets, then run native tests before final packaging. `tools/tauri.mjs` and the native test runner share CMake discovery. Native JPEG compilation requires MSVC, CMake, and NASM; the recipients of a packaged application do not need them. See [test instructions](../test/README.md) and [release instructions](../docs/releases.md).
