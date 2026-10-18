import assert from 'node:assert/strict';
import test from 'node:test';
import * as Y from 'yjs';
import { WhiteboardModel } from '../../src/apps/whiteboard_model.ts';
import { encodeUpdate } from '../../src/apps/models.ts';
import { boardSvg, brushPath, shapeBounds, hitBoardShape, hitBoardLayer, boardBrushWidth, DEFAULT_BOARD_LAYER, parseBoardFile, hasVariablePressure, type BoardShape } from '../../src/apps/whiteboard_scene.ts';
import { BOARD_WIDTH, BOARD_HEIGHT, BrushStabilizer, boardContains, clampBoardPoint, clampBoardViewport, containBoardShape, resizeBoardBounds } from '../../src/apps/whiteboard_interaction.ts';

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

test('bounded navigation exposes a margin, centers a zoomed-out page and keeps objects inside the board', () => {
  const left = clampBoardViewport({ x: 1e6, y: 1e6, zoom: 1 }, 800, 500);
  assert.equal(left.x, 96); assert.equal(left.y, 96);
  const right = clampBoardViewport({ x: -1e6, y: -1e6, zoom: 1 }, 800, 500);
  assert.equal(right.x + BOARD_WIDTH, 800 - 96);
  assert.equal(right.y + BOARD_HEIGHT, 500 - 96);
  const overview = clampBoardViewport({ x: 1e6, y: -1e6, zoom: .025 }, 800, 500);
  assert.equal(overview.x, (800 - BOARD_WIDTH * overview.zoom) / 2);
  assert.equal(boardContains({ x: -1, y: 0 }), false);
  assert.deepEqual(clampBoardPoint({ x: -100, y: BOARD_HEIGHT + 20 }), { x: 0, y: BOARD_HEIGHT });
  const moved = containBoardShape(shape({ x: -1000, y: -1000 }));
  assert.equal(shapeBounds(moved).x, 0);
  assert.equal(shapeBounds(moved).y, 0);
  assert.deepEqual(shapeBounds(shape({ tool: 'brush', width: 100, x: 7, y: 9 })), { x: -33, y: -21, width: 200, height: 200 });
});

test('configurable stabilization reduces jitter, zero follows the pointer and exported curves match the saved stroke', () => {
  const filter = new BrushStabilizer({ x: 0, y: 0 }, 0), raw = new BrushStabilizer({ x: 0, y: 0 }, 0);
  let energy = 0;
  for (let i = 1; i <= 30; i++) {
    const target = { x: i * 5, y: i % 2 ? 10 : -10 };
    const point = filter.sample(target, i * 16, 80); energy += Math.abs(point.y);
    assert.deepEqual(raw.sample(target, i * 16, 0), target);
  }
  assert.ok(energy < 100);
  const stroke = shape({ tool: 'brush', smoothing: 80, points: [{ x: 0, y: 0 }, { x: 100, y: 100 }, { x: 200, y: 0 }] });
  assert.match(brushPath(stroke), /Q/);
  assert.ok(boardSvg([stroke]).includes(`d="${brushPath(stroke)}"`));
  assert.equal(parseBoardFile(JSON.stringify({ version: 1, shapes: [stroke] })).shapes[0].smoothing, 80);
  assert.equal(hitBoardShape(stroke, { x: 100, y: 75 }, 3), true);
  assert.doesNotMatch(brushPath({ ...stroke, smoothing: 0 }), /Q/);
});

