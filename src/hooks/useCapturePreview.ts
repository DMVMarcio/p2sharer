import { localizeError, t } from '../i18n/index.ts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { NativeVideoBridge } from '../video/native_video_bridge';
import { cameraFrameRates, cameraResolutions, configureCamera, preferredCameraFrameRate, type CameraResolution } from '../video/camera_devices';

export interface PreparedCapture { sourceId: string; stream: MediaStream; bridge?: NativeVideoBridge }

export function useCapturePreview(sourceId: string, resolution: { width: number; height: number }, fps: number,
  mouse: boolean, quality: number, disabled: boolean, onModes: (modes: CameraResolution[]) => void,
  onFrameRates: (rates: number[]) => void) {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [settings, setSettings] = useState<MediaTrackSettings>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const active = useRef<PreparedCapture | null>(null);
  const generation = useRef(0);
  const queue = useRef(Promise.resolve());
  const requested = useRef({ resolution, fps, mouse, quality, onModes, onFrameRates });
  const screenConfig = sourceId.startsWith('camera:') ? '' : `${resolution.width}/${resolution.height}/${fps}/${mouse}/${quality}`;
  requested.current = { resolution, fps, mouse, quality, onModes, onFrameRates };
  const dispose = useCallback(async () => {
    const capture = active.current;
    active.current = null;
    if (capture?.bridge) await capture.bridge.stopCapture();
    else capture?.stream.getTracks().forEach((track) => track.stop());
  }, []);

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
          : await navigator.mediaDevices.getUserMedia({ audio: false, video: {
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
        if (bridge) await bridge.stopCapture();
        if (!cancelled()) setError(t("message.80e583478ab0", { v0: localizeError(err) }));
      } finally { if (!cancelled()) setBusy(false); }
    });
    return () => {
      ++generation.current;
      queue.current = queue.current.catch(() => {}).then(dispose);
    };
  }, [sourceId, disabled, screenConfig, dispose]);

  useEffect(() => {
    if (!stream || !sourceId.startsWith('camera:')) return;
    const version = generation.current;
    let cancelled = false;
    const stale = () => cancelled || version !== generation.current;
    setBusy(true);
    queue.current = queue.current.catch(() => {}).then(async () => {
      if (stale()) return;
      const track = stream.getVideoTracks()[0];
      const mode = { ...resolution, value: '', label: '' };
      try {
        const rates = await cameraFrameRates(track, mode, stale);
        if (stale()) return;
        requested.current.onFrameRates(rates);
        if (!rates.length) throw new Error(t("message.f47f39a15741"));
        const chosen = preferredCameraFrameRate(rates, fps);
        const actual = await configureCamera(track, mode, chosen);
        if (!stale()) { setSettings(actual); setError(''); }
      } catch (err) { if (!stale()) setError(t("message.80e583478ab0", { v0: localizeError(err) })); }
      finally { if (!stale()) setBusy(false); }
    });
    return () => { cancelled = true; };
  }, [stream, sourceId, resolution.width, resolution.height, fps]);

  const take = useCallback(async () => {
    await queue.current;
    ++generation.current;
    const capture = active.current;
    active.current = null;
    setStream(null);
    return capture || undefined;
  }, []);
  return { stream, settings, error, busy, take };
}
