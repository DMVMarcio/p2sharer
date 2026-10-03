import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { getScreenSkeletonCount, getSkeletonCountForTab } from '../../src/components/modals/screen_picker_utils.ts';

const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const values = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => values.set(key, value),
  clear: () => values.clear(),
}});

after(() => {
  if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});

describe('Screen Picker Loading Skeleton Counts', () => {
  beforeEach(() => localStorage.clear());

  describe('Adaptive Skeleton Count', () => {
    it('returns monitorsCount when monitorsCount > 0', () => {
      assert.equal(getScreenSkeletonCount(1), 1);
      assert.equal(getScreenSkeletonCount(2), 2);
      assert.equal(getScreenSkeletonCount(3), 3);
    });

    it('returns cached monitor count when monitorsCount is 0', () => {
      localStorage.setItem('p2sharer_last_monitor_count', '1');
      assert.equal(getScreenSkeletonCount(0), 1);

      localStorage.setItem('p2sharer_last_monitor_count', '3');
      assert.equal(getScreenSkeletonCount(0), 3);
    });

    it('returns default 2 (single row) when monitorsCount is 0 and no cache exists', () => {
      assert.equal(getScreenSkeletonCount(0), 2);
    });

    it('computes correct skeleton count for each tab: single row for screens, 6 for windows', () => {
      // When 1 monitor detected
      assert.equal(getSkeletonCountForTab('screens', 1), 1);
      assert.equal(getSkeletonCountForTab('windows', 1), 6);

      // When 2 monitors detected
      assert.equal(getSkeletonCountForTab('screens', 2), 2);
      assert.equal(getSkeletonCountForTab('windows', 2), 6);

      // When no monitors in memory and default fallback 2 (1 row)
      assert.equal(getSkeletonCountForTab('screens', 0), 2);
      assert.equal(getSkeletonCountForTab('windows', 0), 6);
    });
  });

});
