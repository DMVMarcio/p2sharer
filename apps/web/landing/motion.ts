import { useEffect, useState, type RefObject } from 'react';
import { useReducedMotion } from '../../../src/core/appearance_preferences';

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

/** Applies a subtle pointer-driven 3D tilt through CSS custom properties on fine pointers. */
export function usePointerTilt(ref: RefObject<HTMLElement | null>, strength = 6): void {
  const reduced = useReducedMotion();
  useEffect(() => {
    const element = ref.current;
    if (!element || reduced || !window.matchMedia?.('(pointer: fine)').matches) return;
    let frame = 0;
    const move = (event: PointerEvent) => {
      const bounds = element.getBoundingClientRect();
      const x = (event.clientX - bounds.left) / bounds.width - 0.5;
      const y = (event.clientY - bounds.top) / bounds.height - 0.5;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        element.style.setProperty('--tilt-x', `${(-y * strength).toFixed(2)}deg`);
        element.style.setProperty('--tilt-y', `${(x * strength).toFixed(2)}deg`);
      });
    };
    const leave = () => {
      cancelAnimationFrame(frame);
      element.style.setProperty('--tilt-x', '0deg');
      element.style.setProperty('--tilt-y', '0deg');
    };
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerleave', leave);
    return () => {
      cancelAnimationFrame(frame);
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerleave', leave);
    };
  }, [ref, reduced, strength]);
}
