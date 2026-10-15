export type BoardTool = 'pointer' | 'brush' | 'eraser' | 'rectangle' | 'ellipse' | 'line';
export const DEFAULT_BOARD_LAYER = '00000000-0000-4000-8000-000000000001';
export interface BoardLayer { id: string; name: string; order: number; hidden: boolean; locked: boolean; x: number; y: number; deleted?: boolean }
export const defaultBoardLayer = (): BoardLayer => ({ id: DEFAULT_BOARD_LAYER, name: '', order: 0, hidden: false, locked: false, x: 0, y: 0 });
export interface BoardPoint { x: number; y: number }
export interface BoardShape {
  id: string; tool: Exclude<BoardTool, 'pointer'>; points: BoardPoint[];
  color: string; width: number; filled: boolean; x: number; y: number;
  order: number; hidden: boolean; locked: boolean;
  smoothing?: number;
  layerId?: string;
}
export interface BoardFile { version: 1 | 2; shapes: BoardShape[]; layers?: BoardLayer[] }
export const BOARD_MAX_SHAPES = 256;
export const BOARD_MAX_POINTS = 256;
export const boardId = (value: unknown): value is string => typeof value === 'string' && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value);
export const boardCoordinate = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1_000_000;
export const boardBrushWidth = (value: number): number => value * 20;
export function validBoardLayer(value: unknown): value is BoardLayer {
  const l = value as BoardLayer;
  return Boolean(l && boardId(l.id) && typeof l.name === 'string' && l.name.length <= 80 &&
    Number.isFinite(l.order) && Math.abs(l.order) <= 1e9 && typeof l.hidden === 'boolean' && typeof l.locked === 'boolean' &&
    boardCoordinate(l.x) && boardCoordinate(l.y) && (l.deleted === undefined || typeof l.deleted === 'boolean'));
}
export function validBoardShape(value: unknown): value is BoardShape {
  if (!value || typeof value !== 'object') return false;
  const s = value as BoardShape;
  return boardId(s.id) && ['brush', 'eraser', 'rectangle', 'ellipse', 'line'].includes(s.tool) &&
    Array.isArray(s.points) && s.points.length >= 1 && s.points.length <= BOARD_MAX_POINTS &&
    s.points.every(p => p && boardCoordinate(p.x) && boardCoordinate(p.y)) &&
    (s.tool === 'brush' || s.tool === 'eraser' || s.points.length === 2) && /^#[\da-f]{6}$/i.test(s.color) &&
    Number.isFinite(s.width) && s.width >= 1 && s.width <= 2000 && (s.layerId === undefined || boardId(s.layerId)) &&
    boardCoordinate(s.x) && boardCoordinate(s.y) && Number.isFinite(s.order) && Math.abs(s.order) <= 1e9 &&
    typeof s.filled === 'boolean' && typeof s.hidden === 'boolean' && typeof s.locked === 'boolean' &&
    (s.smoothing === undefined || Number.isFinite(s.smoothing) && s.smoothing >= 0 && s.smoothing <= 100);
}
export function parseBoardFile(content: string): BoardFile {
  if (content.length > 400_000) throw new Error('whiteboard.invalidFile');
  const file = JSON.parse(content) as BoardFile;
  if (![1, 2].includes(file?.version) || !Array.isArray(file.shapes) || file.shapes.length > BOARD_MAX_SHAPES ||
    !file.shapes.every(validBoardShape) || new Set(file.shapes.map(s => s.id)).size !== file.shapes.length)
    throw new Error('whiteboard.invalidFile');
  if (file.version === 2 && (!Array.isArray(file.layers) || !file.layers.length || file.layers.length > 64 ||
    !file.layers.every(l => validBoardLayer(l) && !l.deleted) || new Set(file.layers.map(l => l.id)).size !== file.layers.length ||
    !file.shapes.every(s => file.layers!.some(l => l.id === (s.layerId ?? DEFAULT_BOARD_LAYER))))) throw new Error('whiteboard.invalidFile');
  return file.version === 1 ? { version: 1, shapes: file.shapes.map(s => ({ ...s, layerId: DEFAULT_BOARD_LAYER })) } : file;
}
export function shapeBounds(s: BoardShape) {
  const xs = s.points.map(p => p.x + s.x), ys = s.points.map(p => p.y + s.y);
  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}
