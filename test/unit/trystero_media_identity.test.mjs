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
const streamFixture = (id, tracks = [{ readyState: 'live' }]) => ({ id, getTracks: () => [...tracks] });

test('audio events and reversed video arrival never associate a camera with the screen descriptor', () => {
  const { manager, events } = fixture();
  const screen = streamFixture('screen-stream'), camera = streamFixture('camera-stream');
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
    const id = `camera-${cycle}`, stream = streamFixture(`${id}-stream`);
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
  const screen = streamFixture('screen', [audio]), camera = streamFixture('camera', [video]);
  manager.receiveRemoteTrack('owner', audio, screen);
  manager.receiveTrackMeta({ k: 'camera-track', t: video.id, m: 'camera' }, 'owner');
  manager.receiveTrackMeta({ k: 'audio-track', t: audio.id, m: 'screen' }, 'owner');
  manager.receiveRemoteTrack('owner', video, camera);
  assert.deepEqual(events.map(event => [event.meta, event.stream]), [['screen', screen], ['camera', camera]]);
});

test('reentry ignores an emptied shared cache and delivers a replacement with the same SDP identities', () => {
  const { manager, events } = fixture();
  const tracks = [{ id: 'video', readyState: 'live' }];
  const original = streamFixture('screen-stream', tracks);
  manager.receiveStreamMeta(metadata('screen'), 'owner');
  manager.receiveRemoteStream('owner', original);
  tracks.length = 0; // SDP removal empties the original container without ending its tracks.
  manager.clearPeer('owner');
  manager.receiveStreamMeta(metadata('screen'), 'owner');
  assert.equal(events.length, 1, 'Empty cached media must not consume the new metadata');
  const replacement = streamFixture('screen-stream');
  manager.receiveRemoteStream('owner', replacement);
  assert.equal(events.at(-1).stream, replacement);
  assert.equal(events.length, 2);
  const next = streamFixture('screen-stream');
  manager.receiveRemoteStream('owner', next);
  assert.equal(events.at(-1).stream, next, 'Metadata must survive replacement events after an initial delivery');
});

test('audio tracks replaced under the same SDP ID are not suppressed by the shared cache', () => {
  const { manager } = fixture();
  const events = [];
  manager.onPeerTrack = (track) => events.push(track);
  const meta = { k: 'audio-key', s: 'screen', t: 'audio', m: 'screen' };
  const original = { id: 'audio', readyState: 'live' };
  const tracks = [original];
  manager.receiveTrackMeta(meta, 'owner');
  manager.receiveRemoteTrack('owner', original, streamFixture('screen', tracks));
  tracks.length = 0;
  manager.clearPeer('owner');
  manager.receiveTrackMeta(meta, 'owner');
  assert.equal(events.length, 1);
  const replacement = { id: 'audio', readyState: 'live' };
  manager.receiveRemoteTrack('owner', replacement, streamFixture('screen', [replacement]));
  assert.deepEqual(events, [original, replacement]);
});

test('room reentry can redeliver the same track and container objects retained by a shared connection', () => {
  const { manager } = fixture();
  const events = [];
  manager.onPeerTrack = (track) => events.push(track);
  const track = { id: 'audio', readyState: 'live' }, tracks = [track];
  const stream = streamFixture('screen', tracks);
  const meta = { k: 'audio-key', s: 'screen', t: 'audio', m: 'screen' };
  manager.receiveTrackMeta(meta, 'owner');
  manager.receiveRemoteTrack('owner', track, stream);
  tracks.length = 0;
  manager.clearPeer('owner');
  manager.receiveTrackMeta(meta, 'owner');
  tracks.push(track);
  manager.receiveRemoteTrack('owner', track, stream);
  assert.deepEqual(events, [track, track]);
});

