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

Close the desktop app before running a packaging build. The native benchmark temporarily maximizes the desktop window and keeps it above other windows, restoring both previous settings afterward. The benchmark animates a 1920x1080 canvas, captures `screen:0` through the Rust WGC/image/WebSocket bridge, and sends the resulting track through independent real WebRTC loopback connections. Ensure the desktop window is visible on the selected monitor. `pipeline: 'canvas'` isolates encoding from native capture. `probe: true` applies the production encoder capability selection; use a fresh app instance with `probe: false` for the legacy codec order.

Compute FPS from the differences between `before` and `after` frame counters and timestamps, rather than counting static heartbeat messages. `captureBefore`/`captureAfter` separate full native image messages from cached-frame heartbeats. The benchmark runs sender and receivers on the same PC; it cannot validate another participant's network, decoder, or Internet route.

The animation uses requestAnimationFrame so a quantized setInterval timer cannot cap the benchmark's input below 60 FPS. For native runs, `nativeBefore`/`nativeAfter` expose per-session WGC callbacks, gate drops, image counts, GPU readback, JPEG compression and total processing microseconds. Compute timings from counter deltas divided by the image delta. This separates Windows capture cadence from WebView/encoder throughput.

Use `cargo test --release --lib screen_sources::tests -- --test-threads=1` for optimized native unit checks, and finish with `npm run tauri:build` before launching the packaged application. Running all Cargo test targets can rebuild the application binary without Tauri's production feature configuration in the same release directory.


### JPEG encoding benchmark and native build prerequisites

The native JPEG encoder requires CMake, MSVC C/C++ tools, and NASM on PATH for its SIMD implementation. The JPEG library is statically linked into the app, so recipients do not need these build tools. Do not disable `require-simd` to work around a missing assembler; install NASM before building.

Run `cargo run --release --manifest-path src-tauri/Cargo.toml --example jpeg_encode_bench` to compare the previous Rust JPEG encoder with the new encoder using the same primary-monitor pixels, quality 90, and 4:2:0 sampling. This measures compression cost only; it does not measure WGC or WebRTC delivery.


Recorded RX 5500 XT / WebView2 measurements on 2026-09-30:

| Measurement | Result |
| --- | --- |
| Canvas, legacy H.264, two receivers | 23–24 decoded FPS at 1080p |
| Canvas, automatic VP8 fallback, two receivers | About 56 decoded FPS at 1080p |
| Full native pipeline, final fixes, two receivers | About 49 decoded FPS per receiver at 1080p |
| Same monitor JPEG pixels, previous encoder / SIMD libjpeg-turbo | 15.8 / 5.7 ms per frame |

These local measurements do not prove constant 60 FPS or a remote Internet result.

### RTX 5070 validation (2026-10-01)

Windows 11 build 26100, NVIDIA driver 32.0.16.1714, Ryzen 7 5700X3D, approximately 75 Hz / 1920x1080 display. Packaged native capture at quality 90, 60 FPS and 15 Mbps H.264 was sampled for four seconds after eight seconds of warmup.

| Measurement | Default WGC interval | Short WGC interval with 60 FPS application gate |
| --- | --- | --- |
| Real native image frames | About 37.5 FPS | About 60 FPS |
| One local receiver, decoded 1080p | About 37.3 FPS | 59.95 FPS |
| Two local receivers, decoded 1080p each | Not sampled | 59.95 FPS each, zero dropped frames |

Baseline WGC callbacks were only 37.3 FPS with zero application gate drops; GPU readback took 0.48 ms and JPEG compression 4.70 ms per image. Changing the supported Windows update interval to 4 ms raised WGC delivery to approximately 75 callbacks/second, while the existing phase-preserving handler kept JPEG/transport output at 60 FPS. This does not require encoding at 250 FPS.

Summarize saved benchmark results with `node test/bench/summarize_video_loopback.mjs result.json`. These local measurements do not establish another participant's decoder/network performance or exclusive-fullscreen game behavior.