test('layers group paint, move as one, reorder, rename and preserve per-layer erasing through snapshots and files', () => {
  const a = peer('a'), b = peer('b');
  try {
    a.model.put(shape()); a.model.put(shape({ order: 2 }));
    assert.equal(a.model.layers.length, 1);
    assert.equal(boardBrushWidth(1), 20);
    assert.equal(boardBrushWidth(100), 1400);
    const lower = a.model.layers[0];
    a.model.updateLayer({ ...lower, name: 'Ink', x: 100, y: 50 });
    assert.equal(a.model.shapes.length, 2);
    assert.ok(a.model.shapes.every(s => s.x === 0));
    const upper = a.model.addLayer('Details');
    a.model.put(shape({ layerId: upper, filled: true }));
    a.model.put(shape({ layerId: upper, tool: 'eraser', points: [{ x: 50, y: 50 }, { x: 50, y: 100 }], width: 40, order: 10 }));
    const top = a.model.layers.find(l => l.id === upper)!;
    assert.equal(hitBoardLayer(a.model.shapes, top, { x: 50, y: 70 }, 2), false);
    assert.equal(hitBoardLayer(a.model.shapes, top, { x: 90, y: 70 }, 2), true);
    const svg = boardSvg(a.model.shapes, a.model.layers);
    assert.match(svg, /<mask /); assert.match(svg, /translate\(100 50\)/);
    a.model.reorderLayers([upper, DEFAULT_BOARD_LAYER]);
    b.model.apply(a.model.snapshot(), 'a', true);
    assert.deepEqual(b.model.layers, a.model.layers);
    assert.deepEqual(b.model.shapes, a.model.shapes);
    const file = parseBoardFile(a.model.content);
    assert.equal(file.version, 2);
    b.model.replace(a.model.content, crypto.randomUUID(), 'Drawing');
    assert.deepEqual(b.model.layers, a.model.layers);
    a.model.removeLayer(upper);
    assert.equal(a.model.layers.length, 1);
    assert.equal(a.model.shapes.length, 2);
    a.model.undo();
    assert.equal(a.model.layers.length, 2);
    assert.equal(a.model.shapes.length, 4);
    const legacy = peer('legacy');
    try {
      legacy.model.replace(JSON.stringify({ version: 1, shapes: [shape()] }), crypto.randomUUID(), 'Legacy');
      assert.equal(legacy.model.layers.length, 1);
      assert.equal(parseBoardFile(legacy.model.content).version, 2);
    } finally { legacy.model.destroy(); }
  } finally { a.model.destroy(); b.model.destroy(); }
});

test('unlimited stroke length splits seamlessly, preserves single-step undo, and supports brush types, opacity, and stylus pressure', () => {
  const a = peer('a');
  try {
    const longPoints = Array.from({ length: 9000 }, (_, i) => ({
      x: (i * 3) % BOARD_WIDTH,
      y: Math.floor((i * 3) / BOARD_WIDTH) * 20 + 20,
      p: 0.25 + ((i % 10) / 15),
    }));
    const stroke = shape({ tool: 'brush', brushType: 'pencil', opacity: 60, points: longPoints });
    a.model.put(stroke);
    assert.equal(a.model.shapes.length, 3);
    const groupId = a.model.shapes[0].groupId;
    assert.ok(groupId);
    assert.ok(a.model.shapes.every(s => s.groupId === groupId && s.brushType === 'pencil' && s.opacity === 60));
    assert.equal(hasVariablePressure(a.model.shapes[0]), true);
    const outline = brushPath(a.model.shapes[0]);
    assert.ok(outline.endsWith('Z'));
    const svg = boardSvg(a.model.shapes, a.model.layers);
    assert.match(svg, /<g opacity="0\.\d+">/);
    a.model.undo();
    assert.equal(a.model.shapes.length, 0);
  } finally { a.model.destroy(); }
});

test('layers resize and stretch freely or proportionally with Shift, and validate P2P pasted images', async () => {
  const a = peer('a'), b = peer('b');
  try {
    a.model.setParticipants(['b']);
    b.model.setParticipants(['a']);
    const box = { x: 100, y: 100, width: 200, height: 100 };
    const stretched = resizeBoardBounds(box, 'se', { x: 400, y: 400 }, false);
    assert.equal(stretched.width, 300);
    assert.equal(stretched.height, 300);
    const proportional = resizeBoardBounds(box, 'se', { x: 400, y: 400 }, true);
    assert.equal(Math.round((proportional.width / proportional.height) * 100), 200);

    // 1x1 valid transparent PNG
    const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
    const raw = Uint8Array.from(Buffer.from(pngBase64, 'base64'));
    const digest = await crypto.subtle.digest('SHA-256', raw);
    const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');

    const initialBox = { x: 500, y: 500, width: 100, height: 100 };
    const layerId = a.model.pasteImage({ hash: sha256, data: pngBase64, width: 1, height: 1 }, initialBox, DEFAULT_BOARD_LAYER);
    assert.equal(layerId, DEFAULT_BOARD_LAYER);
    a.model.resizeLayer(layerId, initialBox, { x: 400, y: 400, width: 300, height: 150 });
    assert.equal(a.model.shapes[0].scaleX, 3);
    assert.equal(a.model.shapes[0].scaleY, 1.5);

    for (const msg of a.messages) b.model.apply(msg, 'a', false);
    assert.equal(b.model.shapes.length, 1);
    for (const msg of b.messages) a.model.apply(msg, 'b', false);
    for (const msg of a.messages.slice(-2)) b.model.apply(msg, 'a', false);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(b.model.imageUrl(sha256), `data:image/png;base64,${pngBase64}`);
  } finally { a.model.destroy(); b.model.destroy(); }
});
