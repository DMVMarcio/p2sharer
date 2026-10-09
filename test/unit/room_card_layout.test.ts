import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateCardLayout, placeCardAtPoint, reconcileCardRows, resizeCardScale, type CardResizeEdge } from '../../src/core/room_card_layout.ts';

test('every border and corner resizes outward consistently and clamps unsafe sizes', () => {
  for (const edge of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as CardResizeEdge[]) {
    const dx = edge.includes('e') ? 100 : edge.includes('w') ? -100 : 0;
    const dy = edge.includes('s') ? 50 : edge.includes('n') ? -50 : 0;
    assert.equal(resizeCardScale(1, 200, 100, edge, dx, dy), 1.5);
    assert.equal(resizeCardScale(1, 200, 100, edge, -dx * 10, -dy * 10), .4);
  }
  assert.equal(resizeCardScale(1, 200, 100, 'se', 10000, 10000), 2.5);
});

test('automatic layout maximizes usable card size and centers the short row', () => {
  const layout = calculateCardLayout(['a', 'b', 'c'], 1200, 800);
  assert.deepEqual(layout.rows, [['a'], ['b', 'c']]);
  assert.ok(layout.cards[0].width > 1200 / 3);
  assert.equal(layout.cards[0].left + layout.cards[0].width / 2, 600);
  assert.deepEqual(calculateCardLayout(['a', 'b', 'c'], 1800, 400).rows, [['a', 'b', 'c']]);
});

test('resizing changes only the chosen card size and reflows without overlaps', () => {
  const initial = calculateCardLayout(['a', 'b', 'c'], 1200, 800);
  const resized = calculateCardLayout(['a', 'b', 'c'], 1200, 800, { a: 1.5 });
  assert.equal(resized.cards.find(card => card.id === 'a')!.width, initial.cards[0].width * 1.5);
  for (const id of ['b', 'c']) assert.equal(resized.cards.find(card => card.id === id)!.width,
    initial.cards.find(card => card.id === id)!.width);
});

test('dropping beside and below creates manual rows that survive viewport changes', () => {
  const layout = calculateCardLayout(['a', 'b', 'c'], 1200, 800);
  const b = layout.cards.find(card => card.id === 'b')!;
  const beside = placeCardAtPoint(layout, 'a', 0, b.top + b.height / 2);
  assert.deepEqual(beside, [['a', 'b', 'c']]);
  const manual = calculateCardLayout(['a', 'b', 'c'], 1200, 800, {}, beside);
  assert.equal(manual.rows.length, 1);
  const below = placeCardAtPoint(manual, 'b', 600, 800);
  assert.deepEqual(below, [['a', 'c'], ['b']]);
  const narrow = calculateCardLayout(['a', 'c', 'b'], 240, 600, {}, below);
  assert.deepEqual(narrow.rows.flat(), ['a', 'c', 'b']);
  assert.deepEqual(calculateCardLayout(['a', 'c', 'b'], 1200, 800, {}, below).rows, below);
});

test('layout retains every visible card exactly once and stays within horizontal bounds', () => {
  assert.deepEqual(reconcileCardRows([['a', 'b'], ['b', 'gone']], ['a', 'b', 'new']), [['a', 'b'], ['new']]);
  for (const width of [120, 320, 800, 1600]) for (const height of [200, 700]) for (const count of [0, 1, 3, 9, 24]) {
    const ids = Array.from({ length: count }, (_, index) => String(index));
    for (const rows of [null, [ids]]) {
      const layout = calculateCardLayout(ids, width, height, { '0': 2, '1': .5 }, rows);
      assert.deepEqual(layout.cards.map(card => card.id).sort(), [...ids].sort());
      for (const card of layout.cards) {
        assert.ok(card.left >= -.01 && card.left + card.width <= width + .01);
        assert.ok(card.width > 0 && card.height > 0 && card.top + card.height <= layout.height + .01);
        for (const other of layout.cards) {
          if (card === other) continue;
          assert.ok(card.left + card.width <= other.left + .01 || other.left + other.width <= card.left + .01 ||
            card.top + card.height <= other.top + .01 || other.top + other.height <= card.top + .01);
        }
      }
    }
  }
});
