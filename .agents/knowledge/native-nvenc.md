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
on-demand IDRs and SPS/PPS on IDR. Periodic GOP refreshes are disabled; startup,
new viewers and actual decoder/dependency recovery still request explicit IDRs.
The local-only default budget is 15 Mbps.
Published capture budget follows the user's selected bitrate and native transport
feedback, with live NVENC reconfiguration. Bitrate-only changes preserve prediction
and rate-control history (`resetEncoder=0`, `forceIDR=0`); geometry changes still
recreate the session. H264 targets 80% of the shared wire/pacer budget, leaving room
for RTP/SRTP overhead and timing variance. `encoderBitrate` route statistics report
that shared wire budget, not the encoder's 80% elementary-stream target. VBV uses
an 80 ms bit reservoir (at least one frame) instead of the one-frame cap. This is a
bit allowance, not an added frame queue or a guarantee of a maximum packet size.
JPEG quality is not an H264 quality scale.

## Native transport control and recovery

Each viewer has independent SRTP keys, RTP sequence numbers and a random timestamp
origin. RTP timestamps derive directly from native capture microseconds, preserving
elapsed time across skipped frames and wraparound. H264 NAL/FU-A/STAP-A packetization
uses the library payloader; native packet pacing includes overhead and allows at most
2 ms of timer credit. A frame has a 120 ms send deadline; three consecutive send
failures select generic publication. Ordinary queued capture frames older than
100 ms are skipped while waiting for a fresh IDR. After a successfully sent IDR,
allow its serialization duration (capped at 120 ms) temporarily on top of that age
limit, retiring the allowance at 20% per elapsed microsecond. The allowance expires
within 600 ms, and total allowed pre-send age never exceeds 220 ms. This prevents a
bounded recovery burst from making its dependent frames request another IDR before
the headroom can drain the queue; the per-frame send deadline remains 120 ms.

Repeated cached encoded packets are not treated as new motion. Sequence gaps,
resize and queue overflow require IDR before more delta frames. Library interceptors
provide RTCP reports and NACK response. Actual PLI/FIR requests reach the capture's
keyframe flag, with a 250 ms request cooldown. Tokens isolate restarted capture
generations; old routes cannot change a replacement capture's budget or encoder.

Native rate control starts with a 2 Mbps 720p/60 reference scaled by actual encoded
pixel count and effective FPS, clamped to 2-8 Mbps and capped by the user's limit
(1080p/60 starts at 4.5 Mbps). Unknown dimensions retain the 2 Mbps reference. It
reduces by 20% for >=5% loss
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
The decoder caps submitted input at eight pictures and retains at most eight more
compressed packets in FIFO order during WebView event-loop bursts. Valid prediction
is preserved until that bounded capacity is exceeded or a real sequence/geometry
change needs recovery. IDR requests are coalesced with a 250 ms cooldown. A 1.5-second
failure timeout remains; stop/fallback rejects both submitted and queued work.
Asynchronous submission is necessary: waiting for output after every input stalled
the first hardware decode. Repeated cached packets are not decoded twice.

The measured hardware decoder delivered occasional 83 ms pauses and burst writes;
`prefer-software` removed these in the controlled run. This policy affects local
bridge decoding only: native encoding still uses NVENC. The decoded GPU/frame cache
and existing track writer retain bounded latest-frame ownership. Native metrics
separate `nvenc_images`, `nvenc_us` and `nvenc_fallbacks` from JPEG/readback and repeats.

## Initial intermediate bridge validation (historical)

Host: RTX 5070, Ryzen 7 5700X3D, Windows 11 build 26100, physical 1920x1080/75 Hz.
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

## Detail-pulse regression (2026-10-02)

The previous configuration generated a badly quantized full-picture refresh on
every bitrate update (`resetEncoder=1`, `forceIDR=1`) as well as periodic GOP keys.
The defect was present in the encoded bytes used by the local preview, not just
receiver rendering. A deterministic real-driver fixture uses 361 detailed static
720p frames, configured for 60 FPS, budget changes 8 -> 6.4 -> 8 Mbps, and explicit
keys at frames 90/270. Before the fix, reconfiguration created extra keys at 180/240;
sampled grayscale PSNR fell from 48.76 to 13.86 dB at the first budget change. After
the fix, only startup and the two requested keys remain and both budget changes
retain the accumulated detail (47.54/47.62 dB before and after each edit) in the
same pattern. This is not a general text/game
fidelity measurement.

Requested recovery keys still lose substantial detail in this deliberately dense
pattern at a bounded bitrate; the fix removes unsolicited resets, not the cost of
genuine IDR recovery. `test/bench/nvenc_quality.ts` decodes the real GPU packets with
the same local preview decoder and asserts stable dimensions, the expected key
sequence, and no quality collapse on either bitrate-only change. The hardware test
also runs without fixture export when `P2SHARER_TEST_NVENC=1`.

The live dense-text RTP diagnostic exposed another source of repeated keys: a full
CBR payload budget left no margin for the pacer's RTP/SRTP overhead. Before adding
headroom, the startup sample accumulated 60 dependency gaps and 11 keys per viewer;
the later low-bitrate phase accumulated further gaps despite plausible average FPS.
The encoder now targets 80% of the shared wire budget, retaining the send deadline
and adding the bounded post-IDR age allowance described above. Check gap/key
counters in addition to FPS when changing these settings. Native release tests
pass 52 cases (including real NVENC and the transient age bound), with two
external/manual tests ignored; the frontend suite passes 427 tests.

