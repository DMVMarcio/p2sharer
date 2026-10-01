import test from 'node:test';
import assert from 'node:assert/strict';
import { streamPointerPosition, validStreamPointer } from '../../src/core/stream_pointer.ts';

test('stream pointing accepts only bounded finite coordinates and visual packet kinds', () => {
  for (const kind of ['move', 'ping']) {
    assert.equal(validStreamPointer({ kind, x: 0, y: 1 }), true);
    for (const x of [-0.01, 1.01, NaN, Infinity, '0.5', null])
      assert.equal(validStreamPointer({ kind, x, y: 0.5 }), false);
    for (const y of [-1, 2, NaN, -Infinity, undefined])
      assert.equal(validStreamPointer({ kind, x: 0.5, y }), false);
  }
  assert.equal(validStreamPointer({ kind: 'leave' }), true);
  for (const packet of [null, {}, [], { kind: 'click', x: 0, y: 0 }, { kind: 'keydown' }])
    assert.equal(validStreamPointer(packet), false);
});

test('letterbox bars never produce desktop pointing coordinates', () => {
  const rect = { left: 100, top: 50, width: 800, height: 600 };
  assert.equal(streamPointerPosition(rect, 1920, 1080, 500, 60), null);
  assert.equal(streamPointerPosition(rect, 1920, 1080, 500, 640), null);
  assert.deepEqual(streamPointerPosition(rect, 1920, 1080, 500, 350), { x: 0.5, y: 0.5 });
  assert.deepEqual(streamPointerPosition(rect, 1920, 1080, 100, 125), { x: 0, y: 0 });
});

test('transformed video rectangles preserve source positions across zoom and pan', () => {
  const normal = streamPointerPosition({ left: 0, top: 0, width: 800, height: 450 }, 1920, 1080, 200, 225);
  const zoomed = streamPointerPosition({ left: -300, top: -200, width: 1600, height: 900 }, 1920, 1080, 100, 250);
  assert.deepEqual(normal, { x: 0.25, y: 0.5 });
  assert.deepEqual(zoomed, normal);
  assert.equal(streamPointerPosition({ left: 0, top: 0, width: 800, height: 450 }, 0, 0, 10, 10), null);
  assert.equal(streamPointerPosition({ left: 0, top: 0, width: 0, height: 0 }, 1920, 1080, 0, 0), null);
});
