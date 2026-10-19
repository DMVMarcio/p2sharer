import { useEffect, useState } from 'react';
import { stateStore } from './state_store.ts';

/**
 * Checks whether reduced motion is requested either via the application setting
 * or through the operating system's prefers-reduced-motion accessibility preference.
 */
export function isReducedMotion(): boolean {
  if (!stateStore.animationsEnabled) {
    return true;
  }
  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    return true;
  }
  return false;
}

/**
 * React hook that stays synchronized with both the user's animation preference in StateStore
 * and the operating system's prefers-reduced-motion media query.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(isReducedMotion);

  useEffect(() => {
    const update = () => setReduced(isReducedMotion());
    const unsubscribe = stateStore.subscribe(update);
    const motion = typeof window !== 'undefined' ? window.matchMedia?.('(prefers-reduced-motion: reduce)') : null;
    motion?.addEventListener?.('change', update);

    return () => {
      unsubscribe();
      motion?.removeEventListener?.('change', update);
    };
  }, []);

  return reduced;
}

/**
 * Applies or clears the data-reduced-motion and data-reduced-effects attributes on the document element.
 */
export function applyAppearanceAttributes(animations: boolean, visualEffects: boolean): void {
  if (typeof document === 'undefined' || !document.documentElement) return;
  const root = document.documentElement;
  if (!animations) {
    root.setAttribute('data-reduced-motion', 'true');
  } else {
    root.removeAttribute('data-reduced-motion');
  }

  if (!visualEffects) {
    root.setAttribute('data-reduced-effects', 'true');
  } else {
    root.removeAttribute('data-reduced-effects');
  }
}
