import { boardLayerBounds, DEFAULT_BOARD_LAYER, shapeBounds, type BoardLayer, type BoardPoint, type BoardShape } from './whiteboard_scene.ts';

export const BOARD_WIDTH = 16_000;
export const BOARD_HEIGHT = 10_000;
export const BOARD_MIN_ZOOM = .025;
export const BOARD_MAX_ZOOM = 4;
export interface BoardViewport { x: number; y: number; zoom: number }
export interface BoardBox { x: number; y: number; width: number; height: number }
export type BoardResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export function clampBoardViewport(view: BoardViewport, width: number, height: number): BoardViewport {
  const zoom = Math.max(BOARD_MIN_ZOOM, Math.min(BOARD_MAX_ZOOM, view.zoom));
  const axis = (position: number, size: number, board: number) => board * zoom + 192 <= size
    ? (size - board * zoom) / 2 : Math.max(size - board * zoom - 96, Math.min(96, position));
  return { x: axis(view.x, width, BOARD_WIDTH), y: axis(view.y, height, BOARD_HEIGHT), zoom };
}
export function boardContains(point: BoardPoint): boolean {
  return point.x >= 0 && point.y >= 0 && point.x <= BOARD_WIDTH && point.y <= BOARD_HEIGHT;
}
export function clampBoardPoint(point: BoardPoint): BoardPoint {
  return {
    x: Math.max(0, Math.min(BOARD_WIDTH, point.x)),
    y: Math.max(0, Math.min(BOARD_HEIGHT, point.y)),
    ...(point.p !== undefined ? { p: Math.max(0, Math.min(1, point.p)) } : {}),
  };
}
export function containBoardShape(shape: BoardShape): BoardShape {
  const bounds = shapeBounds(shape);
  const x = Math.max(0, Math.min(BOARD_WIDTH - bounds.width, bounds.x));
  const y = Math.max(0, Math.min(BOARD_HEIGHT - bounds.height, bounds.y));
  return { ...shape, x: shape.x + x - bounds.x, y: shape.y + y - bounds.y };
}
export function containBoardLayer(layer: BoardLayer, shapes: BoardShape[]): BoardLayer {
  const bounds = boardLayerBounds(shapes, layer);
  if (!bounds) return layer;
  return { ...layer, x: layer.x + Math.max(0, Math.min(BOARD_WIDTH - bounds.width, bounds.x)) - bounds.x,
    y: layer.y + Math.max(0, Math.min(BOARD_HEIGHT - bounds.height, bounds.y)) - bounds.y };
}
export function boardResizeHandles(b: BoardBox): Array<{ handle: BoardResizeHandle; x: number; y: number }> {
  const mx = b.x + b.width / 2, my = b.y + b.height / 2, rx = b.x + b.width, by = b.y + b.height;
  return [
    { handle: 'nw', x: b.x, y: b.y }, { handle: 'n', x: mx, y: b.y }, { handle: 'ne', x: rx, y: b.y },
    { handle: 'e', x: rx, y: my }, { handle: 'se', x: rx, y: by }, { handle: 's', x: mx, y: by },
    { handle: 'sw', x: b.x, y: by }, { handle: 'w', x: b.x, y: my },
  ];
}
export function hitBoardResizeHandle(b: BoardBox, point: BoardPoint, radius: number): BoardResizeHandle | null {
  for (const item of boardResizeHandles(b)) {
    if (Math.hypot(point.x - item.x, point.y - item.y) <= radius) return item.handle;
  }
  return null;
}
export function resizeBoardBounds(b: BoardBox, handle: BoardResizeHandle, point: BoardPoint, keepAspect = false): BoardBox {
  const minSize = 16;
  let left = b.x, right = b.x + b.width, top = b.y, bottom = b.y + b.height;
  if (handle.includes('w')) left = Math.max(0, Math.min(right - minSize, point.x));
  if (handle.includes('e')) right = Math.min(BOARD_WIDTH, Math.max(left + minSize, point.x));
  if (handle.includes('n')) top = Math.max(0, Math.min(bottom - minSize, point.y));
  if (handle.includes('s')) bottom = Math.min(BOARD_HEIGHT, Math.max(top + minSize, point.y));
  if (!keepAspect) return { x: left, y: top, width: right - left, height: bottom - top };
  const bw = Math.max(1, b.width), bh = Math.max(1, b.height);
  const minScale = Math.max(minSize / bw, minSize / bh);
  if (handle.length === 2) {
    const ax = handle.includes('w') ? b.x + b.width : b.x;
    const ay = handle.includes('n') ? b.y + b.height : b.y;
    const maxScaleX = (handle.includes('w') ? ax : BOARD_WIDTH - ax) / bw;
    const maxScaleY = (handle.includes('n') ? ay : BOARD_HEIGHT - ay) / bh;
    const scale = Math.max(minScale, Math.min(maxScaleX, maxScaleY, Math.max((right - left) / bw, (bottom - top) / bh)));
    const width = bw * scale, height = bh * scale;
    return { x: handle.includes('w') ? ax - width : ax, y: handle.includes('n') ? ay - height : ay, width, height };
  }
  if (handle === 'e' || handle === 'w') {
    const ax = handle === 'w' ? b.x + b.width : b.x, cy = b.y + b.height / 2;
    const maxScaleX = (handle === 'w' ? ax : BOARD_WIDTH - ax) / bw;
    const maxScaleY = (Math.min(cy, BOARD_HEIGHT - cy) * 2) / bh;
    const scale = Math.max(minScale, Math.min(maxScaleX, maxScaleY, (right - left) / bw));
    const width = bw * scale, height = bh * scale;
    return { x: handle === 'w' ? ax - width : ax, y: cy - height / 2, width, height };
  }
  const ay = handle === 'n' ? b.y + b.height : b.y, cx = b.x + b.width / 2;
  const maxScaleY = (handle === 'n' ? ay : BOARD_HEIGHT - ay) / bh;
  const maxScaleX = (Math.min(cx, BOARD_WIDTH - cx) * 2) / bw;
  const scale = Math.max(minScale, Math.min(maxScaleX, maxScaleY, (bottom - top) / bh));
  const width = bw * scale, height = bh * scale;
  return { x: cx - width / 2, y: handle === 'n' ? ay - height : ay, width, height };
}
export function scaleBoardLayer(layer: BoardLayer, shapes: BoardShape[], from: BoardBox, to: BoardBox): { layer: BoardLayer; shapes: BoardShape[] } {
  const fx = Math.max(0.01, Math.min(200, to.width / Math.max(1, from.width)));
  const fy = Math.max(0.01, Math.min(200, to.height / Math.max(1, from.height)));
  const localX = from.x - layer.x, localY = from.y - layer.y;
  const nextLayer: BoardLayer = {
    ...layer,
    x: Math.round((to.x - localX * fx) * 100) / 100,
    y: Math.round((to.y - localY * fy) * 100) / 100,
  };
  const nextShapes = shapes
    .filter(s => (s.layerId ?? DEFAULT_BOARD_LAYER) === layer.id)
    .map(s => ({
      ...s,
      x: Math.round(s.x * fx * 100) / 100,
      y: Math.round(s.y * fy * 100) / 100,
      scaleX: Math.round(Math.max(0.001, Math.min(1000, (s.scaleX ?? 1) * fx)) * 10000) / 10000,
      scaleY: Math.round(Math.max(0.001, Math.min(1000, (s.scaleY ?? 1) * fy)) * 10000) / 10000,
    }));
  return { layer: nextLayer, shapes: nextShapes };
}
export class BrushStabilizer {
  private point: BoardPoint;
  private time: number;
  constructor(start: BoardPoint, time: number) { this.point = start; this.time = time; }
  sample(target: BoardPoint, time: number, strength: number): BoardPoint {
    const delta = Math.max(1, Math.min(64, time - this.time)); this.time = time;
    const alpha = strength <= 0 ? 1 : 1 - Math.exp(-delta / (strength * 1.2));
    const p = target.p !== undefined
      ? Math.round(((this.point.p ?? target.p) + (target.p - (this.point.p ?? target.p)) * alpha) * 1000) / 1000
      : undefined;
    this.point = {
      x: this.point.x + (target.x - this.point.x) * alpha,
      y: this.point.y + (target.y - this.point.y) * alpha,
      ...(p !== undefined ? { p } : {}),
    };
    return this.point;
  }
}
