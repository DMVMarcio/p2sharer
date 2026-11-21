import type { CSSProperties } from 'react';

/** Progress line for an auto-advancing selection; restarts whenever `cycle` changes. */
export function CycleTimer({ running, cycle, duration }: { running: boolean; cycle: number; duration: number }) {
  if (!running) return null;
  return (
    <span
      key={cycle}
      className="lp-cycle-timer"
      style={{ '--cycle-duration': `${duration}ms` } as CSSProperties}
      aria-hidden="true"
    />
  );
}
