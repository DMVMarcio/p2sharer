import { useLayoutEffect, useState, type RefObject } from 'react';

/** Preserve the preferred size when a smaller window temporarily constrains it. */
export function usePanelSize(container: RefObject<HTMLElement | null>, axis: 'width' | 'height',
  storageKey: string, initial: number, minimum: number, reserve: number, active = true) {
  const maximum = 4096;
  const [preferred, setPreferred] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(storageKey));
      return Number.isFinite(saved) && saved >= minimum ? Math.min(maximum, saved) : initial;
    } catch { return initial; }
  });
  const [available, setAvailable] = useState(maximum);
  useLayoutEffect(() => {
    const node = container.current;
    if (!node || !active) return;
    const measure = () => setAvailable(Math.max(minimum, Math.min(maximum,
      (axis === 'width' ? node.clientWidth : node.clientHeight) - reserve)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [container, axis, minimum, reserve, active]);
  const size = Math.min(preferred, available);
  const change = (value: number) => {
    const next = Math.round(Math.max(minimum, Math.min(available, value)));
    setPreferred(next);
    try { localStorage.setItem(storageKey, String(next)); } catch { /* Retain session size. */ }
  };
  return { size, minimum, maximum: available, change };
}
