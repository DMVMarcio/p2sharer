import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react';

export interface PersistentSlotPlacement {
  left: number;
  top: number;
  width: number;
  height: number;
  clipPath?: string;
}

const VIEWPORT_SELECTOR = '.streams-grid-wrapper, .spotlight-featured-area, .spotlight-tray-strip';

/** Measures registered slot elements relative to the persistent card container without recreating media nodes. */
export function usePersistentSlotPlacements(options: {
  keys: readonly string[];
  resolveSlotKey: (key: string) => string;
  layoutKey: string;
  rootRef: RefObject<HTMLDivElement | null>;
  slotsRef: RefObject<Map<string, HTMLDivElement>>;
}) {
  const { keys, resolveSlotKey, layoutKey, rootRef, slotsRef } = options;
  const [placements, setPlacements] = useState<Record<string, PersistentSlotPlacement>>({});
  const previousRef = useRef('');

  const measure = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const rootRect = root.getBoundingClientRect();
    const next: Record<string, PersistentSlotPlacement> = {};
    for (const key of keys) {
      const slot = slotsRef.current.get(resolveSlotKey(key));
      if (!slot || slot.closest('[inert]')) continue;
      const rect = slot.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      const viewport = slot.closest<HTMLElement>(VIEWPORT_SELECTOR);
      const bounds = viewport?.getBoundingClientRect() || rootRect;
      const clipTop = Math.max(0, bounds.top - rect.top);
      const clipRight = Math.max(0, rect.right - bounds.right);
      const clipBottom = Math.max(0, rect.bottom - bounds.bottom);
      const clipLeft = Math.max(0, bounds.left - rect.left);
      const hasClip = clipTop > 0 || clipRight > 0 || clipBottom > 0 || clipLeft > 0;
      next[key] = {
        left: rect.left - rootRect.left - root.clientLeft,
        top: rect.top - rootRect.top - root.clientTop,
        width: rect.width,
        height: rect.height,
        ...(hasClip ? { clipPath: `inset(${clipTop}px ${clipRight}px ${clipBottom}px ${clipLeft}px)` } : {}),
      };
    }
    const serialized = JSON.stringify(next);
    if (serialized !== previousRef.current) {
      previousRef.current = serialized;
      setPlacements(next);
    }
  }, [keys, resolveSlotKey, rootRef, slotsRef]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    slotsRef.current.forEach((slot) => observer.observe(slot));
    root.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      root.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [measure, layoutKey, rootRef, slotsRef]);

  return placements;
}
