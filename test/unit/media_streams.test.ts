import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reconcilePinnedRoomSlot, snapOverlay, resizeOverlay, streamOwner, streamSlotKey, validStreamDescriptors, type StreamDescriptor } from '../../src/core/media_streams.ts';
import type { RoomSlotInfo } from '../../src/core/types.ts';
import { GroupRoomManager } from '../../src/p2p/group_room.ts';
import { MediaCoordinator } from '../../src/p2p/media_coordinator.ts';
import { signalingManager } from '../../src/p2p/signaling_manager.ts';

test('spotlight follows its participant through stream start and stop without switching an existing selected source', () => {
  const participant: RoomSlotInfo = { peerId: 'owner', senderName: 'Same name', isLocal: false,
    isStreaming: false, stream: null, color: '#abcdef' };
  const other = { ...participant, peerId: 'other' };
  const screen = { ...participant, peerId: 'owner/screen', ownerPeerId: 'owner', mediaKind: 'screen' as const, isStreaming: true };
  const camera = { ...screen, peerId: 'owner/camera', mediaKind: 'camera' as const };
  const secondScreen = { ...screen, peerId: 'owner/second-screen' };
  let pinned = reconcilePinnedRoomSlot('owner', [other, participant], [other, camera, screen]);
  assert.equal(pinned, screen.peerId);
  pinned = reconcilePinnedRoomSlot(pinned, [other, camera, screen], [secondScreen, other, camera, screen]);
  assert.equal(pinned, screen.peerId);
  assert.equal(reconcilePinnedRoomSlot(camera.peerId, [camera, screen], [screen, camera]), camera.peerId);
  pinned = reconcilePinnedRoomSlot(pinned, [other, screen], [other, participant]);
  assert.equal(pinned, participant.peerId);
  assert.equal(reconcilePinnedRoomSlot(pinned, [other, participant], [other]), null);
  assert.equal(reconcilePinnedRoomSlot('app:notes', [participant], [screen]), 'app:notes');
  assert.equal(reconcilePinnedRoomSlot(null, [participant], [screen]), null);
});

test('native publication targets only its peer, suppresses browser video and preserves audio', () => {
  const manager = new GroupRoomManager('Owner', 'test', '', true);
  const stream = fakeStream('native-screen');
  const audio = { id: 'audio', kind: 'audio' };
  Object.assign(stream, { getAudioTracks: () => [audio] });
  const calls: Array<{ kind: string; track: any; options: any }> = [];
  const internal = manager as any;
  internal.localMedia.set('native-screen', { stream, descriptor: descriptor('native-screen') });
  internal.nativeVideo = { dispatch: () => true };
  internal.room = {
    addStream: () => assert.fail('Native video must not enter the browser encoder'),
    removeTrack: (track: any, options: any) => calls.push({ kind: 'remove', track, options }),
    addTrack: (track: any, _stream: MediaStream, options: any) => { calls.push({ kind: 'add', track, options }); return []; },
  };
  internal.dispatchMediaToPeer('watcher');
  assert.equal(calls.length, 2); assert.equal(calls[0].track.kind, 'video'); assert.equal(calls[1].track, audio);
  assert.ok(calls.every(call => call.options.target === 'watcher'));
  internal.nativeVideo = null; internal.room = null; manager.stopStream();
});

test('native sender HUD measures transmitted frames rather than preview repeats or requested FPS', async () => {
  const manager = new GroupRoomManager('Owner','test','',true);
  const stream = fakeStream('native-screen');
  Object.assign(stream.getVideoTracks()[0],{getSettings:()=>({frameRate:120,width:1280,height:720})});
  manager.shareStream(stream,8_000_000,120,descriptor('native-screen'));
  const internal=manager as any;
  internal.nativeVideo={senderStats:async()=>[{bytes:200_000,frames:110}]};
  internal.mediaStatsSamples.set('local/native-screen',{bytes:100_000,at:Date.now()-1000,nativeFrames:50});
  const stats=await manager.getPeerStats('local/native-screen');
  assert.ok(stats.fps!>=58&&stats.fps!<=62);assert.ok(stats.bitrateKbps!>=780&&stats.bitrateKbps!<=820);
  internal.nativeVideo=null;manager.stopStream();
});

