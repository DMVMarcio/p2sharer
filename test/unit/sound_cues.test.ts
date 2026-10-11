import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { renderSoundCue, SOUND_EVENTS } from '../../src/core/sound_cues.ts';

test('all notification cues render distinct, bounded waveforms without abrupt edges', () => {
  for (const rate of [44100, 48000]) {
    const signatures = new Set<string>();
    for (const event of SOUND_EVENTS) {
      const samples = renderSoundCue(event, rate);
      assert.ok(samples.length > rate * 0.15 && samples.length < rate * 0.6);
      assert.equal(samples[0], 0);
      assert.equal(samples.at(-1), 0);
      let peak = 0, energy = 0, largestStep = 0;
      for (let i = 0; i < samples.length; i++) {
        assert.ok(Number.isFinite(samples[i]));
        peak = Math.max(peak, Math.abs(samples[i]));
        energy += samples[i] ** 2;
        if (i) largestStep = Math.max(largestStep, Math.abs(samples[i] - samples[i - 1]));
      }
      assert.ok(peak < 0.2, 'cues retain headroom even at maximum volume');
      assert.ok(Math.sqrt(energy / samples.length) > 0.005, 'cue must contain audible signal');
      assert.ok(largestStep < 0.025, 'no discontinuous attacks or truncated tails');
      signatures.add(createHash('sha256').update(new Uint8Array(samples.buffer)).digest('hex'));
    }
    assert.equal(signatures.size, SOUND_EVENTS.length);
  }
  for (const rate of [0, NaN, Infinity, 4000, 1000000]) assert.throws(() => renderSoundCue('message', rate), RangeError);
});
