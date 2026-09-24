---
name: native-media-pipeline
description: Governs native Windows WASAPI audio loopback, ITU-R BS.775 downmix, 48kHz resampler, process filtering, xcap GPU screen/window capture, and WebSocket video streaming.
---

# Skill: Native Media Pipeline

## Scope
Applies to native audio and video capture pipelines spanning Rust backend (`src-tauri/src/*`) and TypeScript bridges (`src/audio/*`, `src/video/*`).

## Directives
1. **WASAPI Loopback Latency**: Keep the WASAPI capture loop strictly event-driven with `SetEventHandle`. Never introduce sleep polling.
2. **ITU-R BS.775 Downmixing**: Downmix multi-channel audio (5.1 / 7.1) to stereo using calibrated $-3\text{ dB}$ center/surround coefficients and clamp samples within $[-1.0, 1.0]$.
3. **Resampler Phase Continuity**: Preserve fractional phase accumulation across chunk boundaries in `AudioResampler` to prevent clicks, pops, or clock drift.
4. **Process Audio Filtering**: Support `full`, `exclude`, and `include` modes matching by PID and normalized executable name.
5. **GPU Timer Precision**: Maintain the RAII `MultimediaTimerGuard` (`timeBeginPeriod(1)` / `timeEndPeriod(1)`) around native video captures.
6. **Hardware Acceleration Flags**: Ensure WebView2 GPU flags (`--enable-gpu-rasterization`, `--enable-zero-copy`, `--enable-features=WebRtcHardwareVideoEncoding,WebRtcHardwareVideoDecoding`) are preserved in `lib.rs`.
