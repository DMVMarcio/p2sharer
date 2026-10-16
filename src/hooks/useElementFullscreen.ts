import { useCallback, useEffect, useRef, useState } from 'react';
import { useNativeFullscreen } from './useNativeFullscreen';

/** Keep an embedded player mounted while its surface enters the fullscreen top layer. */
export function useElementFullscreen<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const native = useNativeFullscreen();
  const nativeRef = useRef(native);
  nativeRef.current = native;
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const element = ref.current;
    const changed = () => {
      const active = document.fullscreenElement === element;
      setFullscreen(active);
      if (!active) void nativeRef.current.exitFullscreen().catch(console.warn);
    };
    document.addEventListener('fullscreenchange', changed);
    return () => {
      document.removeEventListener('fullscreenchange', changed);
      if (element && document.fullscreenElement === element) void document.exitFullscreen().catch(() => {});
    };
  }, []);
  const operations = useRef<Promise<void>>(Promise.resolve());
  const transition = useCallback(async () => {
    const element = ref.current;
    if (!element) return;
    if (document.fullscreenElement === element) {
      await document.exitFullscreen();
      await nativeRef.current.exitFullscreen();
    }
    else {
      try {
        // Snapshot the host before WebView2's DOM fullscreen transition can resize it
        // or change the value returned by isFullscreen(). User activation persists
        // across this short IPC operation.
        await nativeRef.current.enterFullscreen();
        if (!element.isConnected) { await nativeRef.current.exitFullscreen(); return; }
        await element.requestFullscreen();
      } catch (error) {
        if (document.fullscreenElement === element) await document.exitFullscreen();
        await nativeRef.current.exitFullscreen();
        throw error;
      }
      // A request can finish after its player was closed.
      if (!element.isConnected && document.fullscreenElement === element) await document.exitFullscreen();
    }
  }, []);
  const toggleFullscreen = useCallback(() => {
    const next = operations.current.then(transition);
    operations.current = next.catch(() => {});
    return next;
  }, [transition]);
  return { ref, fullscreen, toggleFullscreen };
}
