import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestDOM, MockAudioBufferSourceNode } from '../e2e/harness/dom-mock.ts';
import { AudioBridge } from '../../src/audio/audio_bridge.ts';

function makeChunk(startFrame: number): string {
  const bytes = Buffer.alloc(480 * 2 * 4);
  for (let frame = 0; frame < 480; frame++) {
    const sample = Math.sin(2 * Math.PI * 997 * (startFrame + frame) / 48000) * 0.7;
    bytes.writeFloatLE(sample, frame * 8);
    bytes.writeFloatLE(sample, frame * 8 + 4);
  }
  return bytes.toString('base64');
}

describe('audio playout continuity under ordered IPC jitter', () => {
  it('schedules a continuous 10-second signal without gaps or overlaps', () => {
    const dom = setupTestDOM();
    try {
      const bridge = new AudioBridge();
      bridge.init();
      const ctx = (bridge as any).audioCtx;
      const sources: MockAudioBufferSourceNode[] = [];
      const createSource = ctx.createBufferSource.bind(ctx);
      ctx.createBufferSource = () => {
        const source = createSource();
        sources.push(source);
        return source;
      };

      let previousArrival = 0;
      for (let chunk = 0; chunk < 1000; chunk++) {
        // Deterministic 0..30ms dispatch jitter, with IPC event ordering retained.
        const jitter = ((chunk * 37) % 31) / 1000;
        const arrival = Math.max(previousArrival, chunk * 0.01 + jitter);
        ctx.currentTime = arrival;
        previousArrival = arrival;
        (bridge as any).playPCMChunk({
          pcm_base64: makeChunk(chunk * 480),
          sample_rate: 48000,
          channels: 2,
          rms_level: 0.5,
          timestamp_us: chunk * 10000,
        });
      }

      assert.equal(sources.length, 1000, 'no chunk may be dropped under bounded jitter');
      for (let i = 1; i < sources.length; i++) {
        const previous = sources[i - 1]!;
        const current = sources[i]!;
        const gap = current.startedAt! - (previous.startedAt! + previous.buffer!.duration);
        assert.ok(Math.abs(gap) < 1e-6, `gap or overlap at chunk ${i}: ${gap}s`);
        const previousLast = previous.buffer!.getChannelData(0)[479]!;
        const currentFirst = current.buffer!.getChannelData(0)[0]!;
        assert.ok(Math.abs(currentFirst - previousLast) < 0.1, `PCM discontinuity at chunk ${i}`);
      }
      bridge.stop();
    } finally {
      dom.cleanup();
    }
  });
});
