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
- `[Video]` **Windows Graphics Capture (WGC) & Zero-Copy 60 FPS Pipeline**: Screen and window sharing uses the native Windows Graphics Capture API via `windows-capture` to capture Direct3D11 frames directly from the DWM compositor in <0.5ms with hardware cursor compositing and borderless capture. To prevent WebRTC starvation when the screen is static, a zero-drift 60 FPS heartbeat pacer thread with `MultimediaTimerGuard` continuously emits cached frames, sustaining a solid 60.0 FPS clock. Resizing uses SIMD `fast_image_resize` with `FilterType::Bilinear` convolution for ultra-fast SIMD downsampling (<0.8ms vs 15ms Catmull-Rom), preventing gaming CPU bottlenecks. The software arrival gate permits frame intervals up to 2x target FPS (`1_000_000_000 / (fps * 2)`), ensuring natural DWM VSync +/- 1.5ms jitter never triggers false-positive frame drops. JPEG encoding uses 4:4:4 full chroma sampling with AVX2 SIMD at quality 85 (`SamplingFactor::R_4_4_4`), preserving 100% color resolution without chroma downsampling or macroblocking. This prevents generation loss when the H.264 hardware encoder compresses fast camera motion in games. WebRTC video tracks enforce `contentHint = 'detail'` and `degradationPreference = 'maintain-resolution'` to strictly prohibit the browser from dropping spatial resolution or applying lowpass blur filters during camera movement. Decoding in Chromium uses `createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none', resizeQuality: 'pixelated' })`. WebCodecs `MediaStreamTrackGenerator` and `VideoFrame` feed frames directly into WebRTC transceivers, with WebView2 flags enabling hardware video/MJPEG decoding and disabling background timer throttling (`--disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows`). Fallback canvases are attached to the DOM to prevent Chromium power-saving frame rate throttles. All transmission is in-app without Chromium browser dialogs or technical jargon ("GPU Direta").
- `[Video]` **Zero-Overhead Transmission & Mirror Loop Prevention**: To keep CPU usage under 2-3% during 1080p 60fps transmissions, the native Rust capture pacer loop de-conflicts with WGC by checking `pacer_wgc_last_sent_us`. When WGC is actively delivering frames (e.g. during gaming or video playback), the pacer detects active motion (< 22.5ms threshold) and stays dormant, preventing 120 FPS frame bursts and WebRTC queue congestion. During static screen periods, it emits 1-byte heartbeat ticks (`Message::Binary(vec![0])`) at 60 FPS, sending a full keyframe once per second (~60 ticks). The frontend `NativeVideoBridge` intercepts 1-byte ticks and bypasses `Blob` allocation and `createImageBitmap` CPU decoding, reusing the GPU-cached `ImageBitmap` to construct `new VideoFrame(this.latestBitmap)`. Furthermore, `VideoCard.tsx` renders a lightweight Discord-style transmission card (`.local-broadcaster-placeholder`) for the local broadcaster instead of mounting an unthrottled local `<video>` mirror element. This eliminates the recursive hall-of-mirrors feedback loop where the local video playback constantly invalidated screen pixels, triggered false WGC motion capture, and pegged WebView2 CPU at ~23%. Users can toggle live preview on demand with "Ver Prévia" / "Ocultar Prévia". In `style.css`, `.local-broadcaster-radar-pulse` uses GPU-composited `transform` and `opacity` animations instead of continuous `box-shadow` repaints to ensure zero CPU compositor overhead.
- `[Audio]` **Process Isolation & Sync**: Keep WASAPI loopback event-driven (<20us latency). Ensure ITU-R BS.775 downmixing and fractional 48kHz resampling phase continuity across streaming chunks.
- `[P2P]` **Ghost Peer Mitigation & Mesh Bridging**: Enforce strict direct WebRTC verification; quarantine BitTorrent PEX gossip rumors while actively bridging indirect peers via in-mesh data channels to form resilient full-mesh topologies.
- `[P2P]` **Signaling Synchronization**: Prevent premature client-side transport failovers; monitor MQTT brokers with active probe WebSockets and enforce a 6s startup grace period.
- `[P2P]` **Idempotent Watch Actions**: Stream watching actions (`watchStream`, `stopWatchingStream`, `watch_status`) must be strictly idempotent to prevent audio chirping loops (`playWatchStreamStart`) and redundant signaling bursts.
- `[UI]` **React HUD Exclusivity**: All stream card overlays, stats HUDs (FPS, resolution, bitrate, ping), and tooltips must be rendered declaratively within React components (e.g. `VideoCard.tsx`). Legacy controllers like `HudController` must never query or mutate `.stream-card` DOM elements directly.
- `[UI]` **Stream Zoom & Precision Slider**: Stream viewer cards support focal-point wheel/pinch zoom (1.0x to 5.0x) with hardware-accelerated `translate3d` and GPU scaling. Mouse dragging pans the zoomed stream with boundary clamping. When zoom exceeds 1.0x, a precision control bar (`ZoomControlBar.tsx`) appears in the bottom-right corner with range slider, step buttons, percentage readout, and quick reset. Double-clicking on the zoomed video resets zoom to 1.0x.
- `[UI]` **Spotlight Tray & Stream Filters**: In spotlight mode, the bottom tray renders all participants in stable order (including the currently featured stream) to prevent layout jumping; the currently featured card is highlighted with `selected-featured` (2px accent border and glowing status dot badge without redundant text). Cards in the tray are simplified to eliminate HUD clutter (no stats bubbles, no volume slider, no status text, keeping only preview/avatar, username, and compact stop-watching button). Global stream filters (`all`, `streaming`, `watching`) can be toggled via header pills with real-time participant counts positioned on the left side of `StreamHeaderBar`.
- `[UI]` **Stream Fullscreen & Header Optimization**: Global app fullscreen and chat toggle buttons are removed from `StreamHeaderBar`, creating a cleaner header with transmission button labeled "Transmitir" ("Parar Transmissão" when active). Fullscreen is moved directly to individual video cards (`.btn-stream-fullscreen` in `VideoCard.tsx`), positioned directly to the right of the volume control. Clicking maximizes only that specific stream card via the Fullscreen API.
- `[UI]` **Lateral Hoverable Sidebar Toggle Arrow**: Sidebar collapse/expand functionality is accessed via a lateral toggle arrow (`.sidebar-toggle-edge` in `RoomView.tsx`) positioned along the dividing vertical edge between the stream area and sidebar. It remains completely invisible (`opacity: 0`) until the user hovers near the vertical edge, where it smoothly fades into view with a directional chevron (left to open when collapsed, right to collapse when open).
- `[Build]` **Mandatory Full Desktop Packaging**: ALWAYS build and verify the full native desktop artifact using `npm run tauri:build`. Never stop at `npm run build`. `npm run tauri:build` encapsulates the frontend bundling via `beforeBuildCommand`, compiles the native Rust release binary, and builds the Windows desktop installer/bundle. Any code change must pass `npm run tauri:build`.

---

## 5. Build, Test & Run Commands
- **Development Server**: `npm run dev` (Vite on port 1420)
- **Tauri App Dev**: `npm run tauri:dev` (runs `npm run dev` and starts Tauri window)
- **Frontend Typecheck & Build (Web Only)**: `npm run build` (`tsc && vite build`)
- **Full Production Desktop Build (Frontend + Rust Native Bundle)**: `npm run tauri:build` (invokes `beforeBuildCommand: "npm run build"`, compiles Rust in release mode, and outputs `p2sharer.exe` and bundles to `src-tauri/target/release/bundle/`)
- **Frontend Unit & Adversarial Tests**: `node --experimental-strip-types --test test/unit/*.test.ts` (137+ tests across 11 suites)
- **Backend Rust Tests**: `cargo test` inside `src-tauri/` (38+ tests)
- **Cargo Compilation Check**: `cargo check` inside `src-tauri/`