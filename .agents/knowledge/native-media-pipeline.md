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
- `AudioResampler` maintains fractional phase accumulation across chunk boundaries to avoid audio clicks, pops, or drift during hours of streaming.

### Continuous FIFO Draining & Smooth Hann Half-Cosine Fade
- To prevent tail-end clicks ("mini-chiado") and stream stuttering ("como se fosse internet travando"):
  - Mixing ticks calculate dynamic frame counts: `tick_frames = (sample_rate * 10) / 1000` (`tick_floats = tick_frames * 2`).
  - Source FIFOs are never partially drained during active playback; only complete chunks are dispatched, preserving waveform continuity.
  - When all sources have been quiet for $\ge 50\text{ ms}$, residual samples are smoothly faded to zero using a $5\text{ ms}$ (240 samples) Hann half-cosine window ($0.5 \times (1.0 + \cos(\pi \times t))$) and zero-padded to `tick_floats`. This completely eliminates high-frequency spectral clicks and prevents stale audio from contaminating subsequent sounds.
  - WebRTC audio sender encodings are configured with `maxBitrate = 192000` (192 kbps high-fidelity stereo Opus) and `priority = 'high'`.

### Selective Process-Level Audio Filtering
- **Modes**:
  - `full`: Captures all desktop sound via master render audio client.
  - `exclude`: Captures desktop sound but omits specific processes (e.g. Discord, Spotify, Chrome VoIP).
  - `include`: Captures sound strictly from designated processes (e.g. game window only).
- **Windows WASAPI Process Loopback (`VAD\Process_Loopback`)**:
  - Activated asynchronously via `ActivateAudioInterfaceAsync` using `AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS` with either `PROCESS_LOOPBACK_MODE_EXCLUDE` or `PROCESS_LOOPBACK_MODE_INCLUDE`.
  - **Mandatory Flag**: `IAudioClient::Initialize` strictly requires `AUDCLNT_STREAMFLAGS_LOOPBACK` even for process loopback interfaces. Omitting this flag triggers error `0x88890021` (`AUDCLNT_E_INVALID_STREAM_FLAG`), which causes the capture thread to abort into total silence.
  - **Resilient Fallback**: If process loopback activation fails, or target PID tree returns invalid handle, the loopback thread automatically falls back to master audio (`get_default_render_audio_client()`) rather than dropping to silence.
  - **48kHz Stereo WaveFormat Fallback**: If device mix format pointer is null or unqueryable, a canonical IEEE float 48kHz stereo `WAVEFORMATEX` is synthesized as a fallback.
- **Multi-Process Include Mode Loopback (`MultiCaptureSource`)**:
  - When the user selects multiple applications to transmit in `include` mode, `resolve_target_process_roots` discovers the unique top-level root PID for each candidate.
  - Rust activates an independent `IAudioClient` loopback interface for each target root PID, initializing them with shared stream flags and mix format.
  - In the capture loop, `WaitForMultipleObjects` waits concurrently across all client event handles with a 20ms slice.
  - When packets arrive, each client's PCM frames are downmixed to stereo `f32` and digitally mixed: `mixed[i] = (chunk_a[i] + chunk_b[i]).clamp(-1.0, 1.0)`.
  - The mixed stream is resampled to 48kHz and dispatched as a unified audio track, allowing users to broadcast multiple apps (e.g. Game + Discord + Spotify) simultaneously.

### Monotonic Microsecond A/V Timestamps
- Every audio chunk payload contains `timestamp_us` derived from `std::time::Instant` or `QueryPerformanceCounter`.
- Enables monotonic audio playback synchronization in Web Audio without drifting behind video frames.

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

These flags force hardware-accelerated encoding/decoding via dedicated GPU video engines (NVENC/AMF/QuickSync) and zero-copy texture transfer within Chromium, preventing WebRTC from falling back to CPU software encoders (OpenH264/libvpx).

---

## 5. Windows Graphics Capture (WGC) & Fullscreen 3D Gaming Hardening

### DirectFlip / Independent Flip & MinimumUpdateInterval
- DirectX 11/12 and Vulkan games running in exclusive fullscreen or borderless window engage DirectFlip / Independent Flip (MPO hardware scanout bypass), bypassing DWM desktop composition.
- Setting `MinimumUpdateIntervalSettings::Custom(...)` calls WinRT `SetMinUpdateInterval`, which relies on DWM compositor ticks. Under DirectFlip, DWM composition is dormant, causing frame arrival callbacks to stall or drop to ~0-1 FPS.
- Always use `MinimumUpdateIntervalSettings::Default` on WGC capture sessions. Software rate-limiting (`min_frame_interval = 1s / (fps * 2)`) inside `on_frame_arrived` handles framerate capping without DWM dependencies.

### Transient DXGI Error Recovery in `on_frame_arrived`
- When a game launches, switches resolutions, or alters swapchain presentation formats, mapping Direct3D11 staging textures via `frame.buffer()` can temporarily fail with transient DXGI errors (`DXGI_ERROR_INVALID_CALL` or surface lock contention).
- In `windows-capture`, returning `Err` from `on_frame_arrived` immediately posts `WM_QUIT` and permanently terminates the capture loop.
- Handling `frame.buffer()` with `match` and returning `Ok(())` on transient error skips the single corrupted frame while keeping the WGC capture loop alive.

### Windows Game Mode & Process Priority (`HIGH_PRIORITY_CLASS`)
- Windows Game Mode deprioritizes background applications when a 3D game launches, which can starve capture and encoding threads.
- Setting `SetPriorityClass(GetCurrentProcess(), HIGH_PRIORITY_CLASS)` on capture startup and restoring `NORMAL_PRIORITY_CLASS` on teardown guarantees CPU and GPU scheduling slices even under 100% game load.

### Pacer Heartbeat De-confliction & WebCodecs Monotonic Timestamps
- The pacer thread monitors `last_sent_us` with a 100ms threshold (`static_timeout_us = 100_000`). While games deliver frames at 30-120 FPS, the pacer remains completely dormant and sends 0 competing WebSocket messages.
- In `NativeVideoBridge` (`src/video/native_video_bridge.ts`), incoming 1-byte dummy heartbeat ticks (`byteLength <= 4`) never overwrite real video frames (`pendingBuffer.byteLength > 4`) awaiting asynchronous decoding.
- WebCodecs `VideoFrame` timestamps are strictly checked and advanced (`nowUs > lastTimestampUs`) to prevent pipeline rejection.
