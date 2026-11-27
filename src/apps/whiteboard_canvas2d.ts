import {
  boardLayerBounds, brushHitPoints, brushProfile, chiselMarkerPath, DEFAULT_BOARD_LAYER,
  expandSymmetryPointLists, gPenCalligraphicPath, shapeOpacity,
  type BoardBlendMode, type BoardBrushType, type BoardLayer, type BoardPoint, type BoardShape,
} from './whiteboard_scene';
import type { BoardBox } from './whiteboard_interaction';
import { computeFloodMask, parseHexRgb } from './whiteboard_raster';

export interface DirtyRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayerCompositeItem {
  id: string;
  canvas: HTMLCanvasElement;
  version: number;
  dirtyRect: DirtyRect | null;
  x: number;
  y: number;
  opacity: number;
  blendMode: BoardBlendMode;
  clipping: boolean;
  isBase: boolean;
  baseLayerId: string | null;
  resizeTransform?: { from: BoardBox; to: BoardBox };
}

export interface SyncLayersResult {
  layers: LayerCompositeItem[];
  changed: boolean;
  compositeKey: string;
}

interface LayerCanvasEntry {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  renderedIds: string[];
  alphaLock: boolean;
  width: number;
  height: number;
  version: number;
}

interface LiveStrokeSession {
  shapeId: string;
  layerId: string;
  layerVersion: number;
  signature: string;
  alphaLock: boolean;
  finalizedEndIdx: number;
  residuals: number[];
  dirtyRect: DirtyRect | null;
  tipRect: DirtyRect | null;
  lastOpacity: number;
  incremental: boolean;
}

