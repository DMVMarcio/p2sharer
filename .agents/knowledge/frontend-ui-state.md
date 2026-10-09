# Deep Dive: Frontend Architecture, State & UI System

## Remote Screen PiP Audio

Remote screen PiP keeps audio in the main window's `AudioContextManager` sink, where remote stream playback already works, while its loopback WebRTC connection carries only the video track. The PiP video element stays muted for reliable autoplay in WebView2. Initial audio volume and mute state travel with the offer, and PiP control changes return as validated `audio-settings` signals to update the main sink. The sink remains active when PiP closes so the regular stream card inherits the latest volume.

`AudioContextManager` owns an independent audio-only `MediaStream` and a hidden,
playing HTML audio element with volume zero for each subscribed audio-bearing slot.
This keeps Chromium's remote audio sample pull active when the visible video is
removed for native PiP. Web Audio gain remains the single audible output. Audio
source nodes are keyed by actual audio track object identity, so changing a video
container or repeating the same tracks does not disconnect audio. Detach pauses,
clears and removes the auxiliary element without stopping shared remote tracks.

## Overview
The frontend is built using TypeScript 5.6, HTML5, and CSS3, bundled via Vite 6. React owns rendering and lifecycle; shared services coordinate state and native/P2P boundaries.

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
│   ├── useCapturePreview.ts # Managed screen/camera picker previews
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
├── ui/                      # Audio SFX & diagnostics
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

## 3. React Media Rendering (`RoomVideoContainer` and `VideoCard`)

### Keyed Media Elements

- React owns peer cards and their markup. Stable peer keys retain video nodes across name/status updates, sibling churn, and reordering. A stable callback ref attaches each node; stream replacements update its native srcObject without ref detachment. Unmount releases the decoder through pause, source clearing, and load.
- Only the active grid or spotlight layout mounts cards. The selected spotlight tray entry keeps its lightweight placeholder, preventing duplicate decoders for the featured stream.
- Persistent room apps retain keyed player/editor components while React callback refs register their grid, featured, and tray slots. Layout measurement and ResizeObserver follow those refs and preserve clipping and transitions.
- Saved-room sorting registers cards through useSortableGrid.cardRef; keyboard and pointer gestures share the existing draft, focus, rollback, and animation lifecycle.
- Room cards share a keyed session-local order across grid and spotlight. `core/room_card_layout.ts` maximizes automatic 16:9 card size against both viewport dimensions and calculates manual rows and independent size overrides. `useRoomCardGestures` starts body dragging after a movement threshold, protects controls/editors and stream annotation mode, resizes from invisible border hit areas, and supports keyboard alternatives. Draft geometry uses the same keyed card plus an empty destination, with no cloned content or competing FLIP transforms. Persistent apps measure slot placement synchronously before paint. Reset actions come from `RoomCardLayoutContext` through the canonical right-click menus. Narrow viewports reflow saved rows without replacing their arrangement; room changes reset the session-local layout.
- Selector options, context-menu buttons, transmission tabs, and inline drawing editors use refs instead of selector lookups. Chat right-click actions use React onContextMenu and the same action builder as dots menus.
- Native DOM APIs remain at explicit boundaries: React's root mount, media playback/capture, third-party editor/player integrations, geometry/animation measurements, selection highlighting, document-level dismissal, and modal focus traps. These are necessary browser contracts; do not replace them with HTML strings or duplicate feature renderers.

---

## 4. UI Design Tokens & Theme Engine (`src/style.css`)

- **Design System Tokens**:
  - CSS Custom Properties define all surfaces (`--bg-app`, `--bg-surface`, `--bg-elevated`, `--bg-card`, `--bg-input`), borders (`--border-subtle`, `--border-focus`), text (`--text-primary`, `--text-muted`), and accent hues.
  - Accent colors dynamically update `--accent-color`, `--accent-glow`, and `--accent-hover`.
- **Accessibility & Feedback**:
  - Custom SVG icons from `lucide`.
  - Micro-animations with transition curves (`cubic-bezier(0.4, 0, 0.2, 1)`).
  - Floating toast notifications and interactive connection overlays.

## Application Context Menus

`components/common/ContextMenu.tsx` owns the shared portal, viewport clamping, keyboard navigation, focus return, dismissal, and retained dropdown exit. `AppContextMenu` installs it for the main and PiP WebViews. Feature surfaces pass typed action lists; optional `selected` actions render radio menu items with a selected background, and `{ toggle: true }` allows a trigger to dismiss its own open menu without pointerdown reopening it; messages share their action builder between dots and right-click, and participant moderation keeps its existing confirmation dialog. Stream menus use existing local audio, preview, layout, fullscreen, and PiP actions, preventing WebView2's native media menu from altering playback. Text fields use shared selection-aware editing actions from `text_editing_actions.tsx` and snapshots in `core/text_editing.ts`. Tiptap editors register through `useTextEditorContextMenu` so mutations and undo/redo use their own commands, including collaboration history. Native fields use WebView2 editing commands to preserve undo and React input events. Modal backgrounds suppress underlying room actions. Add new contexts through `useContextMenu` rather than separate popups.

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

