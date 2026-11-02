import { boardLayerBounds, DEFAULT_BOARD_LAYER, shapeBounds, type BoardLayer, type BoardPoint, type BoardShape } from './whiteboard_scene.ts';

export const BOARD_WIDTH = 1920;
export const BOARD_HEIGHT = 1080;
export const BOARD_MIN_ZOOM = 0.08;
export const BOARD_MAX_ZOOM = 16;

export interface BoardViewport { x: number; y: number; zoom: number }
export interface BoardBox { x: number; y: number; width: number; height: number }
export type BoardResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export interface CanvasPreset {
  id: string;
  labelKey: string;
  width: number;
  height: number;
}

export const CANVAS_PRESETS: readonly CanvasPreset[] = [
  { id: '1920x1080', labelKey: 'whiteboard.presetFhd', width: 1920, height: 1080 },
  { id: '2560x1440', labelKey: 'whiteboard.presetQhd', width: 2560, height: 1440 },
  { id: '2048x2048', labelKey: 'whiteboard.presetSquare', width: 2048, height: 2048 },
  { id: '1500x2100', labelKey: 'whiteboard.presetPortrait', width: 1500, height: 2100 },
  { id: '1280x720', labelKey: 'whiteboard.presetHd', width: 1280, height: 720 },
];

export function clampBoardViewport(
  view: BoardViewport,
  width: number,
  height: number,
  boardWidth = BOARD_WIDTH,
  boardHeight = BOARD_HEIGHT,
): BoardViewport {
  const zoom = Math.max(BOARD_MIN_ZOOM, Math.min(BOARD_MAX_ZOOM, view.zoom));
  const axis = (position: number, size: number, board: number) => {
    const scaled = board * zoom;
    const minVisible = Math.min(80, Math.max(24, scaled * 0.25));
    const minPos = Math.min(size - scaled - 96, minVisible - scaled);
    const maxPos = Math.max(96, size - minVisible);
    return Math.max(minPos, Math.min(maxPos, position));
  };
  return { x: axis(view.x, width, boardWidth), y: axis(view.y, height, boardHeight), zoom };
}

export function boardContains(point: BoardPoint, boardWidth = BOARD_WIDTH, boardHeight = BOARD_HEIGHT): boolean {
  return point.x >= 0 && point.y >= 0 && point.x <= boardWidth && point.y <= boardHeight;
}

export function clampBoardPoint(point: BoardPoint, boardWidth = BOARD_WIDTH, boardHeight = BOARD_HEIGHT): BoardPoint {
  return {
    x: Math.max(0, Math.min(boardWidth, point.x)),
    y: Math.max(0, Math.min(boardHeight, point.y)),
    ...(point.p !== undefined ? { p: Math.max(0, Math.min(1, point.p)) } : {}),
  };
}

export function containBoardShape(shape: BoardShape, boardWidth = BOARD_WIDTH, boardHeight = BOARD_HEIGHT): BoardShape {
  const bounds = shapeBounds(shape);
  const x = Math.max(0, Math.min(boardWidth - bounds.width, bounds.x));
  const y = Math.max(0, Math.min(boardHeight - bounds.height, bounds.y));
  return { ...shape, x: shape.x + x - bounds.x, y: shape.y + y - bounds.y };
}

