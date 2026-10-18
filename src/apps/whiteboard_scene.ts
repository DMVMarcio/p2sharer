export type BoardTool = 'pointer' | 'brush' | 'eraser' | 'rectangle' | 'ellipse' | 'line' | 'image';
export type BoardBrushType = 'pencil' | 'pen' | 'brush';
export const DEFAULT_BOARD_LAYER = '00000000-0000-4000-8000-000000000001';
export interface BoardLayer { id: string; name: string; order: number; hidden: boolean; locked: boolean; x: number; y: number; deleted?: boolean }
export const defaultBoardLayer = (): BoardLayer => ({ id: DEFAULT_BOARD_LAYER, name: '', order: 0, hidden: false, locked: false, x: 0, y: 0 });
export interface BoardPoint { x: number; y: number; p?: number }
export interface BoardShape {
  id: string; tool: Exclude<BoardTool, 'pointer'>; points: BoardPoint[];
  color: string; width: number; filled: boolean; x: number; y: number;
  order: number; hidden: boolean; locked: boolean;
  smoothing?: number;
  opacity?: number;
  brushType?: BoardBrushType;
  scaleX?: number;
  scaleY?: number;
  imageHash?: string;
  groupId?: string;
  layerId?: string;
}
export interface BoardFile { version: 1 | 2; shapes: BoardShape[]; layers?: BoardLayer[]; images?: Record<string, string> }
export const BOARD_MAX_SHAPES = 4096;
export const BOARD_MAX_POINTS = 4096;
export const boardId = (value: unknown): value is string => typeof value === 'string' && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value);
export const validBoardHash = (value: unknown): value is string => typeof value === 'string' && /^[\da-f]{64}$/.test(value);
export const boardCoordinate = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1_000_000;
export const boardScale = (value: unknown): boolean => value === undefined || (typeof value === 'number' && Number.isFinite(value) && value >= 0.001 && value <= 1000);
export const boardBrushWidth = (value: number): number => 20 + (value - 1) * 1380 / 99;
const round = (value: number): number => Math.round(value * 100) / 100;