test('native video and ordinary audio merge into the same advertised slot without replacing another source', () => {
  const original = globalThis.MediaStream;
  class TestStream extends EventTarget {
    id = crypto.randomUUID(); private tracks: any[];
    constructor(tracks: any[]) { super(); this.tracks = tracks; }
    getTracks() { return this.tracks; } getVideoTracks() { return this.tracks.filter(t=>t.kind==='video'); }
    getAudioTracks() { return this.tracks.filter(t=>t.kind==='audio'); }
    addTrack(track: any) { this.tracks.push(track); this.dispatchEvent(new Event('addtrack')); }
  }
  Object.assign(globalThis, { MediaStream: TestStream });
  try {
    const manager = new GroupRoomManager('Viewer','test','',false); const internal = manager as any;
    internal.peerTracker.receivePeerExchange('owner',true,'Owner');
    internal.remoteDescriptors.set('owner',[descriptor('screen'),descriptor('camera','camera')]);
    internal.remoteMediaRevisions.set('owner',1);
    const audio = { id:'audio', kind:'audio', readyState:'live' }, video = { id:'native',kind:'video',readyState:'live' };
    const camera = { id:'camera',kind:'video',readyState:'live' };
    internal.receivePeerStream(new TestStream([camera]),'owner',descriptor('camera','camera'));
    internal.receivePeerStream(new TestStream([audio]),'owner',descriptor('screen'));
    internal.receivePeerStream(new TestStream([video]),'owner',descriptor('screen'));
    const media=internal.remoteMedia.get('owner'); assert.deepEqual(media.get('screen').getTracks(),[video,audio]);
    assert.equal(media.get('camera').getVideoTracks()[0],camera);
    const stable = media.get('screen');
    for (let index = 0; index < 10; index++) {
      internal.receivePeerStream(new TestStream([video, audio]), 'owner', descriptor('screen'));
      internal.receivePeerStream(new TestStream([audio]), 'owner', descriptor('screen'));
      assert.equal(media.get('screen'), stable, 'Repeated presence must not reset playback or pointing');
    }
    const replacement={id:'generic-fallback',kind:'video',readyState:'live'};
    internal.receivePeerStream(new TestStream([replacement]),'owner',descriptor('screen'));
    assert.deepEqual(media.get('screen').getTracks(),[replacement,audio]);
    assert.equal(media.get('camera').getVideoTracks()[0],camera);
    const cameraStream = media.get('camera');
    cameraStream.addTrack({ id: 'late-audio', kind: 'audio', readyState: 'live' });
    assert.equal(media.get('camera'), cameraStream, 'Late tracks must preserve the observed container');
    assert.equal(media.get('camera').getAudioTracks().length, 1);
  } finally { Object.assign(globalThis,{MediaStream:original}); }
});

const descriptor = (id: string, kind: 'screen' | 'camera' = 'screen'): StreamDescriptor =>
  ({ id, kind, label: kind, videoTrackId: `${id}-video`, fps: 60, bitrate: 8000 });
function fakeStream(id: string) {
  const track = { id: `${id}-video`, kind: 'video', readyState: 'live', stop() { this.readyState = 'ended'; } };
  let tracks = [track];
  return { id, getTracks: () => tracks, getVideoTracks: () => tracks, getAudioTracks: () => [],
    addTrack: (item: typeof track) => { tracks.push(item); }, removeTrack: (item: typeof track) => { tracks = tracks.filter((entry) => entry !== item); } } as unknown as MediaStream;
}

test('stream slots keep their identity when cameras and screens reorder', () => {
  assert.equal(streamSlotKey('owner', 'camera', true), streamSlotKey('owner', 'camera', false));
  assert.equal(streamOwner(streamSlotKey('owner', 'camera')), 'owner');
  assert.notEqual(streamSlotKey('owner', 'camera'), streamSlotKey('owner', 'screen'));
});