function segmentDistance(p: BoardPoint, a: BoardPoint, b: BoardPoint): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const f = dx || dy ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy))) : 0;
  return Math.hypot(p.x - a.x - f * dx, p.y - a.y - f * dy);
}
function brushCurves(points: BoardPoint[]): { control: BoardPoint; end: BoardPoint }[] {
  return [...points.slice(1).map((point, i) => ({ control: points[i], end: { x: (points[i].x + point.x) / 2, y: (points[i].y + point.y) / 2 } })),
    { control: points[points.length - 1], end: points[points.length - 1] }];
}
export function brushPath(s: BoardShape): string {
  const first = s.points[0], prefix = `M${first.x} ${first.y}`;
  if (s.points.length === 1) return `${prefix} l0.01 0`;
  return (s.tool === 'brush' || s.tool === 'eraser') && s.smoothing ? `${prefix} ${brushCurves(s.points).map(({ control: c, end: e }) => `Q${c.x} ${c.y} ${e.x} ${e.y}`).join(' ')}`
    : `${prefix} ${s.points.slice(1).map(p => `L${p.x} ${p.y}`).join(' ')}`;
}
function brushHitPoints(s: BoardShape): BoardPoint[] {
  if (!s.smoothing || !['brush', 'eraser'].includes(s.tool) || s.points.length < 2) return s.points;
  const result = [s.points[0]];
  let start = s.points[0];
  for (const { control: c, end: e } of brushCurves(s.points)) {
    for (let i = 1; i <= 8; i++) { const t = i / 8, u = 1 - t;
      result.push({ x: u * u * start.x + 2 * u * t * c.x + t * t * e.x, y: u * u * start.y + 2 * u * t * c.y + t * t * e.y }); }
    start = e;
  }
  return result;
}
export function hitBoardShape(s: BoardShape, point: BoardPoint, tolerance: number): boolean {
  if (s.hidden || s.locked || s.tool === 'eraser') return false;
  const p = { x: point.x - s.x, y: point.y - s.y }, margin = tolerance + s.width / 2;
  if (s.tool === 'brush' || s.tool === 'line') {
    const points = brushHitPoints(s);
    return points.length === 1 ? segmentDistance(p, points[0], points[0]) <= margin
      : points.slice(1).some((b, i) => segmentDistance(p, points[i], b) <= margin);
  }
  const b = shapeBounds(s), x = point.x - b.x, y = point.y - b.y;
  if (s.tool === 'rectangle') return x >= -margin && y >= -margin && x <= b.width + margin && y <= b.height + margin &&
    (s.filled || Math.min(x, y, b.width - x, b.height - y) <= margin);
  const rx = b.width / 2, ry = b.height / 2;
  if (!rx || !ry) return segmentDistance(p, s.points[0], s.points[1]) <= margin;
  const radius = Math.hypot((x - rx) / rx, (y - ry) / ry);
  return s.filled ? radius <= 1 + margin / Math.min(rx, ry) : Math.abs(radius - 1) <= margin / Math.min(rx, ry);
}
export function hitBoardLayer(shapes: BoardShape[], layer: BoardLayer, point: BoardPoint, tolerance: number): boolean {
  if (layer.hidden || layer.locked) return false;
  const local = { x: point.x - layer.x, y: point.y - layer.y };
  for (const s of [...shapes].reverse().filter(s => (s.layerId ?? DEFAULT_BOARD_LAYER) === layer.id && !s.hidden)) {
    if (s.tool === 'eraser') { if (hitBoardShape({ ...s, tool: 'brush' }, local, 0)) return false; }
    else if (hitBoardShape(s, local, tolerance)) return true;
  }
  return false;
}
export function boardLayerBounds(shapes: BoardShape[], layer: BoardLayer) {
  const boxes = shapes.filter(s => (s.layerId ?? DEFAULT_BOARD_LAYER) === layer.id && s.tool !== 'eraser' && !s.hidden).map(shapeBounds);
  if (!boxes.length) return null;
  const x = Math.min(...boxes.map(b => b.x)), y = Math.min(...boxes.map(b => b.y));
  return { x: x + layer.x, y: y + layer.y, width: Math.max(...boxes.map(b => b.x + b.width)) - x, height: Math.max(...boxes.map(b => b.y + b.height)) - y };
}
export function shapeSvg(s: BoardShape): string {
  const common = `stroke="${s.color}" stroke-width="${s.width}" fill="${s.filled && !['brush', 'eraser', 'line'].includes(s.tool) ? s.color : 'none'}" stroke-linecap="round" stroke-linejoin="round" transform="translate(${s.x} ${s.y})"`;
  const [a, b = a] = s.points;
  if (s.tool === 'brush' || s.tool === 'eraser' || s.tool === 'line') return `<path ${common} d="${brushPath(s)}"/>`;
  if (s.tool === 'rectangle') return `<rect ${common} x="${Math.min(a.x, b.x)}" y="${Math.min(a.y, b.y)}" width="${Math.abs(b.x - a.x)}" height="${Math.abs(b.y - a.y)}"/>`;
  return `<ellipse ${common} cx="${(a.x + b.x) / 2}" cy="${(a.y + b.y) / 2}" rx="${Math.abs(b.x - a.x) / 2}" ry="${Math.abs(b.y - a.y) / 2}"/>`;
}
export function boardSvg(shapes: BoardShape[], layers: BoardLayer[] = [defaultBoardLayer()]): string {
  const visible = layers.filter(l => !l.hidden).flatMap(l => shapes.filter(s => !s.hidden && (s.layerId ?? DEFAULT_BOARD_LAYER) === l.id).map(s => ({ ...s, x: s.x + l.x, y: s.y + l.y }))), bounds = visible.map(shapeBounds);
  const pad = 60, x = Math.min(0, ...bounds.map(b => b.x)) - pad, y = Math.min(0, ...bounds.map(b => b.y)) - pad;
  const width = Math.max(100, ...bounds.map(b => b.x + b.width)) - x + pad;
  const height = Math.max(100, ...bounds.map(b => b.y + b.height)) - y + pad;
  const art = layers.filter(l => !l.hidden).map(l => {
    let content = '';
    for (const s of shapes.filter(s => !s.hidden && (s.layerId ?? DEFAULT_BOARD_LAYER) === l.id)) {
      if (s.tool === 'eraser') content = `<defs><mask id="erase-${s.id}" maskUnits="userSpaceOnUse" x="-16000" y="-10000" width="48000" height="30000"><rect x="-16000" y="-10000" width="48000" height="30000" fill="white"/>${shapeSvg({ ...s, color: '#000000' })}</mask></defs><g mask="url(#erase-${s.id})">${content}</g>`;
      else content += shapeSvg(s);
    }
    return `<g transform="translate(${l.x} ${l.y})">${content}</g>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${width} ${height}">${art}</svg>`;
}
