# Deep Dive: Native Media Pipeline (Rust Backend & Web Bridges)

## Overview
P2Sharer provides native Windows audio loopback capture with process-level isolation and GPU-accelerated screen/window video capture. The Rust backend communicates with the TypeScript frontend via Tauri v2 IPC and a dedicated high-throughput local WebSocket server.

---

## 1. Windows WASAPI Audio Loopback (`src-tauri/src/audio_loopback.rs`)

### Event-Driven Capture Loop
- Uses Windows Core Audio APIs (`IMMDeviceEnumerator`, `IAudioClient`, `IAudioCaptureClient`).
- Configured in loopback mode (`AUDCLNT_STREAMFLAGS_LOOPBACK`) with an event handle (`SetEventHandle`).
- Wakes up immediately when audio hardware buffers are ready, reducing capture latency to `< 20 microseconds` without CPU-heavy sleep polling.
- Thread safety and clean teardown are managed by RAII guards (`EventHandleGuard`).

### ITU-R BS.775 Multichannel Downmixing
When capture devices output 5.1, 7.1, or other multi-channel audio:
- Downmixes to stereo according to ITU-R BS.775:
  - Center: $-3\text{ dB}$ ($0.7071$) to Left and Right.
  - Surround Left / Right: $-3\text{ dB}$ to respective channels.
  - Low Frequency Effects (LFE/Subwoofer): $-3\text{ dB}$ (or $-6\text{ dB}$ in 7.1) summed to both channels.
- Clamps values to $[-1.0, 1.0]$ with overflow protection to prevent audio clipping.

### Stateful 48kHz Fractional Audio Resampler (`AudioResampler`)
- Windows devices run at variable native sample rates (44.1kHz, 48kHz, 96kHz, 192kHz).
- WebRTC expects standardized 48kHz stereo Opus.
- `AudioResampler` maintains fractional phase and the previous input frame across chunk boundaries. Causal interpolation produces the same PCM for whole and fragmented input.

### Capture-Clock PCM Draining & Playback Buffering
- A single WASAPI source drains every captured frame in device-clock order. Wall-clock ticks must never insert hard zeros or discard capture samples.
- Multiple sources mix 10ms blocks paced by the fullest capture FIFO with one block in reserve, then fade a residual tail after 50ms of packet silence. Process/session discovery runs on a separate worker, outside the capture loop.
- WAVEFORMATEXTENSIBLE subtype selects float or integer PCM decoding; 16-, 24-, and 32-bit integer formats are handled explicitly.
- The mixed-output soft clipper is continuous at its piecewise boundary so louder summed samples cannot create a waveform step.
- The Web Audio bridge begins with a 50ms playout cushion, grows it up to 120ms after underruns, and slowly returns to the baseline. It discards new chunks when more than 200ms is already scheduled; it never resets the clock over queued audio.
- WebRTC audio sender encodings use `maxBitrate = 192000` and high network priority. Video has medium priority and a low SDP bitrate floor so congestion control can preserve audio.
- `MediaCoordinator` advertises Opus `stereo=1;sprop-stereo=1` in local offers and answers, including receive-only answers and parameterless Trystero negotiation. The global startup hook covers screen sharing, shared-browser media and detached relays. `opus/48000/2` alone defaults to a mono preference; the PCM bridge and playback gains already preserve independent channels.

### Selective Process-Level Audio Filtering
- **Modes**:
  - `full`: Captures all desktop sound via master render audio client.
  - `exclude`: Captures desktop sound but omits specific processes (e.g. Discord, Spotify, Chrome VoIP).
  - `include`: Captures sound strictly from designated processes (e.g. game window only).
- **Windows WASAPI Process Loopback (`VAD\Process_Loopback`)**:
  - Activated asynchronously via `ActivateAudioInterfaceAsync` using `AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS` with either `PROCESS_LOOPBACK_MODE_EXCLUDE` or `PROCESS_LOOPBACK_MODE_INCLUDE`.
  - **Mandatory Flag**: `IAudioClient::Initialize` strictly requires `AUDCLNT_STREAMFLAGS_LOOPBACK` even for process loopback interfaces. Omitting this flag triggers error `0x88890021` (`AUDCLNT_E_INVALID_STREAM_FLAG`), which causes the capture thread to abort into total silence.
  - **Resilient Fallback**: If process loopback activation fails, or target PID tree returns invalid handle, the loopback thread automatically falls back to master audio (`get_default_render_audio_client()`) rather than dropping to silence.
  - **48kHz Stereo WaveFormat Fallback**: If device mix format pointer is null or unqueryable, a 16-bit PCM 48kHz stereo `WAVEFORMATEX` is synthesized as a fallback.
