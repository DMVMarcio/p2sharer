import assert from 'node:assert/strict';
import test from 'node:test';
import { describeYouTubeActivity } from '../../src/apps/youtube_activity.ts';
import { validYouTubeState } from '../../src/apps/models.ts';
import type { YouTubeState } from '../../src/apps/types.ts';

const state: YouTubeState = {
  queue: [{ videoId: 'aaaaaaaaaaa', title: 'First', addedBy: 'actor-1', addedByName: 'Alice' }],
  index: 0, playing: true, position: 12, repeat: 'off', shuffle: false,
  removePlayed: false, updatedAt: 1,
};

test('meaningful shared player actions produce a single short activity description', () => {
  assert.equal(describeYouTubeActivity(state, { ...state, playing: false, syncReason: 'playback' }),
    'pausou o vídeo');
  assert.equal(describeYouTubeActivity(state, { ...state, position: 32, syncReason: 'seek' }),
    'avançou o vídeo');
  assert.equal(describeYouTubeActivity(state, { ...state, position: 4, syncReason: 'seek' }),
    'voltou no vídeo');
  assert.equal(describeYouTubeActivity(state, { ...state, queue: [...state.queue,
    { videoId: 'bbbbbbbbbbb', title: 'Second' }] }), 'adicionou “Second” à fila');
  assert.equal(describeYouTubeActivity(state, { ...state, queue: [...state.queue,
    { videoId: 'bbbbbbbbbbb', title: 'Second' }], index: 1, playing: false }),
    'adicionou “Second” à fila');
});

test('timing heartbeats and small adjustments do not create activity toasts', () => {
  assert.equal(describeYouTubeActivity(state, { ...state, position: 18, syncReason: 'heartbeat' }), null);
  assert.equal(describeYouTubeActivity(state, { ...state, position: 12.5, syncReason: 'seek' }), null);
  assert.equal(describeYouTubeActivity(state, { ...state, position: 300, syncReason: 'seek' }, 1_000, 301_000),
    'voltou no vídeo');
});

test('queue attribution metadata is validated without rejecting older entries', () => {
  assert.equal(validYouTubeState(state), true);
  assert.equal(validYouTubeState({ ...state, queue: [{ videoId: 'aaaaaaaaaaa', title: 'First' }] }), true);
  assert.equal(validYouTubeState({ ...state, queue: [{ ...state.queue[0], addedByName: 4 }] }), false);
});