test('media manifests reject duplicate identities, excessive sessions and invalid settings', () => {
  assert.ok(validStreamDescriptors([descriptor('screen'), descriptor('camera', 'camera')]));
  assert.equal(validStreamDescriptors([descriptor('same'), descriptor('same')]), false);
  assert.equal(validStreamDescriptors([descriptor('../other')]), false);
  assert.equal(validStreamDescriptors([{ ...descriptor('bad'), fps: Infinity }]), false);
  assert.equal(validStreamDescriptors([{ ...descriptor('bad'), bitrate: -1 }]), false);
  assert.equal(validStreamDescriptors(Array.from({ length: 17 }, (_, index) => descriptor(`s${index}`))), false);
});

test('camera occupies the main participant card; adding screens produces independent owned cards', () => {
  const manager = new GroupRoomManager('Owner', 'test', '', true);
  manager.shareStream(fakeStream('camera'), 8_000_000, 60, descriptor('camera', 'camera'));
  assert.equal(manager.getAllRoomSlots().length, 1);
  manager.shareStream(fakeStream('screen'), 8_000_000, 60, descriptor('screen'));
  manager.shareStream(fakeStream('screen2'), 8_000_000, 60, descriptor('screen2'));
  const slots = manager.getAllRoomSlots();
  assert.deepEqual(slots.map((slot) => slot.mediaKind), ['screen', 'screen', 'camera']);
  assert.ok(slots.every((slot) => slot.ownerPeerId === 'local'));
  assert.deepEqual(slots.map(slot => slot.pointerEligible), [true, true, false]);
  const remainingTrack = slots[1].stream!.getVideoTracks()[0];
  manager.stopStream('screen');
  assert.equal(remainingTrack.readyState, 'live');
  assert.equal(manager.getAllRoomSlots().length, 2);
  manager.stopStream('screen2');
  assert.equal(manager.getAllRoomSlots()[0].mediaId, 'camera');
  manager.stopStream();
  assert.equal(manager.getAllRoomSlots()[0].isStreaming, false);
});

test('live source replacement preserves stream identity and leaves other senders intact', async () => {
  const manager = new GroupRoomManager('Owner', 'test', '', true);
  const first = fakeStream('screen');
  const second = fakeStream('camera');
  manager.shareStream(first, 8_000_000, 60, descriptor('screen'));
  manager.shareStream(second, 8_000_000, 60, descriptor('camera', 'camera'));
  const old = first.getVideoTracks()[0];
  const other = second.getVideoTracks()[0];
  const replacement = fakeStream('replacement').getVideoTracks()[0];
  const sender = { track: old, async replaceTrack(track: MediaStreamTrack) { this.track = track; } };
  const otherSender = { track: other, async replaceTrack(track: MediaStreamTrack) { this.track = track; } };
  (manager as any).room = { getPeers: () => ({ peer: { getSenders: () => [sender, otherSender] } }) };
  await manager.replaceMediaTrack('screen', replacement, { ...descriptor('screen'), videoTrackId: replacement.id, fps: 30 });
  assert.equal(sender.track, replacement);
  assert.equal(otherSender.track, other);
  assert.equal(old.readyState, 'ended');
  assert.equal(manager.getAllRoomSlots().find((slot) => slot.mediaId === 'screen')!.stream, first);
  assert.equal(first.id, 'screen');
  (manager as any).room = null;
  manager.stopStream();
});

