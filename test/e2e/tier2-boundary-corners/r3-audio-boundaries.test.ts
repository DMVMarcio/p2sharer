import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertNear } from '../harness/assertions.ts';
import {
  calculateRms,
  resampleInterleavedFloat,
  resolveProcessFilter,
} from '../harness/audio-dsp-oracle.ts';
import type { ProcessNode } from '../harness/audio-dsp-oracle.ts';
import { validateAudioStreamPayload } from '../harness/ipc-contract.ts';

describe('Tier 2: R3 Audio Boundaries & Corner Cases', () => {
  it('R3-T2-1: Should calculate exact 0.0 RMS for complete digital silence', () => {
    const silence = new Float32Array(4800); // 100ms of silence
    const rms = calculateRms(silence);
    assert.equal(rms, 0.0);
  });

  it('R3-T2-2: Should clamp extreme audio clipping (+10.0 and -10.0) to max 1.0 RMS', () => {
    const clipped = new Float32Array([10.0, -10.0, 50.0, -25.0]);
    const rms = calculateRms(clipped);
    assert.equal(rms, 1.0, 'RMS should clamp to 1.0 ceiling to protect audio decoders');
  });

  it('R3-T2-3: Should gracefully handle empty PCM buffer (0 samples) in DSP algorithms', () => {
    const empty = new Float32Array(0);
    const rms = calculateRms(empty);
    assert.equal(rms, 0.0);

    const resampled = resampleInterleavedFloat(empty, 2, 44100, 48000);
    assert.equal(resampled.length, 0);
  });

  it('R3-T2-4: Should resample extreme sample rate: 8000 Hz telephony to 48000 Hz (6:1 upsampling)', () => {
    const inRate = 8000;
    const outRate = 48000;
    const inFrames = 800; // 100ms at 8kHz
    const input = new Float32Array(inFrames * 2);
    for (let i = 0; i < input.length; i++) {
      input[i] = Math.sin((i / 8) * Math.PI);
    }

    const resampled = resampleInterleavedFloat(input, 2, inRate, outRate);
    const expectedFrames = Math.round((inFrames * outRate) / inRate); // 4800
    assert.equal(resampled.length / 2, expectedFrames);
  });

  it('R3-T2-5: Should resample extreme sample rate: 192000 Hz studio master to 48000 Hz (4:1 downsampling)', () => {
    const inRate = 192000;
    const outRate = 48000;
    const inFrames = 19200; // 100ms at 192kHz
    const input = new Float32Array(inFrames * 2);
    for (let i = 0; i < input.length; i++) {
      input[i] = 0.5 * Math.sin((i / 32) * Math.PI);
    }

    const resampled = resampleInterleavedFloat(input, 2, inRate, outRate);
    const expectedFrames = Math.round((inFrames * outRate) / inRate); // 4800
    assert.equal(resampled.length / 2, expectedFrames);
  });

  it('R3-T2-6: Should return empty set (total silence) in include mode with 0 target apps', () => {
    const processes: ProcessNode[] = [
      { pid: 100, name: 'system.exe', parentPid: 0 },
      { pid: 200, name: 'browser.exe', parentPid: 100 },
    ];

    // Authoritative specification: in include mode with no target, silence is streamed
    const allowed = resolveProcessFilter(processes, [], [], 'include');
    assert.equal(allowed.size, 0, 'Include mode with 0 targets must capture 0 processes (silence)');
  });

  it('R3-T2-7: Should reject malformed or non-string base64 in AudioStreamPayload', () => {
    const badPayload1 = {
      pcm_base64: 12345, // Not a string
      sample_rate: 48000,
      channels: 2,
      rms_level: 0.5,
    };
    assert.equal(validateAudioStreamPayload(badPayload1).valid, false);

    const badPayload2 = {
      pcm_base64: 'valid_b64',
      sample_rate: -48000, // Invalid sample rate
      channels: 2,
      rms_level: 0.5,
    };
    assert.equal(validateAudioStreamPayload(badPayload2).valid, false);
  });
});
