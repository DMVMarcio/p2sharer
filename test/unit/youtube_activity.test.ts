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

test('queue options and manual removals announce meaningful changes', () => {
  assert.equal(describeYouTubeActivity(state, { ...state, repeat: 'all' }),
    'ativou a repetição da fila');
  assert.equal(describeYouTubeActivity({ ...state, repeat: 'all' }, { ...state, repeat: 'one' }),
    'ativou a repetição de um vídeo');
  assert.equal(describeYouTubeActivity({ ...state, repeat: 'one' }, state),
    'desativou a repetição');
  assert.equal(describeYouTubeActivity(state, { ...state, shuffle: true }),
    'ativou a ordem aleatória');
  assert.equal(describeYouTubeActivity({ ...state, shuffle: true }, state),
    'desativou a ordem aleatória');
  assert.equal(describeYouTubeActivity(state, { ...state, removePlayed: true }),
    'ativou a remoção automática');
  assert.equal(describeYouTubeActivity({ ...state, removePlayed: true }, state),
    'desativou a remoção automática');
  assert.equal(describeYouTubeActivity(state, { ...state, queue: [], playing: false,
    syncReason: 'update' }), 'removeu “First” da fila');
  assert.equal(describeYouTubeActivity(state, { ...state, queue: [], playing: false,
    syncReason: 'seek' }), null);
});

test('queue attribution metadata is validated without rejecting older entries', () => {
  assert.equal(validYouTubeState(state), true);
  assert.equal(validYouTubeState({ ...state, queue: [{ videoId: 'aaaaaaaaaaa', title: 'First' }] }), true);
  assert.equal(validYouTubeState({ ...state, queue: [{ ...state.queue[0], addedByName: 4 }] }), false);
});
