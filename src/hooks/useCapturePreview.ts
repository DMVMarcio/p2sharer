import { localizeError, t } from '../i18n/index.ts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { NativeVideoBridge } from '../video/native_video_bridge';
import { logDiagnostic } from '../core/logger.ts';
import { acquireCamera, cameraFrameRates, cameraResolution, cameraResolutions, configureCamera, preferredCameraFrameRate, type CameraResolution } from '../video/camera_devices';

export interface PreparedCapture { sourceId: string; stream: MediaStream; bridge?: NativeVideoBridge }

export function useCapturePreview(sourceId: string, resolution: { width: number; height: number }, fps: number,
  mouse: boolean, quality: number, disabled: boolean, onModes: (modes: CameraResolution[]) => void,
  onFrameRates: (rates: number[]) => void) {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [settings, setSettings] = useState<MediaTrackSettings>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const active = useRef<PreparedCapture | null>(null);
  const generation = useRef(0);
  const queue = useRef(Promise.resolve());
  const recoveredTracks = useRef(new WeakSet<MediaStreamTrack>());
  const verifiedRates = useRef(new WeakMap<MediaStreamTrack, Map<string, number[]>>());
  const requested = useRef({ resolution, fps, mouse, quality, onModes, onFrameRates });
  const screenConfig = sourceId.startsWith('camera:') ? '' : `${resolution.width}/${resolution.height}/${fps}/${mouse}/${quality}`;
  requested.current = { resolution, fps, mouse, quality, onModes, onFrameRates };
  const dispose = useCallback(async () => {
    const capture = active.current;
    active.current = null;
    if (capture?.bridge) await capture.bridge.stopCapture();
    else capture?.stream.getTracks().forEach((track) => track.stop());
  }, []);

  const recoverCamera = useCallback(async (source: string, cancelled: () => boolean) => {
    logDiagnostic('WARN', 'capture.preview', 'Retrying camera with device default mode', { sourceId: source });
    await dispose();
    if (cancelled()) return;
    // Some USB drivers hang while switching modes. Reopen once in the device's
    // default mode and offer only the negotiated pair instead of probing it again.
    const preview = await acquireCamera({ audio: false, video: { deviceId: { exact: source.slice(7) },
      frameRate: { ideal: 30, max: 120 } } });
    if (cancelled()) { preview.getTracks().forEach((track) => track.stop()); return; }
    const track = preview.getVideoTracks()[0];
    const actual = track?.getSettings();
    if (!track || !actual?.width || !actual.height || !actual.frameRate) {
      preview.getTracks().forEach((item) => item.stop());
      throw new Error(t('message.f47f39a15741'));
    }
    recoveredTracks.current.add(track);
    logDiagnostic('INFO', 'capture.preview', 'Camera recovered without mode probing', { sourceId: source, settings: actual });
    active.current = { sourceId: source, stream: preview };
    track.onended = () => {
      if (active.current?.stream === preview) setError(t('message.a1d4a2ca6dcf'));
    };
    requested.current.onModes([cameraResolution(actual.width, actual.height)]);
    requested.current.onFrameRates([actual.frameRate]);
    setSettings(actual); setError(''); setStream(preview);
  }, [dispose]);

  useEffect(() => {
    const version = ++generation.current;
    const cancelled = () => generation.current !== version;
    setStream(null); setError(''); setSettings({}); setBusy(!disabled && !!sourceId);
    queue.current = queue.current.catch(() => {}).then(async () => {
      await dispose();
      if (disabled || !sourceId || cancelled()) return;
      const options = requested.current;
      const bridge = sourceId.startsWith('camera:') ? undefined : new NativeVideoBridge(`preview-${crypto.randomUUID()}`);
      try {
        const preview = bridge ? await bridge.startCapture(sourceId, options.fps, options.resolution, options.mouse, options.quality)
          : await acquireCamera({ audio: false, video: {
            deviceId: { exact: sourceId.slice(7) }, width: { ideal: options.resolution.width },
            height: { ideal: options.resolution.height }, frameRate: { ideal: options.fps },
          } });
        active.current = { sourceId, stream: preview, bridge };
        if (cancelled()) { await dispose(); return; }
        preview.getVideoTracks()[0].onended = () => {
          if (!cancelled() && active.current?.stream === preview) setError(t("message.a1d4a2ca6dcf"));
        };
        setStream(preview);
        if (!bridge) {
          const modes = await cameraResolutions(preview.getVideoTracks()[0], cancelled);
          if (!cancelled()) options.onModes(modes);
        } else setSettings(preview.getVideoTracks()[0].getSettings());
      } catch (err) {
        if (!cancelled()) logDiagnostic('ERROR', 'capture.preview', 'Preview acquisition/discovery failed', { sourceId, generation: version, requested: { resolution: options.resolution, fps: options.fps }, error: err });
        if (bridge) await bridge.stopCapture();
        else if (!cancelled() && !(err instanceof DOMException && ['NotAllowedError', 'NotFoundError'].includes(err.name))) {
          try { await recoverCamera(sourceId, cancelled); return; }
          catch (recoveryError) {
            logDiagnostic('ERROR', 'capture.preview', 'Camera recovery failed', { sourceId, error: recoveryError });
            err = recoveryError;
          }
        }
        if (!bridge) await dispose();
        if (!cancelled()) { setStream(null); setError(t("message.80e583478ab0", { v0: localizeError(err) })); }
      } finally { if (!cancelled()) setBusy(false); }
    });
    return () => {
      ++generation.current;
      if (active.current && !active.current.bridge) {
        active.current.stream.getTracks().forEach((track) => track.stop());
        active.current = null;
      }
      queue.current = queue.current.catch(() => {}).then(dispose);
    };
  }, [sourceId, disabled, screenConfig, dispose, recoverCamera, attempt]);

  useEffect(() => {
    if (!stream || !sourceId.startsWith('camera:')) return;
    const version = generation.current;
    let cancelled = false;
    const stale = () => cancelled || version !== generation.current;
    setBusy(true);
    queue.current = queue.current.catch(() => {}).then(async () => {
      if (stale()) return;
      const track = stream.getVideoTracks()[0];
      if (active.current?.stream !== stream) { setBusy(false); return; }
      if (recoveredTracks.current.has(track)) {
        setSettings(track.getSettings()); setBusy(false);
        return;
      }
      const mode = { ...resolution, value: '', label: '' };
      try {
        const modeKey = `${mode.width}x${mode.height}`;
        let cache = verifiedRates.current.get(track);
        if (!cache) { cache = new Map(); verifiedRates.current.set(track, cache); }
        const rates = cache.get(modeKey) || await cameraFrameRates(track, mode, stale);
        if (stale()) return;
        cache.set(modeKey, rates);
        requested.current.onFrameRates(rates);
        if (!rates.length) throw new Error(t("message.f47f39a15741"));
        const chosen = preferredCameraFrameRate(rates, fps);
        const actual = await configureCamera(track, mode, chosen);
        if (!stale()) { setSettings(actual); setError(''); }
      } catch (error) {
        if (!stale()) {
          logDiagnostic('ERROR', 'camera.configure', 'Camera mode configuration failed', { sourceId, resolution, fps, error });
          try { await recoverCamera(sourceId, stale); }
          catch (recoveryError) {
            logDiagnostic('ERROR', 'capture.preview', 'Camera recovery failed', { sourceId, error: recoveryError });
            await dispose();
            if (!stale()) { setStream(null); setError(t("message.80e583478ab0", { v0: localizeError(recoveryError) })); }
          }
        }
      }
      finally { if (!stale()) setBusy(false); }
    });
    return () => { cancelled = true; };
  }, [stream, sourceId, resolution.width, resolution.height, fps, dispose, recoverCamera]);

  const take = useCallback(async () => {
    await queue.current;
    const capture = active.current;
    const track = capture?.stream.getVideoTracks()[0];
    if (!capture || !track || track.readyState === 'ended') {
      throw new Error(t('capture.previewNoFrames'));
    }
    ++generation.current;
    active.current = null;
    setStream(null);
    return capture;
  }, []);
  const reportPlaybackError = useCallback(() => {
    const capture = active.current;
    const version = generation.current;
    const stale = () => generation.current !== version;
    if (!capture) return;
    logDiagnostic('ERROR', 'capture.preview', 'Preview player failed or received no decoded frame', {
      sourceId: capture.sourceId, sessionId: capture.bridge?.sessionId, settings: capture.stream.getVideoTracks()[0]?.getSettings(),
    });
    setBusy(true);
    queue.current = queue.current.catch(() => {}).then(async () => {
      if (stale() || active.current !== capture) return;
      try {
        if (!capture.bridge && !recoveredTracks.current.has(capture.stream.getVideoTracks()[0])) {
          await recoverCamera(capture.sourceId, stale);
        } else {
          await dispose();
          if (!stale()) { setStream(null); setError(t('capture.previewNoFrames')); }
        }
      } catch (err) {
        await dispose();
        if (!stale()) { setStream(null); setError(t('message.80e583478ab0', { v0: localizeError(err) })); }
      } finally { if (!stale()) setBusy(false); }
    });
  }, [dispose, recoverCamera]);
  const retry = useCallback(() => setAttempt((current) => current + 1), []);
  return { stream, settings, error, busy, take, retry, reportPlaybackError };
}
