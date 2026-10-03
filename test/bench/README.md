# Manual media diagnostics

These diagnostics exercise real transports or native media paths. They are explicit developer tools, outside `pnpm test` and the default native suite. Measurements depend on current hardware, display cadence, drivers and load; no recorded personal machine baseline is required.

## Browser file transfer

Run `pnpm exec vite --host 127.0.0.1 --port 1420`, then open `http://127.0.0.1:1420/test/bench/chat_file_webrtc.html?mib=55` in Chromium. Optional collection: `node test/bench/result_receiver.mjs`, bound to loopback only.

The page connects actual local RTCPeerConnections and compares raw data channels, Trystero action-wire and signed chunk/acknowledgement transfers, validating digests and signatures. It does not cover native file selection, consent UI, Rust IPC, disk access or remote Internet performance.

## Desktop video and media

Start `pnpm run tauri:dev --release --no-watch` and load the modules in the desktop WebView2 developer console. These checks require capture permission and an interactive Windows desktop. Keep the benchmark window visible on the selected monitor. Source selection enumerates the current machine's monitors and defaults to its primary monitor; provide `sourceId` (or a function's `requestedSource` argument) to choose another enumerated source.

```js
const { runVideoLoopback } = await import('/test/bench/video_loopback.ts');
await runVideoLoopback({ pipeline: 'native', peers: 2, probe: true });
// A browser canvas source isolates encoding from native capture.
await runVideoLoopback({ pipeline: 'canvas', peers: 2 });

const { runMultipleMediaLoopback, runPointerIsolation } =
  await import('/test/bench/multiple_media_loopback.ts');
await runMultipleMediaLoopback();
await runPointerIsolation();
```

`video_loopback.ts` measures actual native JPEG/WebSocket capture, WebRTC encoding and receiver counters. `multiple_media_loopback.ts` checks Trystero media identity, independent source teardown and portrait dimensions. Its camera track is animated synthetic video by default; `{ cameraMode: 'device' }` explicitly requires a camera and permission. Pointer isolation checks independent native pointer windows.

`native_rtp_loopback.ts` exposes `runNativeRtpLoopback({ peers: 2, lifecycle: true, detail: true })` for actual native H264 RTP routing, receiver decoding, recovery, restart and fallback. `nvenc_lifecycle.ts` exposes `runNvencLifecycle()` and `runNvencVisualCheck()` for encoder lifecycle and decoded color/orientation. These NVENC paths require a compatible NVIDIA GPU, current driver and WebCodecs H264 decoding. Check the application's native encoder support and choose the NVENC preference before running them. Unsupported hardware is not evidence of an application regression.

For two desktop processes with distinct WebView profiles, `native_rtp_room.ts` supplies `joinNativeRtpRoom(roomId, password, name)`, `publishNativeRtpRoom(requestedSource?)`, statistics, selective teardown and encoder fallback. Use fresh diagnostic identifiers supplied at runtime, then call `closeNativeRtpRoom()` in both processes.

`stream_playback_continuity.ts` mounts canonical React room cards. In both desktop processes call `joinPlaybackRoom(room, password, name)` with the same fresh room and distinct names. On the sender call `publishPlaybackSources(requestedSource?)`; on the receiver call `validatePlaybackContinuity()`. It validates stable media elements, presence cycles, pointing, nonblack frames, native PiP restore and synthetic Web Audio continuity. Call `closePlaybackRoom()` in both processes afterward. This check does not establish WASAPI fidelity or WAN throughput.

## Native fixtures and timing

Native builds require the documented MSVC/CMake/NASM prerequisites. Always keep the normal Cargo target directory.

- `cargo run --release --manifest-path src-tauri/Cargo.toml --example jpeg_encode_bench` compares JPEG encoders using captured primary-monitor pixels; it requires a visible desktop.
- `cargo run --release --manifest-path src-tauri/Cargo.toml --example video_readback_bench` measures actual D3D11 readback on the available adapter.
- `node test/bench/summarize_video_loopback.mjs result.json` summarizes saved frame and timing counter deltas. Keep result files outside Git.

NVENC quality and motion fixtures are ignored native tests. Run an individual named test with `pnpm run test:native --release <test-name> -- --ignored --test-threads=1`. Optional `P2SHARER_NVENC_QUALITY_DIR` exports packets and reference pixels; choose an ignored directory under `src-tauri/target/`. `nvenc_quality.ts` exposes `measureNvencDetail(base64, validate, motion1080)` to decode those fixtures, check dimensions, keys, sequence continuity and detail across bitrate changes. Static synthetic detail is not a game-fidelity benchmark.

Compare fresh sender/receiver counter deltas and frame intervals; cached heartbeats are not newly captured frames. Local peers share the same machine and cannot prove another participant's decoder or network performance. Close the desktop application before the required `pnpm run tauri:build` packaging validation. Never commit captures, packet exports, logs, credentials or personal hardware reports.
