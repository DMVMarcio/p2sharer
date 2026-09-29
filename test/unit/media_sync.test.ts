import assert from 'node:assert/strict';
import test from 'node:test';
import { MEDIA_SYNC_INTERVAL_MS, projectMediaPosition, shouldCorrectMediaPosition } from '../../src/core/media_sync.ts';

test('shared playback projects from receipt time and stops advancing while paused', () => {
  assert.equal(MEDIA_SYNC_INTERVAL_MS, 10_000);
  assert.equal(projectMediaPosition(42, true, 1_000, 6_000), 47);
  assert.equal(projectMediaPosition(42, false, 1_000, 6_000), 42);
  assert.equal(projectMediaPosition(42, true, 6_000, 1_000), 42);
  assert.equal(projectMediaPosition(42, true, 1_000, 101_000), 142);
});

test('routine drift up to four seconds is tolerated, while larger drift seeks once', () => {
  assert.equal(shouldCorrectMediaPosition(96, 100, false, 0, 20_000), false);
  assert.equal(shouldCorrectMediaPosition(95.9, 100, false, 0, 20_000), true);
  assert.equal(shouldCorrectMediaPosition(95, 100, false, 19_000, 20_000), false);
  assert.equal(shouldCorrectMediaPosition(95, 100, false, 10_000, 20_000), true);
  assert.equal(shouldCorrectMediaPosition(NaN, 100, false, 0, 20_000), false);
});

test('playback and seek events get tighter immediate correction', () => {
  assert.equal(shouldCorrectMediaPosition(99.3, 100, true, 19_000, 20_000), false);
  assert.equal(shouldCorrectMediaPosition(99.2, 100, true, 19_000, 20_000), true);
});