`Tooltip` cancels pending shows and dismisses after activation, Escape, outside focus, scroll/resize, window blur, document visibility changes and pointer exit. While open it checks whether the trigger moves or is detached. Global listeners are attached only during an active/pending tooltip, and `onOpenChange` emits each transition exactly once, including unmount. Interactive hover and keyboard focus remain supported; mouse activation cannot reopen a tooltip through its resulting focus event.

Stream PiP creation receives available video track dimensions and falls back to 16:9 until the receiver reports metadata. `PipView` reports video metadata/resolution changes to `set_pip_aspect_ratio`, scoped to its own PiP window. The Windows UI thread installs a subclass for `WM_SIZING`, adjusting the client rectangle proportionally on every resize edge, accounting for frame thickness and DPI, and removing the subclass on destruction. Initial sizing fits the current monitor work area; native maximization is disabled because its bounds would break the video aspect. Explicit fullscreen remains available. `usePipWindowDrag` starts native dragging after a small primary-pointer movement anywhere outside controls; Shift-drag retains zoom panning, and the enabled pointing/drawing mode retains ownership of video interactions.

## Consent-Based Stream Pointing

`useStreamPointer` and `StreamPointerToggle` share viewer pointing in stream cards and native PiP. Pointing starts off, resets when the stream/surface changes, excludes HUD controls and letterboxing, inverts the video element's transformed contain rectangle, and captures primary video clicks instead of layout selection or pan drags. Over active video, the native mouse is hidden and replaced by the same named, participant-colored `StreamPointerGlyph` used on the desktop. The local ring was removed. Movement is targeted at 25 Hz with an 800 ms stationary heartbeat; leaving, blur, visibility changes, and unmount send `leave`. PiP forwards visual packets to the main WebView through a targeted Tauri event.

`GroupRoomManager` uses the independent `stream_pointer` action, its existing verified/admitted peer gate, targeted sends, and broadcaster watcher membership. The receiver derives names/colors from peer identity rather than packet claims, rate-limits motion and pings, expires stale cursors after three seconds, and clears departed watchers. Independent persistent `allowParticipantCursors` and `allowParticipantPings` switches default on and apply on Settings Save. Pings animate for one second and require cursor consent. The broadcaster relays bounded `StreamPointerState` snapshots only to verified/admitted watchers, including passive viewers and the pointer author. Snapshots are accepted only from the broadcaster whose media is present and locally subscribed. `streamPointerView` converts sender-relative TTLs to local time; `StreamPointerVideoLayer` projects shared glyphs onto the transformed video image, with expiry and clipping. Own cursors are rendered locally to avoid echoed duplicates; own pings arrive in the same shared snapshots as other participants. Targeted main/PiP events provide identity and the current snapshot even when interactive mode is off. Passive video views include spotlight tray streams and local previews.

`stream_pointer.rs` tracks the native capture source and hosts an unfocusable, click-through, transparent topmost WebView. It follows monitor physical bounds using the capture library's monitor ordering and window extended frame bounds, hiding minimized/closed windows. The annotation WebView starts with a transparent native background and waits for its frontend readiness handshake before being shown; empty snapshots clear the existing surface rather than destroy it. Capture teardown closes the retained per-session overlay. Display affinity excludes the annotation layer from captured monitor video. The main WebView publishes bounded, expiring visual snapshots; the overlay itself only reads snapshots/events. No mouse injection or remote desktop input commands exist in this feature. Capture stop clears the native source; room/stream lifecycle clears receiver state. Runtime verification with two desktop clients remains separate from compilation and unit checks.

Virtual cursor motion is centralized in `StreamPointerGlyph` and the `.stream-pointer-remote.is-interpolated` recipe. Received cursor coordinates use a 70 ms linear transition, covering the 50 ms snapshot cadence plus modest jitter. Interrupted transitions retarget from the currently rendered position rather than the last network sample. This shared recipe works for pixel-based video coordinates and percentage-based native overlay coordinates. The locally controlled cursor explicitly opts out of interpolation, ripple coordinates do not interpolate, newly mounted cursors start at their received position, and reduced-motion preferences disable the transition.

## Interactive Stream Annotations

