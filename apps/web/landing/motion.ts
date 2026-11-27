import { useCallback, useEffect, useMemo, useState, type FocusEvent, type RefObject } from 'react';
import { useReducedMotion } from '../../../src/core/appearance/appearance_preferences';

const hasObserver = () => typeof window !== 'undefined' && 'IntersectionObserver' in window;

/** Tracks whether an element is near the viewport so looping demos only run while visible. */
export function useInView(ref: RefObject<Element | null>, rootMargin = '120px 0px'): boolean {
  const [visible, setVisible] = useState(() => !hasObserver());
  useEffect(() => {
    const element = ref.current;
    if (!element || !hasObserver()) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { rootMargin });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, rootMargin]);
  return visible;
}

/**
 * Reveals `[data-reveal]` descendants once as they scroll into view.
 * Content stays visible when observers are unavailable or motion is reduced.
 */
export function useScrollReveal(ref: RefObject<HTMLElement | null>): void {
  const reduced = useReducedMotion();
  useEffect(() => {
    const root = ref.current;
    if (!root || reduced || !hasObserver()) return;
    const targets = Array.from(root.querySelectorAll<HTMLElement>('[data-reveal]'));
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.setAttribute('data-revealed', '');
        observer.unobserve(entry.target);
      }
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.12 });
    for (const target of targets) {
      if (target.getBoundingClientRect().top < window.innerHeight * 0.92) target.setAttribute('data-revealed', '');
      else observer.observe(target);
    }
    root.classList.add('site-motion');
    return () => {
      observer.disconnect();
      root.classList.remove('site-motion');
      for (const target of targets) target.setAttribute('data-revealed', '');
    };
  }, [ref, reduced]);
}

/**
 * Advances through `count` steps on an interval while `active`; restarts from zero after the last step.
 * Under reduced motion the final, fully populated step is shown statically.
 */
export function useLoopStep(count: number, interval: number, active: boolean, holdLast = 1): number {
  const reduced = useReducedMotion();
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (reduced || !active) return;
    let current = 0;
    let held = 0;
    const timer = window.setInterval(() => {
      if (current === count - 1 && held < holdLast) {
        held += 1;
        return;
      }
      held = 0;
      current = (current + 1) % count;
      setStep(current);
    }, interval);
    return () => window.clearInterval(timer);
  }, [active, count, holdLast, interval, reduced]);
  return reduced ? count - 1 : step;
}

/**
 * Auto-advancing selection with a restartable timer. Choosing an item restarts the countdown
 * instead of stopping the rotation; keyboard focus inside the group pauses it.
 */
export function useAutoCycle(count: number, interval: number, active: boolean) {
  const reduced = useReducedMotion();
  const [index, setIndex] = useState(0);
  const [cycle, setCycle] = useState(0);
  const [focused, setFocused] = useState(false);
  const running = active && !reduced && !focused;

  // Resuming restarts the countdown so the visible timer and the advance stay aligned.
  useEffect(() => {
    if (running) setCycle(current => current + 1);
  }, [running]);

  useEffect(() => {
    if (!running) return;
    const timer = window.setTimeout(() => {
      setIndex(current => (current + 1) % count);
      setCycle(current => current + 1);
    }, interval);
    return () => window.clearTimeout(timer);
  }, [count, cycle, interval, running]);

  const select = useCallback((next: number) => {
    setIndex(next);
    setCycle(current => current + 1);
  }, []);

  const focusHandlers = useMemo(() => ({
    onFocus: (event: FocusEvent) => {
      if ((event.target as Element).matches?.(':focus-visible')) setFocused(true);
    },
    onBlur: (event: FocusEvent) => {
      if (!(event.currentTarget as Element).contains(event.relatedTarget as Node | null)) setFocused(false);
    },
  }), []);

  return { index, select, running, cycle, focusHandlers };
}

/**
 * Applies a subtle 3D tilt that follows the pointer anywhere in the window, relative to the
 * element's center, through CSS custom properties. Fine pointers only.
 */
export function usePointerTilt(ref: RefObject<HTMLElement | null>, strength = 10): void {
  const reduced = useReducedMotion();
  useEffect(() => {
    const element = ref.current;
    if (!element || reduced || !window.matchMedia?.('(pointer: fine)').matches) return;
    let frame = 0;
    const clamp = (value: number) => Math.max(-0.5, Math.min(0.5, value));
    const apply = (x: number, y: number) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        element.style.setProperty('--tilt-x', `${(-y * strength).toFixed(2)}deg`);
        element.style.setProperty('--tilt-y', `${(x * strength).toFixed(2)}deg`);
      });
    };
    const move = (event: PointerEvent) => {
      const bounds = element.getBoundingClientRect();
      if (bounds.bottom < 0 || bounds.top > window.innerHeight) return;
      const x = clamp((event.clientX - (bounds.left + bounds.width / 2)) / window.innerWidth);
      const y = clamp((event.clientY - (bounds.top + bounds.height / 2)) / window.innerHeight);
      apply(x, y);
    };
    const leave = () => apply(0, 0);
    window.addEventListener('pointermove', move, { passive: true });
    document.documentElement.addEventListener('pointerleave', leave);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', move);
      document.documentElement.removeEventListener('pointerleave', leave);
    };
  }, [ref, reduced, strength]);
}
