import { useLayoutEffect, useState, type RefObject } from 'react';

/** Wait for presented content after a source change, independently of page navigation. */
export function useVideoPresentation(video: RefObject<HTMLVideoElement | null>, source: unknown, stream: MediaStream | null, enabled: boolean, sampling = true) {
  const [ready, setReady] = useState<{ source: unknown; stream: MediaStream | null } | null>(null);
  useLayoutEffect(() => {
    setReady(null);
    const element = video.current;
    if (!enabled || !sampling || !element || !stream) return;
    let disposed = false; let callback = 0; let timer: ReturnType<typeof setTimeout> | undefined;
    const started = performance.now(); let frames = 0;
    const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 18;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const check = () => {
      if (disposed) return;
      let content = false;
      if (element.readyState >= 2 && element.videoWidth > 0) {
        frames++;
        try {
          context?.drawImage(element, 0, 0, canvas.width, canvas.height);
          const pixels = context?.getImageData(0, 0, canvas.width, canvas.height).data;
          if (pixels) for (let index = 0; index < pixels.length; index += 4) {
            if (Math.max(pixels[index], pixels[index + 1], pixels[index + 2]) > 16) { content = true; break; }
          }
          else content = true;
        } catch { content = true; }
        // A genuinely black page must remain usable once frames are demonstrably arriving.
        if (frames >= 2 && (content || performance.now() - started > 8000)) {
          setReady({ source, stream }); return;
        }
      }
      if (element.requestVideoFrameCallback) callback = element.requestVideoFrameCallback(check);
      else timer = setTimeout(check, 66);
    };
    if (element.requestVideoFrameCallback) callback = element.requestVideoFrameCallback(check);
    else timer = setTimeout(check, 0);
    return () => { disposed = true; if (callback) element.cancelVideoFrameCallback?.(callback); clearTimeout(timer); };
  }, [video, source, stream, enabled, sampling]);
  return enabled && (!sampling || !stream || ready?.source !== source || ready?.stream !== stream);
}
