import type { BoardPoint } from './whiteboard_scene';
import { useEffect, useRef, type RefObject } from 'react';
import { BOARD_MAX_ZOOM, BOARD_MIN_ZOOM, clampBoardViewport, type BoardViewport } from './whiteboard_interaction';

export function useWhiteboardViewport(root: RefObject<HTMLDivElement | null>, viewport: BoardViewport, onChange: (view: BoardViewport) => void) {
  const current = useRef(viewport); current.current = viewport;
  const target = useRef<BoardViewport | null>(null);
  const frame = useRef<number | null>(null);
  const lastTime = useRef<number | null>(null);
  const dimensions = () => ({ width: root.current?.clientWidth || 800, height: root.current?.clientHeight || 500 });
  const stop = () => { if (frame.current !== null) cancelAnimationFrame(frame.current); frame.current = null; target.current = null; lastTime.current = null; };
  const publish = (view: BoardViewport) => { current.current = view; onChange(view); };
  const set = (view: BoardViewport) => {
    stop(); const { width, height } = dimensions(); publish(clampBoardViewport(view, width, height));
  };
  const zoom = (delta: number, anchor: BoardPoint) => {
    const previous = target.current ?? current.current;
    const scale = Math.max(BOARD_MIN_ZOOM, Math.min(BOARD_MAX_ZOOM, previous.zoom * Math.exp(-delta * .0015)));
    const { width, height } = dimensions();
    const next = clampBoardViewport({ x: anchor.x - (anchor.x - previous.x) * scale / previous.zoom,
      y: anchor.y - (anchor.y - previous.y) * scale / previous.zoom, zoom: scale }, width, height);
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { set(next); return; }
    target.current = next;
    const tick = (time: number) => {
      const destination = target.current;
      if (!destination) return;
      const alpha = 1 - Math.exp(-Math.min(64, lastTime.current === null ? 16 : time - lastTime.current) / 55);
      lastTime.current = time;
      const view = current.current;
      const done = Math.abs(view.zoom - destination.zoom) < .0001 && Math.hypot(view.x - destination.x, view.y - destination.y) < .05;
      publish(done ? destination : { x: view.x + (destination.x - view.x) * alpha, y: view.y + (destination.y - view.y) * alpha,
        zoom: view.zoom + (destination.zoom - view.zoom) * alpha });
      if (done) { frame.current = null; target.current = null; lastTime.current = null; }
      else frame.current = requestAnimationFrame(tick);
    };
    if (frame.current === null) frame.current = requestAnimationFrame(tick);
  };
  useEffect(() => stop, []);
  return { set, zoom, stop, current };
}
