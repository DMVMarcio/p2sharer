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
  return (s.tool === 'brush' && Boolean(s.brushType)) ||
    ((s.tool === 'brush' || s.tool === 'eraser') && s.points.some(p => p.p !== undefined));
}
function brushProfile(s: BoardShape, hasPressure: boolean) {
  if (s.tool === 'eraser') {
    return { base: s.width * 0.5, min: 0.3, max: 1.0, exp: 0.9, taper: 0, tip: 1.0 };
  }
  if (s.brushType === 'pencil') {
    return { base: s.width * 0.32, min: hasPressure ? 0.26 : 0.34, max: 0.92, exp: 0.78, taper: 1.8, tip: hasPressure ? 0.16 : 0.26 };
  }
  if (s.brushType === 'pen') {
    return { base: s.width * 0.48, min: hasPressure ? 0.05 : 0.14, max: 1.04, exp: 1.15, taper: 3.2, tip: hasPressure ? 0.04 : 0.08 };
  }
  return { base: s.width * 0.55, min: hasPressure ? 0.10 : 0.20, max: 1.18, exp: 0.86, taper: 2.5, tip: hasPressure ? 0.08 : 0.14 };
}
export function shapeOpacity(s: BoardShape): number {
  const base = Math.max(1, Math.min(100, s.opacity ?? 100)) / 100;
  if (s.tool === 'brush' && s.brushType === 'pencil') {
    const pressures = s.points.filter(p => p.p !== undefined).map(p => p.p!);
    const pressureFactor = pressures.length
      ? 0.52 + 0.44 * Math.pow(pressures.reduce((a, b) => a + b, 0) / pressures.length, 0.8)
      : 0.86;
    return round(Math.max(0.05, Math.min(1, base * pressureFactor)));
  }
  return round(base);
}
function traceContourSide(pts: BoardPoint[], smooth: boolean): string {
  if (pts.length <= 1) return '';
  if (!smooth || pts.length === 2) return pts.slice(1).map(p => `L${round(p.x)} ${round(p.y)}`).join(' ');
  const cmds: string[] = [];
  for (let i = 1; i < pts.length - 1; i++) {
    const midX = round((pts[i].x + pts[i + 1].x) / 2);
    const midY = round((pts[i].y + pts[i + 1].y) / 2);
    cmds.push(`Q${round(pts[i].x)} ${round(pts[i].y)} ${midX} ${midY}`);
  }
  const last = pts[pts.length - 1];
  cmds.push(`L${round(last.x)} ${round(last.y)}`);
  return cmds.join(' ');
}
function circleSubpath(center: BoardPoint, radius: number): string {
  const r = Math.max(0.4, radius);
  const pts: string[] = [];
  for (let k = 0; k < 12; k++) {
    const theta = (k / 12) * Math.PI * 2;
    const x = round(center.x + Math.cos(theta) * r);
    const y = round(center.y + Math.sin(theta) * r);
    pts.push(k === 0 ? `M${x} ${y}` : `L${x} ${y}`);
  }
  return `${pts.join(' ')} Z`;
}
function subStrokeContour(pts: BoardPoint[], radii: number[], windowDist: number, smooth: boolean): string {
  if (pts.length === 1) return circleSubpath(pts[0], radii[0]);
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  if (total < 0.35) return circleSubpath(pts[0], Math.max(...radii));
  const tangents: BoardPoint[] = [];
  for (let i = 0; i < pts.length; i++) {
    let back = i, dBack = 0;
    while (back > 0 && dBack < windowDist) {
      dBack += Math.hypot(pts[back].x - pts[back - 1].x, pts[back].y - pts[back - 1].y);
      back--;
    }
    let fwd = i, dFwd = 0;
    while (fwd < pts.length - 1 && dFwd < windowDist) {
      dFwd += Math.hypot(pts[fwd + 1].x - pts[fwd].x, pts[fwd + 1].y - pts[fwd].y);
      fwd++;
    }
    let dx = pts[fwd].x - pts[back].x, dy = pts[fwd].y - pts[back].y;
    let len = Math.hypot(dx, dy);
    if (len < 1e-4) { dx = 1; dy = 0; len = 1; }
    tangents.push({ x: dx / len, y: dy / len });
  }
  const upper: BoardPoint[] = [], lower: BoardPoint[] = [];
  for (let i = 0; i < pts.length; i++) {
    const t = tangents[i], nx = -t.y, ny = t.x, r = radii[i];
    let up = { x: pts[i].x - nx * r, y: pts[i].y - ny * r };
    let lo = { x: pts[i].x + nx * r, y: pts[i].y + ny * r };
    if (i > 0) {
      if ((up.x - upper[i - 1].x) * t.x + (up.y - upper[i - 1].y) * t.y < 0) up = upper[i - 1];
      if ((lo.x - lower[i - 1].x) * t.x + (lo.y - lower[i - 1].y) * t.y < 0) lo = lower[i - 1];
    }
    upper.push(up);
    lower.push(lo);
  }
  const last = pts.length - 1;
  const tStart = tangents[0], nStart = { x: -tStart.y, y: tStart.x }, rStart = radii[0];
  const tEnd = tangents[last], nEnd = { x: -tEnd.y, y: tEnd.x }, rEnd = radii[last];
  const endCap: string[] = [];
  for (let k = 1; k <= 6; k++) {
    const theta = (k / 6) * Math.PI;
    const dx = -nEnd.x * Math.cos(theta) + tEnd.x * Math.sin(theta);
    const dy = -nEnd.y * Math.cos(theta) + tEnd.y * Math.sin(theta);
    endCap.push(`L${round(pts[last].x + dx * rEnd)} ${round(pts[last].y + dy * rEnd)}`);
  }
  const startCap: string[] = [];
  for (let k = 1; k < 6; k++) {
    const theta = (k / 6) * Math.PI;
    const dx = nStart.x * Math.cos(theta) - tStart.x * Math.sin(theta);
    const dy = nStart.y * Math.cos(theta) - tStart.y * Math.sin(theta);
    startCap.push(`L${round(pts[0].x + dx * rStart)} ${round(pts[0].y + dy * rStart)}`);
  }
  const revLower = [...lower].reverse();
  return [
    `M${round(upper[0].x)} ${round(upper[0].y)}`,
    traceContourSide(upper, smooth),
    endCap.join(' '),
    traceContourSide(revLower, smooth),
    startCap.join(' '),
    'Z',
  ].filter(Boolean).join(' ');
}
function variableWidthBrushPath(s: BoardShape): string {
  const hasPressure = s.points.some(p => p.p !== undefined);
  const profile = brushProfile(s, hasPressure);
  const baseRadius = Math.max(0.5, profile.base);
  const rawSamples = brushHitPoints(s);
  const minStep = Math.max(0.35, baseRadius * 0.08);
  const spine: BoardPoint[] = [rawSamples[0]];
  for (let i = 1; i < rawSamples.length; i++) {
    const prev = spine[spine.length - 1], cur = rawSamples[i];
    if (Math.hypot(cur.x - prev.x, cur.y - prev.y) >= minStep) {
      spine.push(cur);
    } else if (cur.p !== undefined) {
      spine[spine.length - 1] = { ...prev, p: prev.p !== undefined ? (prev.p + cur.p) / 2 : cur.p };
    }
  }
  if (spine.length === 1) {
    const p0 = hasPressure ? Math.pow(Math.max(0.02, Math.min(1, spine[0].p ?? 0.5)), profile.exp) : 0.85;
    const r = baseRadius * (profile.min + (profile.max - profile.min) * p0);
    return circleSubpath(spine[0], r);
  }
  const pressures = spine.map(p => Math.max(0.02, Math.min(1, p.p ?? 0.5)));
  if (hasPressure && pressures.length >= 3) {
    pressures[0] = Math.min(pressures[0], pressures[1] * 0.85);
    pressures[pressures.length - 1] = Math.min(pressures[pressures.length - 1], pressures[pressures.length - 2] * 0.75);
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 1; i < pressures.length - 1; i++) {
        pressures[i] = pressures[i - 1] * 0.25 + pressures[i] * 0.5 + pressures[i + 1] * 0.25;
      }
    }
  }
  const arc: number[] = [0];
  for (let i = 1; i < spine.length; i++) {
    arc.push(arc[i - 1] + Math.hypot(spine[i].x - spine[i - 1].x, spine[i].y - spine[i - 1].y));
  }
  const totalLen = arc[arc.length - 1];
  const taperLen = profile.taper > 0 && totalLen > baseRadius * 0.5
    ? Math.min(totalLen * 0.42, baseRadius * 2 * profile.taper)
    : 0;
  const radii = spine.map((_, i) => {
    const pScale = hasPressure
      ? profile.min + (profile.max - profile.min) * Math.pow(pressures[i], profile.exp)
      : profile.max;
    let taperScale = 1;
    if (taperLen > 0.5) {
      const dStart = arc[i], dEnd = totalLen - arc[i];
      const startFactor = dStart < taperLen ? profile.tip + (1 - profile.tip) * Math.sin((dStart / taperLen) * (Math.PI / 2)) : 1;
      const endFactor = dEnd < taperLen ? profile.tip + (1 - profile.tip) * Math.sin((dEnd / taperLen) * (Math.PI / 2)) : 1;
      taperScale = Math.min(startFactor, endFactor);
    }
    return Math.max(0.35, baseRadius * pScale * taperScale);
  });
  const windowDist = Math.max(1.5, baseRadius * 0.45);
  const subStrokes: { pts: BoardPoint[]; radii: number[] }[] = [];
  let startIdx = 0;
  for (let i = 1; i < spine.length - 1; i++) {
    let b = i - 1;
    while (b > startIdx && arc[i] - arc[b] < windowDist) b--;
    let f = i + 1;
    while (f < spine.length - 1 && arc[f] - arc[i] < windowDist) f++;
    const dx1 = spine[i].x - spine[b].x, dy1 = spine[i].y - spine[b].y, l1 = Math.hypot(dx1, dy1);
    const dx2 = spine[f].x - spine[i].x, dy2 = spine[f].y - spine[i].y, l2 = Math.hypot(dx2, dy2);
    if (l1 > 0.5 && l2 > 0.5 && (dx1 * dx2 + dy1 * dy2) / (l1 * l2) < -0.25) {
      subStrokes.push({ pts: spine.slice(startIdx, i + 1), radii: radii.slice(startIdx, i + 1) });
      startIdx = i;
    }
  }
  subStrokes.push({ pts: spine.slice(startIdx), radii: radii.slice(startIdx) });
  const smooth = Boolean(s.smoothing);
  return subStrokes.map(sub => subStrokeContour(sub.pts, sub.radii, windowDist, smooth)).join(' ');
}
export function brushPath(s: BoardShape): string {
  if (hasVariablePressure(s)) return variableWidthBrushPath(s);
  const first = s.points[0], prefix = `M${first.x} ${first.y}`;
  if (s.points.length === 1) return `${prefix} l0.01 0`;
  return (s.tool === 'brush' || s.tool === 'eraser') && s.smoothing ? `${prefix} ${brushCurves(s.points).map(({ control: c, end: e }) => `Q${c.x} ${c.y} ${e.x} ${e.y}`).join(' ')}`
    : `${prefix} ${s.points.slice(1).map(p => `L${p.x} ${p.y}`).join(' ')}`;
}
function brushHitPoints(s: BoardShape): BoardPoint[] {
  const subdivide = (s.tool === 'brush' || s.tool === 'eraser') && (Boolean(s.smoothing) || Boolean(s.brushType) || s.points.some(p => p.p !== undefined));
  if (!subdivide || s.points.length < 2) return s.points;
  const steps = s.smoothing ? 8 : 4;
  const result = [s.points[0]];
  let start = s.points[0];
  for (const { control: c, end: e } of brushCurves(s.points)) {
    const p0 = start.p, pc = c.p, pe = e.p;
    const hasP = p0 !== undefined || pc !== undefined || pe !== undefined;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps, u = 1 - t;
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
      return `<path fill="${s.color}" fill-rule="nonzero" stroke="none"${opacityAttr} ${transform} d="${d}"/>`;
    }
    return `<path stroke="${s.color}" stroke-width="${s.width}" fill="none"${opacityAttr} stroke-linecap="round" stroke-linejoin="round" ${transform} d="${d}"/>`;
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
