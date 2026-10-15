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
  const toggleFullscreen = useCallback(async () => {
    const element = ref.current;
    if (!element) return;
    if (document.fullscreenElement === element) {
      await document.exitFullscreen();
      await nativeRef.current.exitFullscreen();
    }
    else {
      try {
        // Start the DOM request within the click's user activation, while the shared
        // native session expands the actual Windows host and remembers its prior state.
        const results = await Promise.allSettled([nativeRef.current.enterFullscreen(), element.requestFullscreen()]);
        const failed = results.find(result => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
      } catch (error) {
        if (document.fullscreenElement === element) await document.exitFullscreen();
        await nativeRef.current.exitFullscreen();
        throw error;
      }
      // A request can finish after its player was closed.
      if (!element.isConnected && document.fullscreenElement === element) await document.exitFullscreen();
    }
  }, []);
  return { ref, fullscreen, toggleFullscreen };
}
