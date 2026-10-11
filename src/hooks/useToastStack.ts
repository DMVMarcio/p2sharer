import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ToastItem } from '../core/toast_manager';

interface PresentedToast extends ToastItem { exiting: boolean; }

// Matches the shared fast exit and normal movement transitions.
const EXIT_MS = 150;
const MOVE_MS = 220;

/** Retain inert exits and animate stack movement independently of each toast's entrance. */
export function useToastStack(toasts: ToastItem[]) {
  const [items, setItems] = useState<PresentedToast[]>(() => toasts.map(item => ({ ...item, exiting: false })));
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
  const nodes = useRef(new Map<string, HTMLDivElement>());
  const callbacks = useRef(new Map<string, (node: HTMLDivElement | null) => void>());
  const positions = useRef(new Map<string, number>());
  const animations = useRef(new Map<string, Animation>());
  const exits = useRef(new Map<string, number>());

  useEffect(() => {
    const motion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const change = () => setReducedMotion(motion?.matches ?? false);
    change();
    motion?.addEventListener?.('change', change);
    return () => motion?.removeEventListener?.('change', change);
  }, []);

  useLayoutEffect(() => {
    setItems(previous => {
      if (reducedMotion) return toasts.map(item => ({ ...item, exiting: false }));
      const current = new Map(toasts.map(item => [item.id, item]));
      const retained = previous.map(item => current.has(item.id)
        ? { ...current.get(item.id)!, exiting: false }
        : { ...item, paused: true, exiting: true });
      const known = new Set(previous.map(item => item.id));
      return [...retained, ...toasts.filter(item => !known.has(item.id)).map(item => ({ ...item, exiting: false }))];
    });
  }, [toasts, reducedMotion]);

  useEffect(() => {
    const outgoing = new Set(items.filter(item => item.exiting).map(item => item.id));
    for (const [id, timer] of exits.current) {
      if (!outgoing.has(id)) { window.clearTimeout(timer); exits.current.delete(id); }
    }
    for (const id of outgoing) {
      if (exits.current.has(id)) continue;
      exits.current.set(id, window.setTimeout(() => {
        exits.current.delete(id);
        setItems(previous => previous.filter(item => item.id !== id || !item.exiting));
      }, EXIT_MS));
    }
  }, [items]);

  useLayoutEffect(() => {
    const measure = () => {
      const next = new Map<string, number>();
      for (const [id, node] of nodes.current) {
        const transform = getComputedStyle(node).transform;
        const offset = transform && transform !== 'none' ? new DOMMatrixReadOnly(transform).m42 : 0;
        const top = node.getBoundingClientRect().top - offset;
        const previous = positions.current.get(id);
        next.set(id, top);
        if (reducedMotion) { animations.current.get(id)?.cancel(); animations.current.delete(id); }
        else if (previous !== undefined && Math.abs(previous - top) > 0.5 && node.animate) {
          animations.current.get(id)?.cancel();
          const animation = node.animate([
            { transform: `translateY(${previous + offset - top}px)` }, { transform: 'translateY(0)' },
          ], { duration: MOVE_MS, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' });
          animations.current.set(id, animation);
          animation.onfinish = () => { if (animations.current.get(id) === animation) animations.current.delete(id); };
        }
      }
      positions.current = next;
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    nodes.current.forEach(node => observer?.observe(node));
    window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, [items, reducedMotion]);

  useEffect(() => () => {
    exits.current.forEach(timer => window.clearTimeout(timer));
    animations.current.forEach(animation => animation.cancel());
    exits.current.clear(); animations.current.clear();
  }, []);

  const refFor = (id: string) => {
    let callback = callbacks.current.get(id);
    if (!callback) {
      callback = (node: HTMLDivElement | null) => {
        if (node) { nodes.current.set(id, node); callbacks.current.set(id, callback!); }
        else {
          nodes.current.delete(id); callbacks.current.delete(id);
          animations.current.get(id)?.cancel(); animations.current.delete(id);
        }
      };
      callbacks.current.set(id, callback);
    }
    return callback;
  };
  return { items, refFor };
}
