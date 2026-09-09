# P2Sharer E2E Test Infrastructure & Methodology

## 1. Overview
The P2Sharer End-to-End (E2E) testing framework provides opaque-box, contract-driven, and behavior-based verification of the entire application across all 5 architectural requirements (R1–R5).

The test suite exercises:
- **Build Cleanliness & Compiler Integrity**: Frontend TypeScript compilation (`tsc --noEmit`), Rust backend validation (`cargo check`), and config validation.
- **Tauri IPC Contracts**: Exact schema validation across 12 Rust invoke handlers, parameter types, default fallbacks, and event payloads (`p2sharer://audio-stream`).
- **Signaling & Connectivity State Machines**: Public and password-isolated SHA-256 room derivations, deterministic user coloring, room slug grammar, and multi-transport failover (MQTT → Nostr → Torrent).
- **Audio DSP Resampling Math**: Exact mathematical linear interpolation resampling (e.g. 44.1 kHz → 48 kHz, 8 kHz → 48 kHz, 192 kHz → 48 kHz), RMS calculation, 16-bit to float conversion, and process inclusion/exclusion tree filtering.
- **Viewer Decoding & DOM Invariants**: Keyed non-destructive DOM reconciliation, element identity preservation, Spotlight vs Grid layout modes, and the Singleton AudioContext invariant across remote streams.

---

## 2. 4-Tier Test Case Design Methodology

```
+------------------------------------------------------------------------------------+
|                                 P2Sharer E2E Suite                                 |
+------------------------------------------------------------------------------------+
| Tier 1: Feature Coverage (Isolation)                                     32 Tests  |
|         - Happy-path verification for each feature domain in isolation              |
+------------------------------------------------------------------------------------+
| Tier 2: Boundary & Corner Cases                                          32 Tests  |
|         - Limits, extremes, zero inputs, malformed packets, and rapid churn         |
+------------------------------------------------------------------------------------+
| Tier 3: Cross-Feature Combinations                                       15 Tests  |
|         - Pairwise interactions (A/V sync, stream toggle recovery, failover)       |
+------------------------------------------------------------------------------------+
| Tier 4: Real-World Application Scenarios                                 12 Tests  |
|         - End-to-end multi-peer conferences, crypto private rooms, stress stability|
+------------------------------------------------------------------------------------+
| TOTAL TESTS EXECUTED:                                                    91 Tests  |
+------------------------------------------------------------------------------------+
```

### Tier 1: Feature Coverage (Isolation)
Tests core capabilities independently with authoritative expected outputs:
- **R1 Video Pipeline**: Direct GPU 1080p60 capture options, `WindowSource` / `MonitorSource` schema parsing, native capture IPC invocation, offscreen canvas with `bitmaprenderer`, WebRTC `contentHint = 'motion'`.
- **R2 Signaling & Connectivity**: Public room ID derivation, password-isolated room ID hashing, room slug generation grammar (`adj-noun-num`), deterministic user color generation, direct WebRTC peer tracking, multi-transport failover.
- **R3 Audio Loopback & Resampling**: RMS calculation for pure sine tone ($\approx 0.7071$), 44.1 kHz to 48 kHz resampling, 16-bit PCM integer to Float32 conversion, Little-Endian Base64 roundtrip, process exclusion and inclusion filtering.
- **R4 Viewer Rendering & DOM**: Non-destructive keyed reconciliation, grid layout card generation, spotlight stage/tray partitioning, departed peer cleanup, Singleton AudioContext invariant.
- **R5 Subsystem Quality**: Project config file integrity, TypeScript compilation (`tsc --noEmit`), Rust backend compilation (`cargo check`), IPC command registry matrix, HUD telemetry calculations.

### Tier 2: Boundary & Corner Cases
Tests limits, stress points, and adversarial inputs:
- **R1 Video Boundaries**: 0x0 resolution fallback, extreme 8K UHD (7680x4320) uncompressed memory sizing, boundary frame rates (0 FPS fallback, 240 FPS ceiling), invalid JPEG quality, missing `sourceId`, fallback from failed `bitmaprenderer`.
- **R2 Signaling Boundaries**: Whitespace passwords, malicious payloads in room names (XSS, SQLi, null bytes), 10,000-character usernames, rapid churn (100 joins/leaves), duplicate join idempotency, 12-hop continuous failover cycling, unverified PEX rumor quarantine.
- **R3 Audio Boundaries**: Digital silence RMS ($0.0$), extreme clipping ($\pm 10.0$) clamping to $1.0$, empty PCM buffers (0 samples), extreme sample rates (8 kHz telephony upsampling and 192 kHz studio master downsampling), include mode with 0 target apps (silence streaming), malformed Base64 rejection.
- **R4 Rendering Boundaries**: Empty room reconciliation (0 slots), rapid spotlight toggling between 10 peers without element duplication, pinned peer departure auto-revert, 100 participants in room, external media track `readyState = 'ended'` handling, video-to-avatar mode switching.
- **R5 IPC Boundaries**: Invocations to unknown commands, missing required parameters (`level`, `message`), mismatched argument types (`targetFps = "sixty"`), invalid `AudioConfig` modes and negative sample rates, out-of-range channels (0 or 64) and invalid RMS levels, null/undefined payload protection.

