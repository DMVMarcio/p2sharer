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

### Multimedia Timer RAII Guard (`MultimediaTimerGuard`)
- Automatically calls `timeBeginPeriod(1)` upon capture initialization and `timeEndPeriod(1)` on drop.
- Forces Windows OS scheduler timer resolution to 1ms, ensuring steady 60–120 FPS capture timing without jitter.

### Local WebSocket Video Server & Direct GPU Pipeline
- For ultra-low latency native capture, Rust binds a loopback WebSocket server on an ephemeral port.
- Transmits compressed/raw frame buffers directly to the frontend's `NativeVideoBridge` without blocking Tauri's main IPC channel.
- Direct GPU capture is the official application pipeline: in-app screen and window selection dispatches directly via `NativeVideoBridge` without triggering Chromium's browser dialog (`getDisplayMedia`).
- Capture lifecycle signals (window minimized or closed) trigger native in-app toast alerts and clean teardown instead of spawning unexpected browser popups.
- On the user's AMD RX 5500 XT, wallpaper images appeared above board content in P2Sharer's local preview and transmitted frame while the actual Windows desktop remained correctly composed. The user later confirmed that the normal WGC mode works after the capture and frame-queue changes, while the optional GDI compatibility mode flickers. Keep WGC as the normal capture path and do not expose the GDI mode.

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
- Setting `MinimumUpdateIntervalSettings::Custom(...)` calls WinRT `SetMinUpdateInterval`, which relies on DWM compositor ticks. Under DirectFlip, DWM composition is dormant, causing frame arrival callbacks to stall or drop to ~0-1 FPS.
- The previous recommendation to always leave the WGC update interval at its default is superseded by the measured RTX 5070 / approximately 75 Hz result on 2026-10-01: default sessions delivered only 37.5 callbacks/second, even though readback plus compression took about 5.2 ms and the app discarded no frames. Use a short 4 ms WGC minimum interval when the Windows API supports it, retaining the default on older Windows. A phase-preserving deadline inside `on_frame_arrived` caps capture at the requested cadence without tying the next deadline to GPU readback completion. Callback jitter and monitor refresh rates that differ from the requested FPS must not reset the cadence on every accepted frame. The 4 ms configuration follows the same approach as [Sunshine's WGC backend](https://github.com/LizardByte/Sunshine/blob/master/src/platform/windows/display_wgc.cpp); it does not request 250 FPS JPEG encoding. Exclusive-fullscreen game behavior must be evaluated separately from the measured desktop animation.
- The capture test must report JPEG image frames separately from one-byte static heartbeat messages. Heartbeat throughput is not evidence of live capture FPS; a static desktop can produce many heartbeats and few new images.

### Transient DXGI Error Recovery in `on_frame_arrived`
- When a game launches, switches resolutions, or alters swapchain presentation formats, mapping Direct3D11 staging textures via `frame.buffer()` can temporarily fail with transient DXGI errors (`DXGI_ERROR_INVALID_CALL` or surface lock contention).
- In `windows-capture`, returning `Err` from `on_frame_arrived` immediately posts `WM_QUIT` and permanently terminates the capture loop.
- Handling `frame.buffer()` with `match` and returning `Ok(())` on transient error skips the single corrupted frame while keeping the WGC capture loop alive.

### Windows Game Mode & Process Priority (`HIGH_PRIORITY_CLASS`)
- Capture and encoding can compete with a game for CPU/GPU resources. Identify the constrained stage under measured game load rather than assuming a universal Game Mode effect.
- The current Rust source contains no `SetPriorityClass` implementation. CPU process priority is not a guarantee of GPU scheduling capacity; the former claim of guaranteed CPU/GPU slices under full game load was incorrect. Preserve this distinction when evaluating load adaptation or scheduling changes.

### Pacer Heartbeat De-confliction & WebCodecs Monotonic Timestamps
- The pacer thread monitors `last_sent_us` with a 100ms threshold (`static_timeout_us = 100_000`). While games deliver frames at 30-120 FPS, the pacer remains completely dormant and sends 0 competing WebSocket messages.

---

## 6. Process Lifecycle & Atomic Child Teardown via Windows Job Object (`src-tauri/src/process_manager.rs`)

### Elimination of Orphan WebView2 Processes
- In Windows, child processes spawned by an application (including all `msedgewebview2.exe` renderer, GPU, utility, and crashpad processes) are not automatically terminated when the parent process exits unless managed by a Windows Job Object.
- At startup, P2Sharer initializes a Windows Job Object with `JOBOBJECT_EXTENDED_LIMIT_INFORMATION` and `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, assigning the main process to it via `AssignProcessToJobObject`.
- When the parent process terminates (via window close, `std::process::exit(0)`, task manager, or unexpected crash), the Windows kernel atomically and immediately terminates all child processes in the job, guaranteeing zero lingering zombie processes.

### Single-Instance Enforcement
- Uses a local session named mutex (`Local\P2SharerSingleInstanceMutex`) via `CreateMutexW`.
- If an instance is already active, `GetLastError() == ERROR_ALREADY_EXISTS (183)`. The secondary launcher brings the existing window to focus via `FindWindowW` and `SetForegroundWindow`, exiting immediately to prevent duplicate parallel WebRTC and WebView2 instances.

- In `NativeVideoBridge` (`src/video/native_video_bridge.ts`), incoming 1-byte dummy heartbeat ticks (`byteLength <= 4`) never overwrite real video frames (`pendingBuffer.byteLength > 4`) awaiting asynchronous decoding.
- WebCodecs `VideoFrame` timestamps are strictly checked and advanced (`nowUs > lastTimestampUs`) to prevent pipeline rejection.


## 7. Encoder Capability Selection and Receiver FPS

Before starting capture, `RoomService` calls `MediaCoordinator.prepareCodecPreferences` for the selected resolution, FPS, and bitrate. A bounded 1.5-second WebRTC media-capabilities probe ranks reported power-efficient encoders first, retaining the original hardware codec ordering within that group. When no encoder is reported power-efficient, VP8 precedes software H.264, VP9, and AV1. Missing capability APIs retain the legacy ordering. These capability reports are hints, not proof of a particular GPU encoder implementation.

Apply codec preferences immediately before offer/answer generation, including Trystero's parameterless `setLocalDescription`. Restrict local preferences to transceivers with an outgoing video track so receive-only answers preserve the broadcaster's codec order.

Measured in the RX 5500 XT desktop WebView2 using a 1080p canvas and two independent real loopback receivers: H.264 produced approximately 23–24 decoded FPS with 20 ms encoding time per frame; VP8 produced approximately 56 decoded FPS with 5 ms encoding time per frame. All probed encoders were reported non-power-efficient on this installation. The native WGC/JPEG bridge must be measured separately; these canvas results do not establish native capture FPS or remote Internet throughput. Reproduce with `test/bench/video_loopback.ts` as described in `test/bench/README.md`.


### Reusable Native JPEG Encoder

WGC and automatic xcap capture share `video_jpeg::RealtimeJpegEncoder`, backed by statically linked libjpeg-turbo through the `turbojpeg` crate. It preserves requested quality and 4:2:0 subsampling, keeps a compressor and output buffer across frames, and disables optimized entropy coding for real-time work. A decoder round-trip test checks RGBA color order and reuse across changing image sizes. Raw RGBA WebSocket transport was tested and rejected because the large local packets reduced measured FPS in this WebView2.

Building the vendored native library requires CMake and the existing MSVC C/C++ toolchain. NASM is required for x86 SIMD by the selected `require-simd` feature; do not silently package the slower scalar encoder. `.cargo/config.toml` selects a CMake toolchain setting `WITH_CRT_DLL=ON`, matching Rust's default MSVC runtime while keeping the JPEG library static. No separately installed JPEG DLL is required at runtime. Benchmark the full native path after encoder changes; a faster synthetic source alone is insufficient.


### Desktop Measurements (RX 5500 XT, 2026-09-30)

With SIMD and the shared MSVC runtime, encoding the same 1920x1080 primary-monitor pixels at quality 90 took approximately 15.8 ms/frame in the previous Rust JPEG encoder and 5.7 ms/frame in libjpeg-turbo. The final native desktop loopback with two receivers measured approximately 49 encoded FPS and 49 decoded FPS per receiver at 1920x1080, with around 5.5 ms RTP encoding time per frame. This does not establish constant 60 FPS or delivery across the Internet. The video socket sets TCP_NODELAY to deliver partial frame tails promptly; the codec-only canvas test reached approximately 56 decoded FPS instead of the previous H.264 24 FPS.


### Sender Parameter Transactions and Remote Retest (2026-10-01)

The user confirmed that FPS normalized in a subsequent real remote test; this confirmation does not establish an exact constant frame rate or identify the original cause. Session logs also contained repeated RTCRtpSender `InvalidStateError` messages while applying transmission parameters. `MediaCoordinator.applySenderBitrate` now serializes parameter updates per peer connection and skips senders without negotiated encodings. Do not fabricate an encoding array before RTP negotiation. Reapply through the existing stable-signaling listener and startup retries once encodings are available. Regression tests cover overlapping updates and the transition from unnegotiated to negotiated senders. Codec selection remains unchanged after the successful remote retest.

### RTX 5070 Capture Cadence Diagnosis (2026-10-01)

The current host is an RTX 5070 (driver 32.0.16.1714), Ryzen 7 5700X3D, Windows 11 build 26100, 1920x1080 display at approximately 75 Hz (CIM reports 74). Do not reuse old RX 5500 XT hardware assumptions. Packaged production measurements reproduced 37.5 FPS: 37.3 WGC callbacks/second, zero application gate drops, approximately 0.48 ms readback and 4.70 ms JPEG compression per image. Therefore the measured ceiling precedes the local bridge and WebRTC encoder; it is not explained by JPEG processing time or app FPS gating.

With the supported short WGC update interval and the existing 60 FPS handler gate, a warmed four-second desktop sample measured 59.75 native image FPS / 59.95 H.264 decoded FPS with one receiver. With two independent local receivers: 60.10 native image FPS and 59.95 decoded FPS at 1920x1080 on each receiver, zero receiver frame drops and no sender quality limitation. Readback averaged 0.50 ms, compression 4.80 ms, and total native processing 5.29 ms. The encoder-only benchmark previously produced about 55.7 FPS with a quantized interval animation; requestAnimationFrame now avoids that input bottleneck. These results are local loopback, not a remote Internet performance guarantee or proof of a particular NVENC implementation.

`get_capture_metrics` exposes per-session cumulative counters for WGC callbacks, app gate drops, encoded images and stage microseconds. `test/bench/summarize_video_loopback.mjs` computes deltas and actual RTP rates without exposing capture screenshots. Ten optimized native screen-source tests now pass, including the formerly failing real-image FPS threshold, and 393 frontend tests pass. Run native unit tests with `cargo test --release --lib` and package last: all-target Cargo tests can rebuild a development-configured executable in the normal release directory. The final Tauri executable and MSI/NSIS packages were rebuilt and verified after tests.

### First Native Cost-Reduction Stage (2026-10-02)

On branch `refactor/streaming-system`, WGC sessions now own reusable staging textures (`video_readback.rs`) and GPU area-scaling resources (`video_gpu_scale.rs`). Scaling happens before CPU readback and uses the existing `fit_capture_dimensions` aspect-ratio policy. Shader/resource failures retain the CPU box resizer; three consecutive reusable-readback failures switch to the original native readback path. `P2SHARER_LEGACY_VIDEO_READBACK=1` forces the original readback/CPU-scaling path for controlled comparisons. The Windows bindings alias matches windows-capture's 0.62.2 bindings, separate from the host's existing 0.58 interfaces.

Preserve read/write staging semantics, library parallel packing, and direct access for rows without padding. Read-only mappings with direct strided JPEG encoding and unconditional serial RAM copying produced slower full-desktop results and were rejected. The shared JPEG encoder's strided method remains a diagnostic capability, not justification to bypass the measured pixel-packing path. Handler ownership and mapped guards release GPU resources; buffers are allocated lazily.

The measured 1080p-source/720p-output native pipeline on RTX 5070 took 5.14 ms/frame with CPU resizing versus 2.52 ms/frame with GPU resizing (repeat 2.37 ms), about 51% lower processing cost, with two real local H.264 receivers near 60 FPS and zero recorded drops. Warmed staging allocations dropped from 240 to zero in the four-second sample. CPU resize time fell from 2.46 ms to zero, and readback including GPU scale completion took about 0.32 ms. Decoded pixel samples verified nonblack content. At equal 1080p source/output resolution there was no clear total-time gain, so do not promise equivalent benefits for that case or heavy games.

GPU tests validate color/orientation, odd and portrait dimensions, weighted checkerboard averaging and synthetic 4K textures. Physical high-refresh/4K monitors, AMD/Intel hardware and Deadlock remain untested. Native hardware video encoding and JPEG removal are outstanding; load adaptation and frame regularity are subsequent independent stages. See [benchmark reproduction and results](../../test/bench/README.md).

Final packaged-binary confirmation after the invalid-size tests measured 2.80 ms/frame and 58.4–58.7 decoded FPS per receiver, with zero recorded drops, zero warmed allocations and nonblack decoded samples. Do not hide the variation between desktop runs. Frontend tests passed (408), native release library tests passed (31, two ignored), and the final targeted video tests passed (six, one ignored). Tauri build generated and verified the executable, MSI and NSIS bundles.
