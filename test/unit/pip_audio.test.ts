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

test('audio follows track identity across video container changes and releases its independent pull sink', () => {
  const dom = setupTestDOM();
  try {
    const audio = new MockMediaStreamTrack('audio');
    const first = new MockMediaStream(); first.addTrack(audio);
    const state = audioContextManager.attachPeerAudio('stable-audio', first as unknown as MediaStream);
    const source = state.source;
    assert.ok(source);
    const element = dom.document.body.children.find(element => element.tagName === 'AUDIO') as any;
    assert.ok(element); assert.equal(element.volume, 0); assert.equal(element.paused, false);
    const replacement = new MockMediaStream(); replacement.addTrack(audio);
    replacement.addTrack(new MockMediaStreamTrack('video'));
    assert.equal(audioContextManager.attachPeerAudio('stable-audio', replacement as unknown as MediaStream).source, source);
    const changed = new MockMediaStream(); changed.addTrack(new MockMediaStreamTrack('audio'));
    assert.notEqual(audioContextManager.attachPeerAudio('stable-audio', changed as unknown as MediaStream).source, source);
    audioContextManager.detachPeerAudio('stable-audio');
    assert.equal(element.srcObject, null); assert.equal(element.paused, true);
    assert.equal(dom.document.body.children.includes(element), false);
  } finally { audioContextManager.cleanup(); dom.cleanup(); }
});
