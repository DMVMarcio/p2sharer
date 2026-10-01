export type MediaKind = 'screen' | 'camera';

export interface StreamDescriptor {
  id: string;
  kind: MediaKind;
  label: string;
  videoTrackId: string;
  fps: number;
  bitrate: number;
}

export function validStreamDescriptors(value: unknown): value is StreamDescriptor[] {
  return Array.isArray(value) && value.length <= 16 && new Set(value.map((s) => s?.id)).size === value.length && value.every((s) =>
    s && typeof s.id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(s.id) &&
    (s.kind === 'screen' || s.kind === 'camera') && typeof s.label === 'string' && s.label.length <= 200 &&
    typeof s.videoTrackId === 'string' && s.videoTrackId.length <= 100 &&
    Number.isFinite(s.fps) && s.fps >= 1 && s.fps <= 120 &&
    Number.isFinite(s.bitrate) && s.bitrate >= 100 && s.bitrate <= 50000);
}

export function streamOwner(key: string): string {
  return key.split('/')[0];
}

export function streamSlotKey(owner: string, id: string, _primary = false): string {
  return `${owner}/${id}`;
}

export interface OverlayPosition { x: number; y: number; width: number }

export function clampOverlay(position: OverlayPosition, aspect = 16 / 9, stageAspect = 16 / 9): OverlayPosition {
  const maxWidth = Math.min(0.6, 0.85 * aspect / stageAspect);
  const width = Math.max(Math.min(0.14, maxWidth), Math.min(maxWidth, position.width));
  const height = width * stageAspect / aspect;
  return { width, x: Math.max(0, Math.min(1 - width, position.x)), y: Math.max(0, Math.min(1 - height, position.y)) };
}

export function snapOverlay(position: OverlayPosition, aspect = 16 / 9, stageAspect = 16 / 9): OverlayPosition {
  const { x, y, width } = clampOverlay(position, aspect, stageAspect);
  const height = width * stageAspect / aspect;
  const maxX = 1 - width;
  const maxY = 1 - height;
  const anchors = [[0, 0], [maxX / 2, 0], [maxX, 0], [0, maxY / 2], [maxX, maxY / 2],
    [0, maxY], [maxX / 2, maxY], [maxX, maxY]];
  const nearest = anchors.reduce((best, anchor) => Math.hypot(anchor[0] - x, anchor[1] - y) <
    Math.hypot(best[0] - x, best[1] - y) ? anchor : best);
  return Math.hypot(nearest[0] - x, nearest[1] - y) < 0.12 ? { x: nearest[0], y: nearest[1], width } : { x, y, width };
}
