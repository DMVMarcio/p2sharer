import test from 'node:test';
import assert from 'node:assert/strict';
import { StreamPointerReceiver } from '../../src/services/stream_pointer_receiver.ts';
import { streamPointerView } from '../../src/services/stream_pointer_view.ts';
import { stateStore } from '../../src/core/state_store.ts';
import { StateStore } from '../../src/core/state_store.ts';
import { STREAM_DRAWING_MAX, streamDrawingLimit, validStreamPointerState, type StreamPointerState } from '../../src/core/stream_pointer.ts';

const drawing = { tool: 'brush' as const, color: '#ff0000', size: 3, points: [{ x: .2, y: .3 }, { x: .4, y: .5 }] };
test('undo/redo affect only the authenticated author, include clear, and new actions invalidate redo', async context => {
  context.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 10000 });
  const original = { sharing: stateStore.isSharingScreen, cursors: stateStore.allowParticipantCursors, drawings: stateStore.allowParticipantDrawings, limit: stateStore.participantDrawingLimit };
  stateStore.isSharingScreen = true; stateStore.allowParticipantCursors = true; stateStore.allowParticipantDrawings = true; stateStore.participantDrawingLimit = 1280;
  const identity = { localPeerId: 'alice', name: 'Alice', color: 'red' };
  const receiver = new StreamPointerReceiver(state => { assert.ok(validStreamPointerState(state)); streamPointerView.set('history-host', state, identity); }, async () => {});
  context.after(() => { receiver.clear(); streamPointerView.clear(); stateStore.isSharingScreen = original.sharing; stateStore.allowParticipantCursors = original.cursors; stateStore.allowParticipantDrawings = original.drawings; stateStore.participantDrawingLimit = original.limit; });
  const flush = async () => { context.mock.timers.tick(100); await Promise.resolve(); await Promise.resolve(); };
  const draw = (peer: string, id: string) => receiver.receive({ kind: 'draw', id, drawing }, peer, peer, '#ff0000');
  const action = (peer: string, kind: string) => receiver.receive({ kind }, peer, peer, '#ff0000');
  const drawings = () => streamPointerView.get('history-host').visuals.filter(v => v.drawing);
  draw('alice', 'a'); await flush(); draw('bob', 'b'); await flush(); draw('alice', 'c'); await flush();
  action('outsider', 'undo'); await flush(); assert.equal(drawings().length, 3);
  action('alice', 'undo'); await flush(); assert.deepEqual(drawings().map(v => v.peerId), ['alice', 'bob']);
  action('alice', 'redo'); await flush(); assert.equal(drawings().length, 3);
  action('alice', 'clear'); await flush(); assert.deepEqual(drawings().map(v => v.peerId), ['bob']);
  action('alice', 'undo'); await flush(); assert.equal(drawings().length, 3);
  action('alice', 'redo'); await flush(); assert.equal(drawings().length, 1);
  action('alice', 'undo'); await flush(); action('alice', 'undo'); await flush();
  draw('alice', 'new'); await flush();
  assert.equal(streamPointerView.get('history-host').history?.find(h => h.peerId === 'alice')?.redo, 0);
  action('alice', 'redo'); await flush(); assert.equal(drawings().length, 3);
  receiver.forget('alice'); await flush(); assert.deepEqual(drawings().map(v => v.peerId), ['bob']);
  action('alice', 'undo'); await flush(); assert.equal(drawings().length, 1);
});

test('1280 drawings survive the former count ceiling and a lower setting evicts oldest drawings and history', async context => {
  context.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 10000 });
  const original = { sharing: stateStore.isSharingScreen, cursors: stateStore.allowParticipantCursors, drawings: stateStore.allowParticipantDrawings, limit: stateStore.participantDrawingLimit };
  stateStore.isSharingScreen = true; stateStore.allowParticipantCursors = true; stateStore.allowParticipantDrawings = true; stateStore.participantDrawingLimit = STREAM_DRAWING_MAX;
  let latest: StreamPointerState | undefined;
  const receiver = new StreamPointerReceiver(state => { latest = state; }, async () => {});
  context.after(() => { receiver.clear(); stateStore.isSharingScreen = original.sharing; stateStore.allowParticipantCursors = original.cursors; stateStore.allowParticipantDrawings = original.drawings; stateStore.participantDrawingLimit = original.limit; });
  const fullBrush = { ...drawing, points: Array.from({ length: 128 }, (_, i) => ({ x: i / 127, y: .5 })) };
  for (let i = 0; i < 1280; i++) {
    receiver.receive({ kind: 'draw', id: `stroke-${i}`, drawing: fullBrush }, 'alice', 'Alice', '#ff0000');
    context.mock.timers.tick(80);
  }
  assert.equal(latest?.visuals.length, 1280); assert.ok(validStreamPointerState(latest));
  stateStore.participantDrawingLimit = 64; receiver.refreshPermissions(); context.mock.timers.tick(100);
  assert.equal(latest?.visuals.length, 64); assert.ok(validStreamPointerState(latest));
  assert.equal(latest?.visuals[0].id, 'alice:d:stroke-1216');
  assert.equal(latest?.history?.[0].undo, 64);
  stateStore.participantDrawingLimit = 1; receiver.refreshPermissions(); context.mock.timers.tick(100);
  assert.equal(latest?.visuals.length, 1);
  assert.equal(latest?.history?.[0].undo, 1);
});

