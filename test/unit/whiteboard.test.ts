import assert from 'node:assert/strict';
import test from 'node:test';
import * as Y from 'yjs';
import { WhiteboardModel } from '../../src/apps/whiteboard_model.ts';
import { encodeUpdate } from '../../src/apps/models.ts';
import { boardSvg, hitBoardShape, parseBoardFile, type BoardShape } from '../../src/apps/whiteboard_scene.ts';

function shape(overrides: Partial<BoardShape> = {}): BoardShape {
  return { id: crypto.randomUUID(), tool: 'rectangle', points: [{ x: 10, y: 20 }, { x: 110, y: 120 }],
    color: '#3b82f6', width: 5, filled: false, x: 0, y: 0, order: 1, hidden: false, locked: false, ...overrides };
}
function peer(actor: string) {
  const messages: unknown[] = [];
  const model = new WhiteboardModel({ localActor: actor, changed() {}, emit(payload) { messages.push(payload); } });
  return { model, messages };
}

test('concurrent drawings converge, duplicate packets are harmless, and undo preserves remote edits', () => {
  const a = peer('a'), b = peer('b'), late = peer('late');
  try {
    const first = shape(), second = shape({ tool: 'ellipse', filled: true });
    a.model.put(first); b.model.put(second);
    for (const message of a.messages) b.model.apply(message, 'a', false);
    for (const message of b.messages) a.model.apply(message, 'b', false);
    assert.deepEqual(a.model.shapes, b.model.shapes);
    assert.equal(a.model.shapes.length, 2);
    for (const message of a.messages) b.model.apply(message, 'a', false);
    assert.equal(b.model.shapes.length, 2);
    a.model.undo();
    assert.deepEqual(a.model.shapes, [second]);
    b.model.apply(a.messages[a.messages.length - 1], 'a', false);
    assert.deepEqual(a.model.shapes, b.model.shapes);
    a.model.redo(); b.model.apply(a.messages[a.messages.length - 1], 'a', false);
    late.model.apply(a.model.snapshot(), 'a', true);
    assert.deepEqual(late.model.shapes, a.model.shapes);
    assert.deepEqual(a.model.shapes, b.model.shapes);
  } finally { a.model.destroy(); b.model.destroy(); late.model.destroy(); }
});

test('layer changes and file identity converge, replacement and export retain editable geometry', () => {
  const a = peer('a'), b = peer('b');
  try {
    const first = shape(), second = shape({ order: 2 });
    a.model.put(first); a.model.put(second);
    a.model.put({ ...first, order: 3, hidden: true, locked: true, x: -100 });
    const id = crypto.randomUUID(); a.model.setIdentity(id, 'Drawing');
    b.model.apply(a.model.snapshot(), 'a', true);
    assert.deepEqual(b.model.identity, { id, name: 'Drawing' });
    assert.deepEqual(parseBoardFile(a.model.content).shapes, a.model.shapes);
    const svg = boardSvg(a.model.shapes);
    assert.equal((svg.match(/<rect /g) ?? []).length, 1);
    b.model.replace(a.model.content, id, 'Drawing');
    assert.deepEqual(b.model.shapes, a.model.shapes);
    assert.equal(b.model.history.canUndo(), false);
    assert.throws(() => b.model.replace('{"version":2,"shapes":[]}', id, 'Invalid'));
    assert.deepEqual(b.model.shapes, a.model.shapes);
  } finally { a.model.destroy(); b.model.destroy(); }
});

test('invalid geometry, unknown document roots and cursor impersonation cannot mutate the scene', () => {
  const a = peer('a'), evil = new Y.Doc();
  try {
    const original = shape(); a.model.put(original);
    evil.getMap('shapes').set('bad', { ...shape(), width: NaN });
    a.model.apply({ update: encodeUpdate(Y.encodeStateAsUpdate(evil)) }, 'untrusted', false);
    assert.deepEqual(a.model.shapes, [original]);
    const other = new Y.Doc(); other.getMap('unknown').set('data', 'invalid');
    a.model.apply({ update: encodeUpdate(Y.encodeStateAsUpdate(other)) }, 'untrusted', true); other.destroy();
    assert.equal(a.model.document.share.has('unknown'), false);
    a.model.setParticipants(['b']);
    const cursor = { x: -10, y: 20, tool: 'brush', width: 25, color: '#ef4444', actor: 'forged' };
    a.model.apply({ cursor }, 'b', false);
    assert.equal(a.model.cursors.get('b')?.width, 25);
    assert.equal(a.model.cursors.has('forged'), false);
    a.model.apply({ cursor }, 'outsider', false);
    assert.equal(a.model.cursors.has('outsider'), false);
    a.model.setParticipants([]); assert.equal(a.model.cursors.size, 0);
  } finally { a.model.destroy(); evil.destroy(); }
});

test('hit testing respects actual outlines, fills, locks, hidden objects and world translations', () => {
  const rect = shape();
  assert.equal(hitBoardShape(rect, { x: 50, y: 50 }, 2), false);
  assert.equal(hitBoardShape({ ...rect, filled: true }, { x: 50, y: 50 }, 2), true);
  assert.equal(hitBoardShape(rect, { x: 10, y: 50 }, 2), true);
  assert.equal(hitBoardShape({ ...rect, locked: true }, { x: 10, y: 50 }, 2), false);
  assert.equal(hitBoardShape({ ...rect, hidden: true }, { x: 10, y: 50 }, 2), false);
  const brush = shape({ tool: 'brush', points: [{ x: 0, y: 0 }, { x: 100, y: 100 }], x: -50 });
  assert.equal(hitBoardShape(brush, { x: 0, y: 50 }, 2), true);
  assert.equal(hitBoardShape(brush, { x: 40, y: 10 }, 2), false);
  assert.throws(() => parseBoardFile(JSON.stringify({ version: 1, shapes: [rect, rect] })));
});