export function validBoardLayer(value: unknown): value is BoardLayer {
  const l = value as BoardLayer;
  return Boolean(l && boardId(l.id) && typeof l.name === 'string' && l.name.length <= 80 &&
    Number.isFinite(l.order) && Math.abs(l.order) <= 1e9 && typeof l.hidden === 'boolean' && typeof l.locked === 'boolean' &&
    boardCoordinate(l.x) && boardCoordinate(l.y) && (l.deleted === undefined || typeof l.deleted === 'boolean'));
}
export function validBoardShape(value: unknown): value is BoardShape {
  if (!value || typeof value !== 'object') return false;
  const s = value as BoardShape;
  return boardId(s.id) && ['brush', 'eraser', 'rectangle', 'ellipse', 'line', 'image'].includes(s.tool) &&
    Array.isArray(s.points) && s.points.length >= 1 && s.points.length <= BOARD_MAX_POINTS &&
    s.points.every(p => p && boardCoordinate(p.x) && boardCoordinate(p.y) &&
      (p.p === undefined || (typeof p.p === 'number' && Number.isFinite(p.p) && p.p >= 0 && p.p <= 1))) &&
    (s.tool === 'brush' || s.tool === 'eraser' || s.points.length === 2) &&
    (s.tool === 'image'
      ? validBoardHash(s.imageHash) && Math.abs(s.points[1].x - s.points[0].x) >= 1 && Math.abs(s.points[1].y - s.points[0].y) >= 1
      : s.imageHash === undefined) &&
    /^#[\da-f]{6}$/i.test(s.color) &&
    Number.isFinite(s.width) && s.width >= 1 && s.width <= 2000 && (s.layerId === undefined || boardId(s.layerId)) &&
    (s.groupId === undefined || boardId(s.groupId)) &&
    boardCoordinate(s.x) && boardCoordinate(s.y) && boardScale(s.scaleX) && boardScale(s.scaleY) &&
    Number.isFinite(s.order) && Math.abs(s.order) <= 1e9 &&
    typeof s.filled === 'boolean' && typeof s.hidden === 'boolean' && typeof s.locked === 'boolean' &&
    (s.smoothing === undefined || (Number.isFinite(s.smoothing) && s.smoothing >= 0 && s.smoothing <= 100)) &&
    (s.opacity === undefined || (Number.isFinite(s.opacity) && s.opacity >= 1 && s.opacity <= 100)) &&
    (s.brushType === undefined || ['pencil', 'pen', 'brush'].includes(s.brushType));
}
export function parseBoardFile(content: string): BoardFile {
  if (content.length > 16_000_000) throw new Error('whiteboard.invalidFile');
  const file = JSON.parse(content) as BoardFile;
  if (![1, 2].includes(file?.version) || !Array.isArray(file.shapes) || file.shapes.length > BOARD_MAX_SHAPES ||
    !file.shapes.every(validBoardShape) || new Set(file.shapes.map(s => s.id)).size !== file.shapes.length)
    throw new Error('whiteboard.invalidFile');
  if (file.images !== undefined) {
    if (!file.images || typeof file.images !== 'object' || Array.isArray(file.images) ||
      Object.entries(file.images).some(([hash, data]) => !validBoardHash(hash) || typeof data !== 'string' ||
        !data.length || data.length > 12_000_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)))
      throw new Error('whiteboard.invalidFile');
  }
  if (file.version === 2 && (!Array.isArray(file.layers) || !file.layers.length || file.layers.length > 64 ||
    !file.layers.every(l => validBoardLayer(l) && !l.deleted) || new Set(file.layers.map(l => l.id)).size !== file.layers.length ||
    !file.shapes.every(s => file.layers!.some(l => l.id === (s.layerId ?? DEFAULT_BOARD_LAYER))))) throw new Error('whiteboard.invalidFile');
  return file.version === 1 ? { version: 1, shapes: file.shapes.map(s => ({ ...s, layerId: DEFAULT_BOARD_LAYER })), ...(file.images ? { images: file.images } : {}) } : file;
}
function geometryBounds(s: BoardShape) {
  const xs = s.points.map(p => p.x), ys = s.points.map(p => p.y);
  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}
