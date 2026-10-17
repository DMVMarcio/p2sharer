import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReleaseNotesController, RELEASE_NOTES_STORAGE_KEY } from '../../src/core/release_notes.ts';

function storage() {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
}

test('fresh installs skip automatic notes but settings can open them', () => {
  const saved = storage();
  const notes = new ReleaseNotesController('1.4.1', saved);
  notes.openPending();
  assert.deepEqual(notes.getSnapshot(), { open: false, pending: false });
  notes.open();
  assert.equal(notes.getSnapshot().open, true);
  notes.close();
  assert.equal(new ReleaseNotesController('1.4.1', saved).getSnapshot().pending, false);
});

test('legacy profiles see 1.4.1 notes until dismissed, including after restarting', () => {
  const saved = storage();
  saved.setItem('p2sharer_username', 'Test profile');
  const notes = new ReleaseNotesController('1.4.1', saved);
  notes.openPending();
  assert.equal(notes.getSnapshot().open, true);
  const restarted = new ReleaseNotesController('1.4.1', saved);
  restarted.openPending();
  assert.equal(restarted.getSnapshot().open, true);
  restarted.close();
  const read = new ReleaseNotesController('1.4.1', saved);
  read.openPending();
  assert.deepEqual(read.getSnapshot(), { open: false, pending: false });
});

test('manual upgrades and channel changes show each installed version only once', () => {
  const saved = storage();
  new ReleaseNotesController('1.4.1', saved);
  const beta = new ReleaseNotesController('1.5.0-beta.1', saved);
  assert.equal(beta.getSnapshot().pending, true);
  beta.openPending();
  beta.close();
  assert.equal(new ReleaseNotesController('1.4.1', saved).getSnapshot().pending, false);
  assert.equal(new ReleaseNotesController('1.5.0-beta.1', saved).getSnapshot().pending, false);
  assert.equal(new ReleaseNotesController('1.5.0', saved).getSnapshot().pending, true);
});

test('corrupt storage migrates safely and failed persistence retains session acknowledgement', () => {
  const saved = storage();
  saved.setItem(RELEASE_NOTES_STORAGE_KEY, '{broken');
  saved.setItem('p2sharer_username', 'Test profile');
  const notes = new ReleaseNotesController('1.4.1', {
    getItem: saved.getItem, setItem() { throw new Error('Storage unavailable'); },
  });
  let changes = 0;
  const unsubscribe = notes.subscribe(() => changes++);
  notes.openPending();
  notes.close();
  notes.openPending();
  assert.deepEqual(notes.getSnapshot(), { open: false, pending: false });
  assert.equal(changes, 2);
  unsubscribe();
  notes.open();
  assert.equal(changes, 2);
});
