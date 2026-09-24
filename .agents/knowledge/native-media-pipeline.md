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

### Selective Process-Level Audio Filtering
- **Modes**:
  - `full`: Captures all desktop sound.
  - `exclude`: Captures desktop sound but omits specific processes (e.g. Discord, Spotify, Chrome VoIP).
  - `include`: Captures sound strictly from designated processes (e.g. game window only).
- Matches by process ID (PID) and executable name (case-insensitive).
- Uses `process_manager.rs` to discover processes and detect common voice/chat applications automatically.

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

### Local WebSocket Video Server
- For ultra-low latency native capture, Rust binds a loopback WebSocket server on an ephemeral port.
- Transmits compressed/raw frame buffers directly to the frontend's `NativeVideoBridge` without blocking Tauri's main IPC channel.
- If WebSocket streaming fails or user prefers browser capture, `NativeVideoBridge` falls back seamlessly to `navigator.mediaDevices.getDisplayMedia`.

---

## 3. WebView2 GPU Acceleration Arguments (`src-tauri/src/lib.rs`)

At application startup, before WebView2 initialization, Rust configures `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`:
- `--enable-gpu-rasterization`
- `--enable-zero-copy`
- `--ignore-gpu-blocklist`
- `--enable-features=WebRtcHardwareVideoEncoding,WebRtcHardwareVideoDecoding`

These flags force hardware-accelerated encoding/decoding and zero-copy texture transfer within Chromium.

---

## 4. Diagnostics & Logging (`src-tauri/src/logger.rs`)

- Rotates two log files in `%APPDATA%\p2sharer\logs`:
  - `latest.log`: Current active session.
  - `previous.log`: Previous session backup.
- Exposes Tauri commands `open_log_folder`, `open_latest_log`, and `write_frontend_log`.
- Frontend logs are forwarded to this single canonical file for full-stack diagnostics.
