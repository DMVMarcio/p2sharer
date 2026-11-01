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
    const isDocFullscreen = () => {
      const doc = document as any;
      return (doc.fullscreenElement || doc.webkitFullscreenElement) === element;
    };
    const changed = () => {
      const active = isDocFullscreen();
      setFullscreen(active);
      if (!active) void nativeRef.current.exitFullscreen().catch(console.warn);
    };
    document.addEventListener('fullscreenchange', changed);
    document.addEventListener('webkitfullscreenchange', changed);
    return () => {
      document.removeEventListener('fullscreenchange', changed);
      document.removeEventListener('webkitfullscreenchange', changed);
      if (element && isDocFullscreen()) {
        const doc = document as any;
        if (doc.exitFullscreen) void doc.exitFullscreen().catch(() => {});
        else if (doc.webkitExitFullscreen) void doc.webkitExitFullscreen().catch(() => {});
      }
    };
  }, []);
  const operations = useRef<Promise<void>>(Promise.resolve());
  const transition = useCallback(async () => {
    const element = ref.current as any;
    if (!element) return;
    const doc = document as any;
    const isCurrent = (doc.fullscreenElement || doc.webkitFullscreenElement) === element;
    if (isCurrent) {
      if (doc.exitFullscreen) await doc.exitFullscreen();
      else if (doc.webkitExitFullscreen) await doc.webkitExitFullscreen();
      await nativeRef.current.exitFullscreen();
    }
    else {
      try {
        await nativeRef.current.enterFullscreen();
        if (!element.isConnected) { await nativeRef.current.exitFullscreen(); return; }
        if (element.requestFullscreen) {
          await element.requestFullscreen();
        } else if (element.webkitRequestFullscreen) {
          await element.webkitRequestFullscreen();
        } else {
          // iOS Safari on iPhone requires video.webkitEnterFullscreen()
          const video = element.querySelector?.('video') as any;
          if (video?.webkitEnterFullscreen) {
            video.webkitEnterFullscreen();
          }
        }
      } catch (error) {
        if ((doc.fullscreenElement || doc.webkitFullscreenElement) === element) {
          if (doc.exitFullscreen) await doc.exitFullscreen();
          else if (doc.webkitExitFullscreen) await doc.webkitExitFullscreen();
        }
        await nativeRef.current.exitFullscreen();
        throw error;
      }
      if (!element.isConnected && (doc.fullscreenElement || doc.webkitFullscreenElement) === element) {
        if (doc.exitFullscreen) await doc.exitFullscreen();
        else if (doc.webkitExitFullscreen) await doc.webkitExitFullscreen();
      }
    }
  }, []);
  const toggleFullscreen = useCallback(() => {
    const next = operations.current.then(transition);
    operations.current = next.catch(() => {});
    return next;
  }, [transition]);
  return { ref, fullscreen, toggleFullscreen };
}
