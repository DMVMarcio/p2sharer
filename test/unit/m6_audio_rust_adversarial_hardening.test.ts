import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestDOM, MockAudioBufferSourceNode } from '../helpers/browser_mocks.ts';
import { AudioBridge } from '../../src/audio/audio_bridge.ts';
import { AudioContextManager } from '../../src/audio/audio_context_manager.ts';
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

describe('Tier 5 Adversarial Hardening: AudioBridge & AudioContextManager Stress', () => {
  describe('1. TypedArray Buffer Capacity Expansion & Steady-State Zero-GC Stability', () => {
    it('should expand capacity through extreme chunk size staircase and remain stable with 0 reallocations', () => {
      const dom = setupTestDOM();
      try {
        const bridge = new AudioBridge();
        bridge.init();

        const initialBuffer = (bridge as any).byteBuffer.buffer;
        assert.equal((bridge as any).byteBuffer.byteLength, 16384, 'Initial capacity must be 16KB');

        // Step 1: Normal 10ms chunk (480 frames = 3840 bytes)
        const chunkNormal = createStereoPcmBase64(Array.from({ length: 480 }, () => [0.1, -0.1]));
        (bridge as any).playPCMChunk({
          pcm_base64: chunkNormal,
          sample_rate: 48000,
          channels: 2,
          rms_level: 0.1,
          timestamp_us: 100000,
        });
        assert.equal((bridge as any).byteBuffer.buffer, initialBuffer);

        // Step 2: Burst 24KB chunk (3000 stereo frames = 6000 floats = 24000 bytes)
        // Capacity formula: max(24000, 16384 * 2) = 32768
        const chunk24k = createStereoPcmBase64(Array.from({ length: 3000 }, () => [0.3, -0.3]));
        (bridge as any).playPCMChunk({
          pcm_base64: chunk24k,
          sample_rate: 48000,
          channels: 2,
          rms_level: 0.3,
          timestamp_us: 110000,
        });

        const bufferAfter24k = (bridge as any).byteBuffer.buffer;
        assert.notEqual(bufferAfter24k, initialBuffer, 'Buffer should expand for 24KB payload');
        assert.equal((bridge as any).byteBuffer.byteLength, 32768, 'Capacity should double to 32768');
        assert.equal((bridge as any).floatBuffer.buffer, (bridge as any).byteBuffer.buffer);

        // Step 3: Extreme Burst 128KB chunk (16384 frames = 32768 floats = 131072 bytes)
        // Capacity formula: max(131072, 32768 * 2) = 131072
        const chunk128k = createStereoPcmBase64(Array.from({ length: 16384 }, () => [0.5, -0.5]));
        (bridge as any).playPCMChunk({
          pcm_base64: chunk128k,
          sample_rate: 48000,
          channels: 2,
          rms_level: 0.5,
          timestamp_us: 120000,
        });

        const expandedBufferRef = (bridge as any).byteBuffer.buffer;
        assert.ok((bridge as any).byteBuffer.byteLength >= 131072);
        assert.equal((bridge as any).floatBuffer.buffer, expandedBufferRef);

        // Step 4: Stream 500 normal chunks back-to-back — verify STRICTLY ZERO further reallocations
        let bufferSwapCount = 0;
        let lastBuf = expandedBufferRef;

        for (let i = 0; i < 500; i++) {
          (bridge as any).playPCMChunk({
            pcm_base64: chunkNormal,
            sample_rate: 48000,
            channels: 2,
            rms_level: 0.1,
            timestamp_us: 130000 + i * 10000,
          });

          const currentBuf = (bridge as any).byteBuffer.buffer;
          if (currentBuf !== lastBuf) {
            bufferSwapCount++;
            lastBuf = currentBuf;
          }
        }

        assert.equal(
          bufferSwapCount,
          0,
          `Buffer was reallocated ${bufferSwapCount} times during steady-state (must be 0)`
        );
        assert.equal((bridge as any).byteBuffer.buffer, expandedBufferRef);

        bridge.stop();
      } finally {
        dom.cleanup();
      }
    });
  });

  describe('2. Web Audio Clock Drift, Late Arrival, & Burst Scheduling Resilience', () => {
    it('should smoothly schedule sequential chunks with duration accumulation', () => {
      const dom = setupTestDOM();
      try {
        const bridge = new AudioBridge();
        bridge.init();

        const ctx = (bridge as any).audioCtx;
        ctx.currentTime = 1.0; // Audio clock at 1.0s

        const chunk = createStereoPcmBase64(Array.from({ length: 480 }, () => [0.2, 0.2]));
        // 480 frames at 48kHz = 0.010s duration

        // Chunk 0: Initial anchor
        (bridge as any).playPCMChunk({
          pcm_base64: chunk,
          sample_rate: 48000,
          channels: 2,
          rms_level: 0.2,
          timestamp_us: 100000,
        });

        const expectedLead = 0.05; // 50ms initial jitter cushion
        const expectedTime0 = 1.0 + expectedLead;
        assert.ok(
          Math.abs((bridge as any).nextPlayTime - (expectedTime0 + 0.010)) < 1e-6,
          `nextPlayTime should be 1.06 after first 10ms chunk (got ${(bridge as any).nextPlayTime})`
        );

        // Advance currentTime by 0.010s (real-time progression)
        ctx.currentTime = 1.010;

        // Chunk 1: Should smoothly advance nextPlayTime without re-anchoring
        (bridge as any).playPCMChunk({
          pcm_base64: chunk,
          sample_rate: 48000,
          channels: 2,
          rms_level: 0.2,
          timestamp_us: 110000,
        });

        assert.ok(
          Math.abs((bridge as any).nextPlayTime - (expectedTime0 + 0.020)) < 1e-6,
          `nextPlayTime should be 1.07 after second 10ms chunk (got ${(bridge as any).nextPlayTime})`
        );

        bridge.stop();
      } finally {
        dom.cleanup();
      }
    });

    it('should re-anchor immediately when audio clock stalls / underruns (currentTime leaps past nextPlayTime)', () => {
      const dom = setupTestDOM();
      try {
        const bridge = new AudioBridge();
        bridge.init();

        const ctx = (bridge as any).audioCtx;
        ctx.currentTime = 2.0;

        const chunk = createStereoPcmBase64(Array.from({ length: 480 }, () => [0.1, 0.1]));
        (bridge as any).playPCMChunk({
          pcm_base64: chunk,
          sample_rate: 48000,
          channels: 2,
          rms_level: 0.1,
          timestamp_us: 200000,
        });

        // Simulate 500ms audio stall (e.g. system sleep, background tab throttle)
        ctx.currentTime = 2.600;

        (bridge as any).playPCMChunk({
          pcm_base64: chunk,
          sample_rate: 48000,
          channels: 2,
          rms_level: 0.1,
          timestamp_us: 250000,
        });

        // The underrun grows the lead from 50ms to 60ms before scheduling the 10ms chunk.
        const expectedNextTime = 2.600 + 0.06 + 0.010;
        assert.ok(
          Math.abs((bridge as any).nextPlayTime - expectedNextTime) < 1e-5,
          `Stall re-anchor failed: expected ${expectedNextTime}, got ${(bridge as any).nextPlayTime}`
        );

        bridge.stop();
      } finally {
        dom.cleanup();
      }
    });

    it('should bound a long burst without overlapping queued chunks', () => {
      const dom = setupTestDOM();
      try {
        const bridge = new AudioBridge();
        bridge.init();

        const ctx = (bridge as any).audioCtx;
        ctx.currentTime = 5.0;

        const chunk = createStereoPcmBase64(Array.from({ length: 480 }, () => [0.1, 0.1]));

        // Deliver 30 chunks in zero simulated time (packet burst).
        for (let i = 0; i < 30; i++) {
          (bridge as any).playPCMChunk({
            pcm_base64: chunk,
            sample_rate: 48000,
            channels: 2,
            rms_level: 0.1,
            timestamp_us: 500000 + i * 10000,
          });
        }

        // The queue remains bounded and its clock never jumps backward over scheduled audio.
        assert.ok(
          (bridge as any).nextPlayTime >= ctx.currentTime + 0.2 &&
          (bridge as any).nextPlayTime <= ctx.currentTime + 0.21,
          `Burst backlog ceiling exceeded: nextPlayTime was ${(bridge as any).nextPlayTime}`
        );

        bridge.stop();
      } finally {
        dom.cleanup();
      }
    });
  });

  describe('3. Corrupted & Adversarial Audio Payload Fault Tolerance', () => {
    it('should silently handle empty or malformed base64 without unhandled exceptions', () => {
      const dom = setupTestDOM();
      try {
        const bridge = new AudioBridge();
        bridge.init();

        // A. Empty string
        assert.doesNotThrow(() => {
          (bridge as any).playPCMChunk({
            pcm_base64: '',
            sample_rate: 48000,
            channels: 2,
            rms_level: 0.0,
            timestamp_us: 0,
          });
        });

        // B. Corrupted non-base64 characters
        const origWarn = console.warn;
        const origErr = console.error;
        let loggedErr = false;
        console.error = () => { loggedErr = true; };
        console.warn = () => {};

        try {
          assert.doesNotThrow(() => {
            (bridge as any).playPCMChunk({
              pcm_base64: '@@@NOT_BASE64@@@',
              sample_rate: 48000,
              channels: 2,
              rms_level: 0.0,
              timestamp_us: 10,
            });
          });
        } finally {
          console.error = origErr;
          console.warn = origWarn;
        }

        // C. Clean stop
        bridge.stop();
        assert.equal((bridge as any).audioCtx, null);
        assert.equal((bridge as any).destNode, null);
      } finally {
        dom.cleanup();
      }
    });
  });

  describe('4. AudioContextManager Multi-Peer Stress & Concurrency', () => {
    it('should manage 50 concurrent peer sinks with isolated volume and clean teardown', () => {
      const dom = setupTestDOM();
      try {
        const manager = AudioContextManager.getInstance();
        const createdStreams: any[] = [];

        // Attach 50 simulated peers
        for (let i = 0; i < 50; i++) {
          const stream = {
            id: `stream-peer-${i}`,
            getAudioTracks: () => [{ id: `track-${i}`, kind: 'audio', enabled: true }],
          };
          createdStreams.push(stream);

          const sink = manager.attachPeerAudio(`peer-${i}`, stream as any);
          assert.ok(sink);
          assert.equal(sink.volume, 100);
          assert.equal(sink.isMuted, false);
          assert.equal(sink.gainNode.gain.value, 1.0);
        }

        // Adjust volumes and mutes across all 50 peers
        for (let i = 0; i < 50; i++) {
          if (i % 3 === 0) {
            manager.setPeerVolume(`peer-${i}`, 50, false);
            const state = manager.getPeerVolumeState(`peer-${i}`);
            assert.equal(state.volume, 50);
            assert.equal(state.isMuted, false);
          } else if (i % 3 === 1) {
            manager.setPeerVolume(`peer-${i}`, 80, true);
            const state = manager.getPeerVolumeState(`peer-${i}`);
            assert.equal(state.volume, 80);
            assert.equal(state.isMuted, true);
          }
        }

        // Detach 25 peers
        for (let i = 0; i < 25; i++) {
          manager.detachPeerAudio(`peer-${i}`);
          assert.equal((manager as any).peerSinks.has(`peer-${i}`), false);
        }

        // Remaining 25 peers must stay intact
        for (let i = 25; i < 50; i++) {
          assert.equal((manager as any).peerSinks.has(`peer-${i}`), true);
        }

        // Full cleanup
        manager.cleanup();
        assert.equal((manager as any).peerSinks.size, 0);
        assert.equal((manager as any).audioCtx, null);
      } finally {
        dom.cleanup();
      }
    });
  });
});
