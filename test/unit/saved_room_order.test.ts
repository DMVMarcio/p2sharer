import assert from 'node:assert/strict';
import test from 'node:test';
import { orderSavedRooms, readSavedRoomOrder, saveSavedRoomOrder } from '../../src/core/saved_room_order.ts';
import { moveOrderedItem } from '../../src/core/ordered_items.ts';

test('manual room order survives metadata changes and appends new rooms', () => {
  const rooms = [{ roomId: 'a', name: 'Alpha' }, { roomId: 'b', name: 'Beta' },
    { roomId: 'c', name: 'Charlie' }];
  saveSavedRoomOrder(['c', 'a', 'b', 'c']);
  assert.deepEqual(readSavedRoomOrder(), ['c', 'a', 'b']);
  assert.deepEqual(orderSavedRooms(rooms).map((room) => room.roomId), ['c', 'a', 'b']);
  assert.deepEqual(orderSavedRooms([{ ...rooms[1], customName: 'First alphabetically' }, rooms[2],
    { roomId: 'd', name: 'New' }]).map((room) => room.roomId), ['c', 'b', 'd']);
  assert.deepEqual(rooms.map((room) => room.roomId), ['a', 'b', 'c']);
});

test('legacy rooms sort alphabetically until a manual order is saved', () => {
  assert.deepEqual(orderSavedRooms([{ roomId: 'b', name: 'Zebra', customName: 'Alpha' },
    { roomId: 'a', name: 'Beta' }], []).map((room) => room.roomId), ['b', 'a']);
});

test('moving rooms preserves membership in both directions and rejects invalid targets', () => {
  const ids = ['a', 'b', 'c', 'd'];
  assert.deepEqual(moveOrderedItem(ids, 'a', 3), ['b', 'c', 'd', 'a']);
  assert.deepEqual(moveOrderedItem(ids, 'd', 0), ['d', 'a', 'b', 'c']);
  assert.equal(moveOrderedItem(ids, 'unknown', 0), ids);
  assert.equal(moveOrderedItem(ids, 'a', -1), ids);
  assert.equal(moveOrderedItem(ids, 'a', 4), ids);
  assert.deepEqual(ids, ['a', 'b', 'c', 'd']);
});

test('device storage retains ordering, rejects corrupt data, and leaves stored order intact on write failure', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  let stored = '';
  let failWrite = false;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: () => stored,
    setItem: (_key: string, value: string) => {
      if (failWrite) throw new Error('Storage unavailable');
      stored = value;
    },
  } });
  try {
    saveSavedRoomOrder(['b', 'a']);
    assert.equal(stored, '["b","a"]');
    assert.deepEqual(readSavedRoomOrder(), ['b', 'a']);
    failWrite = true;
    assert.throws(() => saveSavedRoomOrder(['a', 'b']));
    assert.deepEqual(readSavedRoomOrder(), ['b', 'a']);
    stored = '{invalid';
    assert.deepEqual(readSavedRoomOrder(), []);
    stored = '[42]';
    assert.deepEqual(readSavedRoomOrder(), []);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
