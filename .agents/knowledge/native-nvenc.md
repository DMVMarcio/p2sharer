# Native NVENC encoding

## Current scope

The native WGC handler defaults to automatic GPU-texture H264 encoding. Transmission
settings offer Automatic, Generic, and NVIDIA NVENC only after a real D3D11 encoder
session/preset/resource probe succeeds. The short probe runs off the command thread
and releases its hardware session immediately. Each actual capture still validates
its own device, dimensions and driver resources and falls back to generic on failure.
AMD encoding is not implemented or advertised yet.

`p2sharer_video_encoder` persists the preference. Unknown values or unavailable
explicit NVENC selections recover to Automatic (and generic when native encoding
cannot run). Settings Save applies to future screen/window captures, including source
restarts, without an application restart; existing captures remain intact. Cameras
keep their established path. `P2SHARER_NATIVE_NVENC=0` is a diagnostic override for
Automatic; `=1` remains accepted. Explicit Generic overrides that flag, and explicit
NVENC overrides the automatic diagnostic disable.

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
Automatic enables native RTP on supported captures; failed native negotiation retains
the existing generic fallback.

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

`prefer-software` is the local preview decoding policy. It affects bridge
decoding only: native encoding still uses NVENC. The decoded GPU/frame cache
and existing track writer retain bounded latest-frame ownership. Native metrics
separate `nvenc_images`, `nvenc_us` and `nvenc_fallbacks` from JPEG/readback and repeats.

## Maintenance and limits

Native H264 delivery preserves admitted dependent pictures in FIFO order. When the ready queue is full, source pixels are skipped before NVENC advances prediction; the JPEG path may discard independently decodable images. Preview event-loop stalls retain a bounded compressed backlog rather than resetting valid prediction state on every submitted-frame limit.

Local loopback or decoded FPS alone does not establish Internet throughput, text/game fidelity, physical high-refresh support, driver portability, or audio/video synchronization. Inspect dependency gaps, recovery keys, decode drops, content, and route statistics when diagnosing encoded delivery. Bitrate-only changes must preserve prediction; genuine recovery keys can still lose detail at low budgets.

Native NVENC fixtures are explicitly ignored and require a compatible device. Run a named fixture with `pnpm run test:native --release <test-name> -- --ignored --test-threads=1`. Default texture/invalid-limit checks use Windows WARP software rendering. Quality exports remain ignored. See [test instructions](../../test/README.md) and [benchmark instructions](../../test/bench/README.md).