function unionRects(a: DirtyRect | null, b: DirtyRect | null): DirtyRect | null {
  if (!a) return b;
  if (!b) return a;
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.w, b.x + b.w);
  const y1 = Math.max(a.y + a.h, b.y + b.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function clampRect(r: DirtyRect | null, width: number, height: number): DirtyRect | null {
  if (!r) return null;
  const x0 = Math.max(0, Math.floor(r.x));
  const y0 = Math.max(0, Math.floor(r.y));
  const x1 = Math.min(width, Math.ceil(r.x + r.w));
  const y1 = Math.min(height, Math.ceil(r.y + r.h));
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function shapeSignature(s: BoardShape): string {
  const clipLen = s.clipPolygon?.length ?? 0;
  return `${s.id}:${s.order}:${s.x}:${s.y}:${s.scaleX ?? 1}:${s.scaleY ?? 1}:${s.points.length}:${s.points[0]?.x ?? 0}:${s.points[0]?.y ?? 0}:${s.color}:${s.secondaryColor ?? ''}:${s.opacity ?? 100}:${s.width}:${s.brushType ?? ''}:${s.hardness ?? ''}:${s.flow ?? ''}:${s.spacing ?? ''}:${s.symmetry ?? ''}:${s.filled}:${s.smoothing ?? 0}:${s.flipX ? 1 : 0}:${s.flipY ? 1 : 0}:${clipLen}`;
}

function liveSessionSignature(s: BoardShape, alphaLock: boolean): string {
  const clipLen = s.clipPolygon?.length ?? 0;
  return `${s.tool}:${s.brushType ?? ''}:${s.color}:${s.width}:${s.flow ?? ''}:${s.hardness ?? ''}:${s.spacing ?? ''}:${s.symmetry ?? ''}:${s.smoothing ?? 0}:${s.pressureSize !== false ? 1 : 0}:${s.pressureOpacity !== false ? 1 : 0}:${alphaLock ? 1 : 0}:${clipLen}:${s.x}:${s.y}:${s.scaleX ?? 1}:${s.scaleY ?? 1}`;
}

function isIncrementalStampShape(s: BoardShape): boolean {
  if (s.tool === 'eraser') return true;
  if (s.tool !== 'brush') return false;
  return s.brushType !== 'pen' && s.brushType !== 'marker' && s.brushType !== 'smudge' && s.brushType !== 'blur';
}

function buildFinalizedSegments(
  points: readonly BoardPoint[],
  fromPointIdx: number,
  toPointIdx: number,
  smoothing: boolean,
  hasSubdivide: boolean,
): BoardPoint[] {
  if (toPointIdx <= fromPointIdx || points.length < 2) return [];
  const startIdx = Math.max(0, fromPointIdx);
  const endIdx = Math.min(points.length - 1, toPointIdx);
  if (endIdx <= startIdx) return [];

  if (!hasSubdivide) {
    return points.slice(startIdx, endIdx + 1);
  }

  const steps = smoothing ? 8 : 4;
  const result: BoardPoint[] = [];
  for (let i = startIdx; i < endIdx; i++) {
    const start: BoardPoint = i === 0
      ? points[0]
      : {
          x: (points[i - 1].x + points[i].x) / 2,
          y: (points[i - 1].y + points[i].y) / 2,
          ...(points[i - 1].p !== undefined || points[i].p !== undefined
            ? { p: ((points[i - 1].p ?? 0.5) + (points[i].p ?? 0.5)) / 2 }
            : {}),
        };
    const c = points[i];
    const e: BoardPoint = {
      x: (points[i].x + points[i + 1].x) / 2,
      y: (points[i].y + points[i + 1].y) / 2,
      ...(points[i].p !== undefined || points[i + 1].p !== undefined
        ? { p: ((points[i].p ?? 0.5) + (points[i + 1].p ?? 0.5)) / 2 }
        : {}),
    };
    if (result.length === 0) result.push(start);
    const p0 = start.p, pc = c.p, pe = e.p;
    const hasP = p0 !== undefined || pc !== undefined || pe !== undefined;
    for (let step = 1; step <= steps; step++) {
      const t = step / steps, u = 1 - t;
      result.push({
        x: u * u * start.x + 2 * u * t * c.x + t * t * e.x,
        y: u * u * start.y + 2 * u * t * c.y + t * t * e.y,
        ...(hasP ? { p: u * u * (p0 ?? 0.5) + 2 * u * t * (pc ?? 0.5) + t * t * (pe ?? 0.5) } : {}),
      });
    }
  }
  return result;
}

function buildTailSegment(points: readonly BoardPoint[], smoothing: boolean, hasSubdivide: boolean): BoardPoint[] {
  if (points.length === 0) return [];
  if (points.length === 1) return [points[0]];
  const last = points.length - 1;
  if (!hasSubdivide) {
    return [points[last - 1], points[last]];
  }
  const steps = smoothing ? 8 : 4;
  const start: BoardPoint = {
    x: (points[last - 1].x + points[last].x) / 2,
    y: (points[last - 1].y + points[last].y) / 2,
    ...(points[last - 1].p !== undefined || points[last].p !== undefined
      ? { p: ((points[last - 1].p ?? 0.5) + (points[last].p ?? 0.5)) / 2 }
      : {}),
  };
  const c = points[last];
  const e = points[last];
  const result: BoardPoint[] = [start];
  const p0 = start.p, pc = c.p, pe = e.p;
  const hasP = p0 !== undefined || pc !== undefined || pe !== undefined;
  for (let step = 1; step <= steps; step++) {
    const t = step / steps, u = 1 - t;
    result.push({
      x: u * u * start.x + 2 * u * t * c.x + t * t * e.x,
      y: u * u * start.y + 2 * u * t * c.y + t * t * e.y,
      ...(hasP ? { p: u * u * (p0 ?? 0.5) + 2 * u * t * (pc ?? 0.5) + t * t * (pe ?? 0.5) } : {}),
    });
  }
  return result;
}

/**
 * Per-layer offscreen 2D rasterizer and incremental brush engine for Whiteboard.
 * Maintains exact-resolution offscreen layer canvases, incremental live stroke
 * buffers, dirty rectangles, thumbnail generation, and pixel sampling.
 */
export class WhiteboardCanvas2DRenderer {
  private layerCache = new Map<string, LayerCanvasEntry>();
  private scratchCanvas: HTMLCanvasElement | null = null;
  private scratchCtx: CanvasRenderingContext2D | null = null;
  private scratchVersion = 0;
  private strokeCanvas: HTMLCanvasElement | null = null;
  private strokeCtx: CanvasRenderingContext2D | null = null;
  private tipCanvas: HTMLCanvasElement | null = null;
  private tipCtx: CanvasRenderingContext2D | null = null;
  private sampleCanvas: HTMLCanvasElement | null = null;
  private sampleCtx: CanvasRenderingContext2D | null = null;
  private sampleMaskCanvas: HTMLCanvasElement | null = null;
  private sampleMaskCtx: CanvasRenderingContext2D | null = null;
  private tipCache = new Map<string, HTMLCanvasElement>();
  private imageElements = new Map<string, HTMLImageElement>();
  private unsupportedCanvas = new WeakSet<HTMLCanvasElement>();
  private liveSession: LiveStrokeSession | null = null;
  private nonIncrementalPrevRect: DirtyRect | null = null;
  private lastCompositeKey = '';
  private lastSyncLayers: LayerCompositeItem[] = [];

  private ensureScratch(width: number, height: number): {
    scratchCanvas: HTMLCanvasElement;
    scratchCtx: CanvasRenderingContext2D;
    strokeCanvas: HTMLCanvasElement;
    strokeCtx: CanvasRenderingContext2D;
  } | null {
    if (typeof document === 'undefined') return null;
    if (!this.scratchCanvas || this.scratchCanvas.width !== width || this.scratchCanvas.height !== height) {
      this.scratchCanvas = document.createElement('canvas');
      this.scratchCanvas.width = width;
      this.scratchCanvas.height = height;
      this.scratchCtx = this.scratchCanvas.getContext('2d');
      this.liveSession = null;
      this.nonIncrementalPrevRect = null;
    }
    if (!this.strokeCanvas || this.strokeCanvas.width !== width || this.strokeCanvas.height !== height) {
      this.strokeCanvas = document.createElement('canvas');
      this.strokeCanvas.width = width;
      this.strokeCanvas.height = height;
      this.strokeCtx = this.strokeCanvas.getContext('2d');
      this.liveSession = null;
      this.nonIncrementalPrevRect = null;
    }
    if (!this.scratchCtx || !this.strokeCtx || typeof this.scratchCtx.drawImage !== 'function') return null;
    return {
      scratchCanvas: this.scratchCanvas,
      scratchCtx: this.scratchCtx,
      strokeCanvas: this.strokeCanvas,
      strokeCtx: this.strokeCtx,
    };
  }

  private ensureTipBuffer(width: number, height: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
    if (typeof document === 'undefined') return null;
    if (!this.tipCanvas || this.tipCanvas.width !== width || this.tipCanvas.height !== height) {
      this.tipCanvas = document.createElement('canvas');
      this.tipCanvas.width = width;
      this.tipCanvas.height = height;
      this.tipCtx = this.tipCanvas.getContext('2d');
    }
    if (!this.tipCtx || typeof this.tipCtx.drawImage !== 'function') return null;
    return { canvas: this.tipCanvas, ctx: this.tipCtx };
  }

  registerImage(hash: string, img: HTMLImageElement): void {
    this.imageElements.set(hash, img);
    this.layerCache.clear();
    this.liveSession = null;
    this.lastCompositeKey = '';
  }

  private getBrushTipStamp(
    color: string,
    hardness01: number,
    brushType: BoardBrushType | undefined,
  ): HTMLCanvasElement {
    const hKey = Math.round(hardness01 * 20) / 20;
    const key = `${color}:${hKey}:${brushType ?? 'brush'}`;
    const existing = this.tipCache.get(key);
    if (existing) return existing;

    const size = 64;
    const half = size / 2;
    const tip = document.createElement('canvas');
    tip.width = size;
    tip.height = size;
    const ctx = tip.getContext('2d')!;
    const [r, g, b] = parseHexRgb(color);

    if (brushType === 'marker') {
      ctx.save();
      ctx.translate(half, half);
      ctx.rotate(-0.61);
      ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
      ctx.fillRect(-half * 0.85, -half * 0.28, size * 0.85, size * 0.28);
      ctx.restore();
    } else if (brushType === 'watercolor') {
      const grad = ctx.createRadialGradient(half, half, 0, half, half, half);
      grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0.55)`);
      grad.addColorStop(0.72, `rgba(${r}, ${g}, ${b}, 0.68)`);
      grad.addColorStop(0.9, `rgba(${r}, ${g}, ${b}, 0.88)`);
      grad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, size, size);
    } else if (brushType === 'pencil') {
      const imgData = ctx.createImageData(size, size);
      const data = imgData.data;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const dx = (x + 0.5 - half) / half;
          const dy = (y + 0.5 - half) / half;
          const dist = Math.hypot(dx, dy);
          if (dist > 1) continue;
          const edge = dist > 0.75 ? (1 - dist) / 0.25 : 1;
          const grain = 0.45 + 0.55 * Math.abs(Math.sin(x * 12.9898 + y * 78.233) * Math.cos(x * 4.1414 - y * 9.731));
          const idx = (y * size + x) * 4;
          data[idx] = r;
          data[idx + 1] = g;
          data[idx + 2] = b;
          data[idx + 3] = Math.round(255 * edge * grain);
        }
      }
      ctx.putImageData(imgData, 0, 0);
    } else {
      const effHardness = brushType === 'airbrush'
        ? Math.min(0.15, hKey * 0.25)
        : brushType === 'pen'
          ? Math.max(0.88, hKey)
          : Math.max(0.05, Math.min(0.98, hKey));
      const grad = ctx.createRadialGradient(half, half, half * effHardness * 0.85, half, half, half);
      grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, 1)`);
      grad.addColorStop(Math.max(0.01, effHardness), `rgba(${r}, ${g}, ${b}, 0.92)`);
      grad.addColorStop(Math.min(0.99, effHardness + (1 - effHardness) * 0.55), `rgba(${r}, ${g}, ${b}, 0.35)`);
      grad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, size, size);
    }

    if (this.tipCache.size > 64) {
      const oldest = this.tipCache.keys().next().value;
      if (oldest) this.tipCache.delete(oldest);
    }
    this.tipCache.set(key, tip);
    return tip;
  }

  private renderShapeOntoLayerCtx(
    layerCtx: CanvasRenderingContext2D,
    layerCanvas: HTMLCanvasElement,
    strokeCtx: CanvasRenderingContext2D,
    strokeCanvas: HTMLCanvasElement,
    s: BoardShape,
    width: number,
    height: number,
    alphaLock: boolean,
    clearStrokeRect?: DirtyRect | null,
  ): DirtyRect | null {
    if (s.hidden) return null;
    const opacity = shapeOpacity(s);
    const sx = s.scaleX ?? 1, sy = s.scaleY ?? 1;
    const tx = s.x ?? 0, ty = s.y ?? 0;

    layerCtx.save();
    if (s.clipPolygon?.length) {
      layerCtx.beginPath();
      s.clipPolygon.forEach((p, idx) => {
        const px = tx + p.x * sx, py = ty + p.y * sy;
        if (idx === 0) layerCtx.moveTo(px, py);
        else layerCtx.lineTo(px, py);
      });
      layerCtx.closePath();
      layerCtx.clip('evenodd');
    }

    if (s.tool === 'clear') {
      layerCtx.globalCompositeOperation = 'destination-out';
      layerCtx.fillStyle = '#000000';
      if (s.clipPolygon?.length) {
        layerCtx.fill('evenodd');
      } else {
        layerCtx.clearRect(0, 0, width, height);
      }
      layerCtx.restore();
      return { x: 0, y: 0, w: width, h: height };
    }

    if (alphaLock) {
      layerCtx.globalCompositeOperation = 'source-atop';
    }

    const [a, b = a] = s.points;

    if (s.tool === 'bucket') {
      layerCtx.globalAlpha = opacity;
      layerCtx.fillStyle = s.color;
      if (s.clipPolygon?.length) {
        layerCtx.beginPath();
        s.clipPolygon.forEach((p, idx) => {
          const px = tx + p.x * sx, py = ty + p.y * sy;
          if (idx === 0) layerCtx.moveTo(px, py);
          else layerCtx.lineTo(px, py);
        });
        layerCtx.closePath();
        layerCtx.fill('evenodd');
      } else if (s.points.length === 2) {
        const x0 = tx + Math.min(a.x, b.x) * sx;
        const y0 = ty + Math.min(a.y, b.y) * sy;
        layerCtx.fillRect(x0, y0, Math.abs(b.x - a.x) * sx, Math.abs(b.y - a.y) * sy);
      } else {
        try {
          const imgData = layerCtx.getImageData(0, 0, width, height);
          const seedX = tx + a.x * sx, seedY = ty + a.y * sy;
          const mask = computeFloodMask(
            imgData.data,
            width,
            height,
            seedX,
            seedY,
            s.fillTolerance ?? 32,
            s.fillContiguous !== false,
            s.fillExpand ?? 0,
          );
          const [cr, cg, cb] = parseHexRgb(s.color);
          const fillAlpha = Math.round(opacity * 255);
          const data = imgData.data;
          for (let i = 0; i < width * height; i++) {
            if (mask[i] > 0) {
              const idx4 = i * 4;
              if (alphaLock && data[idx4 + 3] === 0) continue;
              const sA = fillAlpha / 255;
              const dA = data[idx4 + 3] / 255;
              const outA = sA + dA * (1 - sA);
              if (outA > 0) {
                data[idx4] = Math.round((cr * sA + data[idx4] * dA * (1 - sA)) / outA);
                data[idx4 + 1] = Math.round((cg * sA + data[idx4 + 1] * dA * (1 - sA)) / outA);
                data[idx4 + 2] = Math.round((cb * sA + data[idx4 + 2] * dA * (1 - sA)) / outA);
                data[idx4 + 3] = alphaLock ? data[idx4 + 3] : Math.round(outA * 255);
              }
            }
          }
          layerCtx.putImageData(imgData, 0, 0);
        } catch {
          layerCtx.fillRect(0, 0, width, height);
        }
      }
      layerCtx.restore();
      return { x: 0, y: 0, w: width, h: height };
    }

    if (s.tool === 'gradient') {
      const ax = tx + a.x * sx, ay = ty + a.y * sy;
      const bx = tx + b.x * sx, by = ty + b.y * sy;
      const grad = s.gradientType === 'radial'
        ? layerCtx.createRadialGradient(ax, ay, 0, ax, ay, Math.max(1, Math.hypot(bx - ax, by - ay)))
        : layerCtx.createLinearGradient(ax, ay, bx, by);
      grad.addColorStop(0, s.color);
      if (s.gradientTransparent) {
        const [r, g, bl] = parseHexRgb(s.color);
        grad.addColorStop(1, `rgba(${r}, ${g}, ${bl}, 0)`);
      } else {
        grad.addColorStop(1, s.secondaryColor ?? '#ffffff');
      }
      layerCtx.globalAlpha = opacity;
      layerCtx.fillStyle = grad;
      layerCtx.fillRect(0, 0, width, height);
      layerCtx.restore();
      return { x: 0, y: 0, w: width, h: height };
    }

    if (s.tool === 'text' && s.text) {
      const fontSize = Math.max(8, Math.round((s.fontSize ?? Math.max(14, s.width * 2)) * ((sx + sy) / 2)));
      layerCtx.globalAlpha = opacity;
      layerCtx.fillStyle = s.color;
      layerCtx.font = `${s.fontItalic ? 'italic ' : ''}${s.fontBold ? 'bold ' : ''}${fontSize}px sans-serif`;
      const lines = s.text.split('\n');
      let maxChars = 1;
      lines.forEach((line, idx) => {
        if (line.length > maxChars) maxChars = line.length;
        layerCtx.fillText(line, tx + a.x * sx, ty + a.y * sy + (idx === 0 ? fontSize : fontSize + idx * fontSize * 1.25));
      });
      layerCtx.restore();
      return clampRect({
        x: tx + a.x * sx - 4,
        y: ty + a.y * sy - 4,
        w: maxChars * fontSize * 0.8 + 16,
        h: lines.length * fontSize * 1.4 + 16,
      }, width, height);
    }

    if (s.tool === 'image' && s.imageHash) {
      const img = this.imageElements.get(s.imageHash);
      if (img && img.complete && (img.naturalWidth > 0 || img.width > 0)) {
        const x0 = tx + Math.min(a.x, b.x) * sx;
        const y0 = ty + Math.min(a.y, b.y) * sy;
        const w = Math.abs(b.x - a.x) * sx;
        const h = Math.abs(b.y - a.y) * sy;
        layerCtx.save();
        layerCtx.globalAlpha = opacity;
        if (s.flipX || s.flipY) {
          layerCtx.translate(x0 + w / 2, y0 + h / 2);
          layerCtx.scale(s.flipX ? -1 : 1, s.flipY ? -1 : 1);
          layerCtx.drawImage(img, -w / 2, -h / 2, w, h);
        } else {
          layerCtx.drawImage(img, x0, y0, w, h);
        }
        layerCtx.restore();
        layerCtx.restore();
        return clampRect({ x: x0 - 2, y: y0 - 2, w: w + 4, h: h + 4 }, width, height);
      }
      layerCtx.restore();
      return null;
    }

    if (s.tool === 'rectangle' || s.tool === 'ellipse' || s.tool === 'line') {
      const ax = tx + a.x * sx, ay = ty + a.y * sy;
      const bx = tx + b.x * sx, by = ty + b.y * sy;
      const lw = Math.max(1, s.width * ((sx + sy) / 2));
      layerCtx.globalAlpha = opacity;
      layerCtx.strokeStyle = s.color;
      layerCtx.fillStyle = s.color;
      layerCtx.lineWidth = lw;
      layerCtx.lineCap = 'round';
      layerCtx.lineJoin = 'round';
      layerCtx.beginPath();
      if (s.tool === 'line') {
        layerCtx.moveTo(ax, ay);
        layerCtx.lineTo(bx, by);
        layerCtx.stroke();
      } else if (s.tool === 'rectangle') {
        const rx = Math.min(ax, bx), ry = Math.min(ay, by);
        const rw = Math.abs(bx - ax), rh = Math.abs(by - ay);
        if (s.filled) layerCtx.fillRect(rx, ry, rw, rh);
        layerCtx.strokeRect(rx, ry, rw, rh);
      } else {
        const cx = (ax + bx) / 2, cy = (ay + by) / 2;
        const rx = Math.abs(bx - ax) / 2, ry = Math.abs(by - ay) / 2;
        layerCtx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
        if (s.filled) layerCtx.fill();
        layerCtx.stroke();
      }
      layerCtx.restore();
      const pad = lw / 2 + 3;
      const x0 = Math.min(ax, bx) - pad;
      const y0 = Math.min(ay, by) - pad;
      return clampRect({ x: x0, y: y0, w: Math.abs(bx - ax) + pad * 2, h: Math.abs(by - ay) + pad * 2 }, width, height);
    }

    // Brush & Eraser rendering on pixel canvas
    const mappedPoints = s.points.map(p => ({
      x: tx + p.x * sx,
      y: ty + p.y * sy,
      ...(p.p !== undefined ? { p: p.p } : {}),
    }));
    const symmetryLists = expandSymmetryPointLists(mappedPoints, s.symmetry, width / 2, height / 2);
    const hasPressure = s.points.some(p => p.p !== undefined);
    const profile = brushProfile(s, hasPressure);
    const scaleAvg = (sx + sy) / 2;

    if (s.tool === 'eraser') {
      layerCtx.globalCompositeOperation = 'destination-out';
      layerCtx.globalAlpha = opacity;
      const hardness01 = Math.max(0.05, Math.min(1, (s.hardness ?? 85) / 100));
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      if (hardness01 >= 0.85 && !hasPressure) {
        const lw = Math.max(1, s.width * scaleAvg);
        const pad = lw / 2 + 2;
        layerCtx.strokeStyle = '#000000';
        layerCtx.lineWidth = lw;
        layerCtx.lineCap = 'round';
        layerCtx.lineJoin = 'round';
        for (const pts of symmetryLists) {
          layerCtx.beginPath();
          pts.forEach((p, idx) => {
            if (p.x - pad < minX) minX = p.x - pad;
            if (p.y - pad < minY) minY = p.y - pad;
            if (p.x + pad > maxX) maxX = p.x + pad;
            if (p.y + pad > maxY) maxY = p.y + pad;
            if (idx === 0) layerCtx.moveTo(p.x, p.y);
            else layerCtx.lineTo(p.x, p.y);
          });
          if (pts.length === 1) layerCtx.lineTo(pts[0].x + 0.01, pts[0].y);
          layerCtx.stroke();
        }
        layerCtx.restore();
        return maxX >= minX ? clampRect({ x: minX, y: minY, w: maxX - minX, h: maxY - minY }, width, height) : null;
      }
      const tip = this.getBrushTipStamp('#000000', hardness01, 'brush');
      const bounds = this.stampStrokeLists(layerCtx, symmetryLists, s, tip, profile, hasPressure, scaleAvg, 1);
      layerCtx.restore();
      return bounds;
    }

    // 1. Pixel Art Brush
    if (s.brushType === 'pixel') {
      const cell = Math.max(1, Math.round(s.width * scaleAvg));
      layerCtx.globalAlpha = opacity;
      layerCtx.fillStyle = s.color;
      layerCtx.imageSmoothingEnabled = false;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const pts of symmetryLists) {
        if (!pts.length) continue;
        const visited = new Set<number>();
        const fillCell = (gx: number, gy: number) => {
          const key = (gy + 16384) * 32768 + (gx + 16384);
          if (visited.has(key)) return;
          visited.add(key);
          const rx = gx * cell - Math.floor(cell / 2);
          const ry = gy * cell - Math.floor(cell / 2);
          layerCtx.fillRect(rx, ry, cell, cell);
          if (rx < minX) minX = rx;
          if (ry < minY) minY = ry;
          if (rx + cell > maxX) maxX = rx + cell;
          if (ry + cell > maxY) maxY = ry + cell;
        };
        let gx0 = Math.round(pts[0].x / cell);
        let gy0 = Math.round(pts[0].y / cell);
        fillCell(gx0, gy0);
        for (let i = 1; i < pts.length; i++) {
          const gx1 = Math.round(pts[i].x / cell);
          const gy1 = Math.round(pts[i].y / cell);
          const dx = Math.abs(gx1 - gx0), stepX = gx0 < gx1 ? 1 : -1;
          const dy = -Math.abs(gy1 - gy0), stepY = gy0 < gy1 ? 1 : -1;
          let err = dx + dy;
          while (true) {
            fillCell(gx0, gy0);
            if (gx0 === gx1 && gy0 === gy1) break;
            const e2 = 2 * err;
            if (e2 >= dy) { err += dy; gx0 += stepX; }
            if (e2 <= dx) { err += dx; gy0 += stepY; }
          }
        }
      }
      layerCtx.imageSmoothingEnabled = true;
      layerCtx.restore();
      return maxX >= minX ? clampRect({ x: minX - 1, y: minY - 1, w: maxX - minX + 2, h: maxY - minY + 2 }, width, height) : null;
    }

    // 2. Smudge Brush
    if (s.brushType === 'smudge') {
      const rad = Math.max(2, s.width * 0.55 * scaleAvg);
      const diam = rad * 2;
      const stepDist = Math.max(1.5, rad * 0.35);
      const strength = Math.max(0.15, Math.min(0.85, ((s.flow ?? 65) / 100) * opacity));
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const pts of symmetryLists) {
        const interp = brushHitPoints({ ...s, points: pts });
        if (interp.length < 2) continue;
        let prev = interp[0];
        for (let i = 1; i < interp.length; i++) {
          const cur = interp[i];
          const seg = Math.hypot(cur.x - prev.x, cur.y - prev.y);
          const steps = Math.max(1, Math.ceil(seg / stepDist));
          for (let k = 1; k <= steps; k++) {
            const t = k / steps;
            const nx = prev.x + (cur.x - prev.x) * t;
            const ny = prev.y + (cur.y - prev.y) * t;
            const sx0 = Math.max(0, Math.min(width - diam, prev.x - rad));
            const sy0 = Math.max(0, Math.min(height - diam, prev.y - rad));
            layerCtx.save();
            layerCtx.beginPath();
            layerCtx.arc(nx, ny, rad, 0, Math.PI * 2);
            layerCtx.clip();
            layerCtx.globalAlpha = strength;
            layerCtx.drawImage(layerCanvas, sx0, sy0, diam, diam, nx - rad, ny - rad, diam, diam);
            layerCtx.restore();
            if (nx - rad < minX) minX = nx - rad;
            if (ny - rad < minY) minY = ny - rad;
            if (nx + rad > maxX) maxX = nx + rad;
            if (ny + rad > maxY) maxY = ny + rad;
            prev = { x: nx, y: ny };
          }
        }
      }
      layerCtx.restore();
      return maxX >= minX ? clampRect({ x: minX - 2, y: minY - 2, w: maxX - minX + 4, h: maxY - minY + 4 }, width, height) : null;
    }

    // 3. Blur Brush (region-scoped Gaussian blur + spaced dabs)
    if (s.brushType === 'blur') {
      const rad = Math.max(3, s.width * 0.65 * scaleAvg);
      const blurPx = Math.max(2, Math.round(rad * 0.45));
      const pad = rad + blurPx * 3 + 4;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const pts of symmetryLists) {
        for (let i = 0; i < pts.length; i++) {
          if (pts[i].x < minX) minX = pts[i].x;
          if (pts[i].y < minY) minY = pts[i].y;
          if (pts[i].x > maxX) maxX = pts[i].x;
          if (pts[i].y > maxY) maxY = pts[i].y;
        }
      }
      const region = clampRect({ x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 }, width, height);
      if (!region) {
        layerCtx.restore();
        return null;
      }
      strokeCtx.clearRect(region.x, region.y, region.w, region.h);
      strokeCtx.save();
      strokeCtx.beginPath();
      strokeCtx.rect(region.x, region.y, region.w, region.h);
      strokeCtx.clip();
      strokeCtx.filter = `blur(${blurPx}px)`;
      strokeCtx.drawImage(layerCanvas, region.x, region.y, region.w, region.h, region.x, region.y, region.w, region.h);
      strokeCtx.restore();

      const stepDist = Math.max(2, rad * 0.45);
      const diam = rad * 2;
      for (const pts of symmetryLists) {
        const interp = brushHitPoints({ ...s, points: pts });
        if (!interp.length) continue;
        let lastX = interp[0].x, lastY = interp[0].y;
        const applyBlurDab = (px: number, py: number) => {
          const sx0 = Math.max(0, px - rad);
          const sy0 = Math.max(0, py - rad);
          const sx1 = Math.min(width, px + rad);
          const sy1 = Math.min(height, py + rad);
          const sw = sx1 - sx0, sh = sy1 - sy0;
          if (sw <= 0 || sh <= 0) return;
          layerCtx.save();
          layerCtx.beginPath();
          layerCtx.arc(px, py, rad, 0, Math.PI * 2);
          layerCtx.clip();
          layerCtx.globalAlpha = opacity * 0.45;
          layerCtx.drawImage(strokeCanvas, sx0, sy0, sw, sh, sx0, sy0, sw, sh);
          layerCtx.restore();
        };
        applyBlurDab(lastX, lastY);
        for (let i = 1; i < interp.length; i++) {
          const cur = interp[i];
          if (Math.hypot(cur.x - lastX, cur.y - lastY) >= stepDist) {
            applyBlurDab(cur.x, cur.y);
            lastX = cur.x;
            lastY = cur.y;
          }
        }
      }
      void diam;
      layerCtx.restore();
      return region;
    }

    // 4. G-Pen ('pen') & Chisel Marker ('marker') when Path2D is available
    if ((s.brushType === 'pen' || s.brushType === 'marker') && typeof Path2D === 'function') {
      layerCtx.save();
      if (s.brushType === 'marker') {
        layerCtx.globalCompositeOperation = alphaLock ? 'source-atop' : 'multiply';
        layerCtx.globalAlpha = opacity * 0.72;
      } else {
        layerCtx.globalAlpha = opacity;
      }
      layerCtx.fillStyle = s.color;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      const pad = Math.max(4, s.width * scaleAvg);
      for (const pts of symmetryLists) {
        for (let i = 0; i < pts.length; i++) {
          if (pts[i].x - pad < minX) minX = pts[i].x - pad;
          if (pts[i].y - pad < minY) minY = pts[i].y - pad;
          if (pts[i].x + pad > maxX) maxX = pts[i].x + pad;
          if (pts[i].y + pad > maxY) maxY = pts[i].y + pad;
        }
        const sub: BoardShape = { ...s, points: pts, x: 0, y: 0, scaleX: 1, scaleY: 1, width: s.width * scaleAvg };
        const d = s.brushType === 'marker' ? chiselMarkerPath(sub) : gPenCalligraphicPath(sub);
        if (d) {
          layerCtx.fill(new Path2D(d), 'nonzero');
        }
      }
      layerCtx.restore();
      layerCtx.restore();
      return maxX >= minX ? clampRect({ x: minX, y: minY, w: maxX - minX, h: maxY - minY }, width, height) : null;
    }

    // 5. Stamp-based brushes: Pencil, Brush (Oil/Acrylic), Airbrush, Watercolor
    const hardness01 = Math.max(0, Math.min(1, (s.hardness ?? profile.defaultHardness) / 100));
    const flow01 = Math.max(0.02, Math.min(1, (s.flow ?? profile.defaultFlow) / 100));
    const tip = this.getBrushTipStamp(s.color, hardness01, s.brushType);

    if (clearStrokeRect) {
      strokeCtx.clearRect(clearStrokeRect.x, clearStrokeRect.y, clearStrokeRect.w, clearStrokeRect.h);
    } else {
      strokeCtx.clearRect(0, 0, width, height);
    }
    const bounds = this.stampStrokeLists(
      strokeCtx,
      symmetryLists,
      s,
      tip,
      profile,
      hasPressure,
      scaleAvg,
      s.brushType === 'airbrush' ? flow01 * 0.42 : s.brushType === 'watercolor' ? flow01 * 0.55 : flow01,
    );

    if (bounds) {
      layerCtx.save();
      if (s.brushType === 'watercolor' && !alphaLock) {
        layerCtx.globalCompositeOperation = 'multiply';
      }
      layerCtx.globalAlpha = opacity;
      layerCtx.drawImage(
        strokeCanvas,
        bounds.x,
        bounds.y,
        bounds.w,
        bounds.h,
        bounds.x,
        bounds.y,
        bounds.w,
        bounds.h,
      );
      layerCtx.restore();
    }
    layerCtx.restore();
    return bounds;
  }

  private stampInterpolatedList(
    ctx: CanvasRenderingContext2D,
    interp: BoardPoint[],
    s: BoardShape,
    tip: HTMLCanvasElement,
    profile: ReturnType<typeof brushProfile>,
    hasPressure: boolean,
    scaleAvg: number,
    dabAlphaBase: number,
    initialResidual = 0,
    stampStart = true,
  ): { bounds: DirtyRect | null; residual: number } {
    if (!interp.length) return { bounds: null, residual: initialResidual };
    const baseRadius = Math.max(0.75, profile.base * scaleAvg);
    const spacingRatio = s.brushType === 'airbrush'
      ? 0.14
      : s.brushType === 'watercolor'
        ? 0.16
        : s.brushType === 'pencil'
          ? 0.18
          : Math.max(0.08, Math.min(0.5, (s.spacing ?? 14) / 100));
    const stepDist = Math.max(0.6, baseRadius * 2 * spacingRatio);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    const stampDab = (x: number, y: number, p: number) => {
      const pVal = Math.max(0.05, Math.min(1, p));
      const pScale = hasPressure && s.pressureSize !== false
        ? profile.min + (profile.max - profile.min) * Math.pow(pVal, profile.exp)
        : 1;
      const r = Math.max(0.6, baseRadius * pScale * (s.brushType === 'airbrush' ? 1.35 : 1));
      const alpha = dabAlphaBase * (hasPressure && s.pressureOpacity !== false ? Math.pow(pVal, 0.85) : 1);
      ctx.globalAlpha = Math.max(0.02, Math.min(1, alpha));
      ctx.drawImage(tip, x - r, y - r, r * 2, r * 2);
      if (x - r < minX) minX = x - r;
      if (y - r < minY) minY = y - r;
      if (x + r > maxX) maxX = x + r;
      if (y + r > maxY) maxY = y + r;
    };

    if (stampStart) {
      stampDab(interp[0].x, interp[0].y, interp[0].p ?? 0.5);
    }
    let residual = initialResidual;
    for (let i = 1; i < interp.length; i++) {
      const a = interp[i - 1], b = interp[i];
      const segLen = Math.hypot(b.x - a.x, b.y - a.y);
      if (segLen < 1e-4) continue;
      let d = stepDist - residual;
      while (d <= segLen) {
        const t = d / segLen;
        stampDab(
          a.x + (b.x - a.x) * t,
          a.y + (b.y - a.y) * t,
          (a.p ?? 0.5) + ((b.p ?? 0.5) - (a.p ?? 0.5)) * t,
        );
        d += stepDist;
      }
      residual = segLen - (d - stepDist);
    }

    if (maxX < minX || maxY < minY) return { bounds: null, residual };
    const bounds = clampRect({ x: minX - 2, y: minY - 2, w: maxX - minX + 4, h: maxY - minY + 4 }, ctx.canvas.width, ctx.canvas.height);
    return { bounds, residual };
  }

  private stampStrokeLists(
    ctx: CanvasRenderingContext2D,
    symmetryLists: BoardPoint[][],
    s: BoardShape,
    tip: HTMLCanvasElement,
    profile: ReturnType<typeof brushProfile>,
    hasPressure: boolean,
    scaleAvg: number,
    dabAlphaBase: number,
  ): DirtyRect | null {
    let union: DirtyRect | null = null;
    for (const pts of symmetryLists) {
      const interp = brushHitPoints({ ...s, points: pts });
      const { bounds } = this.stampInterpolatedList(ctx, interp, s, tip, profile, hasPressure, scaleAvg, dabAlphaBase, 0, true);
      union = unionRects(union, bounds);
    }
    return union;
  }

  private updateIncrementalLiveStroke(
    entry: LayerCanvasEntry,
    scratchCanvas: HTMLCanvasElement,
    scratchCtx: CanvasRenderingContext2D,
    strokeCanvas: HTMLCanvasElement,
    strokeCtx: CanvasRenderingContext2D,
    d: BoardShape,
    width: number,
    height: number,
    alphaLock: boolean,
  ): DirtyRect | null {
    const sig = liveSessionSignature(d, alphaLock);
    const canIncremental = isIncrementalStampShape(d);
    const sx = d.scaleX ?? 1, sy = d.scaleY ?? 1;
    const tx = d.x ?? 0, ty = d.y ?? 0;
    const scaleAvg = (sx + sy) / 2;
    const opacity = shapeOpacity(d);

    let session = this.liveSession;
    const matchesExisting = Boolean(
      session &&
      canIncremental &&
      session.incremental &&
      session.shapeId === d.id &&
      session.layerId === (d.layerId ?? DEFAULT_BOARD_LAYER) &&
      session.layerVersion === entry.version &&
      session.signature === sig &&
      d.points.length >= Math.max(1, session.finalizedEndIdx + 1),
    );

    if (!session || !matchesExisting || !canIncremental) {
      if (!canIncremental) {
        this.liveSession = null;
        const approxBounds = this.estimateShapeDirtyRect(d, width, height);
        const clearRegion = unionRects(this.nonIncrementalPrevRect, approxBounds);
        scratchCtx.clearRect(0, 0, width, height);
        scratchCtx.drawImage(entry.canvas, 0, 0);
        const nextRect = this.renderShapeOntoLayerCtx(
          scratchCtx,
          scratchCanvas,
          strokeCtx,
          strokeCanvas,
          d,
          width,
          height,
          alphaLock,
          clearRegion,
        );
        const dirty = unionRects(this.nonIncrementalPrevRect, nextRect);
        this.nonIncrementalPrevRect = nextRect;
        return dirty ?? { x: 0, y: 0, w: width, h: height };
      }

      // Initialize a fresh incremental stroke session
      this.nonIncrementalPrevRect = null;
      scratchCtx.clearRect(0, 0, width, height);
      scratchCtx.drawImage(entry.canvas, 0, 0);
      strokeCtx.clearRect(0, 0, width, height);
      const copyCount = expandSymmetryPointLists([{ x: 0, y: 0 }], d.symmetry, width / 2, height / 2).length;
      session = {
        shapeId: d.id,
        layerId: d.layerId ?? DEFAULT_BOARD_LAYER,
        layerVersion: entry.version,
        signature: sig,
        alphaLock,
        finalizedEndIdx: -1,
        residuals: new Array(copyCount).fill(0),
        dirtyRect: null,
        tipRect: null,
        lastOpacity: opacity,
        incremental: true,
      };
      this.liveSession = session;
    }

    const mappedPoints = d.points.map(p => ({
      x: tx + p.x * sx,
      y: ty + p.y * sy,
      ...(p.p !== undefined ? { p: p.p } : {}),
    }));
    const symmetryLists = expandSymmetryPointLists(mappedPoints, d.symmetry, width / 2, height / 2);
    const hasPressure = d.points.some(p => p.p !== undefined);
    const profile = brushProfile(d, hasPressure);
    const hasSubdivide = Boolean(d.smoothing) || Boolean(d.brushType) || hasPressure;
    const isEraser = d.tool === 'eraser';
    const hardness01 = isEraser
      ? Math.max(0.05, Math.min(1, (d.hardness ?? 85) / 100))
      : Math.max(0, Math.min(1, (d.hardness ?? profile.defaultHardness) / 100));
    const flow01 = isEraser ? 1 : Math.max(0.02, Math.min(1, (d.flow ?? profile.defaultFlow) / 100));
    const dabAlphaBase = isEraser
      ? 1
      : d.brushType === 'airbrush'
        ? flow01 * 0.42
        : d.brushType === 'watercolor'
          ? flow01 * 0.55
          : flow01;
    const tip = this.getBrushTipStamp(isEraser ? '#000000' : d.color, hardness01, isEraser ? 'brush' : d.brushType);

    // Finalize any newly completed segments [0 .. d.points.length - 1]
    const targetEndIdx = d.points.length - 1;
    let stepRect: DirtyRect | null = null;

    if (d.points.length === 1 && session.finalizedEndIdx < 0) {
      for (let c = 0; c < symmetryLists.length; c++) {
        const pts = symmetryLists[c];
        const { bounds } = this.stampInterpolatedList(strokeCtx, pts, d, tip, profile, hasPressure, scaleAvg, dabAlphaBase, 0, true);
        stepRect = unionRects(stepRect, bounds);
      }
      session.finalizedEndIdx = 0;
      session.dirtyRect = unionRects(session.dirtyRect, stepRect);
    } else if (d.points.length >= 2 && targetEndIdx > session.finalizedEndIdx) {
      const fromIdx = Math.max(0, session.finalizedEndIdx);
      const toIdx = targetEndIdx;
      const stampStart = session.finalizedEndIdx < 0;
      for (let c = 0; c < symmetryLists.length; c++) {
        const pts = symmetryLists[c];
        const segPts = buildFinalizedSegments(pts, fromIdx, toIdx, Boolean(d.smoothing), hasSubdivide);
        if (segPts.length) {
          const { bounds, residual } = this.stampInterpolatedList(
            strokeCtx,
            segPts,
            d,
            tip,
            profile,
            hasPressure,
            scaleAvg,
            dabAlphaBase,
            session.residuals[c] ?? 0,
            stampStart,
          );
          session.residuals[c] = residual;
          stepRect = unionRects(stepRect, bounds);
        }
      }
      session.finalizedEndIdx = toIdx;
      session.dirtyRect = unionRects(session.dirtyRect, stepRect);
    }

    // Build unfinalized tail segment on tipCanvas (only when subdivided Bezier curves leave a trailing half-segment)
    let currentTipRect: DirtyRect | null = null;
    const tipBuf = hasSubdivide && d.points.length >= 2 ? this.ensureTipBuffer(width, height) : null;
    if (tipBuf && d.points.length >= 2) {
      const lastPt = mappedPoints[mappedPoints.length - 1];
      const prevPt = mappedPoints[mappedPoints.length - 2];
      const approxTipPad = Math.max(8, profile.base * scaleAvg * 2.5);
      const tipApprox = clampRect({
        x: Math.min(prevPt.x, lastPt.x) - approxTipPad,
        y: Math.min(prevPt.y, lastPt.y) - approxTipPad,
        w: Math.abs(lastPt.x - prevPt.x) + approxTipPad * 2,
        h: Math.abs(lastPt.y - prevPt.y) + approxTipPad * 2,
      }, width, height);
      if (d.symmetry && d.symmetry !== 'none') {
        tipBuf.ctx.clearRect(0, 0, width, height);
      } else if (tipApprox) {
        tipBuf.ctx.clearRect(tipApprox.x, tipApprox.y, tipApprox.w, tipApprox.h);
      }
      for (let c = 0; c < symmetryLists.length; c++) {
        const tailPts = buildTailSegment(symmetryLists[c], Boolean(d.smoothing), hasSubdivide);
        if (tailPts.length >= 2) {
          const { bounds } = this.stampInterpolatedList(
            tipBuf.ctx,
            tailPts,
            d,
            tip,
            profile,
            hasPressure,
            scaleAvg,
            dabAlphaBase,
            session.residuals[c] ?? 0,
            false,
          );
          currentTipRect = unionRects(currentTipRect, bounds);
        }
      }
    }

    // Determine exact dirty region to update on scratchCanvas
    const opacityChanged = Math.abs(opacity - session.lastOpacity) > 0.001;
    session.lastOpacity = opacity;
    const dirtyOnScratch = clampRect(
      unionRects(
        unionRects(session.tipRect, currentTipRect),
        opacityChanged ? session.dirtyRect : stepRect,
      ),
      width,
      height,
    );
    session.tipRect = currentTipRect;

    if (dirtyOnScratch) {
      const { x, y, w, h } = dirtyOnScratch;
      scratchCtx.save();
      scratchCtx.beginPath();
      scratchCtx.rect(x, y, w, h);
      scratchCtx.clip();
      scratchCtx.clearRect(x, y, w, h);
      scratchCtx.drawImage(entry.canvas, x, y, w, h, x, y, w, h);

      if (d.clipPolygon?.length) {
        scratchCtx.beginPath();
        d.clipPolygon.forEach((p, idx) => {
          const px = tx + p.x * sx, py = ty + p.y * sy;
          if (idx === 0) scratchCtx.moveTo(px, py);
          else scratchCtx.lineTo(px, py);
        });
        scratchCtx.closePath();
        scratchCtx.clip('evenodd');
      }

      if (isEraser) {
        scratchCtx.globalCompositeOperation = 'destination-out';
      } else if (alphaLock) {
        scratchCtx.globalCompositeOperation = 'source-atop';
      } else if (d.brushType === 'watercolor') {
        scratchCtx.globalCompositeOperation = 'multiply';
      }
      scratchCtx.globalAlpha = opacity;
      scratchCtx.drawImage(strokeCanvas, x, y, w, h, x, y, w, h);
      if (tipBuf && currentTipRect) {
        const tx0 = Math.max(x, currentTipRect.x);
        const ty0 = Math.max(y, currentTipRect.y);
        const tx1 = Math.min(x + w, currentTipRect.x + currentTipRect.w);
        const ty1 = Math.min(y + h, currentTipRect.y + currentTipRect.h);
        if (tx1 > tx0 && ty1 > ty0) {
          scratchCtx.drawImage(tipBuf.canvas, tx0, ty0, tx1 - tx0, ty1 - ty0, tx0, ty0, tx1 - tx0, ty1 - ty0);
        }
      }
      scratchCtx.restore();
    }

    return dirtyOnScratch;
  }

  private estimateShapeDirtyRect(s: BoardShape, width: number, height: number): DirtyRect | null {
    if (!s.points.length) return null;
    const sx = s.scaleX ?? 1, sy = s.scaleY ?? 1;
    const tx = s.x ?? 0, ty = s.y ?? 0;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < s.points.length; i++) {
      const px = tx + s.points[i].x * sx;
      const py = ty + s.points[i].y * sy;
      if (px < minX) minX = px;
      if (py < minY) minY = py;
      if (px > maxX) maxX = px;
      if (py > maxY) maxY = py;
    }
    const pad = Math.max(8, s.width * Math.max(sx, sy) * 1.5);
    return clampRect({ x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 }, width, height);
  }

  private ensureLayerEntry(
    layer: BoardLayer,
    committedShapes: readonly BoardShape[],
    width: number,
    height: number,
    scratch: { scratchCanvas: HTMLCanvasElement; scratchCtx: CanvasRenderingContext2D; strokeCanvas: HTMLCanvasElement; strokeCtx: CanvasRenderingContext2D },
    skipRebuild: boolean,
  ): { entry: LayerCanvasEntry; changed: boolean; dirtyRect: DirtyRect | null } | null {
    const alphaLock = Boolean(layer.alphaLock);
    let entry = this.layerCache.get(layer.id);
    let created = false;
    if (!entry || entry.width !== width || entry.height !== height) {
      const c = document.createElement('canvas');
      c.width = width;
      c.height = height;
      const lCtx = c.getContext('2d');
      if (!lCtx) return null;
      entry = { canvas: c, ctx: lCtx, renderedIds: [], alphaLock, width, height, version: 1 };
      this.layerCache.set(layer.id, entry);
      created = true;
    }

    if (skipRebuild) {
      return { entry, changed: created, dirtyRect: null };
    }

    const nextIds = committedShapes.map(shapeSignature);
    const sameAlphaLock = entry.alphaLock === alphaLock;
    const isPrefixMatch = sameAlphaLock &&
      entry.renderedIds.length <= nextIds.length &&
      entry.renderedIds.every((id, idx) => id === nextIds[idx]);

    if (!isPrefixMatch) {
      entry.ctx.clearRect(0, 0, width, height);
      entry.alphaLock = alphaLock;
      for (const s of committedShapes) {
        this.renderShapeOntoLayerCtx(entry.ctx, entry.canvas, scratch.strokeCtx, scratch.strokeCanvas, s, width, height, alphaLock);
      }
      entry.renderedIds = nextIds;
      entry.version++;
      if (this.liveSession?.layerId === layer.id) this.liveSession = null;
      return { entry, changed: true, dirtyRect: { x: 0, y: 0, w: width, h: height } };
    }

    if (entry.renderedIds.length < nextIds.length) {
      let dirty: DirtyRect | null = null;
      const startIdx = entry.renderedIds.length;

      // Zero-re-stamp fast commit when the single newly appended shape matches our active live stroke session
      if (
        startIdx === committedShapes.length - 1 &&
        this.liveSession &&
        this.liveSession.incremental &&
        this.liveSession.layerId === layer.id &&
        this.liveSession.layerVersion === entry.version &&
        this.liveSession.alphaLock === alphaLock &&
        committedShapes[startIdx].id === this.liveSession.shapeId
      ) {
        const committed = committedShapes[startIdx];
        // Finish the tail segment onto scratch if needed, or copy liveSession.dirtyRect
        const fullLiveRect = this.updateIncrementalLiveStroke(
          entry,
          scratch.scratchCanvas,
          scratch.scratchCtx,
          scratch.strokeCanvas,
          scratch.strokeCtx,
          committed,
          width,
          height,
          alphaLock,
        );
        const blitRect = clampRect(unionRects(this.liveSession.dirtyRect, fullLiveRect), width, height);
        if (blitRect) {
          entry.ctx.clearRect(blitRect.x, blitRect.y, blitRect.w, blitRect.h);
          entry.ctx.drawImage(
            scratch.scratchCanvas,
            blitRect.x,
            blitRect.y,
            blitRect.w,
            blitRect.h,
            blitRect.x,
            blitRect.y,
            blitRect.w,
            blitRect.h,
          );
        }
        this.liveSession = null;
        entry.renderedIds = nextIds;
        entry.version++;
        return { entry, changed: true, dirtyRect: blitRect };
      }

      for (let i = startIdx; i < committedShapes.length; i++) {
        const r = this.renderShapeOntoLayerCtx(
          entry.ctx,
          entry.canvas,
          scratch.strokeCtx,
          scratch.strokeCanvas,
          committedShapes[i],
          width,
          height,
          alphaLock,
        );
        dirty = unionRects(dirty, r);
      }
      entry.renderedIds = nextIds;
      entry.version++;
      if (this.liveSession?.layerId === layer.id) this.liveSession = null;
      return { entry, changed: true, dirtyRect: dirty };
    }

    return { entry, changed: created, dirtyRect: null };
  }

  /**
   * Synchronizes per-layer offscreen canvases and returns the ordered composite descriptor list.
   * Returns `null` if HTML5 2D Canvas is unavailable (e.g. headless JSDOM).
   */
  syncLayers(
    targetProbeCanvas: HTMLCanvasElement | null,
    layers: readonly BoardLayer[],
    shapes: readonly BoardShape[],
    draftsByLayer: ReadonlyMap<string, BoardShape[]>,
    movingLayer: BoardLayer | null,
    resizingPreview: { id: string; layer: BoardLayer; shapes: BoardShape[]; fromBounds: BoardBox; bounds: BoardBox } | null,
    width: number,
    height: number,
    backgroundColor: string,
    transparent: boolean,
  ): SyncLayersResult | null {
    if (targetProbeCanvas && this.unsupportedCanvas.has(targetProbeCanvas)) return null;
    if (typeof document === 'undefined') return null;
    if (targetProbeCanvas) {
      const probe = targetProbeCanvas.getContext('2d');
      if (!probe || typeof probe.clearRect !== 'function' || typeof probe.save !== 'function' || typeof probe.createRadialGradient !== 'function') {
        this.unsupportedCanvas.add(targetProbeCanvas);
        return null;
      }
    }
    const scratch = this.ensureScratch(width, height);
    if (!scratch) return null;

    const activeIds = new Set(layers.map(l => l.id));
    for (const cachedId of this.layerCache.keys()) {
      if (!activeIds.has(cachedId)) this.layerCache.delete(cachedId);
    }

    const shapesByLayer = new Map<string, BoardShape[]>();
    for (let i = 0; i < shapes.length; i++) {
      const s = shapes[i];
      if (s.hidden) continue;
      const lid = s.layerId ?? DEFAULT_BOARD_LAYER;
      let arr = shapesByLayer.get(lid);
      if (!arr) {
        arr = [];
        shapesByLayer.set(lid, arr);
      }
      arr.push(s);
    }

    let hasAnyDraft = false;
    for (const arr of draftsByLayer.values()) {
      if (arr.length > 0) { hasAnyDraft = true; break; }
    }
    if (!hasAnyDraft) {
      this.nonIncrementalPrevRect = null;
    }

    const items: LayerCompositeItem[] = [];
    const keyParts: string[] = [`${width}x${height}:${transparent ? 'T' : backgroundColor}`];
    let baseLayerId: string | null = null;
    let anyDirty = false;

    for (const rawLayer of layers) {
      if (rawLayer.hidden || rawLayer.deleted) continue;
      const isResizing = resizingPreview?.id === rawLayer.id;
      const view = isResizing
        ? resizingPreview!.layer
        : movingLayer?.id === rawLayer.id
          ? movingLayer
          : rawLayer;
      const layerOpacity = Math.max(0, Math.min(100, view.opacity ?? 100)) / 100;
      if (layerOpacity <= 0) continue;

      const committedShapes = shapesByLayer.get(rawLayer.id) ?? [];
      const synced = this.ensureLayerEntry(view, committedShapes, width, height, scratch, isResizing);
      if (!synced) continue;
      const { entry } = synced;
      let dirtyRect = synced.dirtyRect;
      if (synced.changed) anyDirty = true;

      const liveDrafts = isResizing ? [] : (draftsByLayer.get(rawLayer.id) ?? []);
      let sourceCanvas = entry.canvas;
      let itemVersion = entry.version;

      if (liveDrafts.length > 0) {
        const singleDraft = liveDrafts.length === 1 ? liveDrafts[0] : null;
        if (singleDraft) {
          dirtyRect = this.updateIncrementalLiveStroke(
            entry,
            scratch.scratchCanvas,
            scratch.scratchCtx,
            scratch.strokeCanvas,
            scratch.strokeCtx,
            singleDraft,
            width,
            height,
            Boolean(view.alphaLock),
          );
        } else {
          this.liveSession = null;
          scratch.scratchCtx.clearRect(0, 0, width, height);
          scratch.scratchCtx.drawImage(entry.canvas, 0, 0);
          for (const d of liveDrafts) {
            const r = this.renderShapeOntoLayerCtx(
              scratch.scratchCtx,
              scratch.scratchCanvas,
              scratch.strokeCtx,
              scratch.strokeCanvas,
              d,
              width,
              height,
              Boolean(view.alphaLock),
            );
            dirtyRect = unionRects(dirtyRect, r);
          }
        }
        sourceCanvas = scratch.scratchCanvas;
        this.scratchVersion++;
        itemVersion = -this.scratchVersion;
        anyDirty = true;
      }

      const isClipped = Boolean(view.clipping) && baseLayerId !== null;
      if (!view.clipping) {
        baseLayerId = rawLayer.id;
      }

      const resizeTransform = isResizing
        ? { from: resizingPreview!.fromBounds, to: resizingPreview!.bounds }
        : undefined;
      const blendMode = view.blendMode ?? 'normal';

      items.push({
        id: rawLayer.id,
        canvas: sourceCanvas,
        version: itemVersion,
        dirtyRect,
        x: isResizing ? 0 : view.x,
        y: isResizing ? 0 : view.y,
        opacity: layerOpacity,
        blendMode,
        clipping: isClipped,
        isBase: !view.clipping,
        baseLayerId: isClipped ? baseLayerId : null,
        ...(resizeTransform ? { resizeTransform } : {}),
      });

      const rtKey = resizeTransform
        ? `@${resizeTransform.from.x},${resizeTransform.from.y},${resizeTransform.from.width},${resizeTransform.from.height}->${resizeTransform.to.x},${resizeTransform.to.y},${resizeTransform.to.width},${resizeTransform.to.height}`
        : '';
      keyParts.push(`${rawLayer.id}:${itemVersion}:${isResizing ? 0 : view.x}:${isResizing ? 0 : view.y}:${layerOpacity}:${blendMode}:${isClipped ? baseLayerId : ''}${rtKey}`);
    }

    const compositeKey = keyParts.join('|');
    const changed = anyDirty || compositeKey !== this.lastCompositeKey;
    this.lastCompositeKey = compositeKey;
    this.lastSyncLayers = items;
    return { layers: items, changed, compositeKey };
  }

  /** Renders a crisp thumbnail of a single layer (even if hidden) into an offscreen preview canvas. */
  drawLayerThumbnail(
    layerId: string,
    targetCanvas: HTMLCanvasElement,
    layers: readonly BoardLayer[],
    shapes: readonly BoardShape[],
    boardWidth: number,
    boardHeight: number,
  ): boolean {
    const ctx = targetCanvas.getContext('2d');
    if (!ctx || typeof ctx.clearRect !== 'function') return false;
    const scratch = this.ensureScratch(boardWidth, boardHeight);
    if (!scratch) return false;
    const layer = layers.find(l => l.id === layerId);
    if (!layer) return false;

    const layerShapes = shapes.filter(s => !s.hidden && (s.layerId ?? DEFAULT_BOARD_LAYER) === layerId);
    const synced = this.ensureLayerEntry(layer, layerShapes, boardWidth, boardHeight, scratch, false);
    if (!synced) return false;

    const tw = targetCanvas.width;
    const th = targetCanvas.height;
    ctx.clearRect(0, 0, tw, th);
    if (!layerShapes.length) return true;

    const bounds = boardLayerBounds(layerShapes, { ...layer, x: 0, y: 0 });
    const srcX = bounds ? Math.max(0, Math.floor(bounds.x - 4)) : 0;
    const srcY = bounds ? Math.max(0, Math.floor(bounds.y - 4)) : 0;
    const srcW = bounds ? Math.max(1, Math.min(boardWidth - srcX, Math.ceil(bounds.width + 8))) : boardWidth;
    const srcH = bounds ? Math.max(1, Math.min(boardHeight - srcY, Math.ceil(bounds.height + 8))) : boardHeight;

    const pad = 4;
    const availW = Math.max(1, tw - pad * 2);
    const availH = Math.max(1, th - pad * 2);
    const scale = Math.min(availW / srcW, availH / srcH);
    const dstW = srcW * scale;
    const dstH = srcH * scale;
    const dstX = (tw - dstW) / 2;
    const dstY = (th - dstH) / 2;

    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(synced.entry.canvas, srcX, srcY, srcW, srcH, dstX, dstY, dstW, dstH);
    ctx.restore();
    return true;
  }

  /** Composites only a tiny (e.g. 9x9) board patch from cached layer canvases for instant eyedropper sampling. */
  sampleCompositePatch(
    centerX: number,
    centerY: number,
    radius: number,
    layers: readonly BoardLayer[],
    shapes: readonly BoardShape[],
    draftsByLayer: ReadonlyMap<string, BoardShape[]>,
    movingLayer: BoardLayer | null,
    resizingPreview: { id: string; layer: BoardLayer; shapes: BoardShape[]; fromBounds: BoardBox; bounds: BoardBox } | null,
    boardWidth: number,
    boardHeight: number,
    backgroundColor: string,
    transparent: boolean,
  ): { grid: string[]; centerHex: string; px: number; py: number } | null {
    const sync = this.syncLayers(null, layers, shapes, draftsByLayer, movingLayer, resizingPreview, boardWidth, boardHeight, backgroundColor, transparent);
    if (!sync) return null;

    const cx = Math.max(0, Math.min(boardWidth - 1, Math.floor(centerX)));
    const cy = Math.max(0, Math.min(boardHeight - 1, Math.floor(centerY)));
    const sx = Math.max(0, cx - radius);
    const sy = Math.max(0, cy - radius);
    const ex = Math.min(boardWidth, cx + radius + 1);
    const ey = Math.min(boardHeight, cy + radius + 1);
    const sw = Math.max(1, ex - sx);
    const sh = Math.max(1, ey - sy);

    if (!this.sampleCanvas || this.sampleCanvas.width !== sw || this.sampleCanvas.height !== sh) {
      this.sampleCanvas = document.createElement('canvas');
      this.sampleCanvas.width = sw;
      this.sampleCanvas.height = sh;
      this.sampleCtx = this.sampleCanvas.getContext('2d', { willReadFrequently: true });
    }
    if (!this.sampleMaskCanvas || this.sampleMaskCanvas.width !== sw || this.sampleMaskCanvas.height !== sh) {
      this.sampleMaskCanvas = document.createElement('canvas');
      this.sampleMaskCanvas.width = sw;
      this.sampleMaskCanvas.height = sh;
      this.sampleMaskCtx = this.sampleMaskCanvas.getContext('2d');
    }
    const ctx = this.sampleCtx;
    const maskCtx = this.sampleMaskCtx;
    if (!ctx || !maskCtx) return null;

    ctx.clearRect(0, 0, sw, sh);
    if (!transparent) {
      ctx.fillStyle = backgroundColor;
      ctx.fillRect(0, 0, sw, sh);
    }

    let baseItem: LayerCompositeItem | null = null;
    for (const item of sync.layers) {
      if (!item.clipping) baseItem = item;
      ctx.save();
      ctx.globalAlpha = item.opacity;
      if (item.blendMode !== 'normal') {
        ctx.globalCompositeOperation = item.blendMode;
      }

      const drawItemInto = (target: CanvasRenderingContext2D) => {
        if (item.resizeTransform) {
          const { from, to } = item.resizeTransform;
          const fx = to.width / Math.max(1, from.width);
          const fy = to.height / Math.max(1, from.height);
          target.drawImage(
            item.canvas,
            from.x - item.x,
            from.y - item.y,
            from.width,
            from.height,
            to.x - sx,
            to.y - sy,
            to.width,
            to.height,
          );
          void fx; void fy;
        } else {
          target.drawImage(item.canvas, item.x - sx, item.y - sy);
        }
      };

      if (item.clipping && baseItem) {
        maskCtx.clearRect(0, 0, sw, sh);
        if (baseItem.resizeTransform) {
          const { from, to } = baseItem.resizeTransform;
          maskCtx.drawImage(baseItem.canvas, from.x - baseItem.x, from.y - baseItem.y, from.width, from.height, to.x - sx, to.y - sy, to.width, to.height);
        } else {
          maskCtx.drawImage(baseItem.canvas, baseItem.x - sx, baseItem.y - sy);
        }
        maskCtx.globalCompositeOperation = 'source-in';
        drawItemInto(maskCtx);
        maskCtx.globalCompositeOperation = 'source-over';
        ctx.drawImage(this.sampleMaskCanvas!, 0, 0);
      } else {
        drawItemInto(ctx);
      }
      ctx.restore();
    }

    const img = ctx.getImageData(0, 0, sw, sh).data;
    const size = radius * 2 + 1;
    const grid: string[] = [];
    for (let dy = -radius; dy <= radius; dy++) {
      const y = cy + dy;
      for (let dx = -radius; dx <= radius; dx++) {
        const x = cx + dx;
        if (x < 0 || y < 0 || x >= boardWidth || y >= boardHeight) {
          grid.push(transparent ? 'transparent' : backgroundColor);
        } else {
          const idx = ((y - sy) * sw + (x - sx)) * 4;
          const r = img[idx], g = img[idx + 1], b = img[idx + 2], a = img[idx + 3];
          if (a === 0) grid.push(transparent ? 'transparent' : backgroundColor);
          else grid.push(`#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`);
        }
      }
    }
    const centerCell = grid[Math.floor((size * size) / 2)] || (transparent ? '#ffffff' : backgroundColor);
    const centerHex = centerCell === 'transparent' ? (transparent ? '#ffffff' : backgroundColor) : centerCell;
    return { grid, centerHex, px: cx, py: cy };
  }

  getSyncedLayers(): readonly LayerCompositeItem[] {
    return this.lastSyncLayers;
  }

  invalidateComposite(): void {
    this.lastCompositeKey = '';
  }

  /** Legacy full-canvas render helper retained for direct 2D canvas targets. */
  renderScene(
    targetCanvas: HTMLCanvasElement,
    layers: readonly BoardLayer[],
    shapes: readonly BoardShape[],
    draftsByLayer: ReadonlyMap<string, BoardShape[]>,
    movingLayer: BoardLayer | null,
    resizingPreview: { id: string; layer: BoardLayer; shapes: BoardShape[]; fromBounds?: BoardBox; bounds?: BoardBox } | null,
    width: number,
    height: number,
    backgroundColor: string,
    transparent: boolean,
  ): boolean {
    const normalizedResize = resizingPreview && resizingPreview.fromBounds && resizingPreview.bounds
      ? { id: resizingPreview.id, layer: resizingPreview.layer, shapes: resizingPreview.shapes, fromBounds: resizingPreview.fromBounds, bounds: resizingPreview.bounds }
      : null;
    const sync = this.syncLayers(targetCanvas, layers, shapes, draftsByLayer, movingLayer, normalizedResize, width, height, backgroundColor, transparent);
    if (!sync) return false;
    const ctx = targetCanvas.getContext('2d');
    if (!ctx) return false;
    const scratch = this.ensureScratch(width, height);
    if (!scratch) return false;

    ctx.clearRect(0, 0, width, height);
    if (!transparent) {
      ctx.fillStyle = backgroundColor;
      ctx.fillRect(0, 0, width, height);
    }

    let baseItem: LayerCompositeItem | null = null;
    for (const item of sync.layers) {
      if (!item.clipping) baseItem = item;
      ctx.save();
      ctx.globalAlpha = item.opacity;
      if (item.blendMode !== 'normal') {
        ctx.globalCompositeOperation = item.blendMode;
      }
      if (item.clipping && baseItem) {
        scratch.strokeCtx.clearRect(0, 0, width, height);
        scratch.strokeCtx.drawImage(baseItem.canvas, baseItem.x, baseItem.y);
        scratch.strokeCtx.globalCompositeOperation = 'source-in';
        scratch.strokeCtx.drawImage(item.canvas, item.x, item.y);
        scratch.strokeCtx.globalCompositeOperation = 'source-over';
        ctx.drawImage(scratch.strokeCanvas, 0, 0);
      } else if (item.resizeTransform) {
        const { from, to } = item.resizeTransform;
        ctx.drawImage(item.canvas, from.x - item.x, from.y - item.y, from.width, from.height, to.x, to.y, to.width, to.height);
      } else {
        ctx.drawImage(item.canvas, item.x, item.y);
      }
      ctx.restore();
    }
    return true;
  }
}
