import { useLayoutEffect, useState } from 'react';
import { isReducedMotion } from '../core/appearance_preferences.ts';
import { stateStore } from '../core/state_store.ts';

// Matches --content-exit-duration and the shared fast transition in style.css.
const EXIT_DURATION_MS = 150;

/** Keep outgoing content mounted and inert before committing the latest requested view. */
export function useContentPresence<T extends string>(value: T) {
  const [displayed, setDisplayed] = useState(value);
  useLayoutEffect(() => {
    const motion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const commit = () => setDisplayed(() => value);
    if (isReducedMotion()) { commit(); return; }
    const timer = Object.is(displayed, value) ? undefined : window.setTimeout(commit, EXIT_DURATION_MS);
    const onMotionChange = () => { if (isReducedMotion()) { window.clearTimeout(timer); commit(); } };
    const unsubscribe = stateStore.subscribe(onMotionChange);
    motion?.addEventListener?.('change', onMotionChange);
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
      motion?.removeEventListener?.('change', onMotionChange);
    };
  }, [value, displayed]);
  return { value: displayed, closing: !Object.is(value, displayed) };
}