- **Multi-Process Include Mode Loopback (`MultiCaptureSource`)**:
  - When the user selects multiple applications to transmit in `include` mode, `resolve_target_process_roots` discovers the unique top-level root PID for each candidate.
  - Audio process snapshots use `refresh_process_tree` with `ProcessRefreshKind::new()`: routing consumes names and parent PIDs only, without querying CPU, memory, disk or executable paths. Ancestor walks share a visited-PID iterator so stale/reused parent identifiers cannot create infinite loops. Portable regressions exercise cycle termination and the live process-root/exclusion entry points without requiring audio devices.
  - Rust activates an independent `IAudioClient` loopback interface for each target root PID, initializing them with shared stream flags and mix format.
  - In the capture loop, `WaitForMultipleObjects` waits concurrently across all client event handles with a 5ms timeout.
  - When packets arrive, each client's PCM frames are downmixed to stereo `f32` and digitally mixed with headroom and a continuous soft clipper.
  - The mixed stream is resampled to 48kHz and dispatched as a unified audio track, allowing users to broadcast multiple apps (e.g. Game + Discord + Spotify) simultaneously.

### Monotonic Microsecond A/V Timestamps
- Every audio chunk payload contains `timestamp_us` derived from `std::time::Instant` for diagnostics. Web Audio schedules PCM against its own `AudioContext.currentTime` clock.

---

## 2. Screen & Window Capture (`src-tauri/src/screen_sources.rs`)

### Direct Capture via `xcap`
- Captures monitors or individual top-level windows without requiring invasive display hooks.
- Enumerates available monitors (with resolution, primary flag, thumbnail) and open windows (filtered for system artifacts like Program Manager).

### Windows Capture Feature Compatibility

`start_wgc_capture` probes optional cursor and border properties before selecting
settings for either windows or monitors, including supervisor restarts. Windows 10
desktop build 19045 supports WGC but lacks `IsBorderRequired` (introduced in build
20348). Requesting `WithoutBorder` on that system aborts WGC initialization and
unnecessarily selects xcap/JPEG, losing GPU scaling and native encoding. Unsupported
properties retain OS defaults. `start_gpu_capture` prefers DXGI Desktop Duplication
for monitor sharing on systems without the optional border property. It matches
the selected HMONITOR to its DXGI output and creates the device on that output's
adapter. `video_dxgi.rs` converts BGRA to RGBA, restores display rotation and draws
color, masked-color and monochrome cursors on the GPU. Only pointer bitmaps cross
the CPU. The shared texture processor retains scaling, native encoders, pacing,
load feedback and JPEG fallback. Windows, hidden-cursor sessions and unsupported
duplication use WGC; those Windows 10 sessions may still show the OS capture border.
`P2SHARER_CAPTURE_BACKEND=wgc|dxgi` selects a diagnostic preference, without bypassing
compatibility fallback. Access loss uses the existing desktop recovery supervisor;
other duplication failures retire the producer and retry through WGC. Generic mode
uses GPU capture and available scaling without requiring NVIDIA or NVENC. It tries the Windows
hardware H264 encoder before the JPEG fallback. Real overload
adaptation remains enabled; fixing feature selection does not guarantee a specific
GPU's capture or browser encoder throughput.

Capture metrics identify the actual producer with `capture_backend`: 0 during
initialization, 1 for WGC, 2 for DXGI and 3 for xcap. Encoder counters remain shared
across GPU capture backends and supervisor generations.

### Multimedia Timer RAII Guard (`MultimediaTimerGuard`)
- Automatically calls `timeBeginPeriod(1)` upon capture initialization and `timeEndPeriod(1)` on drop.
- Forces Windows OS scheduler timer resolution to 1ms, ensuring steady 60â€“120 FPS capture timing without jitter.

