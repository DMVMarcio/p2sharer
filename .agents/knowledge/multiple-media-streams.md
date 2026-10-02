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

Playback regression validation on 2026-10-02 used two fresh packaged WebView2
processes and the canonical React room cards (`test/bench/stream_playback_continuity.ts`).
Before the fix, identical video/audio track IDs acquired new stream wrappers every
2,000 ms. After the fix, generic and native NVENC runs retained both players with
zero `emptied` events through a 12-second grid sample and kept pointing enabled.
Both received 720p/60 and 360p/30 screens. NVENC used two native routes and zero
browser video senders. Synthetic 440 Hz audio remained nonzero throughout native
PiP (5 seconds generic, 15 seconds NVENC) and restore (3 seconds each). Each grid
sample recorded one isolated silent 50 ms probe, no sustained gap and no black
samples. A separate real PiP window check confirmed 720p decoded video and nonzero
audio in the main Web Audio sink after its visible card video was removed. These
same-host checks do not validate the user's Internet route, real game audio fidelity
or lip sync. The frontend suite passed 427 tests, including late-audio React effects.

`GroupRoomManager.localMedia` and `remoteMedia` map independent media identities to streams. Validated descriptors contain kind, label, track identity, FPS and bitrate. The existing admitted/verified action gate protects the revisioned manifest and targeted Trystero stream metadata. Manifests reconcile removals and recover missing streams; old revisions and late media absent from the current manifest are ignored. Parameter updates are serialized per connection and filter by sender track so sessions retain distinct settings. RTP statistics are sampled per sender/receiver.

Room slot keys are stable `owner/mediaId` identifiers. `ownerPeerId` is the actual authenticated participant; participant rosters, admission and moderation retain that identity. Screens sort before cameras. A camera-only owner has its camera as the first media card; an owner sharing screens has separate camera cards without additional peer identities. PiP uses the same slot keys, including sanitized native-window close routing.

## Viewer composition

`RoomVideoContainer` resolves manual overlay selections plus the featured screen owner's cameras. Automatic cameras are subscribed when the screen is watched in spotlight. `StreamOverlay` renders inside the featured `VideoCard`, including fullscreen. It supports pointer capture, resizing, keyboard movement/resize, bounded normalized geometry, portrait aspect ratios, foreground ordering and snapping at release to eight edge anchors. ResizeObserver keeps overlays inside a resized stage. Removal dismisses automatic overlays for that base, and grid mode renders none.

Compositions and automatic dismissals are viewer-local and reset on room departure. Overlays use muted video; subscribed source cards retain the existing audio sink and volume controls. All four corners resize while preserving the opposite anchor. Dragging, resizing and magnetic anchors retain a 12-pixel stage inset (bounded proportionally on small stages).

Pointer packets and snapshots carry a validated media identity. Each local screen has an independent receiver and native overlay window bound to its capture session. Viewer/PiP scenes resolve the matching owned media slot; cameras are ineligible. Watcher verification and broadcaster ownership remain peer-scoped, while coordinates and native source bounds are media-scoped. Stopping or replacing a source clears its receiver and closes only its previous pointer window.

## Remote identity and repeated capture lifecycle

The patched Trystero media manager pairs metadata with incoming streams/tracks by their SDP stream/track identities, including events arriving before metadata. FIFO pairing was incorrect: a screen's separate video and audio events could consume the next camera's descriptor, replacing screen content remotely. Duplicate stream events no longer consume another pending source. Peer addStream/addTrack operations ignore already connected or ended tracks, making recovery and publication of additional streams idempotent. Async dispatch failures are handled; publication completing after local stop removes stale senders. Stream addtrack observers are registered once.

Native capture fitting preserves source aspect ratio without upscaling, including portrait displays and nonstandard windows. Thumbnails and canvas fallback also preserve that ratio. Native bridge stop disposes WebSocket, bitmap, tracks and canvas before awaiting native shutdown, aborts queued generator writes, and invalidates outstanding decode work with a capture generation.

The final desktop loopback also received a synthetic portrait stream at 180x320 without stretching. Stopping one of two native pointer windows left exactly one active window. Camera devices in this benchmark are simulated; monitor frames use real WGC. The complete Tauri packaging build succeeded and executable/MSI/NSIS files were verified in the normal release output.

Validation on 2026-10-01: 393 frontend tests passed. Nine native screen-source tests passed, including portrait fitting, concurrent captures and authenticated routing; the existing WGC performance threshold still failed at 38 FPS against 55. The packaged WebView2 regression benchmark (`test/bench/multiple_media_loopback.ts`) ran four camera/secondary-WGC-screen start/stop cycles with primary WGC video plus audio continuously active. All three actual incoming RTP videos progressed each cycle, stream identities stayed distinct, no WebRTC errors occurred, and only primary video/audio senders remained afterward. Cameras used Chromium's simulated devices. A separate desktop check created two independent native pointer windows and disposed both. The entire-app black-window report was not reproduced; local loopback does not verify the user's remote machines or physical camera hardware.

## Source picker and camera consent

`camera_permission.rs` registers WebView2 camera-only consent on the main webview. The requesting origin must be the packaged `http://tauri.localhost` origin (or the exact configured development origin in debug builds); embedded external origins retain the normal permission behavior. Windows privacy settings still govern physical device access. `listCameras` unlocks Chromium's initially redacted device identities with one temporary default-camera capture only when necessary, releases it, and returns all labeled video inputs. It does not open every camera for thumbnails. Device cards show an icon; a separate live panel previews the selected device.

