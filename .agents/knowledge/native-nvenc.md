# Optional native NVENC encoding

## Current scope

The native WGC handler has an experimental GPU-texture H264 encoder. Enable it only
with `P2SHARER_NATIVE_NVENC=1` before launching a fresh desktop process. The default
remains the optimized generic WGC/JPEG bridge. This is a deliberate rollout decision,
not a user preference to permanently disable hardware encoding.

The published path is WGC -> GPU area scaler -> NVENC -> native H264 RTP
packetization/pacing -> DTLS-SRTP -> the viewer's ordinary WebRTC video track.
`src-tauri/src/native_rtc.rs` uses pinned webrtc-rs 0.17.2. Native video uses one
standard RTP peer connection per capture/viewer. Targeted SDP/trickle ICE signaling
runs through `native_video_v1` on the existing verified/admitted room channel. The
same STUN/TURN configuration and relay policy are passed to the native stack.
Compatibility with every public NAT/TURN route has not been established.

**The published native video is not decoded and re-encoded by the browser.** The
existing authenticated H264/WebCodecs bridge still supplies the local preview and
local UI track. A WeakMap registers only live local capture tracks and their capture
generation tokens. Cameras, unsupported capture devices and generic captures retain
the established browser WebRTC path. Native negotiation/encoding/transport rejection
also selects that path for the affected viewer without opening a browser picker.
The experimental flag is still required; this does not silently enable native RTP
on every NVIDIA installation.

Audio retains the original Trystero connection and its filters. Its per-track
metadata callback and native video callback merge tracks into the same advertised
media slot. Stopping the audio-bearing screen transfers audio to the surviving
screen. Separate native video connections mean cross-connection audio/video timing
and real content lip sync still require measurement; receiving an audio track alone
is not proof of synchronization or audio fidelity.

NVENC uses H264 baseline level 5.1, P1 ultra-low-latency, no B frames/lookahead,
two-second GOP and SPS/PPS on IDR. The local-only default budget is 15 Mbps.
Published capture budget follows the user's selected bitrate and native transport
feedback, with live NVENC reconfiguration (no new hardware session for bitrate-only
edits). JPEG quality is not an H264 quality scale.

## Native transport control and recovery

Each viewer has independent SRTP keys, RTP sequence numbers and a random timestamp
origin. RTP timestamps derive directly from native capture microseconds, preserving
elapsed time across skipped frames and wraparound. H264 NAL/FU-A/STAP-A packetization
uses the library payloader; native packet pacing includes overhead and allows at most
2 ms of timer credit. A frame has a 120 ms send deadline; three consecutive send
failures select generic publication. Queued capture frames older than 100 ms are
skipped while waiting for a fresh IDR.

Repeated cached encoded packets are not treated as new motion. Sequence gaps,
resize and queue overflow require IDR before more delta frames. Library interceptors
provide RTCP reports and NACK response. Actual PLI/FIR requests reach the capture's
keyframe flag, with a 250 ms request cooldown. Tokens isolate restarted capture
generations; old routes cannot change a replacement capture's budget or encoder.

Native rate control starts at min(user limit, 2 Mbps), reduces by 20% for >=5% loss
or elevated RTT (over baseline +100 ms and 1.5x baseline), and increases by 20% every
two healthy seconds, bounded by the user limit. It uses receiver reports; it is not
Chromium GCC/TWCC bandwidth estimation. Advertising REMB without the corresponding
probing path initially locked healthy loopback video near 300 kbps, so that approach
was removed. The shared encoder uses the lowest active viewer cap for the same
capture generation. Thus a constrained viewer can reduce that capture's quality for
other native viewers; per-viewer renditions would need additional encoders.

Receiver setup validates bounded signaling against current advertised descriptors.
Incoming candidates are queued only for known route IDs, with a 64-candidate bound.
Native source rejection, disconnected/failed routes, missing initial RTP and old
clients that do not answer trigger generic publication; unknown clients may wait up
to the 15-second setup deadline. Stopping/editing sources, room rebinding and peer
leave close their native routes. Local stops and remote owner stops are scoped to
their direction; matching media IDs from different owners do not cross-stop. Successful initial receiver checks stop polling;
failed connection events retain recovery. Native byte counters feed the existing
per-transmission bitrate/FPS UI (transmitted frames, not preview repeats); receivers retain ordinary browser RTP statistics.

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

## Initial intermediate bridge validation (historical)

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

## Direct RTP validation (2026-10-02)

The packaged desktop loopback uses two native SRTP senders and two browser receivers.
Browser receiver connections have no video sending tracks. In the measured 720p/60
run, receivers retained about 60 decoded FPS and zero reported drops. Encoded VCL NAL
fingerprints matched across the local NVENC output and remote RTP depacketization
(1,421 matched observations in the lifecycle run); browser workers inspect only the
receiver and do not modify the video. Preview observation and receiver delivery can
arrive in different orders, so the benchmark reconciles late observations.

The lifecycle test verifies actual receiver keyframe requests (five new native keys
in the four-request diagnostic window), live user bitrate reduction to 800 kbps,
two independent captures, targeted stop leaving exactly one native route, four
restart cycles and native encoder rejection requesting generic publication once
without disturbing the other capture. The failure count alone is not proof that a
full room republished generic video; the separate room benchmark checks that path.

Two separate packaged processes joined an isolated password-protected room through
the real signaling stack. The receiver process had native NVENC disabled. Native
1280x720/60 and 640x360/30 arrived in separate slots, with zero browser video senders
on the broadcaster. Audio arrived on the primary slot; stopping that source retained
the second native video and transferred audio into its slot. Native budget recovered
to the chosen 8 Mbps in healthy conditions. This is same-host peer interoperability,
not an Internet media-path measurement.

A 120 FPS target on the physical 75 Hz display produced about 74.93 decoded fresh
FPS per receiver, zero drops and 100% 720p resolution. Unlike the intermediate bridge,
native RTP does not manufacture 120 FPS by repeating old compressed pictures. This
is the expected physical-source limit, not physical 120/144/165/240 Hz validation.

Frontend tests: 425 passing. Native release tests: 50 passing, two external/manual
cases ignored, with real opt-in NVENC tests. Re-run Tauri packaging, verify executable
and installers, and repeat changed-path desktop checks before completing edits.
Physical high-refresh/VRR/4K, older NVIDIA/drivers, AMD/Intel, constrained Internet
media routes, controlled packet loss, heavy games, end-to-end latency/CPU comparisons,
quantitative text/game fidelity and audio/video synchronization remain unverified.
Keep the rollout experimental while those deployment conditions are evaluated.

Primary references: [webrtc-rs source](https://github.com/webrtc-rs/webrtc),
[NVIDIA NVENC guide](https://docs.nvidia.com/video-technologies/video-codec-sdk/13.1/nvenc-video-encoder-api-prog-guide/index.html),
[W3C encoded transform pipeline](https://www.w3.org/TR/webrtc-encoded-transform/#stream-processing).