### Local WebSocket Video Server & Direct GPU Pipeline
- For ultra-low latency native capture, Rust binds a loopback WebSocket server on an ephemeral port.
- Transmits compressed/raw frame buffers directly to the frontend's `NativeVideoBridge` without blocking Tauri's main IPC channel.
- Direct GPU capture is the official application pipeline: in-app screen and window selection dispatches directly via `NativeVideoBridge` without triggering Chromium's browser dialog (`getDisplayMedia`).
- Window capture authentication can complete before the first image, so a live track can be published without a decoded preview. Preview timeouts retain window sessions. Minimization preserves a working WGC producer or defers a failed startup without consuming restart retries; restoring the window recreates its producer while preserving the transport and track. xcap waits while minimized. Actual source closure signals terminal teardown. Terminal signals are retained per session for bridges that authenticate after closure, and the frontend replays closure to a publication handler attached after capture startup.
- On tested AMD hardware, wallpaper images appeared above board content in P2Sharer's local preview and transmitted frame while the actual Windows desktop remained correctly composed. Later validation confirmed that the normal WGC mode works after the capture and frame-queue changes, while the optional GDI compatibility mode flickers. Keep WGC as the normal capture path and do not expose the GDI mode.

---

## 3. WebView2 GPU Acceleration Arguments (`src-tauri/src/lib.rs`)

At application startup, before WebView2 initialization, Rust configures `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`:
- `--enable-gpu-rasterization`
- `--enable-zero-copy`
- `--ignore-gpu-blocklist`
- `--enable-accelerated-video-decode`
- `--enable-accelerated-video-encode`
- `--enable-webrtc-hw-h264-encoding`
- `--enable-webrtc-hw-vp8-encoding`
- `--enable-gpu-memory-buffer-video-frames`
- `--enable-features=WebRtcHardwareVideoEncoding,WebRtcHardwareVideoDecoding,AcceleratedVideoEncoder,AcceleratedVideoDecoder,MediaStreamTrackGenerator`
- `--enable-blink-features=MediaStreamTrackGenerator`
- `--disable-background-timer-throttling`
- `--disable-renderer-backgrounding`
- `--disable-backgrounding-occluded-windows`

These flags enable hardware acceleration where WebView2 and the GPU driver support it. They do not guarantee a hardware encoder for a particular codec/profile. Probe `navigator.mediaCapabilities.encodingInfo` with `type: "webrtc"` and verify real RTP encoding statistics rather than inferring hardware use from flags.

---

## 5. Windows Graphics Capture (WGC) & Fullscreen 3D Gaming Hardening

### DirectFlip / Independent Flip & MinimumUpdateInterval
- DirectX 11/12 and Vulkan games running in exclusive fullscreen or borderless window engage DirectFlip / Independent Flip (MPO hardware scanout bypass), bypassing DWM desktop composition.
- WGC uses a short 4 ms minimum update interval when supported, with the default on older Windows. A phase-preserving software deadline caps the requested cadence without resetting from GPU readback completion. Fullscreen/DirectFlip behavior and physical refresh rates require separate measurement.
- The capture test must report JPEG image frames separately from one-byte static heartbeat messages. Heartbeat throughput is not evidence of live capture FPS; a static desktop can produce many heartbeats and few new images.

### Transient DXGI Error Recovery in `on_frame_arrived`

Secure desktop switches (UAC and locking) pause capture without closing the sharing
session. `capture_recovery.rs` compares the input desktop with the capture thread's
desktop without switching desktops or requesting elevation. A per-session WGC
supervisor retires the old producer and recreates capture on return, preserving
the WebSocket sender, frame pacer, timestamps, H264 packet sequence and encoder settings and requesting
a new H264 keyframe. Closed callbacks defer terminal source-loss signals to the
supervisor. Session identity prevents a retired supervisor from replacing another
session with the same ID. xcap pauses its error counter and reacquires its source
after return. The protected desktop itself is not captured; real source loss and
persistent restart failure still end sharing. Interactive UAC verification is needed
in addition to the hardware-independent recovery-policy regressions.
- When a game launches, switches resolutions, or alters swapchain presentation formats, mapping Direct3D11 staging textures via `frame.buffer()` can temporarily fail with transient DXGI errors (`DXGI_ERROR_INVALID_CALL` or surface lock contention).
- In `windows-capture`, returning `Err` from `on_frame_arrived` immediately posts `WM_QUIT` and permanently terminates the capture loop.
- Handling `frame.buffer()` with `match` and returning `Ok(())` on transient error skips the single corrupted frame while keeping the WGC capture loop alive.