export function shapeBounds(s: BoardShape) {
  const bounds = geometryBounds(s), radius = s.tool === 'image' ? 0 : s.width / 2;
  const sx = s.scaleX ?? 1, sy = s.scaleY ?? 1;
  return {
    x: s.x + (bounds.x - radius) * sx,
    y: s.y + (bounds.y - radius) * sy,
    width: (bounds.width + radius * 2) * sx,
    height: (bounds.height + radius * 2) * sy,
  };
}
function segmentDistance(p: BoardPoint, a: BoardPoint, b: BoardPoint): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const f = dx || dy ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy))) : 0;
  return Math.hypot(p.x - a.x - f * dx, p.y - a.y - f * dy);
}
function brushCurves(points: BoardPoint[]): { control: BoardPoint; end: BoardPoint }[] {
  return [...points.slice(1).map((point, i) => ({
    control: points[i],
    end: {
      x: (points[i].x + point.x) / 2,
      y: (points[i].y + point.y) / 2,
      ...(points[i].p !== undefined || point.p !== undefined ? { p: ((points[i].p ?? 0.5) + (point.p ?? 0.5)) / 2 } : {}),
    },
  })), { control: points[points.length - 1], end: points[points.length - 1] }];
}
export function hasVariablePressure(s: BoardShape): boolean {
  return (s.tool === 'brush' || s.tool === 'eraser') && s.points.some(p => p.p !== undefined);
}
function pressureRange(s: BoardShape): [number, number] {
  if (s.tool === 'eraser') return [0.25, 1.0];
  if (s.brushType === 'pencil') return [0.35, 0.85];
  if (s.brushType === 'pen') return [0.2, 1.0];
  return [0.12, 1.2];
}
export function shapeOpacity(s: BoardShape): number {
  const base = Math.max(1, Math.min(100, s.opacity ?? 100)) / 100;
  if (s.tool === 'brush' && s.brushType === 'pencil') {
    const pressures = s.points.filter(p => p.p !== undefined).map(p => p.p!);
    const pressureFactor = pressures.length ? 0.5 + 0.5 * (pressures.reduce((a, b) => a + b, 0) / pressures.length) : 0.84;
    return round(Math.max(0.05, Math.min(1, base * pressureFactor)));
  }
  return round(base);
}
function variableWidthBrushPath(s: BoardShape): string {
  const [minScale, maxScale] = pressureRange(s);
  const radiusAt = (p = 0.5) => Math.max(0.5, (s.width / 2) * (minScale + (maxScale - minScale) * Math.max(0, Math.min(1, p))));
  const samples = brushHitPoints(s);
  const spine: BoardPoint[] = [samples[0]];
  for (let i = 1; i < samples.length; i++) {
    const prev = spine[spine.length - 1], cur = samples[i];
    if (Math.hypot(cur.x - prev.x, cur.y - prev.y) >= 0.1) spine.push(cur);
    else if ((cur.p ?? 0.5) > (prev.p ?? 0.5)) spine[spine.length - 1] = { ...prev, p: cur.p };
  }
  if (spine.length === 1) {
    const pt = spine[0], r = round(radiusAt(pt.p));
    return `M${round(pt.x - r)} ${round(pt.y)} a${r} ${r} 0 1 0 ${round(r * 2)} 0 a${r} ${r} 0 1 0 ${round(-r * 2)} 0 Z`;
  }
  const left: BoardPoint[] = [], right: BoardPoint[] = [], radii: number[] = [];
  for (let i = 0; i < spine.length; i++) {
    const p0 = spine[Math.max(0, i - 1)], p1 = spine[i], p2 = spine[Math.min(spine.length - 1, i + 1)];
    let dx = p2.x - p0.x, dy = p2.y - p0.y, len = Math.hypot(dx, dy);
    if (len < 1e-4) { dx = p1.x - p0.x || 1; dy = p1.y - p0.y; len = Math.hypot(dx, dy) || 1; }
    const nx = -dy / len, ny = dx / len, r = radiusAt(p1.p);
    radii.push(round(r));
    left.push({ x: round(p1.x + nx * r), y: round(p1.y + ny * r) });
    right.push({ x: round(p1.x - nx * r), y: round(p1.y - ny * r) });
  }
  const last = spine.length - 1;
  return `M${left[0].x} ${left[0].y} ` +
    left.slice(1).map(p => `L${p.x} ${p.y}`).join(' ') +
    ` A${radii[last]} ${radii[last]} 0 0 1 ${right[last].x} ${right[last].y} ` +
    right.slice(0, -1).reverse().map(p => `L${p.x} ${p.y}`).join(' ') +
    ` A${radii[0]} ${radii[0]} 0 0 1 ${left[0].x} ${left[0].y} Z`;
}
export function brushPath(s: BoardShape): string {
  if (hasVariablePressure(s)) return variableWidthBrushPath(s);
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
    const p0 = start.p, pc = c.p, pe = e.p;
    const hasP = p0 !== undefined || pc !== undefined || pe !== undefined;
    for (let i = 1; i <= 8; i++) {
      const t = i / 8, u = 1 - t;
      result.push({
        x: u * u * start.x + 2 * u * t * c.x + t * t * e.x,
        y: u * u * start.y + 2 * u * t * c.y + t * t * e.y,
        ...(hasP ? { p: u * u * (p0 ?? 0.5) + 2 * u * t * (pc ?? 0.5) + t * t * (pe ?? 0.5) } : {}),
      });
    }
    start = e;
  }
  return result;
}
export function hitBoardShape(s: BoardShape, point: BoardPoint, tolerance: number): boolean {
  if (s.hidden || s.locked || s.tool === 'eraser') return false;
  const sx = s.scaleX ?? 1, sy = s.scaleY ?? 1;
  const p = { x: (point.x - s.x) / sx, y: (point.y - s.y) / sy };
  const localTolerance = tolerance / Math.max(0.001, Math.min(sx, sy));
  const margin = localTolerance + (s.tool === 'image' ? 0 : s.width / 2);
  if (s.tool === 'brush' || s.tool === 'line') {
    const points = brushHitPoints(s);
    return points.length === 1 ? segmentDistance(p, points[0], points[0]) <= margin
      : points.slice(1).some((b, i) => segmentDistance(p, points[i], b) <= margin);
  }
  const b = geometryBounds(s), x = p.x - b.x, y = p.y - b.y;
  if (s.tool === 'image') return x >= -margin && y >= -margin && x <= b.width + margin && y <= b.height + margin;
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
export function shapeTransform(s: BoardShape): string {
  const sx = s.scaleX ?? 1, sy = s.scaleY ?? 1;
  return sx !== 1 || sy !== 1 ? `translate(${s.x} ${s.y}) scale(${sx} ${sy})` : `translate(${s.x} ${s.y})`;
}
function resolveImageHref(hash: string | undefined, images?: ReadonlyMap<string, string> | Record<string, string>): string | undefined {
  if (!hash || !images) return undefined;
  const raw = images instanceof Map ? images.get(hash) : (images as Record<string, string>)[hash];
  if (!raw) return undefined;
  return raw.startsWith('data:') || raw.startsWith('blob:') ? raw : `data:image/png;base64,${raw}`;
}
export function shapeSvg(s: BoardShape, images?: ReadonlyMap<string, string> | Record<string, string>, ignoreOpacity = false): string {
  const opacity = !ignoreOpacity ? shapeOpacity(s) : 1;
  const opacityAttr = opacity < 1 ? ` opacity="${opacity}"` : '';
  const transform = `transform="${shapeTransform(s)}"`;
  const [a, b = a] = s.points;
  if (s.tool === 'image') {
    const href = resolveImageHref(s.imageHash, images);
    if (!href) return '';
    return `<image href="${href}" x="${Math.min(a.x, b.x)}" y="${Math.min(a.y, b.y)}" width="${Math.abs(b.x - a.x)}" height="${Math.abs(b.y - a.y)}" preserveAspectRatio="none"${opacityAttr} ${transform}/>`;
  }
  if (s.tool === 'brush' || s.tool === 'eraser' || s.tool === 'line') {
    const d = brushPath(s);
    if (hasVariablePressure(s)) {
      const core = `<path fill="${s.color}" stroke="none"${opacityAttr} ${transform} d="${d}"/>`;
      return s.tool === 'brush' && s.brushType === 'brush'
        ? `<g${opacityAttr}><path fill="none" stroke="${s.color}" stroke-width="${round(s.width * 0.22)}" stroke-opacity="0.3" stroke-linecap="round" stroke-linejoin="round" ${transform} d="${d}"/><path fill="${s.color}" stroke="none" ${transform} d="${d}"/></g>`
        : core;
    }
    const width = s.tool === 'brush' && s.brushType === 'pencil' ? round(Math.max(1, s.width * 0.72)) : s.width;
    const dash = s.tool === 'brush' && s.brushType === 'pencil' ? ` stroke-dasharray="${round(Math.max(1, s.width * 0.2))} ${round(Math.max(0.5, s.width * 0.06))}"` : '';
    if (s.tool === 'brush' && s.brushType === 'brush') {
      return `<g${opacityAttr}><path stroke="${s.color}" stroke-width="${round(s.width * 1.2)}" stroke-opacity="0.3" fill="none" stroke-linecap="round" stroke-linejoin="round" ${transform} d="${d}"/><path stroke="${s.color}" stroke-width="${round(s.width * 0.88)}" fill="none" stroke-linecap="round" stroke-linejoin="round" ${transform} d="${d}"/></g>`;
    }
    return `<path stroke="${s.color}" stroke-width="${width}" fill="none"${opacityAttr}${dash} stroke-linecap="round" stroke-linejoin="round" ${transform} d="${d}"/>`;
  }
  const common = `stroke="${s.color}" stroke-width="${s.width}" fill="${s.filled ? s.color : 'none'}"${opacityAttr} stroke-linecap="round" stroke-linejoin="round" ${transform}`;
  if (s.tool === 'rectangle') return `<rect ${common} x="${Math.min(a.x, b.x)}" y="${Math.min(a.y, b.y)}" width="${Math.abs(b.x - a.x)}" height="${Math.abs(b.y - a.y)}"/>`;
  return `<ellipse ${common} cx="${(a.x + b.x) / 2}" cy="${(a.y + b.y) / 2}" rx="${Math.abs(b.x - a.x) / 2}" ry="${Math.abs(b.y - a.y) / 2}"/>`;
}
export function boardSvg(shapes: BoardShape[], layers: BoardLayer[] = [defaultBoardLayer()], fullBoard = false, images?: ReadonlyMap<string, string> | Record<string, string>): string {
  const visible = layers.filter(l => !l.hidden).flatMap(l => shapes.filter(s => !s.hidden && (s.layerId ?? DEFAULT_BOARD_LAYER) === l.id).map(s => ({ ...s, x: s.x + l.x, y: s.y + l.y }))), bounds = visible.map(shapeBounds);
  const pad = 60, x = Math.min(0, ...bounds.map(b => b.x)) - pad, y = Math.min(0, ...bounds.map(b => b.y)) - pad;
  const width = Math.max(100, ...bounds.map(b => b.x + b.width)) - x + pad;
  const height = Math.max(100, ...bounds.map(b => b.y + b.height)) - y + pad;
  const art = layers.filter(l => !l.hidden).map(l => {
    let content = '';
    const layerShapes = shapes.filter(s => !s.hidden && (s.layerId ?? DEFAULT_BOARD_LAYER) === l.id);
    for (let i = 0; i < layerShapes.length; i++) {
      const s = layerShapes[i];
      if (s.tool === 'eraser') {
        content = `<defs><mask id="erase-${s.id}" maskUnits="userSpaceOnUse" x="-16000" y="-10000" width="48000" height="30000"><rect x="-16000" y="-10000" width="48000" height="30000" fill="white"/>${shapeSvg({ ...s, color: '#000000', opacity: 100 }, images, true)}</mask></defs><g mask="url(#erase-${s.id})">${content}</g>`;
      } else if (s.groupId && shapeOpacity(s) < 1) {
        const groupOpacity = shapeOpacity(s);
        let groupContent = shapeSvg(s, images, true);
        while (i + 1 < layerShapes.length && layerShapes[i + 1].groupId === s.groupId && layerShapes[i + 1].tool !== 'eraser') {
          i++;
          groupContent += shapeSvg(layerShapes[i], images, true);
        }
        content += `<g opacity="${groupOpacity}">${groupContent}</g>`;
      } else {
        content += shapeSvg(s, images);
      }
    }
    return `<g transform="translate(${l.x} ${l.y})">${content}</g>`;
  }).join('');
  return fullBoard
    ? `<svg xmlns="http://www.w3.org/2000/svg" width="4096" height="2560" viewBox="0 0 16000 10000"><rect width="16000" height="10000" fill="white"/>${art}</svg>`
    : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${width} ${height}">${art}</svg>`;
}