### High-refresh deadline validation (2026-10-01)

The current primary display exposes at most 75 Hz through Win32 EnumDisplaySettings; no physical 120/144/165/240 Hz mode is available on this host. The earlier packaged 75 Hz measurement remains the physical validation. Do not describe synthetic results as high-refresh hardware validation.

Run `node test/bench/check_capture_cadence.mjs` from the repository root with Rust installed. The diagnostic extracts the current Rust rejection/deadline-update blocks and compiles them into an isolated timestamp-driven harness under the ignored standard target directory. Each case represents 60 seconds of ideal callbacks, with and without alternating 1 ms arrival delays. It asserts the expected average cadence for 60/75/120/144/165/240 Hz sources at 60 and 120 FPS targets. This assumes every accepted frame can be processed before subsequent callbacks; it does not exercise WGC's 4 ms minimum interval, frame readback failures, processing, a GPU, VRR, game presentation, WebView2, network or decoding.

At 120/144/165/240 Hz, the modeled output maintains 60 and 120 FPS. At 60/75 Hz, a 120 FPS target is limited by available source updates. Without jitter, 144 Hz to 60 FPS alternates gaps of 13.89 and 20.83 ms, and 165 Hz to 60 FPS has 12.12 and 18.18 ms gaps. Exact average FPS does not imply uniform frame intervals. A future output pacer must evaluate the latency tradeoff of waiting for the next deadline and repeating the latest frame; repeated frames do not represent newly captured motion.

Physical validation remains outstanding for high-refresh hardware, variable refresh, exclusive fullscreen, heavy games and non-NVIDIA adapters. Measure native callbacks/images and stage timings alongside encoded/decoded RTP counters and frame interval percentiles; record display rate, driver, GPU, codec, stream count and game load.

### Native video cost reduction (2026-10-02)

The first implementation stage preserves WGC, the application's picker, the JPEG/WebView bridge and WebRTC. `video_readback.rs` owns one reusable staging texture per capture session, keyed by source device, geometry and format, and retains the capture library's read/write mapping and parallel pixel packing. Three consecutive reusable-readback errors select the legacy native path. GPU resources are released with the handler; CPU packing storage is allocated lazily.

`video_gpu_scale.rs` performs weighted area downscaling on the capture device before readback. It preserves the shared aspect-fit dimensions and skips scaling when the source is already within the requested bounds. Shaders and input/output textures are reused. Unsupported shader/resource creation falls back to the existing CPU box resizer without requesting browser capture. GPU tests exercise landscape, portrait, odd dimensions, synthetic 4K textures, checkerboard averaging, and invalid output sizes. These tests do not establish physical 4K or AMD/Intel validation.

For a controlled desktop comparison, set `P2SHARER_LEGACY_VIDEO_READBACK=1` before launching the app to use the former allocation/CPU-resize path. Unset it for the default GPU path. In a fresh desktop instance, run `runVideoLoopback({pipeline:'native', peers:2, probe:true, hideReceivers:true, resolution:{width:1280,height:720}})`. Hiding the receiver thumbnails prevents recursive capture of those thumbnails. `visualChecks` samples source/decoded RGB ranges and rejects black receivers. `staging_allocations`, `readback_errors`, `resize_us` and `gpu_scaled_images` extend the native metrics. Readback time includes GPU scaling submission and completion; it is not a standalone GPU execution timer.

On the RTX 5070 / approximately 75 Hz / 1920x1080 desktop, two local H.264 receivers at 1280x720 and 60 FPS, quality 90 and 15 Mbps:

| Measurement | Legacy native path | GPU downscale + reusable readback |
| --- | --- | --- |
| Total native processing | 5.14 ms/frame | 2.52 ms/frame (repeat: 2.37 ms) |
| CPU resize | 2.46 ms/frame | 0 ms/frame |
| Readback, including GPU scaling on the new path | 0.46 ms/frame | 0.32 ms/frame |
| JPEG | 2.20 ms/frame | 2.19 ms/frame |
| Staging allocations in the warmed 4-second sample | 240 | 0 |
| Decoded receiver FPS | About 60 each | About 60 each, zero recorded drops |