test('inactive transceiver receivers never shadow replacement tracks on metadata replay', () => {
  const oldTrack = { id: 'video-old', readyState: 'live' };
  const oldStream = streamFixture('screen-stream', [oldTrack]);
  let transceivers = [{ receiver: { track: oldTrack }, currentDirection: 'recvonly', direction: 'recvonly', stopped: false }];
  const peer = {
    __trysteroMedia: createMediaIdentityCache(),
    connection: {
      getReceivers: () => transceivers.map((t) => t.receiver),
      getTransceivers: () => transceivers,
    },
  };
  const manager = createMediaManager({ iterate: () => [], isActive: () => true, getSharedMediaPeer: () => peer });
  const events = [];
  manager.onPeerStream = (stream, _owner, meta) => events.push({ stream, meta });
  manager.receiveStreamMeta(metadata('screen'), 'owner');
  manager.receiveRemoteStream('owner', oldStream);
  assert.equal(events.length, 1);

  // Stopping the track remotely sets transceiver inactive even if readyState has not flipped yet.
  transceivers = [{ receiver: { track: oldTrack }, currentDirection: 'inactive', direction: 'inactive', stopped: false }];
  manager.receiveStreamMeta(metadata('screen'), 'owner');
  assert.equal(events.length, 1, 'Inactive transceiver must not re-emit retired cached stream');

  const replacementTrack = { id: 'video-new', readyState: 'live' };
  const replacementStream = streamFixture('screen-stream', [replacementTrack]);
  transceivers = [{ receiver: { track: replacementTrack }, currentDirection: 'recvonly', direction: 'recvonly', stopped: false }];
  manager.receiveRemoteStream('owner', replacementStream);
  assert.equal(events.length, 2);
  assert.equal(events.at(-1).stream, replacementStream);
});

test('reused transceivers whose receiver track.id differs from sender track.id still pair via streamId and kind', () => {
  const { manager } = fixture();
  const events = [];
  manager.onPeerTrack = (track, stream, owner, meta) => events.push({ track, stream, owner, meta });

  // Meta arrives before track (normal order): receiver transceiver assigns a local UUID instead of sender's trackId.
  const screenMeta = { id: 'screen-1', kind: 'screen' };
  manager.receiveTrackMeta({ k: 'video-key', s: 'sender-stream-1', t: 'sender-video-id', d: 'video', m: screenMeta }, 'owner');
  manager.receiveTrackMeta({ k: 'audio-key', s: 'sender-stream-1', t: 'sender-audio-id', d: 'audio', m: screenMeta }, 'owner');

  const reusedVideo = { id: 'receiver-local-video-uuid', kind: 'video', readyState: 'live' };
  const reusedAudio = { id: 'receiver-local-audio-uuid', kind: 'audio', readyState: 'live' };
  const remoteStream = streamFixture('sender-stream-1', [reusedAudio, reusedVideo]);
  manager.receiveRemoteTrack('owner', reusedVideo, remoteStream);
  manager.receiveRemoteTrack('owner', reusedAudio, remoteStream);

  assert.equal(events.length, 2);
  assert.equal(events[0].track, reusedVideo);
  assert.equal(events[0].meta, screenMeta);
  assert.equal(events[1].track, reusedAudio);
  assert.equal(events[1].meta, screenMeta);

  // Track arrives before meta (reversed order) with mismatched receiver track.id.
  const lateVideo = { id: 'receiver-local-cam-uuid', kind: 'video', readyState: 'live' };
  const camStream = streamFixture('sender-cam-stream', [lateVideo]);
  const camMeta = { id: 'cam-1', kind: 'camera' };
  manager.receiveRemoteTrack('owner', lateVideo, camStream);
  assert.equal(events.length, 2);
  manager.receiveTrackMeta({ k: 'cam-key', s: 'sender-cam-stream', t: 'sender-cam-id', d: 'video', m: camMeta }, 'owner');
  assert.equal(events.length, 3);
  assert.equal(events[2].track, lateVideo);
  assert.equal(events[2].meta, camMeta);
});
