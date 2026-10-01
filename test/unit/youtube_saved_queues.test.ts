import assert from 'node:assert/strict';
import test from 'node:test';
import { createSavedYouTubeQueues, SAVED_YOUTUBE_QUEUES_KEY } from '../../src/apps/youtube_saved_queues.ts';
import { importYouTubeQueue } from '../../src/apps/youtube_queue.ts';
import { YouTubeModel } from '../../src/apps/models.ts';
import { describeYouTubeActivity } from '../../src/apps/youtube_activity.ts';
import type { YouTubeState } from '../../src/apps/types.ts';

function fixture() {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); } };
  return { storage, values, store: createSavedYouTubeQueues(storage) };
}
const entries = [{ videoId: 'aaaaaaaaaaa', title: 'First', addedBy: 'old-actor', addedByName: 'Old name' },
  { videoId: 'bbbbbbbbbbb', title: 'Second' }];
const state: YouTubeState = { queue: [entries[1]], index: 0, position: 42, playing: false,
  repeat: 'all', shuffle: true, removePlayed: true, updatedAt: 1 };

test('saved queues survive a new store and retain order and duplicates without old room identities', () => {
  const { storage, store } = fixture();
  const saved = store.save('  Favorites  ', [...entries, entries[0]]);
  entries[0].title = 'Changed after save';
  const restored = createSavedYouTubeQueues(storage).list()[0];
  assert.equal(restored.id, saved.id);
  assert.equal(restored.name, 'Favorites');
  assert.deepEqual(restored.entries.map((entry) => entry.title), ['First', 'Second', 'First']);
  assert.equal(restored.entries[0].addedBy, undefined);
  restored.entries[0].title = 'Changed copy';
  assert.equal(store.list()[0].entries[0].title, 'First');
  entries[0].title = 'First';
});

test('overwrite preserves identity without creating a second row; rename and delete persist', () => {
  const { store, storage } = fixture();
  const original = store.save('Favorites', entries);
  assert.throws(() => store.save('favorites', entries));
  store.save('Favorites', [entries[1]], original.id);
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].id, original.id);
  assert.equal(store.list()[0].entries.length, 1);
  store.rename(original.id, 'Updated');
  assert.equal(createSavedYouTubeQueues(storage).list()[0].name, 'Updated');
  const other = store.save('Other', entries);
  assert.throws(() => store.rename(original.id, 'other'));
  store.remove(original.id);
  assert.deepEqual(store.list().map((row) => row.id), [other.id]);
  assert.throws(() => store.save('Updated', entries, original.id));
});

test('invalid imports and unreadable storage cannot silently destroy saved data', () => {
  const { store, values } = fixture();
  store.save('Keep', entries);
  const original = values.get(SAVED_YOUTUBE_QUEUES_KEY);
  for (const invalid of [[], [{ videoId: '../invalid', title: 'Unsafe' }], Array(201).fill(entries[0])])
    assert.throws(() => store.save('Invalid', invalid));
  assert.equal(values.get(SAVED_YOUTUBE_QUEUES_KEY), original);
  values.set(SAVED_YOUTUBE_QUEUES_KEY, 'broken JSON');
  assert.throws(() => store.save('New', entries));
  assert.equal(values.get(SAVED_YOUTUBE_QUEUES_KEY), 'broken JSON');
});

test('storage quota failure preserves the previous queue and does not announce success', () => {
  const { storage, store, values } = fixture();
  const original = store.save('Keep', entries);
  const before = values.get(SAVED_YOUTUBE_QUEUES_KEY);
  const failing = createSavedYouTubeQueues({ ...storage, setItem: () => { throw new Error('Quota exceeded'); } });
  let notifications = 0;
  failing.subscribe(() => notifications++);
  assert.throws(() => failing.save('Keep', [entries[1]], original.id));
  assert.equal(values.get(SAVED_YOUTUBE_QUEUES_KEY), before);
  assert.equal(notifications, 0);
});

test('append preserves playback and options, uses fresh room attribution, and does not truncate at capacity', () => {
  const next = importYouTubeQueue(state, entries, 'append', 'new-actor', 'New name');
  assert.equal(next.position, 42);
  assert.equal(next.index, 0);
  assert.equal(next.playing, false);
  assert.equal(next.queue[0], state.queue[0]);
  assert.equal(next.queue[1].addedBy, 'new-actor');
  assert.equal(next.queue[1].addedByName, 'New name');
  assert.equal(next.repeat, 'all');
  assert.equal(next.shuffle, true);
  assert.throws(() => importYouTubeQueue({ ...state, queue: Array(199).fill(entries[0]) }, entries, 'append', 'actor', 'Actor'));
  assert.equal(state.queue.length, 1);
});

test('replacement resets playback even for the same video and reaches a remote model in one state update', () => {
  const receiver = new YouTubeModel({ localActor: 'receiver', emit: () => {}, changed: () => {} });
  let emits = 0;
  const sender = new YouTubeModel({ localActor: 'sender', emit: (payload) => {
    emits++; receiver.apply(payload, 'sender', false);
  }, changed: () => {} });
  sender.update({ ...importYouTubeQueue(state, [entries[1], entries[0]], 'replace', 'sender', 'Sender'),
    updatedAt: Date.now(), syncReason: 'queue-replace' });
  assert.equal(emits, 1);
  assert.equal(receiver.state.position, 0);
  assert.equal(receiver.state.index, 0);
  assert.equal(receiver.state.playing, true);
  assert.equal(receiver.state.queue.length, 2);
  assert.equal(receiver.state.queue[0].addedBy, 'sender');
  assert.equal(describeYouTubeActivity(state, receiver.state), 'substituiu a fila por 2 vídeos');
  const empty = importYouTubeQueue({ ...state, queue: [] }, entries, 'append', 'sender', 'Sender');
  assert.equal(empty.playing, true);
  assert.equal(empty.position, 0);
});