test('failed live replacement rolls back already replaced peers without stopping the old track', async () => {
  const manager = new GroupRoomManager('Owner', 'test', '', true);
  const stream = fakeStream('screen');
  const old = stream.getVideoTracks()[0];
  manager.shareStream(stream, 8_000_000, 60, descriptor('screen'));
  const replacement = fakeStream('replacement').getVideoTracks()[0];
  const sender = { track: old, async replaceTrack(track: MediaStreamTrack) { this.track = track; } };
  (manager as any).room = { getPeers: () => ({ first: { getSenders: () => [sender] }, second: {
    getSenders: () => [{ track: old, replaceTrack: async () => { throw new Error('encoder rejected replacement'); } }],
  } }) };
  await assert.rejects(manager.replaceMediaTrack('screen', replacement, descriptor('screen')));
  assert.equal(sender.track, old);
  assert.equal(old.readyState, 'live');
  assert.equal(stream.getVideoTracks()[0], old);
  (manager as any).room = null;
  manager.stopStream();
});

test('per-stream encoding changes leave camera FPS and bitrate independent', async () => {
  const settings: any[] = [{ encodings: [{}] }, { encodings: [{}] }];
  const pc = { signalingState: 'stable', getSenders: () => ['screen', 'camera'].map((id, index) => ({
    track: { id, kind: 'video' }, getParameters: () => settings[index], setParameters: async () => {},
  })) } as unknown as RTCPeerConnection;
  await MediaCoordinator.applySenderBitrate(pc, 15_000_000, 60, 'screen');
  await MediaCoordinator.applySenderBitrate(pc, 3_000_000, 30, 'camera');
  assert.equal(settings[0].encodings[0].maxBitrate, 15_000_000);
  assert.equal(settings[0].encodings[0].maxFramerate, 60);
  assert.equal(settings[1].encodings[0].maxBitrate, 3_000_000);
  assert.equal(settings[1].encodings[0].maxFramerate, 30);
});

test('stopping the audio-bearing screen transfers audio to a remaining screen', () => {
  const manager = new GroupRoomManager('Owner', 'test', '', true);
  const audio = { id: 'desktop-audio', kind: 'audio', readyState: 'live', stop() { this.readyState = 'ended'; },
    clone() { return { ...this, id: 'desktop-audio-clone' }; } };
  const firstVideo = fakeStream('first').getVideoTracks()[0];
  const secondVideo = fakeStream('second').getVideoTracks()[0];
  function media(id: string, initial: any[]) {
    let tracks = initial;
    return { id, getTracks: () => tracks, getVideoTracks: () => tracks.filter((track) => track.kind === 'video'),
      getAudioTracks: () => tracks.filter((track) => track.kind === 'audio'), addTrack: (track: any) => { tracks.push(track); },
      removeTrack: (track: any) => { tracks = tracks.filter((entry) => entry !== track); } } as MediaStream;
  }
  const first = media('first', [firstVideo, audio]);
  const second = media('second', [secondVideo]);
  manager.shareStream(first, 8_000_000, 60, descriptor('first'));
  manager.shareStream(second, 8_000_000, 60, descriptor('second'));
  manager.stopStream('first');
  assert.equal(audio.readyState, 'ended');
  assert.equal(second.getAudioTracks().length, 1);
  assert.equal(second.getAudioTracks()[0].readyState, 'live');
  assert.equal(secondVideo.readyState, 'live');
  manager.stopStream();
});

test('overlay gravity snaps near corners and side centers while retaining free positions', () => {
  assert.deepEqual(snapOverlay({ x: 0.74, y: 0.74, width: 0.25 }), { x: 0.73, y: 0.73, width: 0.25 });
  assert.deepEqual(snapOverlay({ x: 0.02, y: 0.36, width: 0.25 }), { x: 0.02, y: 0.375, width: 0.25 });
  assert.deepEqual(snapOverlay({ x: 0.31, y: 0.31, width: 0.2 }), { x: 0.31, y: 0.31, width: 0.2 });
  const bounded = snapOverlay({ x: 2, y: -2, width: 0.1 }, 4 / 3, 16 / 9);
  assert.equal(bounded.width, 0.14);
  assert.equal(bounded.y, 0.02);
  assert.equal(bounded.x, 0.84);
});

