import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { isReducedMotion } from '../core/appearance_preferences.ts';
import { stateStore } from '../core/state_store.ts';

// Matches --content-exit-duration, shared with content transitions.
const EXIT_DURATION_MS = 150;
interface Item { id: number | string }
interface Entry<T> { item: T; entering: boolean; exiting: boolean }
/** Retain removed keyed items while their inert exit animation finishes. */
export function useListPresence<T extends Item>(items: readonly T[]) {
  const [entries, setEntries] = useState<Entry<T>[]>(() => items.map(item => ({ item, entering: false, exiting: false })));
  const latest = useRef(items); latest.current = items;
  const timers = useRef(new Map<Item['id'], ReturnType<typeof setTimeout>>());
  useLayoutEffect(() => {
    const live = new Set(items.map(item => item.id));
    const reduced = isReducedMotion();
    for (const [id, timer] of timers.current) if (live.has(id) || reduced) { clearTimeout(timer); timers.current.delete(id); }
    setEntries(previous => {
      const result = items.map(item => { const old = previous.find(entry => entry.item.id === item.id);
        return { item, entering: !reduced && (!old || old.entering || old.exiting), exiting: false }; });
      if (!reduced) previous.forEach((entry, index) => {
        if (!live.has(entry.item.id)) result.splice(Math.min(index, result.length), 0, { ...entry, entering: false, exiting: true });
      });
      return result;
    });
  }, [items]);
  useEffect(() => {
    for (const { item, exiting } of entries) if (exiting && !timers.current.has(item.id)) {
      timers.current.set(item.id, setTimeout(() => {
        timers.current.delete(item.id);
        if (!latest.current.some(live => live.id === item.id)) setEntries(previous => previous.filter(entry => entry.item.id !== item.id));
      }, EXIT_DURATION_MS));
    }
  }, [entries]);
  useEffect(() => {
    const motion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const remove = () => {
      if (!isReducedMotion()) return;
      for (const timer of timers.current.values()) clearTimeout(timer); timers.current.clear();
      setEntries(latest.current.map(item => ({ item, entering: false, exiting: false })));
    };
    const unsubscribe = stateStore.subscribe(remove);
    motion?.addEventListener?.('change', remove);
    return () => {
      motion?.removeEventListener?.('change', remove);
      unsubscribe();
      for (const timer of timers.current.values()) clearTimeout(timer);
      timers.current.clear();
    };
  }, []);
  return entries;
}
