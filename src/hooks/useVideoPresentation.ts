import { useLayoutEffect, useState, type RefObject } from 'react';

/** Wait for presented content after a source change, independently of page navigation. */
export function useVideoPresentation(video: RefObject<HTMLVideoElement | null>, source: unknown, stream: MediaStream | null, enabled: boolean, sampling = true) {
  const [ready, setReady] = useState<{ source: unknown; stream: MediaStream | null } | null>(null);
  useLayoutEffect(() => {
    setReady(null);
    const element = video.current;
    if (!enabled || !sampling || !element || !stream) return;
    let disposed = false; let callback: number | undefined; let timer: ReturnType<typeof setTimeout> | undefined;
    const started = performance.now(); let frames = 0;
    const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 18;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const cancel = () => { if (callback !== undefined) element.cancelVideoFrameCallback?.(callback); clearTimeout(timer); };
    const check = () => {
      if (disposed) return true;
      let content = false;
      if (element.readyState >= 2 && element.videoWidth > 0) {
        try {
          context?.drawImage(element, 0, 0, canvas.width, canvas.height);
          const pixels = context?.getImageData(0, 0, canvas.width, canvas.height).data;
          if (pixels) for (let index = 0; index < pixels.length; index += 4) {
            if (Math.max(pixels[index], pixels[index + 1], pixels[index + 2]) > 16) { content = true; break; }
          }
          else content = true;
        } catch { content = true; }
        // Static WebRTC content may present only one frame. Inspect that cached
        // decoded image after a short settling period without requiring another.
        const elapsed = performance.now() - started;
        if (content && (frames >= 2 || elapsed >= 200) || elapsed >= 8000) {
          disposed = true; cancel(); setReady({ source, stream }); return true;
        }
      }
      return false;
    };
    const frame = () => {
      callback = undefined; frames++;
      if (!check()) callback = element.requestVideoFrameCallback(frame);
    };
    const poll = () => { if (!check()) timer = setTimeout(poll, 200); };
    if (element.requestVideoFrameCallback) callback = element.requestVideoFrameCallback(frame);
    // Keep the bounded black-frame escape live even when frame callbacks pause.
    timer = setTimeout(poll, 200);
    return () => { disposed = true; cancel(); };
  }, [video, source, stream, enabled, sampling]);
  return enabled && (!sampling || !stream || ready?.source !== source || ready?.stream !== stream);
}
