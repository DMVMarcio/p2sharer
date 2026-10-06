import { useCallback, useEffect, useRef, type PointerEvent } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { isTauri } from '@tauri-apps/api/core';

export function usePipWindowDrag(enabled: boolean) {
  const cleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!enabled) cleanupRef.current?.();
    return () => cleanupRef.current?.();
  }, [enabled]);
  return useCallback((event: PointerEvent<HTMLDivElement>) => {
    cleanupRef.current?.();
    if (!enabled || !isTauri() || event.button !== 0 || event.shiftKey || event.target instanceof Element &&
      event.target.closest('button, input, textarea, a, select, [role="button"], [contenteditable="true"], .custom-tooltip, .stream-zoom-bar')) return;
    const { clientX, clientY, pointerId } = event;
    const cleanup = () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', cleanup, true);
      window.removeEventListener('pointercancel', cleanup, true);
      window.removeEventListener('blur', cleanup);
      cleanupRef.current = null;
    };
    const move = (next: globalThis.PointerEvent) => {
      if (next.pointerId !== pointerId || Math.hypot(next.clientX - clientX, next.clientY - clientY) < 4) return;
      cleanup();
      next.preventDefault();
      next.stopPropagation();
      void getCurrentWindow().startDragging().catch(error => console.warn('[PiP] Window drag failed:', error));
    };
    cleanupRef.current = cleanup;
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', cleanup, true);
    window.addEventListener('pointercancel', cleanup, true);
    window.addEventListener('blur', cleanup);
  }, [enabled]);
}
