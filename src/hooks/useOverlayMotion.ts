import { useLayoutEffect, useRef, type RefObject } from 'react';
import { overlayMotionDuration, type OverlayFamily } from '../core/overlay_motion.ts';

/** Animate native compositor properties without replacing popup positioning transforms. */
export function useOverlayMotion(ref: RefObject<HTMLElement | null>, opening: boolean, family: OverlayFamily, ready = true) {
  const active = useRef<Animation[]>([]);
  const previous = useRef<{ element: HTMLElement; opening: boolean; ready: boolean } | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    const last = previous.current;
    if (!element || last?.element !== element) {
      active.current.forEach(animation => animation.cancel());
      active.current = [];
      previous.current = null;
    }
    if (!element || typeof element.animate !== 'function') return; // CSS remains the compatibility fallback.
    if (last?.element === element && last.opening === opening && last.ready === ready) return;
    element.dataset.overlayMotion = 'controlled';
    if (!ready) { previous.current = { element, opening, ready }; return; }
    const targets = family === 'dialog'
      ? [element, element.querySelector<HTMLElement>('.modal-card')].filter((target): target is HTMLElement => Boolean(target))
      : [element];
    const continuing = active.current.length > 0;
    // Read the displayed frame before cancellation, so interrupted transitions never jump to an endpoint.
    const from = targets.map(target => {
      const style = window.getComputedStyle(target);
      return { opacity: continuing ? style.opacity : opening ? '0' : '1',
        scale: continuing ? style.scale : opening ? '0.985' : '1',
        translate: continuing ? style.translate : opening ? '0 -4px' : '0 0' };
    });
    active.current.forEach(animation => animation.cancel());
    const duration = overlayMotionDuration(family, opening);
    active.current = targets.map((target, index) => {
      const backdrop = family === 'dialog' && index === 0;
      const offset = family === 'dialog' ? '8px' : window.getComputedStyle(target).getPropertyValue('--dropdown-enter-offset').trim() || '-4px';
      const start = continuing ? from[index] : { opacity: opening ? '0' : '1', scale: opening ? '0.985' : '1', translate: opening ? `0 ${offset}` : '0 0' };
      const end = { opacity: opening ? '1' : '0', scale: opening ? '1' : '0.985', translate: opening ? '0 0' : `0 ${offset}` };
      const animation = target.animate(backdrop ? [{ opacity: start.opacity }, { opacity: end.opacity }] : [start, end], {
        duration, easing: opening ? 'cubic-bezier(0.16, 1, 0.3, 1)' : 'cubic-bezier(0.4, 0, 0.2, 1)', fill: 'both',
      });
      animation.onfinish = () => {
        if (!active.current.includes(animation)) return;
        target.style.opacity = end.opacity;
        if (!backdrop) { target.style.scale = end.scale; target.style.translate = end.translate; }
        active.current = active.current.filter(current => current !== animation);
        animation.cancel(); // Release completed players instead of keeping compositor layers alive.
      };
      return animation;
    });
    previous.current = { element, opening, ready };
  });
  useLayoutEffect(() => () => {
    active.current.forEach(animation => animation.cancel());
    active.current = [];
    previous.current = null;
  }, []);
}
