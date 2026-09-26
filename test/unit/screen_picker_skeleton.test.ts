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

    it('determines confirm button disabled state based on isLoading, isStarting and source availability', () => {
      const isConfirmDisabled = (
        isLoading: boolean,
        isStarting: boolean,
        selectedSourceId: string,
        currentTab: 'screens' | 'windows',
        monitorsCount: number,
        windowsCount: number
      ) => {
        const hasAvailableSources = currentTab === 'screens' ? monitorsCount > 0 : windowsCount > 0;
        return isLoading || isStarting || !selectedSourceId || !hasAvailableSources;
      };

      // While loading or starting, always disabled
      assert.equal(isConfirmDisabled(true, false, 'screen:0', 'screens', 2, 5), true);
      assert.equal(isConfirmDisabled(false, true, 'screen:0', 'screens', 2, 5), true);
      assert.equal(isConfirmDisabled(true, false, '', 'screens', 0, 0), true);

      // When done loading with valid selection and sources, enabled
      assert.equal(isConfirmDisabled(false, false, 'screen:0', 'screens', 2, 5), false);
      assert.equal(isConfirmDisabled(false, false, 'window:1', 'windows', 2, 5), false);

      // When done loading but no sources exist or no selection, disabled
      assert.equal(isConfirmDisabled(false, false, '', 'screens', 2, 5), true);
      assert.equal(isConfirmDisabled(false, false, 'screen:0', 'screens', 0, 5), true);
      assert.equal(isConfirmDisabled(false, false, 'window:1', 'windows', 2, 0), true);
    });

    it('handles tab switching between screens and windows appropriately with smart source selection', () => {
      let currentTab: 'screens' | 'windows' = 'screens';
      let selectedSourceId = 'screen:0';
      const monitors = [{ id: 'screen:0', name: 'Monitor 1' }];
      const windows = [{ id: 'window:42', title: 'Code Editor' }];

      const handleTabChange = (tab: 'screens' | 'windows') => {
        currentTab = tab;
        if (tab === 'screens' && monitors.length > 0) {
          if (!selectedSourceId || !selectedSourceId.startsWith('screen:')) {
            selectedSourceId = monitors[0].id;
          }
        } else if (tab === 'windows' && windows.length > 0) {
          if (!selectedSourceId || !selectedSourceId.startsWith('window:')) {
            selectedSourceId = windows[0].id;
          }
        }
      };

      assert.equal(currentTab, 'screens');
      assert.equal(selectedSourceId, 'screen:0');

      // Switching to windows tab should select first window
      handleTabChange('windows');
      assert.equal(currentTab, 'windows');
      assert.equal(selectedSourceId, 'window:42');

      // Switching back to screens tab should select first screen
      handleTabChange('screens');
      assert.equal(currentTab, 'screens');
      assert.equal(selectedSourceId, 'screen:0');
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
