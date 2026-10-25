import { logDiagnostic } from '../core/logger.ts';

/** Observe startup only; no per-frame polling or transport changes after first paint. */
export function observeRemoteVideoStartup(element: HTMLVideoElement, options: {
  mediaId: string;
  ready: () => void;
  recover: () => void;
}): () => void {
  const started = performance.now();
  let disposed = false;
  let complete = false;
  let frame: number | undefined;
  let attempts = 0;
  let stalls = 0;
  let lastAttempt = started;
  const details = () => ({ mediaId: options.mediaId, elapsedMs: Math.round(performance.now() - started),
    readyState: element.readyState, paused: element.paused, width: element.videoWidth, height: element.videoHeight,
    tracks: (element.srcObject as MediaStream | null)?.getVideoTracks().map(track => ({
      id: track.id, state: track.readyState, muted: track.muted })), attempts });
  const ready = () => {
    if (disposed || complete) return;
    complete = true;
    clearInterval(timer);
    logDiagnostic('INFO', 'transmission.playback', 'Remote video presented its first frame', details());
    options.ready();
  };
  const check = () => {
    if (element.readyState >= 2 && element.videoWidth > 0 && element.videoHeight > 0) ready();
  };
  const play = () => {
    void element.play().catch(error => {
      if (!disposed && !complete) logDiagnostic('WARN', 'transmission.playback', 'Remote video play failed', { ...details(), error });
    });
  };
  const timer = setInterval(() => {
    if (disposed || complete || attempts >= 3) return;
    // Allow native setup and fallback to finish, then require two missed probes.
    if (performance.now() - started < 15_000 || performance.now() - lastAttempt < 8_000) return;
    if (++stalls < 2) return;
    stalls = 0;
    lastAttempt = performance.now();
    attempts++;
    logDiagnostic('WARN', 'transmission.playback', 'Remote video has no first frame; requesting stream recovery', details());
    play();
    options.recover();
    if (attempts >= 3) clearInterval(timer);
  }, 1500);
  if (typeof element.requestVideoFrameCallback === 'function') {
    frame = element.requestVideoFrameCallback(ready);
  }
  element.addEventListener('loadeddata', check);
  element.addEventListener('timeupdate', check);
  check();
  play();
  return () => {
    disposed = true;
    clearInterval(timer);
    if (frame !== undefined && typeof element.cancelVideoFrameCallback === 'function') element.cancelVideoFrameCallback(frame);
    element.removeEventListener('loadeddata', check);
    element.removeEventListener('timeupdate', check);
  };
}