test('cursor-only frames preserve existing drawings and PiP readiness provides a full scene', () => {
  const sentAt = Date.now(), identity = { localPeerId: 'alice', name: 'Alice', color: 'red' };
  const visual = { id: 'one', peerId: 'alice', name: 'Alice', color: '#ff0000', x: .2, y: .3, expires: sentAt + 3000, ping: false, drawing };
  streamPointerView.set('partial-host', { kind: 'state', sentAt, visuals: [visual], drawingsIncluded: true }, identity);
  streamPointerView.set('partial-host', { kind: 'state', sentAt, visuals: [], drawingsIncluded: false }, identity);
  assert.equal(streamPointerView.get('partial-host').visuals.length, 1);
  assert.equal(streamPointerView.state('partial-host').drawingsIncluded, true);
  assert.equal(streamPointerView.state('partial-host').visuals[0].id, 'one');
  streamPointerView.set('partial-host', { kind: 'state', sentAt, visuals: [], drawingsIncluded: true }, identity);
  assert.equal(streamPointerView.get('partial-host').visuals.length, 0); streamPointerView.clear();
});

test('drawing limit loads persistently and clamps invalid settings', context => {
  const originalStorage = globalThis.localStorage;
  context.after(() => { globalThis.localStorage = originalStorage; });
  globalThis.localStorage = { getItem: (key: string) => key === 'p2sharer_drawing_limit' ? '640' : null } as Storage;
  assert.equal(new StateStore().participantDrawingLimit, 640);
  assert.equal(streamDrawingLimit(NaN), 1280); assert.equal(streamDrawingLimit(Infinity), 1280);
  assert.equal(streamDrawingLimit(5000), 1280); assert.equal(streamDrawingLimit(-1), 1);
});

test('viewer readiness requests a full retained scene and repeated sync requests are rate-limited', async context => {
  context.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 10000 });
  const original = { sharing: stateStore.isSharingScreen, cursors: stateStore.allowParticipantCursors, drawings: stateStore.allowParticipantDrawings };
  stateStore.isSharingScreen = true; stateStore.allowParticipantCursors = true; stateStore.allowParticipantDrawings = true;
  let latest: StreamPointerState | undefined;
  const receiver = new StreamPointerReceiver(state => { latest = state; }, async () => {});
  context.after(() => { receiver.clear(); stateStore.isSharingScreen = original.sharing; stateStore.allowParticipantCursors = original.cursors; stateStore.allowParticipantDrawings = original.drawings; });
  const flush = async () => { context.mock.timers.tick(100); await Promise.resolve(); await Promise.resolve(); };
  receiver.receive({ kind: 'draw', id: 'one', drawing }, 'alice', 'Alice', '#ff0000'); await flush();
  receiver.receive({ kind: 'move', x: .3, y: .4 }, 'alice', 'Alice', '#ff0000'); await flush();
  assert.equal(latest?.drawingsIncluded, false); assert.equal(latest?.visuals.some(v => v.drawing), false);
  receiver.receive({ kind: 'sync' }, 'new-watcher', 'Watcher', '#ff0000'); await flush();
  assert.equal(latest?.drawingsIncluded, true); assert.equal(latest?.visuals.filter(v => v.drawing).length, 1);
  receiver.receive({ kind: 'move', x: .5, y: .6 }, 'alice', 'Alice', '#ff0000'); await flush();
  assert.equal(latest?.drawingsIncluded, false);
  receiver.receive({ kind: 'sync' }, 'new-watcher', 'Watcher', '#ff0000'); await flush();
  assert.equal(latest?.drawingsIncluded, false);
});
