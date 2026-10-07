import { MAX_MEDIA_FPS, formatFrameRate } from '../core/media_streams.ts';
import { t } from '../i18n/index.ts';

export interface CameraResolution { value: string; label: string; width: number; height: number }

async function cameraDeadline<T>(operation: Promise<T>, onTimeout: () => void, duration = 4000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        onTimeout();
        reject(new DOMException(t('capture.cameraTimeout'), 'TimeoutError'));
      }, duration);
    })]);
  } finally { clearTimeout(timer); }
}

/** A late device response must not retain a camera after its caller has given up. */
export async function acquireCamera(constraints: MediaStreamConstraints): Promise<MediaStream> {
  let expired = false;
  const opening = navigator.mediaDevices.getUserMedia(constraints).then((stream) => {
    if (expired) stream.getTracks().forEach((track) => track.stop());
    return stream;
  });
  return cameraDeadline(opening, () => { expired = true; }, 12000);
}

function applyCameraConstraints(track: MediaStreamTrack, options: MediaTrackConstraints) {
  return cameraDeadline(track.applyConstraints(options), () => track.stop());
}

/** Chromium hides device identities until a camera has been granted by the native host. */
export async function listCameras(): Promise<MediaDeviceInfo[]> {
  const media = navigator.mediaDevices;
  if (!media) return [];
  let devices = (await media.enumerateDevices()).filter((device) => device.kind === 'videoinput');
  if (devices.length && devices.some((device) => !device.deviceId || !device.label)) {
    const consent = await acquireCamera({ video: true, audio: false });
    try { devices = (await media.enumerateDevices()).filter((device) => device.kind === 'videoinput'); }
    finally { consent.getTracks().forEach((track) => track.stop()); }
  }
  return devices;
}

export const cameraResolution = (width: number, height: number): CameraResolution => ({
  value: `${width}x${height}`, label: `${width} × ${height}`, width, height,
});

/** Match nominal preferences to the verified device rate behind their displayed label. */
export function preferredCameraFrameRate(rates: number[], preferred: number): number {
  return rates.find((rate) => formatFrameRate(rate) === formatFrameRate(preferred)) ||
    rates.find((rate) => rate <= preferred) || rates[rates.length - 1] || preferred;
}

function within(value: number, range?: { min?: number; max?: number }) {
  return !range || (value >= (range.min ?? 0) && value <= (range.max ?? Infinity));
}

function constraints(width: number, height: number, fps?: number): MediaTrackConstraints {
  return { width: { exact: width }, height: { exact: height },
    ...((navigator.mediaDevices.getSupportedConstraints() as MediaTrackSupportedConstraints & { resizeMode?: boolean }).resizeMode ? { resizeMode: 'none' } : {}),
    ...(fps ? { frameRate: { exact: fps } } : {}) };
}

/** Validate combinations: capability ranges alone do not guarantee a usable camera mode. */
export async function cameraResolutions(track: MediaStreamTrack, cancelled: () => boolean): Promise<CameraResolution[]> {
  const caps = track.getCapabilities?.() || {};
  const settings = track.getSettings();
  const candidates = [[3840, 2160], [2560, 1440], [1920, 1080], [1280, 720],
    [1024, 768], [800, 600], [640, 480], [640, 360], [320, 240],
    [settings.width || 640, settings.height || 480]];
  const result: CameraResolution[] = settings.width && settings.height ? [cameraResolution(settings.width, settings.height)] : [];
  for (const [width, height] of candidates) {
    if (cancelled()) break;
    if (!within(width, caps.width) || !within(height, caps.height) || result.some((mode) => mode.width === width && mode.height === height)) continue;
    try {
      await applyCameraConstraints(track, constraints(width, height));
      const actual = track.getSettings();
      if (actual.width === width && actual.height === height) result.push(cameraResolution(width, height));
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') throw error;
      /* Unsupported pairs are omitted, without preventing preview. */
    }
  }
  if (!cancelled() && settings.width && settings.height) {
    await configureCamera(track, cameraResolution(settings.width, settings.height), settings.frameRate || 30);
  }
  return result.sort((a, b) => b.width * b.height - a.width * a.height);
}

export async function cameraFrameRates(track: MediaStreamTrack, mode: CameraResolution, cancelled: () => boolean): Promise<number[]> {
  const caps = track.getCapabilities?.() || {};
  const current = track.getSettings().frameRate;
  const candidates = [...new Set([120, 60, 30, 24, 15, ...(current ? [current] : []), ...(caps.frameRate?.max ? [caps.frameRate.max] : [])])]
    .filter((fps) => fps >= 1 && fps <= MAX_MEDIA_FPS && within(fps, caps.frameRate)).sort((a, b) => b - a);
  const settings = track.getSettings();
  const result: number[] = settings.width === mode.width && settings.height === mode.height && current &&
    current >= 1 && current <= MAX_MEDIA_FPS ? [current] : [];
  for (const fps of candidates) {
    if (cancelled()) break;
    try {
      await applyCameraConstraints(track, constraints(mode.width, mode.height, fps));
      const actual = track.getSettings();
      if (actual.width === mode.width && actual.height === mode.height && Math.abs((actual.frameRate || 0) - fps) < 0.1 &&
        !result.some((rate) => formatFrameRate(rate) === formatFrameRate(fps))) result.push(fps);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') throw error;
      /* Probe the selected resolution, not a different camera mode. */
    }
  }
  return result.sort((a, b) => b - a);
}

export async function configureCamera(track: MediaStreamTrack, mode: CameraResolution, fps: number) {
  await applyCameraConstraints(track, constraints(mode.width, mode.height, fps));
  return track.getSettings();
}
