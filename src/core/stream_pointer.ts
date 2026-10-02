export const STREAM_DRAWING_MAX = 1280;
export const STREAM_POINTER_MAX_VISUALS = STREAM_DRAWING_MAX + 256;
export function streamDrawingLimit(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(1, Math.min(STREAM_DRAWING_MAX, Math.round(value))) : STREAM_DRAWING_MAX;
}
export function streamDrawingPointLimit(limit: number): number { return streamDrawingLimit(limit) * 128; }
export interface StreamDrawingHistoryState { peerId: string; undo: number; redo: number }
export type DrawingTool = 'brush' | 'rectangle' | 'ellipse' | 'text';
export interface StreamDrawing { tool: DrawingTool; color: string; size: number; points: { x: number; y: number }[]; text?: string }
export function validStreamDrawing(value: unknown): value is StreamDrawing {
  if (!value || typeof value !== 'object') return false;
  const d = value as StreamDrawing;
  return ['brush', 'rectangle', 'ellipse', 'text'].includes(d.tool) && typeof d.color === 'string' && /^#[0-9a-f]{6}$/i.test(d.color) &&
    Number.isInteger(d.size) && d.size >= 0 && d.size <= 10 && Array.isArray(d.points) && d.points.length >= 1 && d.points.length <= 128 &&
    d.points.every(p => p && Number.isFinite(p.x) && p.x >= 0 && p.x <= 1 && Number.isFinite(p.y) && p.y >= 0 && p.y <= 1) &&
    (d.text === undefined || typeof d.text === 'string' && d.text.length <= 160) &&
    (d.tool !== 'text' || typeof d.text === 'string' && d.text.trim().length > 0 && d.text.length <= 160);
}
export type StreamPointerPacket = ({ kind: 'move' | 'ping'; x: number; y: number } | { kind: 'sync' } | { kind: 'leave' } | { kind: 'clear' } | { kind: 'undo' } | { kind: 'redo' } | { kind: 'draw'; id: string; drawing: StreamDrawing }) & { mediaId?: string };
export const STREAM_POINTER_PING_MS = 1000;
export interface StreamPointerVisual { id: string; peerId: string; name: string; color: string; x: number; y: number; expires: number; ping: boolean; drawing?: StreamDrawing }
export interface StreamPointerState { kind: 'state'; sentAt: number; visuals: StreamPointerVisual[]; mediaId?: string; drawingAllowed?: boolean; history?: StreamDrawingHistoryState[]; drawingsIncluded?: boolean }

function validPointerMediaId(value: unknown): boolean {
  return value === undefined || typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
}

export function validStreamPointerState(value: unknown): value is StreamPointerState {
  if (!value || typeof value !== 'object') return false;
  const state = value as StreamPointerState;
  return validPointerMediaId(state.mediaId) && (state.drawingAllowed === undefined || typeof state.drawingAllowed === 'boolean') && (state.drawingsIncluded === undefined || typeof state.drawingsIncluded === 'boolean') &&
    (state.history === undefined || Array.isArray(state.history) && state.history.length <= 256 && state.history.every(h => h && typeof h.peerId === 'string' && h.peerId.length <= 128 && Number.isInteger(h.undo) && h.undo >= 0 && h.undo <= STREAM_DRAWING_MAX && Number.isInteger(h.redo) && h.redo >= 0 && h.redo <= STREAM_DRAWING_MAX)) &&
    state.kind === 'state' && Number.isFinite(state.sentAt) && Array.isArray(state.visuals) &&
    state.visuals.length <= STREAM_POINTER_MAX_VISUALS && (state.drawingsIncluded !== false || state.visuals.every(v => v && !v.drawing)) && state.visuals.filter(v => v?.drawing).length <= STREAM_DRAWING_MAX && state.visuals.filter(v => v && !v.drawing).length <= 256 &&
    state.visuals.reduce((count, v) => count + (Array.isArray(v?.drawing?.points) ? v.drawing.points.length : 0), 0) <= streamDrawingPointLimit(STREAM_DRAWING_MAX) && state.visuals.every((v) => v &&
      typeof v.id === 'string' && v.id.length <= 160 && typeof v.peerId === 'string' && v.peerId.length <= 128 &&
      typeof v.name === 'string' && v.name.length <= 80 && typeof v.color === 'string' && v.color.length <= 80 &&
      (v.drawing === undefined || validStreamDrawing(v.drawing)) && typeof v.ping === 'boolean' && Number.isFinite(v.expires) && v.expires > state.sentAt &&
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
  return validPointerMediaId(p.mediaId) && (p.kind === 'sync' || p.kind === 'leave' || p.kind === 'clear' || p.kind === 'undo' || p.kind === 'redo' || (p.kind === 'draw' && typeof p.id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(p.id) && validStreamDrawing(p.drawing)) || ((p.kind === 'move' || p.kind === 'ping') &&
    typeof p.x === 'number' && Number.isFinite(p.x) && p.x >= 0 && p.x <= 1 &&
    typeof p.y === 'number' && Number.isFinite(p.y) && p.y >= 0 && p.y <= 1));
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
