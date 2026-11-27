import { useCallback, useEffect, useRef, useState } from 'react';

/** Pointer movement reveals overlays; active controls retain keyboard and pointer access. */
export function useIdleControls(enabled: boolean, delay = 1800) {
  const [visible, setVisible] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const held = useRef(new Set<'pointer' | 'focus'>());
  const reveal = useCallback(() => {
    clearTimeout(timer.current); setVisible(true);
    if (enabled && !held.current.size) timer.current = setTimeout(() => setVisible(false), delay);
  }, [enabled, delay]);
  const hold = useCallback((source: 'pointer' | 'focus') => {
    held.current.add(source); clearTimeout(timer.current); setVisible(true);
  }, []);
  const release = useCallback((source: 'pointer' | 'focus') => {
    held.current.delete(source); reveal();
  }, [reveal]);
  useEffect(() => {
    held.current.clear(); reveal();
    return () => clearTimeout(timer.current);
  }, [reveal]);
  return { visible: !enabled || visible, reveal, hold, release };
}
