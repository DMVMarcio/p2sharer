import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestDOM, MockAudioBufferSourceNode } from '../e2e/harness/dom-mock.ts';
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

describe('M4 Adversarial Challenge: AudioBridge Low-Allocation & Buffer Lifecycle', () => {
    describe('Challenge A: Buffer Reuse across 1000 Simulated Chunks (Zero Allocation Leaks)', () => {
        it('should maintain the exact same underlying ArrayBuffer across 1000 consecutive chunks', () => {
            const dom = setupTestDOM();
            try {
                const bridge = new AudioBridge();
                bridge.init();

                const initialBuffer = (bridge as any).byteBuffer.buffer;
                const initialFloatBuffer = (bridge as any).floatBuffer.buffer;

                assert.equal(initialBuffer, initialFloatBuffer, 'byteBuffer and floatBuffer must share the same ArrayBuffer');

                // Generate a typical 10ms chunk (480 frames, 960 floats = 3840 bytes)
                const pcmB64 = createStereoPcmBase64(Array.from({ length: 480 }, () => [0.123, -0.456]));

                let bufferSwapCount = 0;
                let lastBuffer = initialBuffer;

                for (let i = 0; i < 1000; i++) {
                    const payload: AudioStreamPayload = {
                        pcm_base64: pcmB64,
                        sample_rate: 48000,
                        channels: 2,
                        rms_level: 0.3,
                        timestamp_us: 1000000 + i * 10000,
                    };
                    (bridge as any).playPCMChunk(payload);

                    const currentBuffer = (bridge as any).byteBuffer.buffer;
                    if (currentBuffer !== lastBuffer) {
                        bufferSwapCount++;
                        lastBuffer = currentBuffer;
                    }
                }

                assert.equal(
                    bufferSwapCount,
                    0,
                    `Buffer must NEVER be reallocated during steady-state processing across 1000 chunks (observed ${bufferSwapCount} swaps)`
                );
                assert.equal(
                    (bridge as any).byteBuffer.buffer,
                    initialBuffer,
                    'ArrayBuffer reference at chunk 1000 must match chunk 0'
                );

                bridge.stop();
            } finally {
                dom.cleanup();
            }
        });
    });

    describe('Challenge B: Dynamic Capacity Expansion Under Oversized Chunks', () => {
        it('should dynamically expand buffer capacity when payload exceeds initial 16KB without crashing', () => {
            const dom = setupTestDOM();
            try {
                const bridge = new AudioBridge();
                bridge.init();

                assert.equal((bridge as any).byteBuffer.byteLength, 16384);

                // Step 1: Send a 20KB chunk (2500 stereo frames = 5000 floats = 20000 bytes)
                const chunk20k = createStereoPcmBase64(Array.from({ length: 2500 }, () => [0.5, -0.5]));
                (bridge as any).playPCMChunk({
                    pcm_base64: chunk20k,
                    sample_rate: 48000,
                    channels: 2,
                    rms_level: 0.5,
                    timestamp_us: 100000,
                });

                const capAfter20k = (bridge as any).byteBuffer.byteLength;
                // Since 16384 * 2 = 32768, newCapacity = max(20000, 32768) = 32768
                assert.ok(capAfter20k >= 20000, `Capacity must accommodate 20000 bytes (got ${capAfter20k})`);
                assert.equal((bridge as any).floatBuffer.buffer, (bridge as any).byteBuffer.buffer);

                // Step 2: Send a 60KB chunk (7500 stereo frames = 15000 floats = 60000 bytes)
                const chunk60k = createStereoPcmBase64(Array.from({ length: 7500 }, () => [0.3, -0.3]));
                (bridge as any).playPCMChunk({
                    pcm_base64: chunk60k,
                    sample_rate: 48000,
                    channels: 2,
                    rms_level: 0.3,
                    timestamp_us: 200000,
                });

                const capAfter60k = (bridge as any).byteBuffer.byteLength;
                assert.ok(capAfter60k >= 60000, `Capacity must accommodate 60000 bytes (got ${capAfter60k})`);
                assert.equal((bridge as any).floatBuffer.buffer, (bridge as any).byteBuffer.buffer);

                // Step 3: Send normal 10ms chunk after expansion — ensure no shrink/realloc
                const expandedBufferRef = (bridge as any).byteBuffer.buffer;
                const normalChunk = createStereoPcmBase64(Array.from({ length: 480 }, () => [0.1, -0.1]));
                for (let i = 0; i < 50; i++) {
                    (bridge as any).playPCMChunk({
                        pcm_base64: normalChunk,
                        sample_rate: 48000,
                        channels: 2,
                        rms_level: 0.1,
                        timestamp_us: 300000 + i * 10000,
                    });
                    assert.equal((bridge as any).byteBuffer.buffer, expandedBufferRef);
                }

                bridge.stop();
            } finally {
                dom.cleanup();
            }
        });

        it('stress-tests boundary when payload byte length is non-power-of-2 and large', () => {
            const dom = setupTestDOM();
            try {
                const bridge = new AudioBridge();
                bridge.init();

                // 8193 frames = 16386 floats = 65544 bytes (> 65536)
                const oversizedPcm = createStereoPcmBase64(Array.from({ length: 8193 }, () => [0.2, -0.2]));
                (bridge as any).playPCMChunk({
                    pcm_base64: oversizedPcm,
                    sample_rate: 48000,
                    channels: 2,
                    rms_level: 0.2,
                    timestamp_us: 400000,
                });

                const cap = (bridge as any).byteBuffer.byteLength;
                assert.ok(cap >= 65544, `Capacity (${cap}) must be at least 65544`);
                assert.equal((bridge as any).floatBuffer.byteLength, cap);

                bridge.stop();
            } finally {
                dom.cleanup();
            }
        });

        it('investigates non-4-byte-aligned payload expansion failure mode', () => {
            const dom = setupTestDOM();
            try {
                const bridge = new AudioBridge();
                bridge.init();

                // Buffer starts at 16384 bytes
                const initialBuffer = (bridge as any).byteBuffer.buffer;

                // Create an odd-length payload: 35001 raw bytes
                const oddRaw = Buffer.alloc(35001, 0x55);
                const oddB64 = oddRaw.toString('base64');

                // Suppress console.error during the test since playPCMChunk catches and logs
                const origError = console.error;
                let capturedError: any = null;
                console.error = (...args: any[]) => {
                    capturedError = args.join(' ');
                };

                try {
                    (bridge as any).playPCMChunk({
                        pcm_base64: oddB64,
                        sample_rate: 48000,
                        channels: 2,
                        rms_level: 0.5,
                    });
                } finally {
                    console.error = origError;
                }

                // If non-multiple-of-4 is received (> 32768), Float32Array throws RangeError
                // Check whether the error was caught and logged
                assert.ok(capturedError, 'RangeError should be caught and logged when byte length is not a multiple of 4');
                assert.ok(
                    capturedError.includes('RangeError') || capturedError.includes('multiple of 4'),
                    `Expected RangeError in logs, got: ${capturedError}`
                );

                bridge.stop();
            } finally {
                dom.cleanup();
            }
        });
    });

    describe('Challenge C: Web Audio Node Disconnection on source.onended', () => {
        it('should promptly disconnect each source and nullify its buffer reference onended', () => {
            const dom = setupTestDOM();
            try {
                const bridge = new AudioBridge();
                bridge.init();

                const ctx = (bridge as any).audioCtx;
                const activeSources: MockAudioBufferSourceNode[] = [];
                const origCreate = ctx.createBufferSource.bind(ctx);
                ctx.createBufferSource = () => {
                    const src = origCreate();
                    activeSources.push(src);
                    return src;
                };

                const pcm = createStereoPcmBase64(Array.from({ length: 480 }, () => [0.1, 0.1]));

                // Deliver 50 chunks
                for (let i = 0; i < 50; i++) {
                    (bridge as any).playPCMChunk({
                        pcm_base64: pcm,
                        sample_rate: 48000,
                        channels: 2,
                        rms_level: 0.1,
                        timestamp_us: 500000 + i * 10000,
                    });
                }

                assert.equal(activeSources.length, 50, '50 sources should have been created');
                for (const src of activeSources) {
                    assert.ok(src.connectedTo, 'Source must initially be connected');
                    assert.ok(src.buffer, 'Source buffer must initially exist');
                    assert.equal(typeof (src as any).onended, 'function', 'onended must be attached');
                }

                // Simulate onended firing for all 50 sources
                for (let i = 0; i < 50; i++) {
                    (activeSources[i] as any).onended();
                }

                // Verify all 50 are fully disconnected and freed
                for (let i = 0; i < 50; i++) {
                    assert.equal(activeSources[i]!.connectedTo, null, `Source ${i} must be disconnected`);
                    assert.equal(activeSources[i]!.buffer, null, `Source ${i} buffer reference must be nulled`);
                }

                bridge.stop();
            } finally {
                dom.cleanup();
            }
        });

        it('handles staggered out-of-order onended callbacks without corrupting neighboring nodes', () => {
            const dom = setupTestDOM();
            try {
                const bridge = new AudioBridge();
                bridge.init();

                const ctx = (bridge as any).audioCtx;
                const activeSources: MockAudioBufferSourceNode[] = [];
                const origCreate = ctx.createBufferSource.bind(ctx);
                ctx.createBufferSource = () => {
                    const src = origCreate();
                    activeSources.push(src);
                    return src;
                };

                const pcm = createStereoPcmBase64(Array.from({ length: 480 }, () => [0.2, 0.2]));

                for (let i = 0; i < 10; i++) {
                    (bridge as any).playPCMChunk({
                        pcm_base64: pcm,
                        sample_rate: 48000,
                        channels: 2,
                        rms_level: 0.2,
                        timestamp_us: 600000 + i * 10000,
                    });
                }

                // Fire onended in reverse order
                for (let i = 9; i >= 0; i--) {
                    (activeSources[i] as any).onended();
                    assert.equal(activeSources[i]!.connectedTo, null);
                    assert.equal(activeSources[i]!.buffer, null);
                }

                bridge.stop();
            } finally {
                dom.cleanup();
            }
        });
    });
});
