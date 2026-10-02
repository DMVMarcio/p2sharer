# Deep Dive: Frontend Architecture, State & UI System

## Remote Screen PiP Audio

Remote screen PiP keeps audio in the main window's `AudioContextManager` sink, where remote stream playback already works, while its loopback WebRTC connection carries only the video track. The PiP video element stays muted for reliable autoplay in WebView2. Initial audio volume and mute state travel with the offer, and PiP control changes return as validated `audio-settings` signals to update the main sink. The sink remains active when PiP closes so the regular stream card inherits the latest volume.

## Overview
The frontend is built using TypeScript 5.6, HTML5, and CSS3, bundled via Vite 6. It follows a modular structure without heavy single-page application framework overhead, achieving sub-millisecond DOM updates and minimal memory consumption.

---

## 1. Directory & Layer Organization (`src/`)

```
src/
├── components/              # Modular React UI components
│   ├── common/              # Common UI widgets (ToastContainer, etc.)
│   ├── header/              # Titlebar header & room code / user pills (AppHeader)
│   ├── home/                # Welcome & lobby action cards (HomeView)
│   ├── room/                # Room view, grid/spotlight, stream cards, chat, sidebar
│   │   ├── RoomView.tsx
│   │   ├── StreamHeaderBar.tsx
│   │   ├── RoomVideoContainer.tsx
│   │   ├── ParticipantCard.tsx
│   │   ├── VideoCard.tsx
│   │   ├── StreamHudOverlay.tsx
│   │   ├── RoomSidebar.tsx
│   │   ├── ChatPane.tsx
│   │   └── ParticipantsPane.tsx
│   └── modals/              # Modular modal dialogs
│       ├── SettingsModal.tsx
│       ├── ScreenPickerModal.tsx
│       ├── UsernameModal.tsx
│       ├── AudioFilterModal.tsx
│       ├── CreateRoomModal.tsx
│       ├── JoinRoomModal.tsx
│       ├── RoomSecurityModal.tsx
│       └── ConnectingOverlay.tsx
├── hooks/                   # Specialized business logic hooks
│   ├── useStore.ts          # Reactive subscription via useSyncExternalStore
│   ├── useRoom.ts           # Room lifecycle, P2P mesh & chat
│   ├── useScreenCapture.ts  # Native video & WASAPI audio capture
│   ├── useScreenPicker.ts   # Screen/window source selection & GPU direct
│   ├── useAudioFilter.ts    # Windows process audio filtering
│   ├── useAppTheme.ts       # Dark/Light/System & 16-color accent palette
│   ├── useModal.ts          # Declarative modal dialog manager
│   └── useToast.ts          # Reactive floating toast notifications
├── services/                # Core service coordinator
│   └── room_service.ts      # Singleton bridge between React and WebRTC/WASAPI
├── core/                    # Fundamental app primitives
│   ├── types.ts             # Shared interfaces, message contracts, states
│   ├── state_store.ts       # Central state management & reactive subscriptions
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
│   └── viewer_renderer.ts   # Unit-tested DOM reconciliation engine
├── ui/                      # Audio SFX & diagnostics
│   ├── hud_controller.ts    # WebRTC HUD diagnostics overlay
│   └── sound_effects.ts     # Synthesized Web Audio UI sound indicators
├── App.tsx                  # Root application component
├── main.tsx                 # React DOM mount entrypoint
├── style.css                # Global design system & component tokens
└── index.html               # App HTML shell with #root mount point
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

## Application Context Menus

`components/common/ContextMenu.tsx` owns the shared portal, viewport clamping, keyboard navigation, focus return, dismissal, and retained dropdown exit. `AppContextMenu` installs it for the main and PiP WebViews. Feature surfaces pass typed action lists; messages share their action builder between dots and right-click, and participant moderation keeps its existing confirmation dialog. Stream menus use existing local audio, preview, layout, fullscreen, and PiP actions, preventing WebView2's native media menu from altering playback. Text fields use shared selection-aware editing actions from `text_editing_actions.tsx` and snapshots in `core/text_editing.ts`. Tiptap editors register through `useTextEditorContextMenu` so mutations and undo/redo use their own commands, including collaboration history. Native fields use WebView2 editing commands to preserve undo and React input events. Modal backgrounds suppress underlying room actions. Add new contexts through `useContextMenu` rather than separate popups.

## Canonical Select Controls

`components/common/Select.tsx` replaces all native selects. Pass controlled `value`, `options` (value, label, optional disabled), and `onValueChange` (string value), with an associated label or `aria-label`. It uses the shared dropdown presence and duration tokens, retaining inert exit content, and Floating UI for fixed portal positioning, boundary flipping, resize/scroll tracking, and available-height sizing. Keyboard navigation, Home/End, typeahead, Enter/Space, Escape, and Tab work through a select-only combobox with active-descendant semantics. Focus stays on its trigger so modal traps and rich-editor selection remain stable. `ModalDialog` delegates Escape to an expanded combobox before closing the dialog. Application UI must not introduce native `<select>` controls.

## Canonical UI Control Catalog

The application-wide rule covers reusable React components and shared CSS recipes. Styled native buttons, text inputs, checkboxes, and ranges retain their semantic behavior; browser select menus, context menus, and `title` tooltips are replaced by the application's shared implementations.

| Control family | Canonical implementation |
| --- | --- |
| Buttons and icon actions | `style.css`: `.btn` with semantic/size variants and established specialized icon-button recipes; `TooltipButton` for actions with tooltips |
| Text fields and rich composition | `.text-input`, `.text-input-sm`, `EmojiComposerInput`; shared `text_editing_actions` and editor registration for context editing |
| Selection fields | `components/common/Select.tsx` |
| Context and dots menus | `ContextMenu`, `AppContextMenu`, `useContextMenu`, and shared feature action builders |
| Tooltips | `Tooltip`, `TooltipButton`, and shared positioning utilities |
| Dialogs | `ModalDialog` and the existing modal presence lifecycle |
| Switches | `.modern-switch` / `.switch-slider` with semantic checkbox inputs |
| Sliders and playback controls | `.settings-slider-input`, `.stream-volume-range`, existing zoom styles, `MediaSeekBar`, and shared stream-control recipes |
| Emoji and message rendering | `EmojiPickerPopover`, `EmojiPicker`, `EmojiGlyph`, `EmojiText`, `ChatMessageContent` |
| Notifications and activity feedback | `ToastContainer`, `ActivityToast`, `ActivityParticipants`, and established loading/empty/error patterns |
| Shared settings editors | `RendezvousServerEditor` and existing common editors for their supported domain |

Before adding a control, inspect the common components and its existing usage. Extend the canonical implementation when a new variant is needed. Apply shared tokens, keyboard and focus behavior, disabled/read-only states, and reduced-motion handling across main, settings, activities, and PiP surfaces. Menus/dropdowns retain their 320 ms enter / 260 ms exit lifecycle; dialogs and other families keep their established motion rather than inheriting dropdown timings indiscriminately.


## Consent-Based Stream Pointing

`useStreamPointer` and `StreamPointerToggle` share viewer pointing in stream cards and native PiP. Pointing starts off, resets when the stream/surface changes, excludes HUD controls and letterboxing, inverts the video element's transformed contain rectangle, and captures primary video clicks instead of layout selection or pan drags. Over active video, the native mouse is hidden and replaced by the same named, participant-colored `StreamPointerGlyph` used on the desktop. The local ring was removed. Movement is targeted at 25 Hz with an 800 ms stationary heartbeat; leaving, blur, visibility changes, and unmount send `leave`. PiP forwards visual packets to the main WebView through a targeted Tauri event.

`GroupRoomManager` uses the independent `stream_pointer` action, its existing verified/admitted peer gate, targeted sends, and broadcaster watcher membership. The receiver derives names/colors from peer identity rather than packet claims, rate-limits motion and pings, expires stale cursors after three seconds, and clears departed watchers. Independent persistent `allowParticipantCursors` and `allowParticipantPings` switches default on and apply on Settings Save. Pings animate for one second and require cursor consent. The broadcaster relays bounded `StreamPointerState` snapshots only to verified/admitted watchers, including passive viewers and the pointer author. Snapshots are accepted only from the broadcaster whose media is present and locally subscribed. `streamPointerView` converts sender-relative TTLs to local time; `StreamPointerVideoLayer` projects shared glyphs onto the transformed video image, with expiry and clipping. Own cursors are rendered locally to avoid echoed duplicates; own pings arrive in the same shared snapshots as other participants. Targeted main/PiP events provide identity and the current snapshot even when interactive mode is off. Passive video views include spotlight tray streams and local previews.

`stream_pointer.rs` tracks the native capture source and hosts an unfocusable, click-through, transparent topmost WebView. It follows monitor physical bounds using the capture library's monitor ordering and window extended frame bounds, hiding minimized/closed windows. The annotation WebView starts with a transparent native background and waits for its frontend readiness handshake before being shown; empty snapshots clear the existing surface rather than destroy it. Capture teardown closes the retained per-session overlay. Display affinity excludes the annotation layer from captured monitor video. The main WebView publishes bounded, expiring visual snapshots; the overlay itself only reads snapshots/events. No mouse injection or remote desktop input commands exist in this feature. Capture stop clears the native source; room/stream lifecycle clears receiver state. Runtime verification with two desktop clients remains separate from compilation and unit checks.


Virtual cursor motion is centralized in `StreamPointerGlyph` and the `.stream-pointer-remote.is-interpolated` recipe. Received cursor coordinates use a 70 ms linear transition, covering the 50 ms snapshot cadence plus modest jitter. Interrupted transitions retarget from the currently rendered position rather than the last network sample. This shared recipe works for pixel-based video coordinates and percentage-based native overlay coordinates. The locally controlled cursor explicitly opts out of interpolation, ripple coordinates do not interpolate, newly mounted cursors start at their received position, and reduced-motion preferences disable the transition.


## Interactive Stream Annotations

`StreamDrawingToolbar` extends viewer interactive mode in cards and PiP with pointer, brush, outline rectangle/ellipse, text, preset colors through the canonical ContextMenu, and a semantic 0-10 size slider. Text is entered in a history-disabled canonical text input, then placed by clicking the video. Gestures use pointer capture and a local SVG draft; completed drawings travel through the verified watcher pointer channel. `StreamDrawingLayer` projects normalized geometry into the transformed contain rectangle or native desktop bounds, with tool-specific widths and text sizes scaled against 1080 pixels. Pointer events stay visual-only.

`allowParticipantDrawings` is persisted under `p2sharer_participant_drawings`, defaults on, and is independent of pings; both require `allowParticipantCursors`. Changes publish immediately to existing watchers, and new watchers receive permission/scene snapshots. Drawing packets validate tool, hexadecimal color, 0-10 integer size, up to 128 normalized points, and up to 160 text characters. The broadcaster retains at most 64 drawings and 2048 points, evicting oldest instructions at capacity. Drawings persist when a viewer leaves interactive mode, and disappear when their author clears them, stops watching/disconnects, the capture ends, or consent is revoked. Snapshots renew drawing TTLs and idle scenes publish at most every 800 ms. Authors can clear only their own drawings. Native overlay exclusion prevents capture recursion, so passive viewers and PiP receive the same drawings through shared snapshots.
