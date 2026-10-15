import { useEffect, useRef, type RefObject } from 'react';
import type { BrowserCommand } from '../apps/browser_protocol';

/** Physical capture belongs only to the controlling participant's local surface. */
export function useBrowserPointerLock(surface: RefObject<HTMLDivElement | null>, enabled: boolean,
  command: (command: BrowserCommand) => void) {
  const send = useRef(command); send.current = command;
  useEffect(() => {
    const element = surface.current;
    if (!enabled || !element) return;
    let captured = false;
    let stopped = false;
    let frame = 0;
    let dx = 0;
    let dy = 0;
    const release = () => { if (!stopped) send.current({ kind: 'release' }); };
    const changed = () => {
      if (document.pointerLockElement === element) captured = true;
      else if (captured) { captured = false; release(); }
    };
    const failed = () => release();
    const move = (event: MouseEvent) => {
      if (document.pointerLockElement !== element) return;
      event.preventDefault(); event.stopPropagation();
      dx = Math.max(-5000, Math.min(5000, dx + event.movementX));
      dy = Math.max(-5000, Math.min(5000, dy + event.movementY));
      if (!frame) frame = window.requestAnimationFrame(() => {
        frame = 0;
        if (document.pointerLockElement === element && (dx || dy)) send.current({ kind: 'relative-mouse', dx, dy });
        dx = 0; dy = 0;
      });
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation(); document.exitPointerLock?.(); release();
    };
    const blur = () => { document.exitPointerLock?.(); release(); };
    document.addEventListener('pointerlockchange', changed);
    document.addEventListener('pointerlockerror', failed);
    document.addEventListener('mousemove', move, true);
    window.addEventListener('keydown', escape, true);
    window.addEventListener('blur', blur);
    try { void element.requestPointerLock()?.catch(failed); } catch { failed(); }
    return () => {
      stopped = true;
      window.cancelAnimationFrame(frame);
      document.removeEventListener('pointerlockchange', changed);
      document.removeEventListener('pointerlockerror', failed);
      document.removeEventListener('mousemove', move, true);
      window.removeEventListener('keydown', escape, true);
      window.removeEventListener('blur', blur);
      if (document.pointerLockElement === element) document.exitPointerLock();
      send.current({ kind: 'release' });
    };
  }, [surface, enabled]);
}
