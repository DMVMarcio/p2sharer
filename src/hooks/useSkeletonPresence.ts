import { useEffect, useState } from 'react';

// Keep in sync with --source-loading-duration in style.css.
const FADE_DURATION_MS = 400;

/** Share source-loading presence so quick switches can cancel an in-progress fade. */
export function useSkeletonPresence(loading: boolean) {
  const [retained, setRetained] = useState(loading);
  useEffect(() => {
    if (loading) { setRetained(true); return; }
    if (!retained) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { setRetained(false); return; }
    const timer = window.setTimeout(() => setRetained(false), FADE_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [loading, retained]);
  return { displaySkeleton: loading || retained, isFadingOut: !loading && retained };
}