The measured processing reduction is approximately 51% for this downscaling case, not a universal FPS increase or a Deadlock result. Source and output both at 1080p showed no clear total-processing improvement; resource churn is still reduced. Read-only mapped JPEG input and forced serial CPU packing were tested and rejected after slower full-desktop results, despite attractive isolated measurements. Do not reintroduce them based only on the isolated `video_readback_bench` example. The final path retains the library's pixel-access semantics.

Native NVENC/AMF/VPL encoding and removal of the JPEG bridge are not implemented by this stage. Load adaptation and frame pacing remain separate next stages; do not report the overall optimization sequence as complete.

The final packaged binary was checked again after the invalid-size guard tests and desktop build: 2.80 ms/frame, approximately 58.4–58.7 decoded FPS per receiver, zero recorded drops, zero warmed staging allocations and nonblack decoded samples. Desktop content and load varied between runs; retain this variation when reporting the earlier controlled comparison.

### Native capture load adaptation (2026-10-02)

Native capture now uses per-session runtime bounds rather than changing the user's settings. Two consecutive two-second overload windows reduce resolution to 85/70/55 percent before reducing FPS to 75/50 percent of the requested rate (minimum 15 FPS). Overload means average native processing above 80% of the current frame budget or measured bridge decode/write pressure above 80. Pending JPEG replacement also contributes to bridge pressure. Five consecutive healthy windows below 45% restore one step, at least ten seconds apart. Static heartbeat ticks and sparse samples do not drive quality reductions; low callback FPS alone does not imply processing overload. WGC and xcap share the controller; native capture/picker and JPEG quality remain unchanged.

`get_capture_metrics().load` reports requested/effective FPS, resolution scale, actual output dimensions, adjustment count and reason. The bridge feedback token is renewed on every start and checked natively; delayed feedback cannot affect a replacement capture. No CPU/GPU vendor-name heuristic or total-GPU-utilization poll is involved. This stage does not directly monitor WebRTC encoder-only pressure or change its existing network congestion control.

In packaged Tauri WebView2, run `runVideoLoopback({pipeline:'native', peers:2, probe:true, hideReceivers:true, resolution:{width:1280,height:720}, loadScenario:true})`. The diagnostic adds an independent 640x360/30 FPS capture, injects a 100 ms track-writer delay for six seconds, then checks recovery for 26 seconds. It asserts degradation/recovery and zero adjustments to the second session. Use `loadScenario:'sustained'` for 22 seconds of pressure and 54 seconds of recovery, also asserting the 30 FPS fallback. These deliberate delays exercise the real capture/bridge/RTC path but do not emulate game GPU scheduling.

The brief-load RTX 5070 / 75 Hz run stepped 1280x720 -> 1088x612 -> 896x504 -> 1088x612 -> 1280x720. FPS stayed at the requested 60; the independent capture had zero adjustments. Final local receivers decoded about 60.1 FPS each, with zero recorded drops and nonblack sampled content; native processing averaged 2.46 ms/frame. Feedback windows introduce a bounded response delay; one additional reduction can occur shortly after injected pressure is removed. Do not claim instantaneous recovery or a Deadlock performance gain from this test.

The sustained run reached 704x396/45 FPS at about 16 seconds and 704x396/30 FPS at about 20 seconds. After pressure removal at 22 seconds, it restored FPS to 45/60 before restoring resolution to 896x504, 1088x612 and 1280x720, completing recovery at about 76 seconds. The second capture had zero adjustments throughout. Final native images measured 59.73 FPS, both receivers 59.95 FPS with zero recorded drops and nonblack pixels, and native processing averaged 2.39 ms/frame. The final four-second measurement is taken after recovery; the deliberately delayed writer limits receiver delivery during injection and is not a performance comparison.