### Tier 3: Cross-Feature Combinations
Tests pairwise interactions across subsystems:
- **A/V Pipeline (R1 + R3)**: Concurrent video track and audio loopback track bundling into a single `MediaStream`; strictly monotonic timestamps across audio and video chunks; synchronized window discovery and process audio filtering on matching PID; audio persistence during video fallback; audio mute toggle without interrupting 60 FPS video stream.
- **Room Resilience (R2 + R4)**: Multi-peer room state preservation during signaling transport failover; stream recovery protocol with video element preservation across screen share toggles; targeted media stream dispatch without bystander leakage; unverified PEX rumor prevention from creating room cards; broadcaster departure with spotlight fallback.
- **Audio DOM Matrix (R3 + R4 + R5)**: Resampled 44.1 kHz PCM serialized and scheduled into Singleton AudioContext with 8ms jitter buffer; per-peer volume slider adjustments isolated to distinct `GainNode`s; HUD audio meter scaling from chunk RMS; frame sequence tracking with 0 frame drops; synthesized sound cues without disturbing active stream playback.

### Tier 4: Real-World Application Scenarios
Tests end-to-end multi-step user workflows:
- **Multi-Participant Conference Workflow**: 5 participants join; Host shares 1080p60 screen; Alice starts secondary stream; Bob spotlights Host; Host stops sharing (spotlight auto-advances to Alice); Alice stops sharing (UI auto-reverts to 5-avatar grid); in-room chat message ordering; multi-party volume mixer with individual mute controls; session teardown.
- **Private Room Cryptographic Isolation Workflow**: Disjoint groups creating rooms with identical names ("DevStandup") but different passwords derive distinct signaling topologies; password mutation in active room propagates signed event; room normalization preserves cryptographic uniqueness; seamless room reconnection using cached credentials.
- **Long-Running Stability & Resource Invariants**: 10,000-frame sustained stream simulation with queue bounded to $\le 2$ frames; mid-stream transport disconnect with uninterrupted media streaming; A/V drift compensation keeping drift strictly under 15ms target; 500 successive DOM reconciliation cycles with strictly constant node counts.

---

## 3. Directory Layout

```
test/e2e/
├── harness/
│   ├── assertions.ts             # Custom float near, monotonic, referential equality assertions
│   ├── audio-dsp-oracle.ts       # Mathematical audio references (resampling, RMS, PCM packing)
│   ├── build-checker.ts          # Automated tsc and cargo check compiler verifiers
│   ├── dom-mock.ts               # Headless DOM, Web Audio, and WebRTC mock environment
│   ├── ipc-contract.ts           # Tauri IPC command definitions, schemas, and validators
│   ├── signaling-oracle.ts       # Cryptographic room hashing and failover state machines
│   └── types.ts                  # Shared types and interface contracts
│
├── tier1-feature-coverage/
│   ├── r1-video-capture.test.ts
│   ├── r2-signaling-connectivity.test.ts
│   ├── r3-audio-loopback.test.ts
│   ├── r4-viewer-rendering.test.ts
│   └── r5-subsystem-quality.test.ts
│
├── tier2-boundary-corners/
│   ├── r1-video-boundaries.test.ts
│   ├── r2-signaling-boundaries.test.ts
│   ├── r3-audio-boundaries.test.ts
│   ├── r4-rendering-boundaries.test.ts
│   └── r5-ipc-boundaries.test.ts
│
├── tier3-cross-feature/
│   ├── audio-dom-matrix-combinations.test.ts
│   ├── av-pipeline-combinations.test.ts
│   └── room-resilience-combinations.test.ts
│
├── tier4-real-world/
│   ├── e2e-conference-workflow.test.ts
│   ├── long-running-stability.test.ts
│   └── private-room-crypto-workflow.test.ts
│
└── runner.ts                     # Central CLI test runner and report aggregator
```

---

## 4. Runner Invocation Commands

### Run Full Suite (All 4 Tiers, 91 Tests)
```bash
node --experimental-strip-types test/e2e/runner.ts
```

### Run Specific Test Tier
```bash
# Tier 1 only (Feature Coverage)
node --experimental-strip-types test/e2e/runner.ts --tier=1

# Tier 2 only (Boundary & Corner Cases)
node --experimental-strip-types test/e2e/runner.ts --tier=2

# Tier 3 only (Cross-Feature Combinations)
node --experimental-strip-types test/e2e/runner.ts --tier=3

# Tier 4 only (Real-World Application Scenarios)
node --experimental-strip-types test/e2e/runner.ts --tier=4
```

### Run via Node Built-in Test Runner
```bash
node --experimental-strip-types --test "test/e2e/**/*.test.ts"
```

---

## 5. Coverage Matrix by Requirement

| Requirement | Scope | Tier 1 | Tier 2 | Tier 3 | Tier 4 | Total Tests |
|---|---|:---:|:---:|:---:|:---:|:---:|
| **R1: GPU Video & Capture** | Direct GPU capture, window discovery, 60 FPS timing, fallback | 6 | 6 | 5 | 3 | **20** |
| **R2: Connectivity & Failover** | Multi-signaling, room crypto, peer tracker, watchdog failover | 7 | 7 | 5 | 4 | **23** |
| **R3: WASAPI Audio Loopback** | 48kHz resampler, process filtering, RMS meter, NetEQ preservation | 7 | 7 | 5 | 2 | **21** |
| **R4: Viewer Rendering** | Keyed DOM reconciliation, Singleton AudioContext, spotlight grid | 6 | 6 | 5 | 3 | **20** |
| **R5: Subsystem Quality** | Build verification (tsc/cargo), IPC contracts, HUD telemetry, sound cues | 6 | 6 | 3 | 2 | **17** |
| **TOTALS** | | **32** | **32** | **15** | **12** | **91** |