export function containBoardLayer(
  layer: BoardLayer,
  shapes: BoardShape[],
  boardWidth = BOARD_WIDTH,
  boardHeight = BOARD_HEIGHT,
): BoardLayer {
  const bounds = boardLayerBounds(shapes, layer);
  if (!bounds) return layer;
  return {
    ...layer,
    x: layer.x + Math.max(0, Math.min(boardWidth - bounds.width, bounds.x)) - bounds.x,
    y: layer.y + Math.max(0, Math.min(boardHeight - bounds.height, bounds.y)) - bounds.y,
  };
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

export function resizeBoardBounds(
  b: BoardBox,
  handle: BoardResizeHandle,
  point: BoardPoint,
  keepAspect = false,
  boardWidth = BOARD_WIDTH,
  boardHeight = BOARD_HEIGHT,
): BoardBox {
  const minSize = 8;
  let left = b.x, right = b.x + b.width, top = b.y, bottom = b.y + b.height;
  if (handle.includes('w')) left = Math.max(0, Math.min(right - minSize, point.x));
  if (handle.includes('e')) right = Math.min(boardWidth, Math.max(left + minSize, point.x));
  if (handle.includes('n')) top = Math.max(0, Math.min(bottom - minSize, point.y));
  if (handle.includes('s')) bottom = Math.min(boardHeight, Math.max(top + minSize, point.y));
  if (!keepAspect) return { x: left, y: top, width: right - left, height: bottom - top };
  const bw = Math.max(1, b.width), bh = Math.max(1, b.height);
  const minScale = Math.max(minSize / bw, minSize / bh);
  if (handle.length === 2) {
    const ax = handle.includes('w') ? b.x + b.width : b.x;
    const ay = handle.includes('n') ? b.y + b.height : b.y;
    const maxScaleX = (handle.includes('w') ? ax : boardWidth - ax) / bw;
    const maxScaleY = (handle.includes('n') ? ay : boardHeight - ay) / bh;
    const scale = Math.max(minScale, Math.min(maxScaleX, maxScaleY, Math.max((right - left) / bw, (bottom - top) / bh)));
    const width = bw * scale, height = bh * scale;
    return { x: handle.includes('w') ? ax - width : ax, y: handle.includes('n') ? ay - height : ay, width, height };
  }
  if (handle === 'e' || handle === 'w') {
    const ax = handle === 'w' ? b.x + b.width : b.x, cy = b.y + b.height / 2;
    const maxScaleX = (handle === 'w' ? ax : boardWidth - ax) / bw;
    const maxScaleY = (Math.min(cy, boardHeight - cy) * 2) / bh;
    const scale = Math.max(minScale, Math.min(maxScaleX, maxScaleY, (right - left) / bw));
    const width = bw * scale, height = bh * scale;
    return { x: handle === 'w' ? ax - width : ax, y: cy - height / 2, width, height };
  }
  const ay = handle === 'n' ? b.y + b.height : b.y, cx = b.x + b.width / 2;
  const maxScaleY = (handle === 'n' ? ay : boardHeight - ay) / bh;
  const maxScaleX = (Math.min(cx, boardWidth - cx) * 2) / bw;
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

export function flipBoardLayer(
  layer: BoardLayer,
  shapes: BoardShape[],
  axis: 'x' | 'y',
  boardWidth = BOARD_WIDTH,
  boardHeight = BOARD_HEIGHT,
): { layer: BoardLayer; shapes: BoardShape[] } {
  const bounds = boardLayerBounds(shapes, layer) ?? { x: 0, y: 0, width: boardWidth, height: boardHeight };
  const centerX = bounds.x + bounds.width / 2 - layer.x;
  const centerY = bounds.y + bounds.height / 2 - layer.y;
  const nextLayer: BoardLayer = {
    ...layer,
    ...(axis === 'x' ? { flipX: !layer.flipX } : { flipY: !layer.flipY }),
  };
  const nextShapes = shapes
    .filter(s => (s.layerId ?? DEFAULT_BOARD_LAYER) === layer.id)
    .map(s => {
      const sx = s.scaleX ?? 1, sy = s.scaleY ?? 1;
      const flippedPoints = s.points.map(p => ({
        ...p,
        x: axis === 'x' ? Math.round((2 * (centerX - s.x) / sx - p.x) * 100) / 100 : p.x,
        y: axis === 'y' ? Math.round((2 * (centerY - s.y) / sy - p.y) * 100) / 100 : p.y,
      }));
      return {
        ...s,
        points: flippedPoints,
        ...(s.tool === 'image' ? (axis === 'x' ? { flipX: !s.flipX } : { flipY: !s.flipY }) : {}),
      };
    });
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
