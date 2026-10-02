# Local WebRTC file transfer benchmark

Run `npx vite --host 127.0.0.1 --port 1420`, then open `http://127.0.0.1:1420/test/bench/chat_file_webrtc.html?mib=55` in a Chromium-based browser. The result appears on the page as JSON.

To collect results without browser automation, start `node test/bench/result_receiver.mjs` first. The page sends only its final benchmark JSON to that local listener on `127.0.0.1:1421`; the listener prints it to the terminal.

The page connects two actual RTCPeerConnections through local ICE. It measures a raw data channel with the Trystero-style 64 KiB backpressure threshold, the same channel with a larger buffer, and the installed Trystero action-wire carrying P2Sharer's signed binary chunks and acknowledgments. It then repeats the signed transfer after applying the app's 1 MiB channel window and once more on the negotiated dedicated bulk channel with signed acknowledgments on the room channel. The signed test converts chunks to and from base64 to approximate Tauri IPC, validates each digest and signature, and validates the final file digest.

This is a network reproduction, not a full Tauri desktop test. Native file selection, consent UI, Rust IPC, disk I/O, and a remote peer route are outside its scope. Compare the raw and signed rates to isolate application overhead from WebRTC transport cost. A local loopback result cannot establish the route or throughput of another participant's internet connection.

## Desktop video loopback

Start `npm run tauri:dev -- --release --no-watch` and run the following in the desktop WebView2 developer console:

```js
const { runVideoLoopback } = await import('/test/bench/video_loopback.ts');
const result = await runVideoLoopback({ pipeline: 'native', peers: 2, probe: true });
console.log(result);
```

Close the desktop app before running a packaging build. The native benchmark temporarily keeps the desktop window above other windows and restores its previous setting afterward. The benchmark animates a 1920x1080 canvas, captures `screen:0` through the Rust WGC/image/WebSocket bridge, and sends the resulting track through independent real WebRTC loopback connections. Ensure the desktop window is visible on the selected monitor. `pipeline: 'canvas'` isolates encoding from native capture. `probe: true` applies the production encoder capability selection; use a fresh app instance with `probe: false` for the legacy codec order.

Compute FPS from the differences between `before` and `after` frame counters and timestamps, rather than counting static heartbeat messages. `captureBefore`/`captureAfter` separate full native image messages from cached-frame heartbeats. The benchmark runs sender and receivers on the same PC; it cannot validate another participant's network, decoder, or Internet route.

The animation uses requestAnimationFrame so a quantized setInterval timer cannot cap the benchmark's input below 60 FPS. For native runs, `nativeBefore`/`nativeAfter` expose per-session WGC callbacks, gate drops, image counts, GPU readback, JPEG compression and total processing microseconds. Compute timings from counter deltas divided by the image delta. This separates Windows capture cadence from WebView/encoder throughput.

Use `cargo test --release --lib screen_sources::tests -- --test-threads=1` for optimized native unit checks, and finish with `npm run tauri:build` before launching the packaged application. Running all Cargo test targets can rebuild the application binary without Tauri's production feature configuration in the same release directory.


### JPEG encoding benchmark and native build prerequisites

The native JPEG encoder requires CMake, MSVC C/C++ tools, and NASM on PATH for its SIMD implementation. The JPEG library is statically linked into the app, so recipients do not need these build tools. Do not disable `require-simd` to work around a missing assembler; install NASM before building.

Run `cargo run --release --manifest-path src-tauri/Cargo.toml --example jpeg_encode_bench` to compare the previous Rust JPEG encoder with the new encoder using the same primary-monitor pixels, quality 90, and 4:2:0 sampling. This measures compression cost only; it does not measure WGC or WebRTC delivery.


Historical adapter measurements (hardware-dependent):

| Measurement | Result |
| --- | --- |
| Canvas, legacy H.264, two receivers | 23–24 decoded FPS at 1080p |
| Canvas, automatic VP8 fallback, two receivers | About 56 decoded FPS at 1080p |
| Full native pipeline, final fixes, two receivers | About 49 decoded FPS per receiver at 1080p |
| Same monitor JPEG pixels, previous encoder / SIMD libjpeg-turbo | 15.8 / 5.7 ms per frame |

These local measurements do not prove constant 60 FPS or a remote Internet result.

### Historical adapter validation

Historical measurements used an NVENC-capable Windows adapter. Re-measure the current test environment.

| Measurement | Default WGC interval | Short WGC interval with 60 FPS application gate |
| --- | --- | --- |
| Real native image frames | About 37.5 FPS | About 60 FPS |
| One local receiver, decoded 1080p | About 37.3 FPS | 59.95 FPS |
| Two local receivers, decoded 1080p each | Not sampled | 59.95 FPS each, zero dropped frames |

Baseline WGC callbacks were only 37.3 FPS with zero application gate drops; GPU readback took 0.48 ms and JPEG compression 4.70 ms per image. Changing the supported Windows update interval to 4 ms raised WGC delivery to approximately 75 callbacks/second, while the existing phase-preserving handler kept JPEG/transport output at 60 FPS. This does not require encoding at 250 FPS.

Summarize saved benchmark results with `node test/bench/summarize_video_loopback.mjs result.json`. These local measurements do not establish another participant's decoder/network performance or exclusive-fullscreen game behavior.