### Windows Game Mode & Process Priority (`HIGH_PRIORITY_CLASS`)
- Capture and encoding can compete with a game for CPU/GPU resources. Identify the constrained stage under measured game load rather than assuming a universal Game Mode effect.
- The current Rust source contains no `SetPriorityClass` implementation. CPU process priority is not a guarantee of GPU scheduling capacity; the former claim of guaranteed CPU/GPU slices under full game load was incorrect. Preserve this distinction when evaluating load adaptation or scheduling changes.

### Pacer Heartbeat De-confliction & WebCodecs Monotonic Timestamps
- The former idle-only heartbeat is superseded by the bounded native delivery pacer described below. Fresh images and cached repetition share one output thread and deadline; they do not race as independent producers in the default path.

---

## 6. Process Lifecycle & Atomic Child Teardown via Windows Job Object (`src-tauri/src/process_manager.rs`)

### Elimination of Orphan WebView2 Processes
- In Windows, child processes spawned by an application (including all `msedgewebview2.exe` renderer, GPU, utility, and crashpad processes) are not automatically terminated when the parent process exits unless managed by a Windows Job Object.
- At startup, P2Sharer binds to a session-named Windows Job Object (`Local\P2SharerSharedJobObject`) with `JOBOBJECT_EXTENDED_LIMIT_INFORMATION` and `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, assigning each instance to it via `AssignProcessToJobObject`.
- Because the Job Object is named across the local user session, concurrent instances share the job handle. When an earlier instance closes, the kernel preserves the shared WebView2 and media processes for the remaining instances. Only when the last instance closes does the kernel trigger `KILL_ON_JOB_CLOSE`, guaranteeing zero lingering zombie processes.

### Updater installer lifetime

Before the official updater launches its installer and exits, the held application job temporarily enables `JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK`. Existing media/WebView children retain `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`; failed preparation or installer launch restores ordinary containment. Otherwise the installer can inherit the application job and be killed on exit. This contract is covered by isolated native child-membership tests.

### Independent application instances

The application supports independent concurrent desktop processes for local peer testing. Each instance keeps its own session log. Process containment uses the shared Windows Job Object (`Local\P2SharerSharedJobObject`); closing either instance first preserves running child and WebView2 processes for active instances, tearing down cleanly when all instances exit. Covered by isolated native regression tests (`concurrent_instances_share_named_job_and_teardown_only_on_last_close`).

- In `NativeVideoBridge` (`src/video/native_video_bridge.ts`), incoming 1-byte dummy heartbeat ticks (`byteLength <= 4`) never overwrite real video frames (`pendingBuffer.byteLength > 4`) awaiting asynchronous decoding.
- WebCodecs `VideoFrame` timestamps are strictly checked and advanced (`nowUs > lastTimestampUs`) to prevent pipeline rejection.

## 7. Encoder Capability Selection and Receiver FPS

Before starting capture, `RoomService` calls `MediaCoordinator.prepareCodecPreferences` for the selected resolution, FPS, and bitrate. A bounded 1.5-second WebRTC media-capabilities probe ranks reported power-efficient encoders first, retaining the original hardware codec ordering within that group. When no encoder is reported power-efficient, VP8 precedes software H.264, VP9, and AV1. Missing capability APIs retain the legacy ordering. These capability reports are hints, not proof of a particular GPU encoder implementation.

Apply codec preferences immediately before offer/answer generation, including Trystero's parameterless `setLocalDescription`. Restrict local preferences to transceivers with an outgoing video track so receive-only answers preserve the broadcaster's codec order.

### Reusable Native JPEG Encoder

WGC and automatic xcap capture share `video_jpeg::RealtimeJpegEncoder`, backed by statically linked libjpeg-turbo through the `turbojpeg` crate. It preserves requested quality and 4:2:0 subsampling, keeps a compressor and output buffer across frames, and disables optimized entropy coding for real-time work. A decoder round-trip test checks RGBA color order and reuse across changing image sizes. Raw RGBA WebSocket transport was tested and rejected because the large local packets reduced measured FPS in this WebView2.

`NativeJpegDecoder` prefers WebCodecs `ImageDecoder` output directly as a
`VideoFrame`, preserving decoded video planes for the track writer instead of
converting JPEG through an RGB `ImageBitmap` and back to video. Missing or rejected
image decoding falls back to `createImageBitmap` for that capture generation.
Stopping closes pending decoders and discards late output; the bridge owns and
closes cached frames. JPEG preview frames do not register as native H264 senders.
Before track writes, decoded JPEG video planes are copied into reusable storage
and used to construct a frame with the live media timestamp. Cloning a still-image
frame with a new JS timestamp can leave Chromium's underlying media timestamp at
zero, causing irregular RTP/playout despite normal encoded FPS. Rebuild timed
frames for cached repeats too; preserve layout, crop, display size and color space.
Validate the complete capture/bridge/WebRTC path when changing this boundary;
native capture FPS alone does not measure JPEG decoding or browser encoding cost.

Building the vendored native library requires CMake and the existing MSVC C/C++ toolchain. NASM is required for x86 SIMD by the selected `require-simd` feature; do not silently package the slower scalar encoder. `.cargo/config.toml` selects a CMake toolchain setting `WITH_CRT_DLL=ON`, matching Rust's default MSVC runtime while keeping the JPEG library static. No separately installed JPEG DLL is required at runtime. Benchmark the full native path after encoder changes; a faster synthetic source alone is insufficient.

## Capture scaling, load, and pacing

`video_gpu_scale.rs` owns per-session GPU scaling and reusable staging resources; mapped guards release GPU resources. Aspect-fit bounds preserve portrait sources without upscaling. JPEG uses the shared `RealtimeJpegEncoder` directly on read-only mapped rows and their actual pitch. CPU row packing is needed only for legacy capture or the CPU resize fallback.

`video_load.rs` owns per-session runtime limits. Native processing and `bridge_load_meter.ts` feedback measure actual work and pending JPEG replacement; idle ticks do not indicate overload. Sustained pressure reduces scale before FPS, healthy windows restore one step, and generation tokens reject stale feedback. These runtime limits do not rewrite saved capture preferences or replace WebRTC congestion control.

`video_pacer.rs` uses a bounded two-entry ready queue, a cached image, and phase-preserving deadlines. Generic JPEG drops obsolete images under pressure; H264 retains admitted dependent pictures in FIFO order and skips source pixels before encoding when full. Missed deadlines do not generate catch-up bursts. Empty deadlines reuse the last image through a bridge tick; repeats do not represent fresh captured motion. `VideoFrameClock` preserves monotonic microsecond timestamps and resets per capture generation.

`MediaCoordinator.applySenderBitrate` serializes updates per peer connection and skips unnegotiated senders. Stable-signaling callbacks and startup retries apply settings when encodings exist; fabricating encodings before negotiation is unsafe.

## Native encoded publication

Automatic capture tries NVENC, then hardware-only Media Foundation, then JPEG. Generic skips the NVENC SDK but can use Media Foundation on compatible Intel, AMD, NVIDIA and integrated GPUs. JPEG retains browser WebRTC encoding. Native H264 is published through webrtc-rs RTP/DTLS-SRTP; WebCodecs supplies only the local preview. See [native-nvenc.md](native-nvenc.md) for selection, generation ownership, packet pacing, rate control, keyframe recovery, audio association, and fallback.

## Validation boundaries

`stream_pointer.rs` presents broadcaster annotations in a transparent DirectComposition
WebView. Click-through styles, capture exclusion, and visibility are applied on the
window's owning thread; the WebView readiness handshake cannot show an unprepared
surface. `capabilities/stream-pointer.json` grants event listen/unlisten to both
the legacy overlay label and session-specific overlay labels. Event subscription
must succeed before the readiness handshake; omitting that capability leaves the
overlay hidden and prevents cursor/drawing updates. Its compiled ACL is covered by
a native regression without granting window-control or updater permissions.
Broadcaster cursors and drawings remain visible independently of capture
exclusion support. Exclusion requires Windows 10 version 2004 (build 19041) or newer;
earlier versions do not receive `WDA_MONITOR`, which cannot remove that surface from
monitor capture. Unsupported or failed exclusion logs a warning once per overlay
lifecycle while preserving annotations; retransmission remains possible in that case.
Affinity readback verifies the OS flag, not the final captured pixels; cross-version
composition behavior still requires interactive verification.

Use production frame-pacer tests for deterministic timing invariants and explicit hardware checks for actual capture/driver behavior. Software cadence models and local RTP loopback do not establish physical high-refresh, game, remote Internet, or audio/video synchronization results. See [test instructions](../../test/README.md); application changes require the default Tauri packaging build.