test('all overlay resize corners preserve the opposite anchor and portrait edge insets', () => {
  const initial = { x: 0.3, y: 0.3, width: 0.2 };
  for (const corner of ['nw', 'ne', 'sw', 'se'] as const) {
    const left = corner.endsWith('w'), top = corner.startsWith('n');
    const result = resizeOverlay(initial, corner, left ? -0.05 : 0.05, top ? -0.05 : 0.05, 16 / 9, 16 / 9);
    assert.ok(Math.abs(result.width - 0.25) < 1e-8);
    assert.ok(Math.abs(result.x + (left ? result.width : 0) - initial.x - (left ? initial.width : 0)) < 1e-8);
    assert.ok(Math.abs(result.y + (top ? result.width : 0) - initial.y - (top ? initial.width : 0)) < 1e-8);
  }
  const portrait = resizeOverlay(initial, 'se', 5, 5, 9 / 16, 16 / 9);
  assert.ok(portrait.x + portrait.width <= 0.98 + 1e-8);
  assert.ok(portrait.y + portrait.width * (16 / 9) / (9 / 16) <= 0.98 + 1e-8);
});

test('remote screen and camera streams reconcile without fake participants or stale resurrection', async () => {
  const actions = new Map<string, any>();
  const originalJoin = signalingManager.joinRoom;
  const originalLeave = signalingManager.leaveRoom;
  const originalReannounce = signalingManager.reannounce;
  const room: any = { makeAction(name: string) {
    const action = { send: async () => {} }; actions.set(name, action); return action;
  }, getPeers: () => ({}), removeStream: () => {}, leave: async () => {}, addStream: () => [],
    onPeerJoin: () => {}, onPeerLeave: () => {}, onPeerStream: () => {} };
  (signalingManager as any).joinRoom = () => room;
  (signalingManager as any).leaveRoom = async () => {};
  (signalingManager as any).reannounce = async () => {};
  const manager = new GroupRoomManager('Viewer', 'multi-receive-test', '', true);
  try {
    await manager.join({ onStreamsUpdate: () => {}, onSlotsUpdate: () => {}, onPeersUpdate: () => {}, onStatusChange: () => {}, onChat: () => {} });
    room.onPeerJoin('owner');
    actions.get('presence').onMessage({ username: 'Owner', isStreaming: true }, { peerId: 'owner' });
    const status = actions.get('stream_status').onMessage;
    status({ isStreaming: true, revision: 1, streams: [descriptor('screen'), descriptor('camera', 'camera')] }, { peerId: 'owner' });
    const screen = fakeStream('screen'); const camera = fakeStream('camera');
    room.onPeerStream(screen, 'owner', descriptor('screen'));
    room.onPeerStream(camera, 'owner', descriptor('camera', 'camera'));
    const remote = manager.getAllRoomSlots().filter((slot) => !slot.isLocal);
    assert.equal(remote.length, 2);
    assert.ok(remote.every((slot) => slot.ownerPeerId === 'owner'));
    assert.equal(remote[0].stream, screen);
    assert.equal(remote[1].stream, camera);
    assert.equal(manager.getConnectedPeers().length, 1);
    status({ isStreaming: true, revision: 2, streams: [descriptor('screen')] }, { peerId: 'owner' });
    status({ isStreaming: true, revision: 1, streams: [descriptor('screen'), descriptor('camera', 'camera')] }, { peerId: 'owner' });
    room.onPeerStream(camera, 'owner', descriptor('camera', 'camera'));
    assert.equal(manager.getAllRoomSlots().filter((slot) => !slot.isLocal).length, 1);
    status({ isStreaming: false, revision: 3, streams: [] }, { peerId: 'owner' });
    assert.equal(manager.getAllRoomSlots().find((slot) => slot.peerId === 'owner')!.isStreaming, false);
  } finally {
    await manager.leave();
    (signalingManager as any).joinRoom = originalJoin;
    (signalingManager as any).leaveRoom = originalLeave;
    (signalingManager as any).reannounce = originalReannounce;
  }
});
