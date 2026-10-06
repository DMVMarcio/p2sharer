# Multiple Media Streams and Viewer Compositions

## Capture and ownership

`RoomService.localCaptures` owns independent screen/window or camera sessions. Screens use a separate `NativeVideoBridge` and authenticated Rust capture session; cameras use `getUserMedia` with the selected device, resolution and FPS. Rust `SESSIONS` holds each active flag, source, WGC control and bounded frame broadcast channel. The loopback WebSocket authenticates the process token and selects one session, keeping image frames and heartbeat messages isolated. Legacy default-capture commands remain for existing benchmark callers.

Broadcast `MediaStream` containers are separate from bridge-owned capture containers. Editing prepares the replacement capture and waits for a decoded native frame before replacing only matching RTP senders. A failed replacement rolls back already updated peers. The stable broadcast stream and media identity survive replacement; the old capture is disposed afterward. Camera edits remain camera sources, and screen edits allow monitor/window changes. Screen audio uses the existing shared WASAPI bridge on one screen, and moves to a remaining screen if its current screen stops.

## Transport and presentation

Presence can re-deliver the same Trystero tracks every two seconds. Remote stream
merging must preserve the existing `MediaStream` object when the resulting track
objects are identical, including separate native video/browser audio delivery.
Creating a new wrapper on every advertisement reloads React video players, rebuilds
audio sources and resets interactive pointing. Late `addtrack` events re-enter the
same reconciliation path; the slot update fingerprint includes current track IDs
and ready states so actual additions still reach subscribers. A real replacement
retains the independent media slot and other sources while updating its contents.

`VideoCard` audio effects include the current audio track fingerprint, so audio
arriving after video is attached even when its container stays stable. PiP likewise
attaches newly arrived audio before its unchanged-video early return.

`GroupRoomManager.localMedia` and `remoteMedia` map independent media identities to streams. Validated descriptors contain kind, label, track identity, FPS and bitrate. The existing admitted/verified action gate protects the revisioned manifest and targeted Trystero stream metadata. Manifests reconcile removals and recover missing streams; old revisions and late media absent from the current manifest are ignored. Parameter updates are serialized per connection and filter by sender track so sessions retain distinct settings. RTP statistics are sampled per sender/receiver.

Room slot keys are stable `owner/mediaId` identifiers. `ownerPeerId` is the actual authenticated participant; participant rosters, admission and moderation retain that identity. Screens sort before cameras. A camera-only owner has its camera as the first media card; an owner sharing screens has separate camera cards without additional peer identities. PiP uses the same slot keys, including sanitized native-window close routing.

## Viewer composition

`RoomVideoContainer` resolves manual overlay selections plus the featured screen owner's cameras. Automatic cameras are subscribed when the screen is watched in spotlight. `StreamOverlay` renders inside the featured `VideoCard`, including fullscreen. It supports pointer capture, resizing, keyboard movement/resize, bounded normalized geometry, portrait aspect ratios, foreground ordering and snapping at release to eight edge anchors. ResizeObserver keeps overlays inside a resized stage. Removal dismisses automatic overlays for that base, and grid mode renders none.

Compositions and automatic dismissals are viewer-local and reset on room departure. Overlays use muted video; subscribed source cards retain the existing audio sink and volume controls. All four corners resize while preserving the opposite anchor. Dragging, resizing and magnetic anchors retain a bounded inset from the stage edges.

Pointer packets and snapshots carry a validated media identity. Each local screen has an independent receiver and native overlay window bound to its capture session. Viewer/PiP scenes resolve the matching owned media slot; cameras are ineligible. Watcher verification and broadcaster ownership remain peer-scoped, while coordinates and native source bounds are media-scoped. Stopping or replacing a source clears its receiver and closes only its previous pointer window.

## Remote identity and repeated capture lifecycle

The patched Trystero media manager pairs metadata with incoming streams/tracks by their SDP stream/track identities, including events arriving before metadata. FIFO pairing was incorrect: a screen's separate video and audio events could consume the next camera's descriptor, replacing screen content remotely. Duplicate stream events no longer consume another pending source. Peer addStream/addTrack operations ignore already connected or ended tracks, making recovery and publication of additional streams idempotent. Async dispatch failures are handled; publication completing after local stop removes stale senders. Stream addtrack observers are registered once.

Native capture fitting preserves source aspect ratio without upscaling, including portrait displays and nonstandard windows. Thumbnails and canvas fallback also preserve that ratio. Native bridge stop disposes WebSocket, bitmap, tracks and canvas before awaiting native shutdown, aborts queued generator writes, and invalidates outstanding decode work with a capture generation.

## Source picker and camera consent

`camera_permission.rs` registers WebView2 camera-only consent on the main webview. The requesting origin must be the packaged `http://tauri.localhost` origin (or the exact configured development origin in debug builds); embedded external origins retain the normal permission behavior. Windows privacy settings still govern physical device access. `listCameras` unlocks Chromium's initially redacted device identities with one temporary default-camera capture only when necessary, releases it, and returns all labeled video inputs. It does not open every camera for thumbnails. Device cards show an icon; a separate live panel previews the selected device.

`useCapturePreview` serializes isolated native sessions and selected-camera captures, invalidates stale asynchronous results, releases captures on source changes/cancellation, and transfers ownership to `RoomService.startCapture` on confirmation. A prepared stream is published without stopping/reopening its device. Screen configuration changes restart only the isolated preview. Camera mode discovery verifies common resolutions plus the initial actual dimensions against exact constraints with native resize mode where supported, then verifies FPS choices for the selected resolution. Capability ranges alone do not establish valid pairs. Negotiated dimensions/FPS appear below the video. Explicit dimensions preserve nonstandard camera aspect ratios, including during edits, and screen selectors retain their standard options when returning from a camera.

While broadcasting, the single transmission button displays a down arrow and opens the canonical context menu of local media slots. A source's primary row action edits its `mediaId`; an independent adjacent stop button ends that source. The final separated action starts another transmission. Idle clicking opens the picker directly. `ContextMenuAction.secondary` reuses the shared menu's keyboard navigation, viewport bounds, retained exit lifecycle, tooltip and error handling, without nesting buttons.

FPS labels share `formatFrameRate`, which uses Portuguese formatting with up to two decimal places in the picker, preview, cards, PiP and legacy renderer. Native camera probing keeps exact FPS values but removes choices with identical formatted labels. `preferredCameraFrameRate` maps nominal preferences to the verified value behind the same displayed label before choosing a lower fallback, so a nominal 30 FPS preference still selects a verified 30.000030517 FPS device rate.

## Preview loading and dropdown feedback

`useSkeletonPresence` shares the 400 ms source-loading presence lifecycle between the picker cards and `MediaPreview`, including interrupted fades and reduced-motion handling. The preview retains its skeleton through the selected-source acquisition gap and waits for `loadeddata` plus a decoded video frame when frame callbacks are available. Changing a source or stream invalidates old frame callbacks; the live video then fades in as the retained shimmer layer fades out. Source-card skeletons also fade in using the same CSS motion token.
