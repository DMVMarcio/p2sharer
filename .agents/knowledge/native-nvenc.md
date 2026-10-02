# Optional native NVENC encoding

## Current scope

The native WGC handler has an experimental GPU-texture H264 encoder. Enable it only
with `P2SHARER_NATIVE_NVENC=1` before launching a fresh desktop process. The default
remains the optimized generic WGC/JPEG bridge. This is a deliberate rollout decision,
not a user preference to permanently disable hardware encoding.

The path is WGC -> existing GPU area scaler -> session-owned NVENC texture -> H264
Annex B through the existing authenticated local WebSocket -> low-delay software
WebCodecs decoding -> existing video track -> existing WebRTC encoder/RTP. It removes
raw CPU pixel readback and JPEG encoding in successful NVENC sessions. **It still
decodes locally and encodes again for WebRTC.** No direct native RTP, encoded-frame
injection, custom media data-channel protocol, native AMF/VPL or camera encoding was
implemented. Existing receivers, audio, peer targeting, congestion control, picker
and stream identities retain their existing path.

The initial local H264 budget is 15 Mbps CBR, baseline profile, P1 ultra-low-latency,
no B frames/lookahead, two-second GOP and SPS/PPS on each IDR. That internal budget
does not replace the user's network bitrate or map JPEG quality to H264 quality.
There are still two lossy stages. This and unmeasured game/other-device behavior are
reasons to keep it experimental rather than silently change all NVIDIA captures.

## Driver boundary and fallback

`native/nvenc/encoder.cpp` uses the pinned, MIT-licensed NVIDIA SDK 12.1 header. It
loads the driver DLL from Windows System32, checks API compatibility, opens a session
on the actual WGC D3D11 device and queries H264 RGBA input support. A successful DLL
probe or vendor name is not evidence that a particular capture device can encode.
No CUDA runtime, driver DLL, NVIDIA import library or C++ standard-library runtime
is bundled or required by the shim. The final PE import list must not acquire a
mandatory NVENC/MSVCP dependency. Generic captures do not instantiate the encoder.

Each handler owns its encoder, input texture, registered/mapped resource, compressed
output and driver reference. Resize/FPS/device changes destroy the old session before
creating its replacement. Failed initialization/encoding or unavailable GPU scaling
permanently selects JPEG for that capture generation. Decoder rejection sends a
token-checked disable command; the same track/socket/session continues with JPEG.
`disableNativeEncoding()` exposes this same transition. Subsequent starts may retry
NVENC. Old generation tokens cannot disable or request keys from a replacement.

`P2NV` v1 packets carry key flag, actual dimensions, sequence and native microsecond
timestamp followed by Annex B. The parser rejects invalid size/version/geometry and
unsafe timestamps. Queues that drop dependent H264 frames trigger an IDR request.
The decoder caps pending input at eight frames, discards old pending work on recovery,
uses a 1.5-second failure timeout and closes frames/pending work on stop/fallback.
Asynchronous submission is necessary: waiting for output after every input stalled
the first hardware decode. Repeated cached packets are not decoded twice.

The measured hardware decoder delivered occasional 83 ms pauses and burst writes;
`prefer-software` removed these in the controlled run. This policy affects local
bridge decoding only: native encoding still uses NVENC. The decoded GPU/frame cache
and existing track writer retain bounded latest-frame ownership. Native metrics
separate `nvenc_images`, `nvenc_us` and `nvenc_fallbacks` from JPEG/readback and repeats.

## Validation and limits

Test configuration: an NVENC-capable NVIDIA GPU, Windows 11, physical 1920x1080/75 Hz.
Native hardware tests explicitly enabled with `P2SHARER_TEST_NVENC=1` pass horizontal,
portrait, 30/60/120 FPS session recreation and forced IDR recovery. Invalid limits
are rejected without driver sessions. A WARP software D3D11 device fails safely; this
is an unsupported-device check, not physical AMD/Intel validation.

The packaged lifecycle benchmark validates two concurrent NVENC sessions, six repeated restarts, live
fallback without track replacement or disturbing the second session, restart,
stale-token rejection and real driver rejection of 16x9 encoding followed by native
JPEG output. An unavailable WebCodecs decoder also resumes JPEG in the same session.
Decoded quadrant samples verify RGB channel order and orientation (maximum NVENC
channel error two levels on the solid-color diagnostic), including transition to JPEG.
The sustained bridge-pressure benchmark reaches 704x396/30 and restores
720p/60 while the independent capture has zero adjustments. Final receivers retain
about 60 decoded FPS, nonblack content and zero recorded drops. Native processing
after recovery averaged 1.07 ms/frame, with no raw readback or JPEG work.

Final same-executable fresh-process 720p/60 comparisons measured 2.56 ms native
processing for generic JPEG versus 0.97 ms for NVENC/software decode, about 62% less
native processing time. Receivers retained 59.95/60.19 decoded FPS respectively,
zero recorded drops and track-write p95 about 18.1 ms in both paths. Local packets
averaged 34.7 KB/2.87 KB respectively. An initial eight-second generic warmup sample
had adapted to 85% resolution and was excluded from the equal-size comparison; the
20-second warmup repeat retained 100% resolution with zero adjustments. This is local bridge traffic,
not reduced Internet bandwidth; the network still uses WebRTC encoding. Do not claim
matching image quality, zero CPU work, lower complete end-to-end latency, guaranteed
60/120 FPS, or measured heavy-game improvement from those values.

A final 120 FPS target retained 100% resolution and measured 74.72 fresh NVENC
images/second on the 75 Hz display plus about 45 cached repeats/second, 120.15 decoded
FPS per receiver, no fallback and 9.7 ms track-write p95. Repetition is not newly
captured motion and this is not physical 120 Hz monitor validation. The final executable,
MSI/NSIS bundles and PE dependencies were verified; no MSVCP or mandatory NVENC DLL
dependency was introduced.

The frontend suite passes 418 tests. Native release tests pass 46 cases with two
manual/external cases ignored, including real opt-in NVENC hardware tests. Tauri
packaging and final same-binary desktop comparisons are required after edits.
Physical high-refresh/VRR/4K, AMD/Intel, older NVIDIA/driver combinations, GPU-saturated
games, Internet routes and quantitative visual fidelity remain unverified.

## Remaining transport work

Removing the second encoder requires a separately validated encoded transport or
native WebRTC sender. Browser encoded transforms run after the browser encoder and
cannot simply accept arbitrary native-created frames. Any injection design must
prove codec/profile compatibility, sender frame ownership, per-peer keyframe
recovery, congestion/bitrate adaptation, timestamps and multi-stream lifecycle.
Do not replace the native picker with getDisplayMedia to bypass this constraint.

Primary references: [NVIDIA NVENC guide](https://docs.nvidia.com/video-technologies/video-codec-sdk/13.1/nvenc-video-encoder-api-prog-guide/index.html),
[W3C encoded transform pipeline](https://www.w3.org/TR/webrtc-encoded-transform/#stream-processing).
