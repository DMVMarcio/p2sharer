import { boardLayerBounds, shapeBounds, type BoardLayer, type BoardPoint, type BoardShape } from './whiteboard_scene.ts';

export const BOARD_WIDTH = 16_000;
export const BOARD_HEIGHT = 10_000;
export const BOARD_MIN_ZOOM = .025;
export const BOARD_MAX_ZOOM = 4;
export interface BoardViewport { x: number; y: number; zoom: number }
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
  return { x: Math.max(0, Math.min(BOARD_WIDTH, point.x)), y: Math.max(0, Math.min(BOARD_HEIGHT, point.y)) };
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
export class BrushStabilizer {
  private point: BoardPoint;
  private time: number;
  constructor(start: BoardPoint, time: number) { this.point = start; this.time = time; }
  sample(target: BoardPoint, time: number, strength: number): BoardPoint {
    const delta = Math.max(1, Math.min(64, time - this.time)); this.time = time;
    const alpha = strength <= 0 ? 1 : 1 - Math.exp(-delta / (strength * 1.2));
    this.point = { x: this.point.x + (target.x - this.point.x) * alpha, y: this.point.y + (target.y - this.point.y) * alpha };
    return this.point;
  }
}