`useCapturePreview` serializes isolated native sessions and selected-camera captures, invalidates stale asynchronous results, releases captures on source changes/cancellation, and transfers ownership to `RoomService.startCapture` on confirmation. A prepared stream is published without stopping/reopening its device. Screen configuration changes restart only the isolated preview. Camera mode discovery verifies common resolutions plus the initial actual dimensions against exact constraints with native resize mode where supported, then verifies FPS choices for the selected resolution. Capability ranges alone do not establish valid pairs. Negotiated dimensions/FPS appear below the video. Explicit dimensions preserve nonstandard camera aspect ratios, including during edits, and screen selectors retain their standard options when returning from a camera.

While broadcasting, the single transmission button displays a down arrow and opens the canonical context menu of local media slots. A source's primary row action edits its `mediaId`; an independent adjacent stop button ends that source. The final separated action starts another transmission. Idle clicking opens the picker directly. `ContextMenuAction.secondary` reuses the shared menu's keyboard navigation, viewport bounds, retained exit lifecycle, tooltip and error handling, without nesting buttons.

FPS labels share `formatFrameRate`, which uses Portuguese formatting with up to two decimal places in the picker, preview, cards, PiP and legacy renderer. Native camera probing keeps exact FPS values but removes choices with identical formatted labels. `preferredCameraFrameRate` maps nominal preferences to the verified value behind the same displayed label before choosing a lower fallback, so a nominal 30 FPS preference still selects a verified 30.000030517 FPS device rate. The picker width increases from 760 to 820 pixels, retaining the modal's viewport constraints.

The transmission-menu follow-up passed 387 frontend tests, including edit/new/independent-stop actions and noisy FPS labels with exact constraints. Packaged WebView2 checks measured an 820-pixel picker, confirmed the stop control beside its source and absence of an external X button, opened both edit and new-capture dialogs, and stopped a simulated camera using keyboard menu navigation. The QA room was removed and the QA application was closed afterward.

## Preview loading and dropdown feedback

`useSkeletonPresence` shares the 400 ms source-loading presence lifecycle between the picker cards and `MediaPreview`, including interrupted fades and reduced-motion handling. The preview retains its skeleton through the selected-source acquisition gap and waits for `loadeddata` plus a decoded video frame when frame callbacks are available. Changing a source or stream invalidates old frame callbacks; the live video then fades in as the retained shimmer layer fades out. Source-card skeletons also fade in using the same CSS motion token.

The active transmission button places its arrow 3 pixels after the text, with 9 pixels to the outer border in the verified desktop layout. Dropdowns share `--dropdown-hover-bg`, a 4% mix of the primary text color into the previous card-hover background, and the existing fast background/color transition. A transmission menu row highlights as a unit on hover/focus, while stop adds the existing translucent danger background. These styles apply to canonical Select/ContextMenu options and legacy chat, participant, emoji-pack and room-app menus, with reduced-motion overrides.

Packaged WebView2 checks confirmed the source-switch sequence loading → fading → ready, video opacity returning to one, shimmer removal, compact arrow geometry, a continuous row hover and the independent red stop background. Preview interaction tests cover decoded-frame readiness, stale callbacks on source switching, the initial acquisition gap, and reduced motion. A repeated full-suite run exposed an unrelated existing chat stream-notice ordering test with equal timestamps and UUID tie-breaking; its isolated rerun and the final full-suite rerun passed (389 tests). The final Tauri build succeeded and the current executable/MSI/NSIS bundles were verified under the standard release paths.

Validation on 2026-10-01: 386 frontend tests passed, including camera identity bootstrap/release, valid resolution/FPS pairs, the shared protocol's 120 FPS ceiling, cancelled/late preview cleanup, ownership handoff, and individual local stop-menu actions. The native camera origin-scoping test passed. A fresh-profile packaged WebView2 session using Chromium's two simulated camera devices (without the fake permission UI flag) granted camera capture without a browser prompt, listed both labeled devices, played live monitor/camera previews, released the previous selected camera, reused the preview video track when publishing, and stopped the chosen transmission/cancelled preview. The temporary test room was removed afterward. The physical EMEET SmartCam S600 appeared disconnected (`Unknown`) in Windows; physical-camera compatibility remains unverified.

## Previous multistream validation

The source-picker task completed `npm run tauri:build` successfully and verified the current native executable plus MSI/NSIS bundles under the standard `src-tauri/target/release` paths. The QA executable was closed before the final packaging build.

`test/unit/media_streams.test.ts` covers manifest validation, stable ownership/card keys, independent session stopping, successful and failed live track replacement, isolated sender settings and overlay anchors. Native tests exercise two simultaneous WGC captures with distinct frame dimensions and session-selective authenticated WebSockets. Always run the Tauri packaging build and inspect executable/MSI/NSIS artifacts. Native capture tests and local RTP tests do not establish remote Internet performance or actual camera hardware compatibility.

Validation on 2026-10-01: the frontend suite, including actual React composition interactions in jsdom, passed. The native suite passed 25 tests and ignored two, but the existing `test_wgc_live_fps` performance threshold failed: it measured approximately 38 full image frames/second against a minimum of 55. A separate P2Sharer executable was already running from the user's Desktop during this measurement; this observation does not establish the cause of the shortfall. Both new multi-capture and authenticated session-routing tests passed. Camera hardware and remote Internet playback remain unverified.
