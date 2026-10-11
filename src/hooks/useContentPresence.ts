import { useLayoutEffect, useState } from 'react';

// Matches --content-exit-duration and the shared fast transition in style.css.
const EXIT_DURATION_MS = 150;

/** Keep outgoing content mounted and inert before committing the latest requested view. */
export function useContentPresence<T extends string>(value: T) {
  const [displayed, setDisplayed] = useState(value);
  useLayoutEffect(() => {
    const motion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const commit = () => setDisplayed(() => value);
    if (motion?.matches) { commit(); return; }
    const timer = Object.is(displayed, value) ? undefined : window.setTimeout(commit, EXIT_DURATION_MS);
    const onMotionChange = () => { if (motion?.matches) { window.clearTimeout(timer); commit(); } };
    motion?.addEventListener?.('change', onMotionChange);
    return () => {
      window.clearTimeout(timer);
      motion?.removeEventListener?.('change', onMotionChange);
    };
  }, [value, displayed]);
  return { value: displayed, closing: !Object.is(value, displayed) };
}
