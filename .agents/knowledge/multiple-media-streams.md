# Multiple Media Streams and Viewer Compositions

## Capture and ownership

`RoomService.localCaptures` owns independent screen/window or camera sessions. Screens use a separate `NativeVideoBridge` and authenticated Rust capture session; cameras use `getUserMedia` with the selected device, resolution and FPS. Rust `SESSIONS` holds each active flag, source, WGC control and bounded frame broadcast channel. The loopback WebSocket authenticates the process token and selects one session, keeping image frames and heartbeat messages isolated. Legacy default-capture commands remain for existing benchmark callers.

Broadcast `MediaStream` containers are separate from bridge-owned capture containers. Editing prepares the replacement capture and waits for a decoded native frame before replacing only matching RTP senders. A failed replacement rolls back already updated peers. The stable broadcast stream and media identity survive replacement; the old capture is disposed afterward. Camera edits remain camera sources, and screen edits allow monitor/window changes. Screen audio uses the existing shared WASAPI bridge on one screen, and moves to a remaining screen if its current screen stops.

## Transport and presentation

`GroupRoomManager.localMedia` and `remoteMedia` map independent media identities to streams. Validated descriptors contain kind, label, track identity, FPS and bitrate. The existing admitted/verified action gate protects the revisioned manifest and targeted Trystero stream metadata. Manifests reconcile removals and recover missing streams; old revisions and late media absent from the current manifest are ignored. Parameter updates are serialized per connection and filter by sender track so sessions retain distinct settings. RTP statistics are sampled per sender/receiver.

Room slot keys are stable `owner/mediaId` identifiers. `ownerPeerId` is the actual authenticated participant; participant rosters, admission and moderation retain that identity. Screens sort before cameras. A camera-only owner has its camera as the first media card; an owner sharing screens has separate camera cards without additional peer identities. PiP uses the same slot keys, including sanitized native-window close routing.

## Viewer composition

`RoomVideoContainer` resolves manual overlay selections plus the featured screen owner's cameras. Automatic cameras are subscribed when the screen is watched in spotlight. `StreamOverlay` renders inside the featured `VideoCard`, including fullscreen. It supports pointer capture, resizing, keyboard movement/resize, bounded normalized geometry, portrait aspect ratios, foreground ordering and snapping at release to eight edge anchors. ResizeObserver keeps overlays inside a resized stage. Removal dismisses automatic overlays for that base, and grid mode renders none.

Compositions and automatic dismissals are viewer-local and reset on room departure. Overlays use muted video; subscribed source cards retain the existing audio sink and volume controls. Pointer annotations retain the owner's first screen as their eligible source, avoiding misrouting onto additional screens or cameras.

## Validation

`test/unit/media_streams.test.ts` covers manifest validation, stable ownership/card keys, independent session stopping, successful and failed live track replacement, isolated sender settings and overlay anchors. Native tests exercise two simultaneous WGC captures with distinct frame dimensions and session-selective authenticated WebSockets. Always run the Tauri packaging build and inspect executable/MSI/NSIS artifacts. Native capture tests and local RTP tests do not establish remote Internet performance or actual camera hardware compatibility.

Validation on 2026-10-01: the frontend suite, including actual React composition interactions in jsdom, passed. The native suite passed 25 tests and ignored two, but the existing `test_wgc_live_fps` performance threshold failed: it measured approximately 38 full image frames/second against a minimum of 55. A separate P2Sharer executable was already running from the user's Desktop during this measurement; this observation does not establish the cause of the shortfall. Both new multi-capture and authenticated session-routing tests passed. Camera hardware and remote Internet playback remain unverified.
