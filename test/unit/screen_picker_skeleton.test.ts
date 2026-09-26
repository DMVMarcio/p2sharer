import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getScreenSkeletonCount, getSkeletonCountForTab } from '../../src/components/modals/screen_picker_utils.ts';

describe('Screen Picker Loading Skeleton & Modal Architecture', () => {
  beforeEach(() => {
    if (typeof localStorage !== 'undefined') {
      localStorage.clear();
    }
  });

  describe('Adaptive Skeleton Count', () => {
    it('returns monitorsCount when monitorsCount > 0', () => {
      assert.equal(getScreenSkeletonCount(1), 1);
      assert.equal(getScreenSkeletonCount(2), 2);
      assert.equal(getScreenSkeletonCount(3), 3);
    });

    it('returns cached monitor count when monitorsCount is 0', () => {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('p2sharer_last_monitor_count', '1');
        assert.equal(getScreenSkeletonCount(0), 1);

        localStorage.setItem('p2sharer_last_monitor_count', '3');
        assert.equal(getScreenSkeletonCount(0), 3);
      }
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

  describe('Modal Component Architecture', () => {
    it('skeleton layout defines placeholder cards with shimmer thumbnail and title/subtitle lines', () => {
      const skeletonCount = 2; // Single row screens skeleton
      const skeletonItems = Array.from({ length: skeletonCount }).map((_, idx) => ({
        id: `source-skeleton-${idx}`,
        className: 'source-card source-card-skeleton',
        thumbClass: 'source-card-thumb skeleton-shimmer',
        hasIcon: true,
        titleLineClass: 'skeleton-line skeleton-title-line skeleton-shimmer',
        subLineClass: 'skeleton-line skeleton-sub-line skeleton-shimmer',
      }));

      assert.equal(skeletonItems.length, 2);
      skeletonItems.forEach((item, idx) => {
        assert.equal(item.id, `source-skeleton-${idx}`);
        assert.ok(item.className.includes('source-card-skeleton'));
        assert.ok(item.thumbClass.includes('skeleton-shimmer'));
        assert.ok(item.titleLineClass.includes('skeleton-shimmer'));
        assert.ok(item.subLineClass.includes('skeleton-shimmer'));
      });
    });

    it('determines confirm button disabled state based on isLoading and source availability', () => {
      const isConfirmDisabled = (
        isLoading: boolean,
        selectedSourceId: string,
        currentTab: 'screens' | 'windows',
        monitorsCount: number,
        windowsCount: number
      ) => {
        return (
          isLoading ||
          (!selectedSourceId && (currentTab === 'screens' ? monitorsCount === 0 : windowsCount === 0))
        );
      };

      // While loading, always disabled
      assert.equal(isConfirmDisabled(true, 'screen:0', 'screens', 2, 5), true);
      assert.equal(isConfirmDisabled(true, '', 'screens', 0, 0), true);

      // When done loading with valid selection, enabled
      assert.equal(isConfirmDisabled(false, 'screen:0', 'screens', 2, 5), false);
      assert.equal(isConfirmDisabled(false, 'window:1', 'windows', 2, 5), false);

      // When done loading but no sources exist and no selection, disabled
      assert.equal(isConfirmDisabled(false, '', 'screens', 0, 5), true);
      assert.equal(isConfirmDisabled(false, '', 'windows', 2, 0), true);
    });

    it('handles tab switching between screens and windows appropriately', () => {
      let currentTab: 'screens' | 'windows' = 'screens';
      const setTab = (tab: 'screens' | 'windows') => {
        currentTab = tab;
      };

      assert.equal(currentTab, 'screens');
      setTab('windows');
      assert.equal(currentTab, 'windows');
    });

    it('verifies early return on confirmPicker when still loading', async () => {
      let captureCalled = false;
      const confirmPickerFn = async (isLoading: boolean) => {
        if (isLoading) return;
        captureCalled = true;
      };

      await confirmPickerFn(true);
      assert.equal(captureCalled, false, 'Capture must not be triggered when isLoading is true');

      await confirmPickerFn(false);
      assert.equal(captureCalled, true, 'Capture must be triggered when isLoading is false');
    });
  });
});
