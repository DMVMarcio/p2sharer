import { useEffect, useRef, useState } from 'react';

interface Point { x: number; y: number; actor: string; shape?: 'default' | 'text' | 'pointer' }
/** Local visual feedback runs at display cadence, independently of host acknowledgements. */
export function useBrowserCursor(authoritative: Point | null, canPredict: boolean, actor: string, tab: number) {
  const [local, setLocal] = useState<(Point & { tab: number }) | null>(null);
  const [outside, setOutside] = useState(false);
  const pending = useRef<(Point & { tab: number }) | null>(null);
  const frame = useRef<number | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const clear = () => {
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    frame.current = undefined; pending.current = null; clearTimeout(timer.current); setLocal(null);
  };
  useEffect(() => {
    clear();
    return () => { if (frame.current !== undefined) cancelAnimationFrame(frame.current); clearTimeout(timer.current); };
  }, [canPredict, actor, tab]);
  const preview = (point: { x: number; y: number }) => {
    setOutside(false);
    if (!canPredict) return;
    pending.current = { ...point, actor, tab };
    if (frame.current === undefined) frame.current = requestAnimationFrame(() => {
      frame.current = undefined; setLocal(pending.current);
    });
    clearTimeout(timer.current); timer.current = setTimeout(clear, 1000);
  };
  const predicted = canPredict && local?.tab === tab;
  return { pointer: outside && authoritative?.actor === actor ? null : predicted ? { ...local!, shape: authoritative?.actor === actor ? authoritative.shape : 'default' as const } : authoritative, predicted, preview, clear,
    leave() { clear(); setOutside(true); } };
}
