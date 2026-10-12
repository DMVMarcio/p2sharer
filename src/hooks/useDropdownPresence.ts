import { overlayMotionDuration, prefersReducedMotion } from '../core/overlay_motion.ts';
import { useLayoutEffect, useState } from 'react';


/** Retain the last menu content while its noninteractive exit animation finishes. */
export function useDropdownPresence<T>(value: T | null) {
  const [retained, setRetained] = useState<T | null>(value);
  useLayoutEffect(() => {
    if (value !== null) {
      setRetained(value);
      return;
    }
    const reducedMotion = prefersReducedMotion();
    if (reducedMotion) {
      setRetained(null);
      return;
    }
    const timer = window.setTimeout(() => setRetained(null), overlayMotionDuration('menu', false));
    return () => window.clearTimeout(timer);
  }, [value]);
  return { value: value ?? retained, closing: value === null && retained !== null };
}
