/**
 * Calculates the number of skeleton cards to render while screen sources are loading.
 * For "Telas Inteiras" (screens), keeps the skeleton to a single row matching the user's
 * monitor count (from active state or cached in localStorage), defaulting to 2.
 */
export function getScreenSkeletonCount(monitorsCount: number = 0): number {
  if (monitorsCount > 0) return monitorsCount;
  try {
    if (typeof localStorage !== 'undefined') {
      const cached = parseInt(localStorage.getItem('p2sharer_last_monitor_count') || '0', 10);
      if (cached > 0) return cached;
    }
  } catch {}
  return 2;
}

/**
 * Returns the appropriate skeleton placeholder count depending on the active tab.
 */
export function getSkeletonCountForTab(tab: 'screens' | 'windows', monitorsCount: number = 0): number {
  return tab === 'screens' ? getScreenSkeletonCount(monitorsCount) : 6;
}
