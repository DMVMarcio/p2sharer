import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMediaIdentityCache, createMediaManager } from '../../node_modules/@trystero-p2p/core/dist/media.mjs';

function fixture() {
  const peer = { __trysteroMedia: createMediaIdentityCache() };
  const manager = createMediaManager({ iterate: () => [], isActive: () => true, getSharedMediaPeer: () => peer });
  const events = [];
  manager.onPeerStream = (stream, owner, metadata) => events.push({ stream, owner, metadata });
  return { manager, events };
}
const metadata = (id) => ({ k: id, s: `${id}-stream`, m: { id } });

test('audio events and reversed video arrival never associate a camera with the screen descriptor', () => {
  const { manager, events } = fixture();
  const screen = { id: 'screen-stream' }, camera = { id: 'camera-stream' };
  manager.receiveStreamMeta(metadata('screen'), 'owner');
  manager.receiveStreamMeta(metadata('camera'), 'owner');
  manager.receiveRemoteStream('owner', camera);
  manager.receiveRemoteStream('owner', screen);
  manager.receiveRemoteStream('owner', screen); // Separate audio ontrack, same stream.
  assert.deepEqual(events.map(event => [event.metadata.id, event.stream]), [['camera', camera], ['screen', screen]]);
  manager.receiveStreamMeta(metadata('screen'), 'owner'); // Recovery metadata reuses the correct stream.
  assert.equal(events.at(-1).stream, screen);
});

test('tracks arriving before metadata remain paired by identity across repeated start/stop cycles', () => {
  const { manager, events } = fixture();
  for (let cycle = 0; cycle < 8; cycle++) {
    const id = `camera-${cycle}`, stream = { id: `${id}-stream` };
    manager.receiveRemoteStream('owner', stream);
    manager.receiveStreamMeta(metadata(id), 'owner');
    assert.equal(events.at(-1).stream, stream);
    manager.clearPeer('owner');
  }
  assert.equal(events.length, 8);
});

test('late and reversed track metadata attaches transferred audio to the intended stream', () => {
  const { manager } = fixture();
  const events = [];
  manager.onPeerTrack = (track, stream, owner, meta) => events.push({ track, stream, meta });
  const audio = { id: 'audio' }, video = { id: 'camera-video' };
  const screen = { id: 'screen' }, camera = { id: 'camera' };
  manager.receiveRemoteTrack('owner', audio, screen);
  manager.receiveTrackMeta({ k: 'camera-track', t: video.id, m: 'camera' }, 'owner');
  manager.receiveTrackMeta({ k: 'audio-track', t: audio.id, m: 'screen' }, 'owner');
  manager.receiveRemoteTrack('owner', video, camera);
  assert.deepEqual(events.map(event => [event.meta, event.stream]), [['screen', screen], ['camera', camera]]);
});
