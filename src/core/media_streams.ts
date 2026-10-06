import { getLanguage } from '../i18n/index.ts';
import type { RoomSlotInfo } from './types.ts';
export type MediaKind = 'screen' | 'camera';
export const MAX_MEDIA_FPS = 120;
const frameRateFormatters = new Map<string, Intl.NumberFormat>();
function frameRateFormatter() {
  const language = getLanguage();
  if (!frameRateFormatters.has(language)) frameRateFormatters.set(language, new Intl.NumberFormat(language, { maximumFractionDigits: 2, useGrouping: false }));
  return frameRateFormatters.get(language)!;
}

/** Hide device floating-point noise without changing capture constraints. */
export function formatFrameRate(fps: number): string {
  return Number.isFinite(fps) ? frameRateFormatter().format(fps) : '0';
}

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
    Number.isFinite(s.fps) && s.fps >= 1 && s.fps <= MAX_MEDIA_FPS &&
    Number.isFinite(s.bitrate) && s.bitrate >= 100 && s.bitrate <= 50000);
}

export function streamOwner(key: string): string {
  return key.split('/')[0];
}

export function streamSlotKey(owner: string, id: string, _primary = false): string {
  return `${owner}/${id}`;
}

export function reconcilePinnedRoomSlot(
  pinnedId: string | null,
  previousSlots: RoomSlotInfo[],
  slots: RoomSlotInfo[],
): string | null {
  if (!pinnedId || slots.some((slot) => slot.peerId === pinnedId)) return pinnedId;
  const previous = previousSlots.find((slot) => slot.peerId === pinnedId);
  if (!previous) return pinnedId;
  const owner = previous.ownerPeerId || previous.peerId;
  const replacements = slots.filter((slot) => (slot.ownerPeerId || slot.peerId) === owner);
  return (replacements.find((slot) => slot.mediaKind === 'screen') || replacements[0])?.peerId || null;
}

export interface OverlayPosition { x: number; y: number; width: number }

export interface OverlayInset { x: number; y: number }
const overlayInset: OverlayInset = { x: 0.02, y: 0.02 };
export type OverlayCorner = 'nw' | 'ne' | 'sw' | 'se';

export function clampOverlay(position: OverlayPosition, aspect = 16 / 9, stageAspect = 16 / 9, inset = overlayInset): OverlayPosition {
  const maxWidth = Math.min(0.6, 0.85 * aspect / stageAspect);
  const width = Math.max(Math.min(0.14, maxWidth), Math.min(maxWidth, position.width));
  const height = width * stageAspect / aspect;
  return { width, x: Math.max(inset.x, Math.min(1 - width - inset.x, position.x)), y: Math.max(inset.y, Math.min(1 - height - inset.y, position.y)) };
}

export function resizeOverlay(position: OverlayPosition, corner: OverlayCorner, dx: number, dy: number,
  aspect: number, stageAspect: number, inset = overlayInset): OverlayPosition {
  const left = corner.endsWith('w'), top = corner.startsWith('n');
  const ratio = stageAspect / aspect;
  const horizontal = dx * (left ? -1 : 1), vertical = dy / ratio * (top ? -1 : 1);
  const delta = Math.abs(horizontal) >= Math.abs(vertical) ? horizontal : vertical;
  const anchorX = position.x + (left ? position.width : 0);
  const anchorY = position.y + (top ? position.width * ratio : 0);
  const available = Math.min(left ? anchorX - inset.x : 1 - inset.x - anchorX,
    (top ? anchorY - inset.y : 1 - inset.y - anchorY) / ratio);
  const width = Math.min(available, clampOverlay({ ...position, width: position.width + delta }, aspect, stageAspect, inset).width);
  return { width, x: left ? anchorX - width : anchorX, y: top ? anchorY - width * ratio : anchorY };
}

export function snapOverlay(position: OverlayPosition, aspect = 16 / 9, stageAspect = 16 / 9, inset = overlayInset): OverlayPosition {
  const { x, y, width } = clampOverlay(position, aspect, stageAspect, inset);
  const height = width * stageAspect / aspect;
  const maxX = 1 - width - inset.x;
  const maxY = 1 - height - inset.y;
  const midX = (1 - width) / 2, midY = (1 - height) / 2;
  const anchors = [[inset.x, inset.y], [midX, inset.y], [maxX, inset.y], [inset.x, midY], [maxX, midY],
    [inset.x, maxY], [midX, maxY], [maxX, maxY]];
  const nearest = anchors.reduce((best, anchor) => Math.hypot(anchor[0] - x, anchor[1] - y) <
    Math.hypot(best[0] - x, best[1] - y) ? anchor : best);
  return Math.hypot(nearest[0] - x, nearest[1] - y) < 0.12 ? { x: nearest[0], y: nearest[1], width } : { x, y, width };
}
