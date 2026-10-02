import test from 'node:test';
import assert from 'node:assert/strict';
import { validStreamDrawing, validStreamPointer, validStreamPointerState, type StreamDrawing, type StreamPointerState } from '../../src/core/stream_pointer.ts';
import { StreamPointerReceiver } from '../../src/services/stream_pointer_receiver.ts';
import { stateStore } from '../../src/core/state_store.ts';

const drawing = (): StreamDrawing => ({ tool: 'brush', size: 3, color: '#ef4444', points: [{ x: .1, y: .2 }, { x: .8, y: .9 }] });
test('drawing wire input bounds coordinates, text, colors, sizes, and point counts', () => {
  assert.ok(validStreamPointer({ kind: 'draw', id: 'stroke-1', drawing: drawing() }));
  assert.ok(validStreamDrawing({ ...drawing(), points: Array(192).fill({ x: .5, y: .5 }) }));
  for (const patch of [{ tool: 'script' }, { size: -1 }, { size: 11 }, { size: 1.5 }, { color: 'url(x)' },
    { points: [] }, { points: Array(193).fill({ x: 0, y: 0 }) }, { points: [{ x: Infinity, y: .5 }] },
    { text: {} }, { text: 'x'.repeat(161) }, { tool: 'text', text: ' ' }, { tool: 'text', text: 'x'.repeat(161) }]) {
    assert.equal(validStreamDrawing({ ...drawing(), ...patch }), false);
  }
  assert.ok(validStreamDrawing({ ...drawing(), tool: 'text', text: '<script>literal text</script>' }));
  assert.equal(validStreamPointer({ kind: 'draw', id: '../host', drawing: drawing() }), false);
});

test('drawings survive pointing leave, clear only their author, and honor live permission revocation', async context => {
  const original = { sharing: stateStore.isSharingScreen, cursors: stateStore.allowParticipantCursors, drawings: stateStore.allowParticipantDrawings };
  stateStore.isSharingScreen = true; stateStore.allowParticipantCursors = true; stateStore.allowParticipantDrawings = true;
  const states: StreamPointerState[] = [];
  const receiver = new StreamPointerReceiver(state => states.push(structuredClone(state)), async () => {});
  context.after(() => {
    receiver.clear(); stateStore.isSharingScreen = original.sharing;
    stateStore.allowParticipantCursors = original.cursors; stateStore.allowParticipantDrawings = original.drawings;
  });
  receiver.receive({ kind: 'move', x: .5, y: .5 }, 'alice', 'Alice', 'cyan');
  receiver.receive({ kind: 'draw', id: 'one', drawing: drawing() }, 'alice', 'Alice', 'cyan');
  receiver.receive({ kind: 'draw', id: 'two', drawing: drawing() }, 'bob', 'Bob', 'blue');
  receiver.receive({ kind: 'leave' }, 'alice', 'Alice', 'cyan');
  await new Promise(resolve => setTimeout(resolve, 70));
  assert.equal(states.at(-1)?.visuals.length, 2);
  assert.ok(states.at(-1)?.visuals.every(v => v.drawing));
  assert.ok(validStreamPointerState(states.at(-1)));
  receiver.receive({ kind: 'clear' }, 'alice', 'Alice', 'cyan');
  await new Promise(resolve => setTimeout(resolve, 70));
  assert.deepEqual(states.at(-1)?.visuals.map(v => v.peerId), ['bob']);
  stateStore.allowParticipantDrawings = false;
  receiver.refreshPermissions();
  await new Promise(resolve => setTimeout(resolve, 70));
  assert.deepEqual(states.at(-1)?.visuals, []);
  assert.equal(states.at(-1)?.drawingAllowed, false);
  stateStore.allowParticipantDrawings = true; stateStore.allowParticipantCursors = false;
  receiver.receive({ kind: 'draw', id: 'denied', drawing: drawing() }, 'charlie', 'Charlie', 'green');
  receiver.refreshPermissions();
  await new Promise(resolve => setTimeout(resolve, 70));
  assert.deepEqual(states.at(-1)?.visuals, []);
  assert.equal(states.at(-1)?.drawingAllowed, false);
});

test('stationary drawings renew their TTL while snapshots and desktop IPC avoid idle 20Hz traffic', async context => {
  context.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 10000 });
  const original = { sharing: stateStore.isSharingScreen, cursors: stateStore.allowParticipantCursors, drawings: stateStore.allowParticipantDrawings };
  stateStore.isSharingScreen = true; stateStore.allowParticipantCursors = true; stateStore.allowParticipantDrawings = true;
  const states: StreamPointerState[] = [];
  const receiver = new StreamPointerReceiver(state => states.push(structuredClone(state)), async () => {});
  context.after(() => { receiver.clear(); stateStore.isSharingScreen = original.sharing; stateStore.allowParticipantCursors = original.cursors; stateStore.allowParticipantDrawings = original.drawings; });
  receiver.receive({ kind: 'draw', id: 'one', drawing: drawing() }, 'alice', 'Alice', 'cyan');
  for (let i = 0; i < 80; i++) { context.mock.timers.tick(50); await Promise.resolve(); await Promise.resolve(); }
  assert.equal(states.length, 5);
  assert.equal(states[0]?.visuals.length, 1);
  assert.equal(states.at(-1)?.visuals.length, 0);
  assert.equal(states.at(-1)?.drawingsIncluded, false);
  assert.ok(validStreamPointerState(states.at(-1)));
  assert.ok(states[0]!.visuals[0].expires > states[0]!.sentAt);
});
