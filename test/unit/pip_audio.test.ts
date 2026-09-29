import assert from 'node:assert/strict';
import test from 'node:test';
import { setupTestDOM, MockMediaStream, MockMediaStreamTrack } from '../e2e/harness/dom-mock.ts';
import { audioContextManager } from '../../src/audio/audio_context_manager.ts';
import { PipService } from '../../src/services/pip_service.ts';
import { validPipAudioSettings } from '../../src/services/pip_audio.ts';

test('PiP keeps remote audio audible and applies its volume controls to the main audio sink', async () => {
  const dom = setupTestDOM();
  const peerId = `pip-audio-${Date.now()}`;
  const stream = new MockMediaStream();
  stream.addTrack(new MockMediaStreamTrack('video'));
  stream.addTrack(new MockMediaStreamTrack('audio'));
  audioContextManager.attachPeerAudio(peerId, stream as unknown as MediaStream);
  audioContextManager.setPeerVolume(peerId, 35, false);
  const service = new PipService();
  const channel = new BroadcastChannel(`p2sharer-pip-${peerId}`);
  try {
    await service.openPip(peerId, 'Remote screen', stream as unknown as MediaStream);
    assert.deepEqual(audioContextManager.getPeerVolumeState(peerId), { volume: 35, isMuted: false });

    channel.postMessage({ sender: 'pip', type: 'audio-settings', volume: 70, muted: false });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(audioContextManager.getPeerVolumeState(peerId), { volume: 70, isMuted: false });

    channel.postMessage({ sender: 'pip', type: 'audio-settings', volume: -1, muted: true });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(audioContextManager.getPeerVolumeState(peerId), { volume: 70, isMuted: false });

    await service.restoreFromPip(peerId);
    assert.deepEqual(audioContextManager.getPeerVolumeState(peerId), { volume: 70, isMuted: false });
  } finally {
    channel.close();
    await service.restoreFromPip(peerId);
    service.destroy();
    audioContextManager.cleanup();
    dom.cleanup();
  }
});

test('PiP audio settings reject invalid cross-window values', () => {
  assert.equal(validPipAudioSettings({ volume: 50, muted: false }), true);
  assert.equal(validPipAudioSettings({ volume: Number.NaN, muted: false }), false);
  assert.equal(validPipAudioSettings({ volume: 101, muted: false }), false);
  assert.equal(validPipAudioSettings({ volume: 50, muted: 'false' }), false);
});
