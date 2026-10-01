import { MAX_MEDIA_FPS } from '../core/media_streams.ts';

export interface CameraResolution { value: string; label: string; width: number; height: number }

/** Chromium hides device identities until a camera has been granted by the native host. */
export async function listCameras(): Promise<MediaDeviceInfo[]> {
  const media = navigator.mediaDevices;
  if (!media) return [];
  let devices = (await media.enumerateDevices()).filter((device) => device.kind === 'videoinput');
  if (devices.length && devices.some((device) => !device.deviceId || !device.label)) {
    const consent = await media.getUserMedia({ video: true, audio: false });
    try { devices = (await media.enumerateDevices()).filter((device) => device.kind === 'videoinput'); }
    finally { consent.getTracks().forEach((track) => track.stop()); }
  }
  return devices;
}

export const cameraResolution = (width: number, height: number): CameraResolution => ({
  value: `${width}x${height}`, label: `${width} × ${height}`, width, height,
});

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
  const result: CameraResolution[] = [];
  for (const [width, height] of candidates) {
    if (cancelled()) break;
    if (!within(width, caps.width) || !within(height, caps.height) || result.some((mode) => mode.width === width && mode.height === height)) continue;
    try {
      await track.applyConstraints(constraints(width, height));
      const actual = track.getSettings();
      if (actual.width === width && actual.height === height) result.push(cameraResolution(width, height));
    } catch { /* Unsupported pairs are omitted, without preventing preview. */ }
  }
  return result.sort((a, b) => b.width * b.height - a.width * a.height);
}

export async function cameraFrameRates(track: MediaStreamTrack, mode: CameraResolution, cancelled: () => boolean): Promise<number[]> {
  const caps = track.getCapabilities?.() || {};
  const current = track.getSettings().frameRate;
  const candidates = [...new Set([120, 60, 30, 24, 15, ...(current ? [current] : []), ...(caps.frameRate?.max ? [caps.frameRate.max] : [])])]
    .filter((fps) => fps >= 1 && fps <= MAX_MEDIA_FPS && within(fps, caps.frameRate)).sort((a, b) => b - a);
  const result: number[] = [];
  for (const fps of candidates) {
    if (cancelled()) break;
    try {
      await track.applyConstraints(constraints(mode.width, mode.height, fps));
      const actual = track.getSettings();
      if (actual.width === mode.width && actual.height === mode.height && Math.abs((actual.frameRate || 0) - fps) < 0.1) result.push(fps);
    } catch { /* Probe the selected resolution, not a different camera mode. */ }
  }
  return result;
}

export async function configureCamera(track: MediaStreamTrack, mode: CameraResolution, fps: number) {
  await track.applyConstraints(constraints(mode.width, mode.height, fps));
  return track.getSettings();
}