### Native delivery pacing (2026-10-02)

The default native path delivers through a bounded two-image queue on deadlines at the current effective FPS. Set `P2SHARER_LEGACY_VIDEO_PACING=1` before launching a fresh desktop instance to compare immediate image delivery. Keep source content, maximized window, output size, quality, codec and receiver count equal. Use the native 720p options above; the diagnostic now reports `cadence.websocketImages`, `cadence.trackWrites` and receiver callback media/display intervals. `fps:120` changes capture/probe/sender targets, but does not turn a 75 Hz source into 120 fresh images per second.

Controlled packaged same-binary measurements on the RTX 5070 / 75 Hz desktop:

| Measurement | Immediate images | Paced images |
| --- | --- | --- |
| Track-write interval median / p95 / p99 | 13.5 / 27.1 / 27.7 ms | 16.7 / 18.4 / 19.1 ms |
| JPEG arrival interval p95 | 27.0 ms | 18.2 ms |
| Local decoded FPS per receiver | 60.19 | 59.86 |
| JPEG bytes per image | 34,492 | 34,480 |
| Mean ready-image queue wait | 0 ms | 23.76 ms |

The paced four-second sample had zero queue drops, missed deadlines, repeats and receiver drops. This improvement is encoder-input interval regularity, with an added queue-latency tradeoff; it does not establish remote display smoothness or game performance. Queue age starts after JPEG readiness and excludes capture/processing/network/decode time. The maximum-age metric is a session lifetime maximum, not a sampled-window delta.

The summarizer reports fresh paced FPS separately from cached repeats and refresh JPEGs. Hidden receiver callbacks can skip frames even while RTP reports 60 decoded FPS; callback media/display intervals are sampled presentation evidence, not a complete frame log. Display intervals naturally quantize to the physical monitor refresh rate. Physical 120/144/165/240 Hz, VRR, exclusive fullscreen and other adapters still require hardware tests. `cargo test --release --lib video_pacer::tests` covers queue bounds, deadline stalls, adaptive FPS and 24 synthetic source/target/jitter combinations. Finish with a Tauri build before packaged desktop tests.

The final packaged sustained-load run reduced to 704x396/30, recovered full 720p/60 at approximately 76 seconds, and left the second capture unchanged. After recovery: 59.95 decoded FPS each, no recorded drops/readback errors, track-write p95 17.9 ms and mean queue wait 15.05 ms. A separate `fps:120` run on the physical 75 Hz source measured 74.74 fresh native FPS, 44.85 cached ticks/second, 120.15 decoded FPS each and no recorded receiver drops. Track-write p95 was 12.2 ms, above the 8.33 ms target interval: jitter remains. This higher decoded count includes repeated motion and cannot validate a physical high-refresh monitor.

### Optional native NVENC (2026-10-02)

Close the app and launch a fresh packaged process with `P2SHARER_NATIVE_NVENC=1` in
its environment to select the experimental native H264 bridge. Unset the variable
or use `0` for the default generic path. Run the same maximized 720p/60, quality 90,
15 Mbps, two-receiver benchmark above. `nvenc_images` must increase and native JPEG
and readback deltas must be zero to establish that the hardware path was actually
used. `get_native_encoder_support` reports driver API availability, not successful
capture-device initialization. Keep codec, source content, resolution and stream
count equal across fresh-process comparisons.

From PowerShell in the repository root, with the desktop app closed:

```powershell
$env:P2SHARER_NATIVE_NVENC = '1'
& '.\src-tauri\target\release\p2sharer.exe'
```

Use `0` and launch a fresh process to return to the default. This opt-in is not a
persisted application setting.

This uses the NVIDIA driver API on GPU textures, then locally decodes H264 and uses
the existing WebRTC encoder. It does not remove that second encoder or change remote
peer protocols. The internal CBR bridge budget is 15 Mbps; it is separate from the
network bitrate and JPEG quality. Compare fidelity and end-to-end behavior before
considering automatic selection. See [architecture and limits](../../.agents/knowledge/native-nvenc.md).

