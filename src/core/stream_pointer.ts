export type StreamPointerPacket = { kind: 'move' | 'ping'; x: number; y: number } | { kind: 'leave' };
export const STREAM_POINTER_PING_MS = 1000;
export interface StreamPointerVisual { id: string; peerId: string; name: string; color: string; x: number; y: number; expires: number; ping: boolean }
export interface StreamPointerState { kind: 'state'; sentAt: number; visuals: StreamPointerVisual[] }

export function validStreamPointerState(value: unknown): value is StreamPointerState {
  if (!value || typeof value !== 'object') return false;
  const state = value as StreamPointerState;
  return state.kind === 'state' && Number.isFinite(state.sentAt) && Array.isArray(state.visuals) &&
    state.visuals.length <= 256 && state.visuals.every((v) => v &&
      typeof v.id === 'string' && v.id.length <= 160 && typeof v.peerId === 'string' && v.peerId.length <= 128 &&
      typeof v.name === 'string' && v.name.length <= 80 && typeof v.color === 'string' && v.color.length <= 80 &&
      typeof v.ping === 'boolean' && Number.isFinite(v.expires) && v.expires > state.sentAt &&
      v.expires <= state.sentAt + 3500 && validStreamPointer({ kind: 'move', x: v.x, y: v.y }));
}

// Use the sender's remaining lifetime, never assume synchronized wall clocks.
export function localStreamPointerVisuals(state: StreamPointerState, now = Date.now()): StreamPointerVisual[] {
  return state.visuals.map((visual) => ({ ...visual, expires: now + visual.expires - state.sentAt }));
}

export function streamPointerVideoRect(rect: { left: number; top: number; width: number; height: number },
  videoWidth: number, videoHeight: number) {
  if (videoWidth <= 0 || videoHeight <= 0 || rect.width <= 0 || rect.height <= 0) return null;
  const scale = Math.min(rect.width / videoWidth, rect.height / videoHeight);
  const width = videoWidth * scale, height = videoHeight * scale;
  return { left: rect.left + (rect.width - width) / 2, top: rect.top + (rect.height - height) / 2, width, height };
}

export function validStreamPointer(value: unknown): value is StreamPointerPacket {
  if (!value || typeof value !== 'object') return false;
  const p = value as Record<string, unknown>;
  return p.kind === 'leave' || ((p.kind === 'move' || p.kind === 'ping') &&
    typeof p.x === 'number' && Number.isFinite(p.x) && p.x >= 0 && p.x <= 1 &&
    typeof p.y === 'number' && Number.isFinite(p.y) && p.y >= 0 && p.y <= 1);
}

// The element rectangle already includes CSS zoom and pan. Exclude contain letterboxing.
export function streamPointerPosition(rect: { left: number; top: number; width: number; height: number },
  videoWidth: number, videoHeight: number, clientX: number, clientY: number) {
  const image = streamPointerVideoRect(rect, videoWidth, videoHeight);
  if (!image) return null;
  const x = (clientX - image.left) / image.width;
  const y = (clientY - image.top) / image.height;
  return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null;
}
