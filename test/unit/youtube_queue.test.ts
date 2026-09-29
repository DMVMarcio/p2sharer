import assert from 'node:assert/strict';
import test from 'node:test';
import { advanceYouTubeQueue, moveYouTubeQueueEntry } from '../../src/apps/youtube_queue.ts';
import type { YouTubeState } from '../../src/apps/types.ts';

const state: YouTubeState = {
  queue: [
    { videoId: 'aaaaaaaaaaa', title: 'First' },
    { videoId: 'bbbbbbbbbbb', title: 'Playing' },
    { videoId: 'ccccccccccc', title: 'Third' },
  ],
  index: 1,
  playing: true,
  position: 35,
  repeat: 'off',
  shuffle: false,
  removePlayed: false,
  updatedAt: 1,
};

test('queue reorder keeps the same video playing and preserves its position', () => {
  const moved = moveYouTubeQueueEntry(state, 2, 0);
  assert.deepEqual(moved.queue.map((entry) => entry.title), ['Third', 'First', 'Playing']);
  assert.equal(moved.index, 2);
  assert.equal(moved.queue[moved.index].videoId, state.queue[state.index].videoId);
  assert.equal(moved.position, 35);
  assert.equal(state.index, 1);
  assert.equal(moveYouTubeQueueEntry(state, -1, 1), state);
});

test('repeat one restarts the current entry and keeps it in the queue', () => {
  const next = advanceYouTubeQueue({ ...state, repeat: 'one', removePlayed: true });
  assert.equal(next.index, 1);
  assert.equal(next.queue.length, 3);
  assert.equal(next.position, 0);
  assert.equal(next.playing, true);
});

test('shuffle chooses an unplayed entry and keeps prior entries behind', () => {
  const next = advanceYouTubeQueue({ ...state, index: 0, shuffle: true }, false, () => 0.9);
  assert.equal(next.index, 1);
  assert.equal(next.queue[1].title, 'Third');
  assert.equal(next.queue[0].title, 'First');
});

test('remove played advances and empties the queue after its last entry', () => {
  const next = advanceYouTubeQueue({ ...state, index: 0, removePlayed: true });
  assert.deepEqual(next.queue.map((entry) => entry.title), ['Playing', 'Third']);
  assert.equal(next.index, 0);
  const last = advanceYouTubeQueue({ ...state, queue: [state.queue[1]], index: 0,
    removePlayed: true, repeat: 'all' });
  assert.equal(last.queue.length, 0);
  assert.equal(last.playing, false);
});

test('repeat all wraps after the final entry; repeat off stops', () => {
  const end = { ...state, index: 2 };
  assert.equal(advanceYouTubeQueue(end).playing, false);
  const wrapped = advanceYouTubeQueue({ ...end, repeat: 'all' });
  assert.equal(wrapped.index, 0);
  assert.equal(wrapped.playing, true);
});