For lifecycle checks, import `runNvencLifecycle` from `test/bench/nvenc_lifecycle.ts`
in desktop development mode or include it in the packaged QA bundle. It asserts two
concurrent NVENC sessions, live JPEG fallback retaining the track and other session,
restart with stale-token rejection, and unsupported tiny geometry fallback.
`loadScenario:'sustained'` validates adaptive resolution/FPS with encoder recreation.
Run native hardware tests with `P2SHARER_TEST_NVENC=1` and
`cargo test --release --lib -- --test-threads=1`, then package with Tauri last.

The first hardware-decoder run had 83 ms pauses despite about 1 ms native processing.
Low-delay software decoding retained about 60 decoded FPS with regular track writes.
Do not infer an overall improvement from the native encoder timing alone. WARP
fallback tests are not physical AMD/Intel tests, and 120 FPS targets on this host are
not physical high-refresh monitor validation.

Final same-executable fresh-process comparison at full 1280x720/60:

| Measurement | Generic native JPEG | Experimental NVENC/software decode |
| --- | --- | --- |
| Native processing time | 2.56 ms/frame | 0.97 ms/frame |
| Local packet bytes | 34,737/image | 2,867/image |
| Decoded FPS per receiver | 59.95 | 60.19 |
| Track-write interval p95 | 18.1 ms | 18.1 ms |
| Raw pixel readback / JPEG | 0.32 / 2.22 ms | 0 / 0 ms |
| Recorded receiver drops | 0 | 0 |

The generic sample used `warmupMs:20000` after a discarded cold-start sample adapted
to 85% resolution. Both final samples retained 100% resolution with zero adjustments.
This shows lower native processing and local traffic, not higher FPS or less Internet
traffic. The native internal H264 budget and JPEG quality are different controls;
quadrant colors are checked, but quantitative text/game fidelity is not established.

`runNvencVisualCheck()` validates decoded RGB quadrants and orientation before and
after live JPEG fallback. `runNvencLifecycle()` also runs six repeated restarts and
simulates an unavailable decoder, asserting that JPEG resumes. A 120 FPS target on
the physical 75 Hz source delivered 74.72 fresh native FPS plus cached repetition,
120.15 decoded FPS and 9.7 ms track-write p95; it does not establish 120 FPS of motion.


### Native NVENC RTP publication

Enable `P2SHARER_NATIVE_NVENC=1` before a fresh packaged desktop launch. Bundle
`native_rtp_loopback.ts` for desktop WebView2 and call `runNativeRtpLoopback`.
This uses native RTP/SRTP and normal browser H264 receivers, rather than the older
`runVideoLoopback` path which intentionally retains browser sending video tracks.
Options include `peers`, `fps`, `warmupMs`, and `lifecycle`. The diagnostic receiver
worker checks encoded NAL fingerprints and sends real keyframe requests. Native
source websocket observations may arrive after the receiver, so matches are
reconciled. The lifecycle checks bitrate edits, independent sources, restart,
resource release and fallback notification. Keep loopback isolated from other native
routes because its route-count assertions expect ownership of the QA process.

For actual room integration, bundle `native_rtp_room.ts` into two separate packaged
processes/profiles. Join a unique password-protected QA room, call
`publishNativeRtpRoom` in one process and sample `nativeRtpRoomStats` in both.
`stopNativeRtpRoomStream` checks survivor/audio transfer;
`disableNativeRtpRoomEncoder` checks generic republishing; `closeNativeRtpRoom`
cleans up. The receiving process may leave native NVENC disabled. Do not use an
existing user room for diagnostic publications.

On the 75 Hz host, requesting 120 FPS yields about 75 fresh frames/second through
native RTP. This is not a physical high-refresh monitor test. See
`.agents/knowledge/native-nvenc.md` for measured results and outstanding deployment
conditions, including native loss/RTT rate control rather than Chromium GCC.
