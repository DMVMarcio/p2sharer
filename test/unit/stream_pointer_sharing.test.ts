import test from 'node:test';
import assert from 'node:assert/strict';
import { GroupRoomManager } from '../../src/p2p/group_room.ts';
import { stateStore } from '../../src/core/state_store.ts';
import { StreamPointerReceiver } from '../../src/services/stream_pointer_receiver.ts';
import { streamPointerView } from '../../src/services/stream_pointer_view.ts';
import { localStreamPointerVisuals, validStreamPointerState, type StreamPointerState } from '../../src/core/stream_pointer.ts';

function snapshot(): StreamPointerState {
  return { kind: 'state', sentAt: 10000, visuals: [
    { id: 'alice', peerId: 'alice', name: 'Alice', color: 'hsl(190,65%,45%)', x: 0.1, y: 0.2, expires: 13000, ping: false },
    { id: 'bob', peerId: 'bob', name: 'Bob', color: 'hsl(90,65%,45%)', x: 0.9, y: 0.8, expires: 13000, ping: false },
    { id: 'alice:click', peerId: 'alice', name: 'Alice', color: 'hsl(190,65%,45%)', x: 0.1, y: 0.2, expires: 11000, ping: true },
  ] };
}

test('broadcaster delivers named cursors and own/other pings to active and passive admitted watchers only', () => {
  const manager = new GroupRoomManager('Host', 'pointer-room') as any;
  const sent: { target: string; state: StreamPointerState }[] = [];
  manager.authority = {};
  manager.localAdmitted = true;
  manager.peerTracker.isVerified = (id: string) => id !== 'rumor';
  manager.isAdmittedPeer = (id: string) => id !== 'pending';
  manager.getStreamWatchers = () => ['alice', 'bob', 'passive', 'pending', 'rumor'].map((peerId) => ({ peerId }));
  manager.pointerAction = { send: (state: StreamPointerState, { target }: { target: string }) => { sent.push({ target, state }); } };
  manager.sendStreamPointerState(snapshot());
  assert.deepEqual(sent.map((v) => v.target), ['alice', 'bob', 'passive']);
  for (const packet of sent) assert.deepEqual(packet.state.visuals.map((v) => v.id), ['alice', 'bob', 'alice:click']);
});

test('snapshots reject invalid coordinates, oversized state, missing authors, and unbounded lifetimes', () => {
  assert.equal(validStreamPointerState(snapshot()), true);
  for (const patch of [{ peerId: null }, { x: Infinity }, { expires: 14000 }, { ping: 'true' }]) {
    const state = snapshot(); Object.assign(state.visuals[0], patch);
    assert.equal(validStreamPointerState(state), false);
  }
  const state = snapshot(); state.visuals = Array(257).fill(state.visuals[0]);
  assert.equal(validStreamPointerState(state), false);
});

test('receive gate accepts scenes only from the watched broadcaster and pointer input only from verified watchers', () => {
  const manager = new GroupRoomManager('Viewer', 'pointer-gate-room') as any;
  const actions = new Map<string, any>();
  manager.room = { makeAction: (name: string) => {
    const action = { send: () => {}, onMessage: undefined }; actions.set(name, action); return action;
  } };
  manager.peerTracker.isVerified = (id: string) => id !== 'rumor';
  manager.remoteStreams.set('host', {});
  manager.localStream = {};
  manager.getStreamWatchers = () => [{ peerId: 'alice' }];
  const scenes: string[] = [], pointers: string[] = [];
  manager.callbacks = { onStreamPointerState: (_state: unknown, id: string) => scenes.push(id),
    onStreamPointer: (_packet: unknown, id: string) => pointers.push(id) };
  manager.bindRoomActions();
  const action = actions.get('stream_pointer');
  for (const peerId of ['host', 'alice', 'rumor']) action.onMessage(snapshot(), { peerId });
  for (const peerId of ['alice', 'outsider', 'rumor']) action.onMessage({ kind: 'ping', x: 0.5, y: 0.5 }, { peerId });
  assert.deepEqual(scenes, ['host']);
  assert.deepEqual(pointers, ['alice']);
  manager.localMedia.set('second-screen', { descriptor: { kind: 'screen' } });
  manager.localMedia.set('camera', { descriptor: { kind: 'camera' } });
  manager.remoteDescriptors.set('host', [{ id: 'second-screen', kind: 'screen' }]);
  action.onMessage({ kind: 'move', x: 0.5, y: 0.5, mediaId: 'second-screen' }, { peerId: 'alice' });
  action.onMessage({ kind: 'move', x: 0.5, y: 0.5, mediaId: 'camera' }, { peerId: 'alice' });
  action.onMessage({ ...snapshot(), mediaId: 'second-screen' }, { peerId: 'host' });
  action.onMessage({ ...snapshot(), mediaId: 'missing' }, { peerId: 'host' });
  assert.deepEqual(pointers, ['alice', 'alice']);
  assert.deepEqual(scenes, ['host', 'host']);
});

test('viewer/PiP scenes retain both participants and own pings without requiring interactive mode or synchronized clocks', () => {
  assert.deepEqual(localStreamPointerVisuals(snapshot(), 500).map((v) => v.expires), [3500, 3500, 1500]);
  streamPointerView.set('host', snapshot(), { localPeerId: 'alice', name: 'Alice', color: 'cyan' });
  const scene = streamPointerView.get('host');
  assert.equal(scene.visuals.length, 3);
  assert.equal(scene.visuals.find((v) => v.ping)?.peerId, 'alice');
  assert.equal(streamPointerView.state('host').visuals.length, 3);
  streamPointerView.clear();
  assert.equal(streamPointerView.get('host').visuals.length, 0);
});

test('broadcaster relay applies independent cursor/ping consent and clears departed participants', async (context) => {
  const original = { sharing: stateStore.isSharingScreen, cursors: stateStore.allowParticipantCursors, pings: stateStore.allowParticipantPings };
  stateStore.isSharingScreen = true; stateStore.allowParticipantCursors = false; stateStore.allowParticipantPings = true;
  const states: StreamPointerState[] = [];
  const receiver = new StreamPointerReceiver((state) => states.push(state), async () => {});
  context.after(() => {
    receiver.clear(); stateStore.isSharingScreen = original.sharing;
    stateStore.allowParticipantCursors = original.cursors; stateStore.allowParticipantPings = original.pings;
  });
  receiver.receive({ kind: 'ping', x: 0.2, y: 0.4 }, 'alice', 'Alice', 'cyan');
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(states.at(-1)?.visuals.length, 1);
  assert.equal(states.at(-1)?.visuals[0].ping, true);
  assert.ok(states.at(-1)!.visuals[0].expires - states.at(-1)!.sentAt <= 1000);
  stateStore.allowParticipantCursors = true; stateStore.allowParticipantPings = false;
  receiver.receive({ kind: 'ping', x: 0.5, y: 0.5 }, 'bob', 'Bob', 'lime');
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.deepEqual(states.at(-1)?.visuals.map((v) => [v.peerId, v.ping]), [['bob', false]]);
  receiver.forget('bob');
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.deepEqual(states.at(-1)?.visuals, []);
});