`StreamDrawingToolbar` extends viewer interactive mode in cards and PiP with pointer, brush, outline rectangle/ellipse, text, preset colors through the canonical ContextMenu, and a semantic 0-10 size slider. Text uses the inline `StreamDrawingTextEditor` described below. Gestures use pointer capture and a local SVG draft; completed drawings travel through the verified watcher pointer channel. `StreamDrawingLayer` projects normalized geometry into the transformed contain rectangle or native desktop bounds, with tool-specific widths and text sizes scaled against 1080 pixels. Pointer events stay visual-only.

`allowParticipantDrawings` is persisted under `p2sharer_participant_drawings`, defaults on, and is independent of pings; both require `allowParticipantCursors`. Changes publish immediately to existing watchers, and new watchers receive permission/scene snapshots. Drawing packets validate tool, hexadecimal color, 0-10 integer size, up to 192 normalized points, and up to 160 text characters. The broadcaster retains a configurable 1-1024 drawings (default 1024), each with up to 192 points, evicting oldest instructions at capacity. The Transmission slider persists under `p2sharer_drawing_limit`. Broadcaster-owned `StreamDrawingHistory` maintains independent author undo/redo stacks, including clear operations, trims evicted drawings/history, resets redo on a new action, and clears history on watch departure or revoked consent. History button state is relayed with snapshots; Ctrl+Z/Ctrl+Y (and Ctrl+Shift+Z) are scoped to the active interactive surface and bypass text fields and active dialogs/menus. Drawings persist when a viewer leaves interactive mode, and disappear when their author clears them, stops watching/disconnects, the capture ends, or consent is revoked. Snapshots renew drawing TTLs and idle scenes publish at most every 800 ms. `drawingsIncluded=false` sends cursor-only frames that retain existing drawings; complete drawing lists travel only on geometry/history/consent changes or watcher readiness. Main viewer readiness requests a rate-limited full `sync` snapshot after the media surface mounts, and PiP readiness exports a full merged scene. Native event frames use the same distinction, Rust shares immutable drawing geometry with Arc, and memoized SVG shapes retain geometry during cursor updates. Authors can clear only their own drawings. Native overlay exclusion prevents capture recursion, so passive viewers and PiP receive the same drawings through shared snapshots.

Text annotations use `StreamDrawingTextEditor`, a borderless native textarea anchored to the same normalized video bounds as the SVG scene. The toolbar has no text field. Text drafts remain local until Enter or outside click confirms one history action; Shift+Enter preserves newlines, empty drafts are discarded, and IME composition does not commit on Enter. Shared SVG text uses one tspan per line across native overlays, viewers, and PiP. Consent revocation or stream departure removes the editor without publishing.

## Transmission settings sections

The default-on `StateStore.rememberTransmissionSettings` preference is persisted under `p2sharer_remember_transmission_settings`. Settings exposes it beside transmission defaults and applies it only on Save. `saveTransmissionDefaults` centralizes persistence of resolution, FPS, bitrate, image quality, and cursor capture. The picker saves screen/window defaults only after a successful start or edit; cancellation and capture failure leave both saved defaults and the previous runtime configuration intact. The capture service accepts an explicit bitrate so starting a capture does not require changing global defaults beforehand. When remembering is off, picker changes still configure that capture but do not replace stored defaults. Camera choices remain independent per-picker drafts constrained by the device; editing retains exact active camera constraints without updating global defaults.

`core/encoder_preferences.ts` centralizes validated encoder persistence and stale hardware selection recovery. Hardware options require a native probe; Automatic and Generic remain available. Settings drafts survive local tab changes and apply on Save. Encoder changes affect future screen/window captures, preserving active sessions and the camera path.

## Local transmission previews

`StateStore.localPreviewStreams` stores a boolean override per local media slot, with cameras defaulting to preview on and screens defaulting off. Every `VideoCard` in grid, stage, and tray reads the same choice, so remounting a layout cannot reset it. Room slot reconciliation removes ended stream keys and room teardown clears all choices. Local spotlight tray cards reuse the stop-watching control recipe to stop only their own `mediaId`. The selected featured tray card retains the existing lightweight placeholder, matching other selected streams.

## Saved room ordering

`SavedRoomsSection` displays device-local order from `core/saved_room_order.ts`, persisted as room IDs under `p2sharer_saved_room_order_v1`; it never rewrites signed invitations, identities, or passwords to reorder cards. Existing rooms initially use their display-name alphabetical order. New records absent from the manual order append afterward, and renames retain their positions. `useSortableGrid` provides shared pointer/keyboard sorting with a six-dot handle, a transient draft, grid-aware nearest-slot placement, scroll-edge movement, and FLIP animations using the shared normal transition and reduced-motion setting. Drop commits once; Escape, pointer cancellation, and blur restore the initial order. Storage failures roll back the gesture and show a toast. The focused handle remains attached to its keyed card. Unit DOM checks verify gestures, keyboard focus, animations, and reduced motion; storage tests cover corruption and write failure.
