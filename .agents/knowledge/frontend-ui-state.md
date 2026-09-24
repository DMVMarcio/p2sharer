# Deep Dive: Frontend Architecture, State & UI System

## Overview
The frontend is built using TypeScript 5.6, HTML5, and CSS3, bundled via Vite 6. It follows a modular structure without heavy single-page application framework overhead, achieving sub-millisecond DOM updates and minimal memory consumption.

---

## 1. Directory & Layer Organization (`src/`)

```
src/
├── core/                    # Fundamental app primitives
│   ├── types.ts             # Shared interfaces, message contracts, states
│   ├── state_store.ts       # Central state management & localStorage persistence
│   ├── event_bus.ts         # Pub/sub event emitter for cross-module decoupling
│   └── logger.ts            # Frontend logger forwarding to Rust backend
├── p2p/                     # WebRTC networking & signaling
│   ├── group_room.ts        # Mesh room coordinator & lifecycle
│   ├── signaling_manager.ts # Multi-transport failover (MQTT/Nostr/Torrent)
│   ├── media_coordinator.ts # WebRTC stream negotiation & recovery
│   ├── peer_tracker.ts      # Ghost peer quarantine & heartbeats
│   └── ice_config.ts        # STUN/TURN parsing & sanitization
├── audio/                   # Audio pipeline & playback
│   ├── audio_bridge.ts      # WASAPI loopback receiver & Web Audio router
│   └── audio_context_manager.ts # Zero-allocation buffer reuse & AudioContext lifecycle
├── video/                   # Video pipeline & presentation
│   ├── native_video_bridge.ts # Rust WebSocket client & getDisplayMedia fallback
│   └── viewer_renderer.ts   # Keyed in-place DOM reconciliation & layout engine
├── ui/                      # Visual components & controllers
│   ├── modal_controller.ts  # Modals (screens, settings, filters, logs, theme)
│   ├── hud_controller.ts    # WebRTC HUD diagnostics overlay
│   └── sound_effects.ts     # Synthesized Web Audio UI sound indicators
├── main.ts                  # Application entrypoint & composition root
├── style.css                # Global design system & component tokens
└── index.html               # Main view shell & modal templates
```

---

## 2. State Management (`src/core/state_store.ts`)

`StateStore` is a singleton holding the client's operational state:
- **User Identity & Room**: `username`, `currentRoomCode`, `currentRoomPassword`, `isCreator`.
- **Layout & Subscriptions**: `layoutMode` (`'grid'` or `'spotlight'`), `pinnedPeerId`, `subscribedStreams` (Set of peer IDs), `roomSlots` (array of `RoomSlotInfo`).
- **Capture Settings**: `currentFps` (30/60/120), `currentBitrate` (5000–50000 kbps), `currentResolution` (1080p, 720p, 1440p, 4K).
- **Process Audio Filtering**: `selectedFilterMode` (`'exclude'` or `'include'`), `excludeProcessNames`, `includeProcessNames`, `excludePids`, `includePids`.
- **Theme & Appearance**: `currentThemeMode` (`'dark'` | `'light'`), `currentAccentColor` (`cyan`, `emerald`, `amber`, `rose`, `indigo`).

Persistent settings are automatically synchronized to and restored from `localStorage`.

---

## 3. Keyed In-Place DOM Reconciliation (`src/video/viewer_renderer.ts`)

### Zero-Allocation Video Element Reuse
Rather than re-rendering HTML strings when peers join, leave, or toggle streams:
- `ViewerRenderer` tracks peer cards by unique `peerId`.
- Existing `<video>` elements are kept intact across re-renders to avoid triggering expensive Chromium video decoder recreation or GPU texture stalls.
- Modifies classes, hidden attributes, and stream assignments in-place.

### Layout Modes & Spotlight Pinning
- **Grid View**: Responsive CSS grid adapting automatically from 1 to 16+ peer cards.
- **Spotlight View**: Highlights one pinned peer stream in the central viewport while docking remaining participants in a collapsible bottom tray.
- **Auto-Reversion**: If the pinned peer leaves the room or stops streaming, the renderer gracefully falls back to grid mode without freezing the UI.

---

## 4. UI Design Tokens & Theme Engine (`src/style.css`)

- **Design System Tokens**:
  - CSS Custom Properties define all surfaces (`--bg-primary`, `--bg-secondary`, `--bg-tertiary`), borders (`--border-subtle`, `--border-focus`), text (`--text-primary`, `--text-muted`), and accent hues.
  - Accent colors dynamically update `--accent-color`, `--accent-glow`, and `--accent-hover`.
- **Accessibility & Feedback**:
  - Custom SVG icons from `lucide`.
  - Micro-animations with transition curves (`cubic-bezier(0.4, 0, 0.2, 1)`).
  - Floating toast notifications and interactive connection overlays.
