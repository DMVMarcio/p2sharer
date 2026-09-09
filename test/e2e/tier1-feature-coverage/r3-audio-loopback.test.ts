import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertNear } from '../harness/assertions.ts';
import {
  calculateRms,
  pcm16ToFloat32,
  resampleInterleavedFloat,
  float32ArrayToBase64,
  base64ToFloat32Array,
  generateSineWave,
  resolveProcessFilter,
} from '../harness/audio-dsp-oracle.ts';
import type { ProcessNode } from '../harness/audio-dsp-oracle.ts';
import { validateAudioStreamPayload } from '../harness/ipc-contract.ts';

describe('Tier 1: R3 Audio Loopback & Resampling Coverage', () => {
  it('R3-T1-1: Should calculate exact RMS of pure sine wave (expected 1/sqrt(2) ~ 0.7071)', () => {
    // 440 Hz tone, 1 second, 48000 Hz, 2 channels, full amplitude 1.0
    const sine = generateSineWave(440, 1.0, 48000, 1.0, 2);
    const rms = calculateRms(sine);
    const expected = 1 / Math.SQRT2;
    assertNear(rms, expected, 0.005, 'RMS of full-scale sine must equal ~0.7071');
  });

  it('R3-T1-2: Should accurately resample 44100 Hz audio to standard 48000 Hz', () => {
    const inRate = 44100;
    const outRate = 48000;
    const channels = 2;
    const durationSec = 0.5;
    const inputSine = generateSineWave(1000, durationSec, inRate, 0.8, channels);

    const resampled = resampleInterleavedFloat(inputSine, channels, inRate, outRate);

    const expectedFrames = Math.round(durationSec * outRate);
    const actualFrames = resampled.length / channels;
    assert.equal(actualFrames, expectedFrames);

    // RMS energy should be preserved across linear resampling
    const inRms = calculateRms(inputSine);
    const outRms = calculateRms(resampled);
    assertNear(outRms, inRms, 0.02, 'RMS energy must be preserved across resampling');
  });

  it('R3-T1-3: Should accurately convert 16-bit PCM integer samples to Float32 [-1.0, 1.0]', () => {
    const int16Samples = [0, 32767, -32768, 16384, -16384];
    const floats = pcm16ToFloat32(int16Samples);

    assertNear(floats[0]!, 0.0, 0.0001);
    assertNear(floats[1]!, 32767 / 32768.0, 0.0001); // ~0.999969
    assertNear(floats[2]!, -1.0, 0.0001);
    assertNear(floats[3]!, 0.5, 0.0001);
    assertNear(floats[4]!, -0.5, 0.0001);
  });

  it('R3-T1-4: Should roundtrip Float32Array through Little-Endian Base64 without bit degradation', () => {
    const original = new Float32Array([0.0, 0.5, -0.5, 0.7071, -0.9999, 1.0]);
    const b64 = float32ArrayToBase64(original);
    const restored = base64ToFloat32Array(b64);

    assert.equal(restored.length, original.length);
    for (let i = 0; i < original.length; i++) {
      assertNear(restored[i]!, original[i]!, 0.00001, `Index ${i} float mismatch`);
    }
  });

  it('R3-T1-5: Should validate AudioStreamPayload contract', () => {
    const payload = {
      pcm_base64: 'AAAAAEAAgD8AAABA',
      sample_rate: 48000,
      channels: 2,
      rms_level: 0.42,
    };
    const validation = validateAudioStreamPayload(payload);
    assert.equal(validation.valid, true);
  });

  it('R3-T1-6: Should correctly filter processes in exclude mode', () => {
    const processes: ProcessNode[] = [
      { pid: 1000, name: 'system.exe', parentPid: 0 },
      { pid: 2000, name: 'spotify.exe', parentPid: 1000 },
      { pid: 2001, name: 'spotify_helper.exe', parentPid: 2000 },
      { pid: 3000, name: 'game.exe', parentPid: 1000 },
    ];

    // Exclude spotify.exe -> both 2000 and child 2001 must be excluded
    const allowed = resolveProcessFilter(processes, ['spotify.exe'], [], 'exclude');
    assert.ok(allowed.has(1000));
    assert.ok(allowed.has(3000));
    assert.equal(allowed.has(2000), false);
    assert.equal(allowed.has(2001), false);
  });

  it('R3-T1-7: Should correctly filter processes in include mode', () => {
    const processes: ProcessNode[] = [
      { pid: 1000, name: 'system.exe', parentPid: 0 },
      { pid: 2000, name: 'discord.exe', parentPid: 1000 },
      { pid: 3000, name: 'game.exe', parentPid: 1000 },
      { pid: 3001, name: 'game_subprocess.exe', parentPid: 3000 },
    ];

    // Include game.exe -> only 3000 and 3001 should be captured
    const allowed = resolveProcessFilter(processes, ['game.exe'], [], 'include');
    assert.equal(allowed.size, 2);
    assert.ok(allowed.has(3000));
    assert.ok(allowed.has(3001));
    assert.equal(allowed.has(2000), false);
  });
});
