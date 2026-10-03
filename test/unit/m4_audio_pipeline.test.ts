import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestDOM, MockAudioBufferSourceNode } from '../helpers/browser_mocks.ts';
import { AudioBridge } from '../../src/audio/audio_bridge.ts';
import type { AudioStreamPayload } from '../../src/core/types.ts';

function createStereoPcmBase64(samples: [number, number][]): string {
    const totalFloats = samples.length * 2;
    const buf = Buffer.alloc(totalFloats * 4);
    for (let i = 0; i < samples.length; i++) {
        const [l, r] = samples[i]!;
        buf.writeFloatLE(l, (i * 2) * 4);
        buf.writeFloatLE(r, (i * 2 + 1) * 4);
    }
    return buf.toString('base64');
}

describe('M4 Unit Tests: Audio Pipeline Subsystem & Low-Allocation AudioBridge', () => {
    describe('1. AudioBridge Initialization & Track Lifecycle', () => {
        it('should initialize AudioContext at 48 kHz and return media stream audio track', () => {
            const dom = setupTestDOM();
            try {
                const bridge = new AudioBridge();
                let rmsLevelReceived = -1;
                const track = bridge.init((level) => {
                    rmsLevelReceived = level;
                });

                assert.ok(track, 'Track must be non-null');
                assert.equal(track.kind, 'audio');
                assert.equal(track.readyState, 'live');

                // Internal AudioContext state
                const ctx = (bridge as any).audioCtx;
                assert.ok(ctx);
                assert.equal(ctx.sampleRate, 48000);
                assert.equal(ctx.state, 'running');

                bridge.stop();
                assert.equal(ctx.state, 'closed');
                assert.equal((bridge as any).audioCtx, null);
                assert.equal((bridge as any).destNode, null);
            } finally {
                dom.cleanup();
            }
        });
    });

    describe('2. TypedArray Buffer Reuse & Elimination of GC Churn', () => {
        it('should reuse pre-allocated byteBuffer and floatBuffer across consecutive chunks', () => {
            const dom = setupTestDOM();
            try {
                const bridge = new AudioBridge();
                bridge.init();

                const initialByteBuffer = (bridge as any).byteBuffer;
                const initialFloatBuffer = (bridge as any).floatBuffer;
                const initialArrayBuffer = initialByteBuffer.buffer;

                assert.ok(initialByteBuffer instanceof Uint8Array);
                assert.ok(initialFloatBuffer instanceof Float32Array);
                assert.ok(initialByteBuffer.byteLength >= 16384);

                // Deliver 20 consecutive 10ms audio chunks (480 frames = 960 floats = 3840 bytes)
                const pcmB64 = createStereoPcmBase64(Array.from({ length: 480 }, () => [0.25, -0.25]));

                for (let i = 0; i < 20; i++) {
                    const payload: AudioStreamPayload = {
                        pcm_base64: pcmB64,
                        sample_rate: 48000,
                        channels: 2,
                        rms_level: 0.25,
                        timestamp_us: 1000000 + i * 10000,
                    };
                    (bridge as any).playPCMChunk(payload);

                    // Assert buffer references NEVER change (zero allocation)
                    assert.equal(
                        (bridge as any).byteBuffer.buffer,
                        initialArrayBuffer,
                        `ArrayBuffer reference must remain identical on chunk ${i}`
                    );
                    assert.equal(
                        (bridge as any).floatBuffer.buffer,
                        initialArrayBuffer,
                        `Float32Array underlying buffer must remain identical on chunk ${i}`
                    );
                }

                bridge.stop();
            } finally {
                dom.cleanup();
            }
        });

        it('should dynamically expand buffer capacity when payload exceeds initial 16KB', () => {
            const dom = setupTestDOM();
            try {
                const bridge = new AudioBridge();
                bridge.init();

                // Initial capacity = 16384 bytes
                assert.equal((bridge as any).byteBuffer.byteLength, 16384);

                // Create jumbo payload: 5000 frames = 10000 floats = 40000 bytes
                const jumboPcm = createStereoPcmBase64(Array.from({ length: 5000 }, () => [0.1, -0.1]));
                const jumboPayload: AudioStreamPayload = {
                    pcm_base64: jumboPcm,
                    sample_rate: 48000,
                    channels: 2,
                    rms_level: 0.1,
                    timestamp_us: 5000000,
                };

                (bridge as any).playPCMChunk(jumboPayload);

                // Capacity should have expanded to accommodate 40000 bytes
                const newCap = (bridge as any).byteBuffer.byteLength;
                assert.ok(newCap >= 40000, `Buffer capacity (${newCap}) must be >= 40000`);
                assert.equal(
                    (bridge as any).floatBuffer.buffer,
                    (bridge as any).byteBuffer.buffer,
                    'floatBuffer must point to expanded byteBuffer.buffer'
                );

                bridge.stop();
            } finally {
                dom.cleanup();
            }
        });
    });

    describe('3. Monotonic Timestamp Tracking & Presentation Sync', () => {
        it('should accurately record and expose presentation timestamp_us from payload', () => {
            const dom = setupTestDOM();
            try {
                const bridge = new AudioBridge();
                bridge.init();

                assert.equal(bridge.getLastTimestampUs(), 0, 'Initial timestamp must be 0');

                const samplePayload: AudioStreamPayload = {
                    pcm_base64: createStereoPcmBase64([[0.5, -0.5]]),
                    sample_rate: 48000,
                    channels: 2,
                    rms_level: 0.5,
                    timestamp_us: 1725838491234,
                };

                (bridge as any).playPCMChunk(samplePayload);
                assert.equal(bridge.getLastTimestampUs(), 1725838491234);

                // Next chunk advances timestamp
                samplePayload.timestamp_us = 1725838501234;
                (bridge as any).playPCMChunk(samplePayload);
                assert.equal(bridge.getLastTimestampUs(), 1725838501234);

                // Stop resets timestamp to 0
                bridge.stop();
                assert.equal(bridge.getLastTimestampUs(), 0);
            } finally {
                dom.cleanup();
            }
        });

        it('should handle payloads without timestamp_us gracefully without overriding last timestamp', () => {
            const dom = setupTestDOM();
            try {
                const bridge = new AudioBridge();
                bridge.init();

                const pcm = createStereoPcmBase64([[0.1, 0.1]]);
                (bridge as any).playPCMChunk({
                    pcm_base64: pcm,
                    sample_rate: 48000,
                    channels: 2,
                    rms_level: 0.1,
                    timestamp_us: 42000,
                });
                assert.equal(bridge.getLastTimestampUs(), 42000);

                // Legacy payload without timestamp_us
                (bridge as any).playPCMChunk({
                    pcm_base64: pcm,
                    sample_rate: 48000,
                    channels: 2,
                    rms_level: 0.1,
                });
                assert.equal(bridge.getLastTimestampUs(), 42000, 'Undefined timestamp must not clobber existing timestamp');

                bridge.stop();
            } finally {
                dom.cleanup();
            }
        });
    });

    describe('4. Unrolled Stereo Copy & AudioBufferSourceNode Cleanup', () => {
        it('should correctly de-interleave stereo channels into AudioBuffer', () => {
            const dom = setupTestDOM();
            try {
                const bridge = new AudioBridge();
                bridge.init();

                const testPattern: [number, number][] = [
                    [0.1, -0.1],
                    [0.2, -0.2],
                    [0.3, -0.3],
                    [0.4, -0.4],
                ];
                const b64 = createStereoPcmBase64(testPattern);

                // Intercept created AudioBuffer
                let capturedBuffer: any = null;
                const origCreateBuffer = (bridge as any).audioCtx.createBuffer.bind((bridge as any).audioCtx);
                (bridge as any).audioCtx.createBuffer = (ch: number, len: number, sr: number) => {
                    capturedBuffer = origCreateBuffer(ch, len, sr);
                    return capturedBuffer;
                };

                (bridge as any).playPCMChunk({
                    pcm_base64: b64,
                    sample_rate: 48000,
                    channels: 2,
                    rms_level: 0.25,
                });

                assert.ok(capturedBuffer);
                assert.equal(capturedBuffer.numberOfChannels, 2);
                assert.equal(capturedBuffer.length, 4);

                const left = capturedBuffer.getChannelData(0);
                const right = capturedBuffer.getChannelData(1);

                for (let i = 0; i < testPattern.length; i++) {
                    assert.ok(Math.abs(left[i] - testPattern[i]![0]) < 1e-5, `Left channel mismatch at ${i}`);
                    assert.ok(Math.abs(right[i] - testPattern[i]![1]) < 1e-5, `Right channel mismatch at ${i}`);
                }

                bridge.stop();
            } finally {
                dom.cleanup();
            }
        });

        it('should bind onended handler to disconnect source and null buffer on completion', () => {
            const dom = setupTestDOM();
            try {
                const bridge = new AudioBridge();
                bridge.init();

                let capturedSource: MockAudioBufferSourceNode | null = null;
                const origCreateSource = (bridge as any).audioCtx.createBufferSource.bind((bridge as any).audioCtx);
                (bridge as any).audioCtx.createBufferSource = () => {
                    capturedSource = origCreateSource();
                    return capturedSource;
                };

                const b64 = createStereoPcmBase64([[0.5, 0.5]]);
                (bridge as any).playPCMChunk({
                    pcm_base64: b64,
                    sample_rate: 48000,
                    channels: 2,
                    rms_level: 0.5,
                });

                assert.ok(capturedSource);
                assert.ok(capturedSource.connectedTo, 'Source must be connected to destination node');
                assert.ok(typeof (capturedSource as any).onended === 'function', 'source.onended handler must be attached');

                // Simulate buffer playback completion
                (capturedSource as any).onended();

                assert.equal(capturedSource.connectedTo, null, 'Source must be disconnected on ended');
                assert.equal(capturedSource.buffer, null, 'Buffer reference must be cleared on ended');

                bridge.stop();
            } finally {
                dom.cleanup();
            }
        });
    });

    describe('5. Smooth Scheduling Window & Jitter Compensation', () => {
        it('should anchor initial playback with a 50ms jitter cushion', () => {
            const dom = setupTestDOM();
            try {
                const bridge = new AudioBridge();
                bridge.init();

                const ctx = (bridge as any).audioCtx;
                ctx.currentTime = 5.0; // Current audio hardware clock

                let capturedSource: MockAudioBufferSourceNode | null = null;
                const origCreateSource = ctx.createBufferSource.bind(ctx);
                ctx.createBufferSource = () => {
                    capturedSource = origCreateSource();
                    return capturedSource;
                };

                const b64 = createStereoPcmBase64(Array.from({ length: 480 }, () => [0.1, 0.1]));
                (bridge as any).playPCMChunk({
                    pcm_base64: b64,
                    sample_rate: 48000,
                    channels: 2,
                    rms_level: 0.1,
                });

                // Initial cushion leaves room for Tauri event and renderer jitter.
                assert.ok(capturedSource);
                assert.ok(Math.abs(capturedSource.startedAt! - 5.05) < 1e-4, `Expected start at 5.05, got ${capturedSource.startedAt}`);

                // Next chunk should smoothly append after buffer duration (10ms = 0.010s)
                assert.ok(Math.abs((bridge as any).nextPlayTime - (5.05 + 480 / 48000)) < 1e-4);

                bridge.stop();
            } finally {
                dom.cleanup();
            }
        });

        it('should re-anchor if audio clock experiences buffer underrun (nextPlayTime < currentTime)', () => {
            const dom = setupTestDOM();
            try {
                const bridge = new AudioBridge();
                bridge.init();

                const ctx = (bridge as any).audioCtx;
                ctx.currentTime = 1.0;

                const b64 = createStereoPcmBase64(Array.from({ length: 480 }, () => [0.1, 0.1]));
                (bridge as any).playPCMChunk({
                    pcm_base64: b64,
                    sample_rate: 48000,
                    channels: 2,
                    rms_level: 0.1,
                });

                // Simulate audio thread stutter or system sleep: clock jumps forward to 2.0s
                ctx.currentTime = 2.0;

                let capturedSource: MockAudioBufferSourceNode | null = null;
                const origCreateSource = ctx.createBufferSource.bind(ctx);
                ctx.createBufferSource = () => {
                    capturedSource = origCreateSource();
                    return capturedSource;
                };

                (bridge as any).playPCMChunk({
                    pcm_base64: b64,
                    sample_rate: 48000,
                    channels: 2,
                    rms_level: 0.1,
                });

                // The next recovery grows the cushion from 50ms to 60ms.
                assert.ok(capturedSource);
                assert.ok(Math.abs(capturedSource.startedAt! - 2.06) < 1e-4);

                bridge.stop();
            } finally {
                dom.cleanup();
            }
        });

        it('should preserve queued audio at 150ms and discard a chunk above 200ms', () => {
            const dom = setupTestDOM();
            try {
                const bridge = new AudioBridge();
                bridge.init();

                const ctx = (bridge as any).audioCtx;
                ctx.currentTime = 1.0;

                // A burst must keep the established timeline rather than overlap it.
                (bridge as any).nextPlayTime = 1.0 + 0.150; // 150ms lead

                let capturedSource: MockAudioBufferSourceNode | null = null;
                const origCreateSource = ctx.createBufferSource.bind(ctx);
                ctx.createBufferSource = () => {
                    capturedSource = origCreateSource();
                    return capturedSource;
                };

                const b64 = createStereoPcmBase64(Array.from({ length: 480 }, () => [0.1, 0.1]));
                (bridge as any).playPCMChunk({
                    pcm_base64: b64,
                    sample_rate: 48000,
                    channels: 2,
                    rms_level: 0.1,
                });

                assert.ok(capturedSource);
                assert.ok(Math.abs(capturedSource.startedAt! - 1.15) < 1e-4);

                capturedSource = null;
                (bridge as any).nextPlayTime = 1.21;
                (bridge as any).playPCMChunk({ pcm_base64: b64, sample_rate: 48000, channels: 2, rms_level: 0.1 });
                assert.equal(capturedSource, null);
                assert.equal((bridge as any).nextPlayTime, 1.21);

                bridge.stop();
            } finally {
                dom.cleanup();
            }
        });
    });
});
