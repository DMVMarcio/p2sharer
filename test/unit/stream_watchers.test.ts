import assert from 'node:assert/strict';
import test from 'node:test';
import { GroupRoomManager } from '../../src/p2p/group_room.ts';
import type { StreamDescriptor } from '../../src/core/media_streams.ts';

const descriptor = (id: string): StreamDescriptor => ({ id, kind: 'screen', label: id, videoTrackId: id, fps: 60, bitrate: 8000 });
function fixture() {
  const manager = new GroupRoomManager('Viewer', 'watchers-fixture') as any;
  const actions = new Map<string, any>();
  const sent: any[] = [], slots: any[] = [];
  manager.room = { makeAction: (name: string) => {
    const action = { send: (data: any, options: any) => { sent.push({ name, data, options }); } };
    actions.set(name, action); return action;
  }, getPeers: () => ({}) };
  manager.callbacks = { onStreamsUpdate() {}, onSlotsUpdate: (value: any) => slots.push(value), onPeersUpdate() {}, onStatusChange() {} };
  for (const id of ['host', 'alice', 'bob']) manager.peerTracker.addPeer(id, id);
  manager.remoteDescriptors.set('host', [descriptor('screen'), descriptor('camera')]);
  manager.bindRoomActions();
  manager.bindRoomListeners();
  return { manager, actions, sent, slots };
}

test('receiving and recovering media never creates a watcher; explicit selection tracks only its slot', () => {
  const { manager, sent } = fixture();
  const stream = { id: 'received', addEventListener() {}, getTracks: () => [], getVideoTracks: () => [], getAudioTracks: () => [] };
  manager.room.onPeerStream(stream, 'host', descriptor('screen'));
  assert.deepEqual(manager.getStreamWatchers('host/screen'), []);
  manager.requestStream('host/screen');
  assert.equal(sent.findLast((entry) => entry.name === 'stream_req').options.target, 'host');
  assert.equal(manager.getStreamWatchers('host/screen')[0].isSelf, true);
  assert.deepEqual(manager.getStreamWatchers('host/camera'), []);
  manager.stopWatching('host/screen');
  manager.room.onPeerStream(stream, 'host', descriptor('screen'));
  assert.deepEqual(manager.getStreamWatchers('host/screen'), []);
  assert.deepEqual(sent.findLast((entry) => entry.name === 'watch_status').data.watching, []);
});

test('watch snapshots reconcile identities, exact streams, missed stops and stale revisions', () => {
  const { manager, actions, slots } = fixture();
  const status = actions.get('watch_status').onMessage;
  status({ watching: ['host/screen'], revision: 1 }, { peerId: 'alice' });
  status({ watching: ['host/camera'], revision: 1 }, { peerId: 'bob' });
  assert.deepEqual(manager.getStreamWatchers('host/screen').map((w: any) => w.peerId), ['alice']);
  assert.deepEqual(manager.getStreamWatchers('host/camera').map((w: any) => w.peerId), ['bob']);
  const before = slots.length;
  // Identity changes must reach React even when the count stays at one.
  manager.peerTracker.removeWatcher('host/screen', 'alice');
  status({ watching: ['host/screen'], revision: 2 }, { peerId: 'bob' });
  assert.ok(slots.length > before);
  assert.deepEqual(slots.at(-1).find((slot: any) => slot.peerId === 'host/screen').watchers.map((w: any) => w.peerId), ['bob']);
  // Presence repairs a lost stop message, and older snapshots cannot undo it.
  actions.get('presence').onMessage({ username: 'bob', watching: [], watchRevision: 3 }, { peerId: 'bob' });
  status({ watching: ['host/screen'], revision: 2 }, { peerId: 'bob' });
  assert.deepEqual(manager.getStreamWatchers('host/screen'), []);
  status({ watching: ['host/screen'], revision: 4 }, { peerId: 'rumor' });
  status({ watching: ['host/screen'], revision: -1 }, { peerId: 'alice' });
  status({ watching: ['alice/screen'], revision: 2 }, { peerId: 'alice' });
  assert.deepEqual(manager.getStreamWatchers('host/screen'), []);
});

test('ending one transmission and peer departure purge only the relevant subscriptions', () => {
  const { manager, actions } = fixture();
  manager.requestStream('host/screen'); manager.requestStream('host/camera');
  actions.get('stream_status').onMessage({ isStreaming: true, streams: [descriptor('camera')], revision: 1 }, { peerId: 'host' });
  assert.deepEqual(manager.getStreamWatchers('host/screen'), []);
  assert.equal(manager.getStreamWatchers('host/camera').length, 1);
  actions.get('watch_status').onMessage({ watching: ['host/camera'], revision: 1 }, { peerId: 'alice' });
  manager.room.onPeerLeave('alice');
  assert.equal(manager.getStreamWatchers('host/camera').length, 1);
  manager.room.onPeerLeave('host');
  assert.deepEqual(manager.getStreamWatchers('host'), []);
  assert.equal(manager.localWatching.size, 0);
});

test('late peer announcement includes actual viewing subscriptions and revision', () => {
  const { manager, sent } = fixture();
  manager.requestStream('host/screen');
  manager.room.onPeerJoin('late');
  const presence = sent.findLast((entry) => entry.name === 'presence' && entry.options?.target === 'late');
  assert.deepEqual(presence.data.watching, ['host/screen']);
  assert.equal(presence.data.watchRevision, 1);
});