An initial 10% reserve passed once but reproduced repeated recovery on subsequent
sharp decreases to 800 kbps; 20% alone also failed. Encoded diagnostic packets showed
roughly 11 KB recovery keys, whose serialization near 110 ms caused the subsequent
dependent frames to trip the fixed 100 ms age check. The result was another recovery
key every 250 ms. Headroom and bounded post-key drain time address different parts
of this cycle. Do not validate this path only
at the selected high bitrate after warmup. The dense-text benchmark asserts no
repeated unsolicited keys during healthy adaptation and the low-bitrate window.

Final packaged WebView2/NVENC dense-text runs with two local receivers passed both
8-second and 15-second warmups. The four-second healthy samples retained about
60 FPS with zero receiver decoder drops, no new dependency gaps and no unsolicited
keys while shared caps grew 3.456 -> 4.977 and 5.972 -> 8.600 Mbps respectively.
Sharp reductions from 7.166/12.383 Mbps to 800 kbps sent 120/121 frames per route
over two seconds, with zero new gaps or keys. Each run also passed four genuine
receiver key requests, four source restarts, independent capture/targeted stop,
and deliberate generic fallback; 1399/1399 and 1834/1834 encoded slices matched.
The final fixture decoded all 361 frames at 1280x720 with the expected three keys.
Tauri release executable, MSI and NSIS packaging succeeded. These are local-machine
diagnostics, not impaired Internet, other GPU/driver, or heavy-game validation.

## Solo 1080p preview recovery bursts (2026-10-03)

User reproduction: 1080p/60 at 15 Mbps, no viewers, animated wallpaper and static
chat/VS Code. A real packaged local-only capture reproduced five unnecessary IDRs
during three controlled 200 ms UI interruptions despite zero sequence gaps, zero
native queue drops and unchanged 1080p/60 dimensions. The main-thread WebCodecs
wrapper discarded its prediction state when intact queued WS packets filled its
eight submitted-frame limit. The FIFO compressed backlog above reduced this
specific reproduction to zero new IDRs under the same interruptions. This establishes
an actual local cause beyond the prior bitrate/GOP changes; it does not identify
every possible desktop/game/driver quality fluctuation.

The native delivery pacer also used its JPEG latest-image eviction policy for
H264 reference pictures. It now retains admitted dependent pictures in FIFO order
and skips source pixels before NVENC advances prediction when its two-slot queue
is full. Deterministic short-stall tests prove the order and capacity bound;
real-driver 1080p moving-detail fixtures include three roughly 50 ms delivery pauses,
with no discarded encoded references or extra IDRs. Generic JPEG pacing is unchanged.

The independent 601-frame motion fixture at 15 Mbps had no >4 dB one-frame drops in
its stationary text ROI even before these fixes (mean delta PSNR about 44.46 dB).
Do not blame rate control or change presets based on the symptom alone. The dense
text ROI is a synthetic fidelity measurement, not the user's exact wallpaper/game.

The same 1080p dense-text diagnostic also exposed native sender startup selecting
generic fallback for both routes with the fixed 2 Mbps probe. Scaling the probe to
actual geometry/FPS (4.5 Mbps at 1080p/60) prevented this failure while preserving the
user ceiling and normal RTCP loss/RTT adaptation. Two local receivers then retained
1080p at about 59.97 FPS with zero decoder drops during a ten-second sample, no new
dependency gaps or IDRs, and a cap growing from 9.331 to the selected 15 Mbps.
A repeat with three 200 ms UI interruptions also retained roughly 60 FPS, zero new
IDRs or gaps after warmup, and matching native/depacketized encoded slices
(1171/1171 and 1483/1483). Startup can still need genuine recovery; these counts do
not claim a loss-free handshake or prove constrained Internet behavior.

Final packaged solo preview stress sent 901 fresh pictures in the 15-second sample
with zero additional keys/gaps and no native load/resolution adjustment. Decoding
the real motion/delivery fixtures in final WebView2 produced 601/593 pictures at
1080p, only the initial key, no >4 dB one-frame text drops, and mean delta PSNR
44.46/44.45 dB. Release native tests pass 56 cases with two external/manual cases
ignored and real NVENC enabled; frontend tests pass 486 cases. A broader frontend
run initially failed its Cargo-check case due to missing CMake in that shell; using
the existing bundled CMake path resolved it. Tauri executable/MSI/NSIS packaging
succeeded. Other driver/device, physical high-refresh and heavy-game conditions
still require measurement.

The final 720p lifecycle regression also passed four real receiver key requests,
four route restarts, targeted stop retaining an independent 640x360/30 source, and
deliberate generic fallback (1528/1528 matching slices). A sharp 7.166 Mbps -> 800
kbps cut needed one genuine IDR and skipped eight dependent pictures while waiting
for it; the next two-second settled sample sent 120/121 pictures with no further
keys/gaps. The benchmark now measures that separate settled window. Its previous
three-gap threshold incorrectly treated skipped waiting pictures as repeated
recovery events even though keys advanced only once; do not silently reinterpret
`gaps` as a count of loss episodes.
