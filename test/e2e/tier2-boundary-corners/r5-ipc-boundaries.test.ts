import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateIpcInvoke,
  validateAudioConfig,
  validateAudioStreamPayload,
} from '../harness/ipc-contract.ts';

describe('Tier 2: R5 IPC Contract Boundaries & Corner Cases', () => {
  it('R5-T2-1: Should reject invocations to unknown Tauri commands', () => {
    const res = validateIpcInvoke('non_existent_command', {});
    assert.equal(res.valid, false);
    assert.ok(res.error?.includes('Unknown Tauri command'));
  });

  it('R5-T2-2: Should reject write_frontend_log if required level or message is missing', () => {
    const missingLevel = validateIpcInvoke('write_frontend_log', { message: 'hello' });
    assert.equal(missingLevel.valid, false);
    assert.ok(missingLevel.error?.includes('level'));

    const missingMessage = validateIpcInvoke('write_frontend_log', { level: 'INFO' });
    assert.equal(missingMessage.valid, false);
    assert.ok(missingMessage.error?.includes('message'));
  });

  it('R5-T2-3: Should reject IPC arguments with mismatched types', () => {
    // targetFps must be a number, not a string
    const badFps = validateIpcInvoke('start_native_screen_capture', {
      sourceId: 'monitor:0',
      targetFps: 'sixty',
    });
    assert.equal(badFps.valid, false);
    assert.ok(badFps.error?.includes('expected type number'));

    // captureMouse must be boolean, not string
    const badMouse = validateIpcInvoke('start_native_screen_capture', {
      sourceId: 'monitor:0',
      captureMouse: 'yes',
    });
    assert.equal(badMouse.valid, false);
    assert.ok(badMouse.error?.includes('expected type boolean'));
  });

  it('R5-T2-4: Should reject invalid AudioConfig structures', () => {
    // Invalid mode
    const badMode = validateAudioConfig({
      mode: 'unsupported_mode',
      target_pids: [],
      target_names: [],
      sample_rate: 48000,
    });
    assert.equal(badMode.valid, false);
    assert.ok(badMode.error?.includes('Invalid AudioConfig.mode'));

    // Negative sample rate
    const badRate = validateAudioConfig({
      mode: 'exclude',
      target_pids: [],
      target_names: [],
      sample_rate: -44100,
    });
    assert.equal(badRate.valid, false);
    assert.ok(badRate.error?.includes('positive number'));

    // Non-array target_pids
    const badPids = validateAudioConfig({
      mode: 'exclude',
      target_pids: '1234,5678', // String instead of array
      target_names: [],
      sample_rate: 48000,
    });
    assert.equal(badPids.valid, false);
    assert.ok(badPids.error?.includes('array of numbers'));
  });

  it('R5-T2-5: Should reject AudioStreamPayload with out-of-range channels or RMS level', () => {
    // Channels = 0
    const zeroChannels = validateAudioStreamPayload({
      pcm_base64: 'AAAA',
      sample_rate: 48000,
      channels: 0,
      rms_level: 0.5,
    });
    assert.equal(zeroChannels.valid, false);
    assert.ok(zeroChannels.error?.includes('channels'));

    // Channels = 64
    const extremeChannels = validateAudioStreamPayload({
      pcm_base64: 'AAAA',
      sample_rate: 48000,
      channels: 64,
      rms_level: 0.5,
    });
    assert.equal(extremeChannels.valid, false);
    assert.ok(extremeChannels.error?.includes('channels'));

    // RMS level > 1.0
    const highRms = validateAudioStreamPayload({
      pcm_base64: 'AAAA',
      sample_rate: 48000,
      channels: 2,
      rms_level: 2.5,
    });
    assert.equal(highRms.valid, false);
    assert.ok(highRms.error?.includes('rms_level'));

    // Negative RMS level
    const negRms = validateAudioStreamPayload({
      pcm_base64: 'AAAA',
      sample_rate: 48000,
      channels: 2,
      rms_level: -0.1,
    });
    assert.equal(negRms.valid, false);
    assert.ok(negRms.error?.includes('rms_level'));
  });

  it('R5-T2-6: Should reject null or non-object payloads gracefully', () => {
    assert.equal(validateAudioConfig(null).valid, false);
    assert.equal(validateAudioConfig(undefined).valid, false);
    assert.equal(validateAudioStreamPayload(null).valid, false);
    assert.equal(validateAudioStreamPayload('string_payload').valid, false);
  });
});
