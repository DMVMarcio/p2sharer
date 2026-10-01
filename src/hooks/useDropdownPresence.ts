import { useLayoutEffect, useState } from 'react';

// Keep in sync with --dropdown-exit-duration in style.css.
const EXIT_DURATION_MS = 260;

/** Retain the last menu content while its noninteractive exit animation finishes. */
export function useDropdownPresence<T>(value: T | null) {
  const [retained, setRetained] = useState<T | null>(value);
  useLayoutEffect(() => {
    if (value !== null) {
      setRetained(value);
      return;
    }
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reducedMotion) {
      setRetained(null);
      return;
    }
    const timer = window.setTimeout(() => setRetained(null), EXIT_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [value]);
  return { value: value ?? retained, closing: value === null && retained !== null };
}
