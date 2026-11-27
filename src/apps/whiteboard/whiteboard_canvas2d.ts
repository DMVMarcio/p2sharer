import {
  boardLayerBounds, brushHitPoints, brushProfile, DEFAULT_BOARD_LAYER,
  expandSymmetryPointLists, shapeOpacity,
  type BoardBlendMode, type BoardLayer, type BoardPoint, type BoardShape,
} from './whiteboard_scene';
import type { BoardBox } from '../shared/whiteboard_interaction';
import { computeFloodMask, parseHexRgb, polygonToMask } from './whiteboard_raster';
import { applySurfaceTransfer, BrushTipLibrary } from './whiteboard_brushes';

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
  dabCounts: number[];
  arcLengths: number[];
  pixelCells: Array<{ gx: number; gy: number } | null>;
  carryCanvases: HTMLCanvasElement[];
  dirtyRect: DirtyRect | null;
  tipRect: DirtyRect | null;
  lastOpacity: number;
  mode: 'stamp' | 'pixel' | 'smudge' | 'blur';
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

function getLiveStrokeMode(s: BoardShape): LiveStrokeSession['mode'] | null {
  if (s.tool === 'eraser') return 'stamp';
  if (s.tool !== 'brush') return null;
  if (s.brushType === 'pixel') return 'pixel';
  if (s.brushType === 'smudge') return 'smudge';
  if (s.brushType === 'blur') return 'blur';
  return 'stamp';
}

function copyPatchClamped(
  srcCanvas: HTMLCanvasElement,
  centerX: number,
  centerY: number,
  size: number,
  dstCtx: CanvasRenderingContext2D,
): void {
  dstCtx.clearRect(0, 0, size, size);
  const sx0 = centerX - size / 2;
  const sy0 = centerY - size / 2;
  const cx0 = Math.max(0, sx0);
  const cy0 = Math.max(0, sy0);
  const cx1 = Math.min(srcCanvas.width, sx0 + size);
  const cy1 = Math.min(srcCanvas.height, sy0 + size);
  const cw = cx1 - cx0;
  const ch = cy1 - cy0;
  if (cw <= 0 || ch <= 0) return;
  dstCtx.drawImage(srcCanvas, cx0, cy0, cw, ch, cx0 - sx0, cy0 - sy0, cw, ch);
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

function applyClipPolygon(
  ctx: CanvasRenderingContext2D,
  clipPolygon: readonly BoardPoint[] | undefined,
  tx: number,
  ty: number,
  sx: number,
  sy: number,
): void {
  if (!clipPolygon?.length) return;
  ctx.beginPath();
  clipPolygon.forEach((p, idx) => {
    const px = tx + p.x * sx, py = ty + p.y * sy;
    if (idx === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.closePath();
  ctx.clip('evenodd');
}

/**
 * Per-layer offscreen 2D rasterizer and incremental brush engine for Whiteboard.
 * Maintains exact-resolution offscreen layer canvases, incremental live stroke
 * buffers for all brush types, dirty rectangles, thumbnail generation, and pixel sampling.
 */
export class WhiteboardCanvas2DRenderer {
  private layerCache = new Map<string, LayerCanvasEntry>();
  private tipLib = new BrushTipLibrary();
  private scratchCanvas: HTMLCanvasElement | null = null;
  private scratchCtx: CanvasRenderingContext2D | null = null;
  private scratchVersion = 0;
  private strokeCanvas: HTMLCanvasElement | null = null;
  private strokeCtx: CanvasRenderingContext2D | null = null;
  private tipCanvas: HTMLCanvasElement | null = null;
  private tipCtx: CanvasRenderingContext2D | null = null;
  private workCanvas: HTMLCanvasElement | null = null;
  private workCtx: CanvasRenderingContext2D | null = null;
  private pickupCanvas: HTMLCanvasElement | null = null;
  private pickupCtx: CanvasRenderingContext2D | null = null;
  private blurSrcCanvas: HTMLCanvasElement | null = null;
  private blurSrcCtx: CanvasRenderingContext2D | null = null;
  private blurDstCanvas: HTMLCanvasElement | null = null;
  private blurDstCtx: CanvasRenderingContext2D | null = null;
  private sampleCanvas: HTMLCanvasElement | null = null;
  private sampleCtx: CanvasRenderingContext2D | null = null;
  private sampleMaskCanvas: HTMLCanvasElement | null = null;
  private sampleMaskCtx: CanvasRenderingContext2D | null = null;
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
      this.strokeCtx = this.strokeCanvas.getContext('2d', { willReadFrequently: true });
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
      this.tipCtx = this.tipCanvas.getContext('2d', { willReadFrequently: true });
    }
    if (!this.tipCtx || typeof this.tipCtx.drawImage !== 'function') return null;
    return { canvas: this.tipCanvas, ctx: this.tipCtx };
  }

  private ensureWorkPatch(diam: number): {
    workCanvas: HTMLCanvasElement;
    workCtx: CanvasRenderingContext2D;
    pickupCanvas: HTMLCanvasElement;
    pickupCtx: CanvasRenderingContext2D;
  } | null {
    if (typeof document === 'undefined') return null;
    if (!this.workCanvas || this.workCanvas.width !== diam || this.workCanvas.height !== diam) {
      this.workCanvas = document.createElement('canvas');
      this.workCanvas.width = diam;
      this.workCanvas.height = diam;
      this.workCtx = this.workCanvas.getContext('2d');
    }
    if (!this.pickupCanvas || this.pickupCanvas.width !== diam || this.pickupCanvas.height !== diam) {
      this.pickupCanvas = document.createElement('canvas');
      this.pickupCanvas.width = diam;
      this.pickupCanvas.height = diam;
      this.pickupCtx = this.pickupCanvas.getContext('2d');
    }
    if (!this.workCtx || !this.pickupCtx) return null;
    return {
      workCanvas: this.workCanvas,
      workCtx: this.workCtx,
      pickupCanvas: this.pickupCanvas,
      pickupCtx: this.pickupCtx,
    };
  }

  private ensureBlurPatch(patchSize: number): {
    srcCanvas: HTMLCanvasElement;
    srcCtx: CanvasRenderingContext2D;
    dstCanvas: HTMLCanvasElement;
    dstCtx: CanvasRenderingContext2D;
  } | null {
    if (typeof document === 'undefined') return null;
    if (!this.blurSrcCanvas || this.blurSrcCanvas.width !== patchSize || this.blurSrcCanvas.height !== patchSize) {
      this.blurSrcCanvas = document.createElement('canvas');
      this.blurSrcCanvas.width = patchSize;
      this.blurSrcCanvas.height = patchSize;
      this.blurSrcCtx = this.blurSrcCanvas.getContext('2d');
    }
    if (!this.blurDstCanvas || this.blurDstCanvas.width !== patchSize || this.blurDstCanvas.height !== patchSize) {
      this.blurDstCanvas = document.createElement('canvas');
      this.blurDstCanvas.width = patchSize;
      this.blurDstCanvas.height = patchSize;
      this.blurDstCtx = this.blurDstCanvas.getContext('2d');
    }
    if (!this.blurSrcCtx || !this.blurDstCtx) return null;
    return {
      srcCanvas: this.blurSrcCanvas,
      srcCtx: this.blurSrcCtx,
      dstCanvas: this.blurDstCanvas,
      dstCtx: this.blurDstCtx,
    };
  }

  registerImage(hash: string, img: HTMLImageElement): void {
    this.imageElements.set(hash, img);
    this.layerCache.clear();
    this.liveSession = null;
    this.lastCompositeKey = '';
  }

  private stepPixelSegment(
    ctx: CanvasRenderingContext2D,
    pts: readonly BoardPoint[],
    cell: number,
    prevCell: { gx: number; gy: number } | null,
  ): { bounds: DirtyRect | null; lastCell: { gx: number; gy: number } | null } {
    if (!pts.length) return { bounds: null, lastCell: prevCell };
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const visited = new Set<number>();
    const fillCell = (gx: number, gy: number) => {
      const key = (gy + 16384) * 32768 + (gx + 16384);
      if (visited.has(key)) return;
      visited.add(key);
      const rx = gx * cell - Math.floor(cell / 2);
      const ry = gy * cell - Math.floor(cell / 2);
      ctx.fillRect(rx, ry, cell, cell);
      if (rx < minX) minX = rx;
      if (ry < minY) minY = ry;
      if (rx + cell > maxX) maxX = rx + cell;
      if (ry + cell > maxY) maxY = ry + cell;
    };

    let gx0 = prevCell ? prevCell.gx : Math.round(pts[0].x / cell);
    let gy0 = prevCell ? prevCell.gy : Math.round(pts[0].y / cell);
    if (!prevCell) fillCell(gx0, gy0);

    const startI = prevCell ? 0 : 1;
    for (let i = startI; i < pts.length; i++) {
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
    ctx.restore();
    const bounds = maxX >= minX
      ? clampRect({ x: minX - 1, y: minY - 1, w: maxX - minX + 2, h: maxY - minY + 2 }, ctx.canvas.width, ctx.canvas.height)
      : null;
    return { bounds, lastCell: { gx: gx0, gy: gy0 } };
  }

  private stepSmudgeSegment(
    targetCtx: CanvasRenderingContext2D,
    targetCanvas: HTMLCanvasElement,
    carryCanvas: HTMLCanvasElement,
    interp: readonly BoardPoint[],
    s: BoardShape,
    rad: number,
    diam: number,
    stepDist: number,
    pickupWeight: number,
    depositAlpha: number,
    softMask: HTMLCanvasElement,
    alphaLock: boolean,
    tx: number,
    ty: number,
    sx: number,
    sy: number,
    initialResidual = 0,
    initializeCarry = true,
  ): { bounds: DirtyRect | null; residual: number } {
    if (!interp.length) return { bounds: null, residual: initialResidual };
    const carryCtx = carryCanvas.getContext('2d');
    const patches = this.ensureWorkPatch(diam);
    if (!carryCtx || !patches) return { bounds: null, residual: initialResidual };
    const { workCanvas, workCtx, pickupCanvas, pickupCtx } = patches;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    if (initializeCarry) {
      copyPatchClamped(targetCanvas, interp[0].x, interp[0].y, diam, carryCtx);
    }

    targetCtx.save();
    applyClipPolygon(targetCtx, s.clipPolygon, tx, ty, sx, sy);
    if (alphaLock) {
      targetCtx.globalCompositeOperation = 'source-atop';
    }

    const applyDab = (nx: number, ny: number) => {
      // 1. Sample underlying canvas at (nx, ny) into pickupCanvas and blend into carryCanvas
      copyPatchClamped(targetCanvas, nx, ny, diam, pickupCtx);
      carryCtx.save();
      carryCtx.globalCompositeOperation = 'destination-out';
      carryCtx.globalAlpha = pickupWeight * 0.25;
      carryCtx.fillRect(0, 0, diam, diam);
      carryCtx.globalCompositeOperation = 'source-over';
      carryCtx.globalAlpha = pickupWeight;
      carryCtx.drawImage(pickupCanvas, 0, 0);
      carryCtx.restore();

      // 2. Apply smooth radial feather mask (zero hard circle edges)
      workCtx.clearRect(0, 0, diam, diam);
      workCtx.globalCompositeOperation = 'source-over';
      workCtx.drawImage(carryCanvas, 0, 0);
      workCtx.globalCompositeOperation = 'destination-in';
      workCtx.drawImage(softMask, 0, 0, diam, diam);
      workCtx.globalCompositeOperation = 'source-over';

      // 3. Deposit smudged paint smoothly onto target layer
      targetCtx.globalAlpha = depositAlpha;
      targetCtx.drawImage(workCanvas, nx - rad, ny - rad);

      if (nx - rad < minX) minX = nx - rad;
      if (ny - rad < minY) minY = ny - rad;
      if (nx + rad > maxX) maxX = nx + rad;
      if (ny + rad > maxY) maxY = ny + rad;
    };

    let residual = initialResidual;
    for (let i = 1; i < interp.length; i++) {
      const a = interp[i - 1], b = interp[i];
      const segLen = Math.hypot(b.x - a.x, b.y - a.y);
      if (segLen < 1e-4) continue;
      let d = stepDist - residual;
      while (d <= segLen) {
        const t = d / segLen;
        applyDab(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
        d += stepDist;
      }
      residual = segLen - (d - stepDist);
    }

    targetCtx.restore();
    const bounds = maxX >= minX
      ? clampRect({ x: minX - 2, y: minY - 2, w: maxX - minX + 4, h: maxY - minY + 4 }, targetCanvas.width, targetCanvas.height)
      : null;
    return { bounds, residual };
  }

  private stepBlurSegment(
    targetCtx: CanvasRenderingContext2D,
    targetCanvas: HTMLCanvasElement,
    interp: readonly BoardPoint[],
    s: BoardShape,
    rad: number,
    diam: number,
    blurPx: number,
    pad: number,
    stepDist: number,
    dabAlpha: number,
    softMask: HTMLCanvasElement,
    alphaLock: boolean,
    tx: number,
    ty: number,
    sx: number,
    sy: number,
    initialResidual = 0,
    stampStart = true,
  ): { bounds: DirtyRect | null; residual: number } {
    if (!interp.length) return { bounds: null, residual: initialResidual };
    const patchSize = diam + pad * 2;
    const blurBuf = this.ensureBlurPatch(patchSize);
    const workBuf = this.ensureWorkPatch(diam);
    if (!blurBuf || !workBuf) return { bounds: null, residual: initialResidual };
    const { srcCanvas, srcCtx, dstCanvas, dstCtx } = blurBuf;
    const { workCanvas, workCtx } = workBuf;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    targetCtx.save();
    applyClipPolygon(targetCtx, s.clipPolygon, tx, ty, sx, sy);
    if (alphaLock) {
      targetCtx.globalCompositeOperation = 'source-atop';
    }

    const applyDab = (nx: number, ny: number) => {
      copyPatchClamped(targetCanvas, nx, ny, patchSize, srcCtx);
      dstCtx.clearRect(0, 0, patchSize, patchSize);
      dstCtx.save();
      dstCtx.filter = `blur(${blurPx}px)`;
      dstCtx.drawImage(srcCanvas, 0, 0);
      dstCtx.restore();

      workCtx.clearRect(0, 0, diam, diam);
      workCtx.globalCompositeOperation = 'source-over';
      workCtx.drawImage(dstCanvas, pad, pad, diam, diam, 0, 0, diam, diam);
      workCtx.globalCompositeOperation = 'destination-in';
      workCtx.drawImage(softMask, 0, 0, diam, diam);
      workCtx.globalCompositeOperation = 'source-over';

      targetCtx.globalAlpha = dabAlpha;
      targetCtx.drawImage(workCanvas, nx - rad, ny - rad);

      if (nx - rad < minX) minX = nx - rad;
      if (ny - rad < minY) minY = ny - rad;
      if (nx + rad > maxX) maxX = nx + rad;
      if (ny + rad > maxY) maxY = ny + rad;
    };

    if (stampStart) {
      applyDab(interp[0].x, interp[0].y);
    }
    let residual = initialResidual;
    for (let i = 1; i < interp.length; i++) {
      const a = interp[i - 1], b = interp[i];
      const segLen = Math.hypot(b.x - a.x, b.y - a.y);
      if (segLen < 1e-4) continue;
      let d = stepDist - residual;
      while (d <= segLen) {
        const t = d / segLen;
        applyDab(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
        d += stepDist;
      }
      residual = segLen - (d - stepDist);
    }

    targetCtx.restore();
    const bounds = maxX >= minX
      ? clampRect({ x: minX - 2, y: minY - 2, w: maxX - minX + 4, h: maxY - minY + 4 }, targetCanvas.width, targetCanvas.height)
      : null;
    return { bounds, residual };
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
    getCompositeSample?: () => Uint8ClampedArray | null,
  ): DirtyRect | null {
    if (s.hidden) return null;
    const opacity = shapeOpacity(s);
    const sx = s.scaleX ?? 1, sy = s.scaleY ?? 1;
    const tx = s.x ?? 0, ty = s.y ?? 0;

    if (s.tool === 'clear') {
      layerCtx.save();
      applyClipPolygon(layerCtx, s.clipPolygon, tx, ty, sx, sy);
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

    const [a, b = a] = s.points;

    if (s.tool === 'bucket') {
      // Fill Selection button (has clipPolygon and no fillTolerance) or explicit 2-point rect bucket
      if (s.fillTolerance === undefined && s.clipPolygon?.length) {
        layerCtx.save();
        if (alphaLock) layerCtx.globalCompositeOperation = 'source-atop';
        layerCtx.globalAlpha = opacity;
        layerCtx.fillStyle = s.color;
        layerCtx.beginPath();
        s.clipPolygon.forEach((p, idx) => {
          const px = tx + p.x * sx, py = ty + p.y * sy;
          if (idx === 0) layerCtx.moveTo(px, py);
          else layerCtx.lineTo(px, py);
        });
        layerCtx.closePath();
        layerCtx.fill('evenodd');
        layerCtx.restore();
        return { x: 0, y: 0, w: width, h: height };
      }
      if (s.points.length === 2 && !s.clipPolygon?.length) {
        layerCtx.save();
        if (alphaLock) layerCtx.globalCompositeOperation = 'source-atop';
        layerCtx.globalAlpha = opacity;
        layerCtx.fillStyle = s.color;
        const x0 = tx + Math.min(a.x, b.x) * sx;
        const y0 = ty + Math.min(a.y, b.y) * sy;
        layerCtx.fillRect(x0, y0, Math.abs(b.x - a.x) * sx, Math.abs(b.y - a.y) * sy);
        layerCtx.restore();
        return clampRect({ x: x0 - 1, y: y0 - 1, w: Math.abs(b.x - a.x) * sx + 2, h: Math.abs(b.y - a.y) * sy + 2 }, width, height);
      }

      // True pixel flood fill against real rendered pixels (supports active selection clipPolygon & fillSample='all')
      try {
        const imgData = layerCtx.getImageData(0, 0, width, height);
        const sampleData = s.fillSample === 'all' && getCompositeSample
          ? (getCompositeSample() ?? imgData.data)
          : imgData.data;
        const clipMask = s.clipPolygon?.length
          ? polygonToMask(s.clipPolygon.map(p => ({ x: tx + p.x * sx, y: ty + p.y * sy })), width, height)
          : null;
        const seedX = tx + a.x * sx;
        const seedY = ty + a.y * sy;
        const mask = computeFloodMask(
          sampleData,
          width,
          height,
          seedX,
          seedY,
          s.fillTolerance ?? 32,
          s.fillContiguous !== false,
          s.fillExpand ?? 0,
          clipMask,
        );
        const [cr, cg, cb] = parseHexRgb(s.color);
        const antiAlias = s.fillAntiAlias !== false;
        const data = imgData.data;
        let minX = width, minY = height, maxX = -1, maxY = -1;
        for (let y = 0; y < height; y++) {
          const row = y * width;
          for (let x = 0; x < width; x++) {
            const i = row + x;
            let m = mask[i];
            if (m === 0 && antiAlias) {
              let neighbors = 0;
              if (x > 0 && mask[i - 1] > 0) neighbors++;
              if (x < width - 1 && mask[i + 1] > 0) neighbors++;
              if (y > 0 && mask[i - width] > 0) neighbors++;
              if (y < height - 1 && mask[i + width] > 0) neighbors++;
              if (neighbors >= 2 && (!clipMask || clipMask[i] > 0)) {
                m = neighbors * 52;
              }
            }
            if (m > 0) {
              const idx4 = i * 4;
              if (alphaLock && data[idx4 + 3] === 0) continue;
              const sA = opacity * (m / 255);
              if (alphaLock) {
                data[idx4] = Math.round(data[idx4] * (1 - sA) + cr * sA);
                data[idx4 + 1] = Math.round(data[idx4 + 1] * (1 - sA) + cg * sA);
                data[idx4 + 2] = Math.round(data[idx4 + 2] * (1 - sA) + cb * sA);
              } else {
                const dA = data[idx4 + 3] / 255;
                const outA = sA + dA * (1 - sA);
                if (outA > 0) {
                  data[idx4] = Math.round((cr * sA + data[idx4] * dA * (1 - sA)) / outA);
                  data[idx4 + 1] = Math.round((cg * sA + data[idx4 + 1] * dA * (1 - sA)) / outA);
                  data[idx4 + 2] = Math.round((cb * sA + data[idx4 + 2] * dA * (1 - sA)) / outA);
                  data[idx4 + 3] = Math.round(outA * 255);
                }
              }
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
            }
          }
        }
        layerCtx.putImageData(imgData, 0, 0);
        return maxX >= minX ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } : null;
      } catch {
        layerCtx.save();
        layerCtx.globalAlpha = opacity;
        layerCtx.fillStyle = s.color;
        layerCtx.fillRect(0, 0, width, height);
        layerCtx.restore();
        return { x: 0, y: 0, w: width, h: height };
      }
    }

    layerCtx.save();
    applyClipPolygon(layerCtx, s.clipPolygon, tx, ty, sx, sy);
    if (alphaLock) {
      layerCtx.globalCompositeOperation = 'source-atop';
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

    layerCtx.restore();

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
      const hardness01 = Math.max(0.05, Math.min(1, (s.hardness ?? 85) / 100));
      const tip = this.tipLib.getTip('#000000', hardness01, 'pen');
      if (clearStrokeRect) {
        strokeCtx.clearRect(clearStrokeRect.x, clearStrokeRect.y, clearStrokeRect.w, clearStrokeRect.h);
      } else {
        strokeCtx.clearRect(0, 0, width, height);
      }
      const bounds = this.stampStrokeLists(strokeCtx, symmetryLists, s, tip, profile, hasPressure, scaleAvg, 1);
      if (bounds) {
        layerCtx.save();
        applyClipPolygon(layerCtx, s.clipPolygon, tx, ty, sx, sy);
        layerCtx.globalCompositeOperation = 'destination-out';
        layerCtx.globalAlpha = opacity;
        layerCtx.drawImage(strokeCanvas, bounds.x, bounds.y, bounds.w, bounds.h, bounds.x, bounds.y, bounds.w, bounds.h);
        layerCtx.restore();
      }
      return bounds;
    }

    if (s.brushType === 'pixel') {
      const cell = Math.max(1, Math.round(s.width * scaleAvg));
      layerCtx.save();
      applyClipPolygon(layerCtx, s.clipPolygon, tx, ty, sx, sy);
      if (alphaLock) layerCtx.globalCompositeOperation = 'source-atop';
      layerCtx.globalAlpha = opacity;
      layerCtx.fillStyle = s.color;
      let union: DirtyRect | null = null;
      for (const pts of symmetryLists) {
        const { bounds } = this.stepPixelSegment(layerCtx, pts, cell, null);
        union = unionRects(union, bounds);
      }
      layerCtx.restore();
      return union;
    }

    if (s.brushType === 'smudge') {
      const rad = Math.max(2, s.width * 0.55 * scaleAvg);
      const diam = Math.max(4, Math.ceil(rad * 2));
      const stepDist = Math.max(1.2, rad * 0.22);
      const hardness01 = Math.max(0.05, Math.min(1, (s.hardness ?? 30) / 100));
      const flow01 = Math.max(0.05, Math.min(1, (s.flow ?? 68) / 100));
      const carryWeight = 0.4 + 0.52 * flow01;
      const pickupWeight = 1 - carryWeight;
      const depositAlpha = Math.max(0.08, Math.min(0.95, opacity * (0.35 + 0.65 * flow01)));
      const softMask = this.tipLib.getSoftMaskTip(hardness01);
      let union: DirtyRect | null = null;
      for (const pts of symmetryLists) {
        const interp = brushHitPoints({ ...s, points: pts });
        const carry = document.createElement('canvas');
        carry.width = diam;
        carry.height = diam;
        const { bounds } = this.stepSmudgeSegment(
          layerCtx,
          layerCanvas,
          carry,
          interp,
          s,
          rad,
          diam,
          stepDist,
          pickupWeight,
          depositAlpha,
          softMask,
          alphaLock,
          tx,
          ty,
          sx,
          sy,
          0,
          true,
        );
        union = unionRects(union, bounds);
      }
      return union;
    }

    if (s.brushType === 'blur') {
      const rad = Math.max(3, s.width * 0.6 * scaleAvg);
      const diam = Math.max(6, Math.ceil(rad * 2));
      const hardness01 = Math.max(0.05, Math.min(1, (s.hardness ?? 25) / 100));
      const flow01 = Math.max(0.05, Math.min(1, (s.flow ?? 60) / 100));
      const blurPx = Math.max(1.5, Math.min(18, rad * 0.38 * (0.4 + 0.6 * flow01)));
      const pad = Math.ceil(blurPx * 2.5) + 2;
      const stepDist = Math.max(2, rad * 0.32);
      const dabAlpha = Math.max(0.1, Math.min(0.9, opacity * flow01 * 0.72));
      const softMask = this.tipLib.getSoftMaskTip(hardness01);
      let union: DirtyRect | null = null;
      for (const pts of symmetryLists) {
        const interp = brushHitPoints({ ...s, points: pts });
        const { bounds } = this.stepBlurSegment(
          layerCtx,
          layerCanvas,
          interp,
          s,
          rad,
          diam,
          blurPx,
          pad,
          stepDist,
          dabAlpha,
          softMask,
          alphaLock,
          tx,
          ty,
          sx,
          sy,
          0,
          true,
        );
        union = unionRects(union, bounds);
      }
      return union;
    }

    // Stamp-based brushes (Pencil, Pen, Brush, Airbrush, Watercolor, Marker)
    const hardness01 = Math.max(0, Math.min(1, (s.hardness ?? profile.defaultHardness) / 100));
    const flow01 = Math.max(0.02, Math.min(1, (s.flow ?? profile.defaultFlow) / 100));
    const tipColor = s.brushType === 'pencil' || s.brushType === 'watercolor' ? '#000000' : s.color;
    const tip = this.tipLib.getTip(tipColor, hardness01, s.brushType);

    if (clearStrokeRect) {
      strokeCtx.clearRect(clearStrokeRect.x, clearStrokeRect.y, clearStrokeRect.w, clearStrokeRect.h);
    } else {
      strokeCtx.clearRect(0, 0, width, height);
    }
    const dabAlphaBase = s.brushType === 'airbrush'
      ? flow01 * 0.34
      : s.brushType === 'watercolor'
        ? flow01 * 0.55
        : s.brushType === 'pencil'
          ? flow01 * 0.78
          : flow01;

    const bounds = this.stampStrokeLists(
      strokeCtx,
      symmetryLists,
      s,
      tip,
      profile,
      hasPressure,
      scaleAvg,
      dabAlphaBase,
    );

    if (bounds) {
      applySurfaceTransfer(
        strokeCtx,
        layerCtx,
        bounds,
        s.brushType,
        s.color,
        opacity,
        alphaLock,
        s.clipPolygon,
        tx,
        ty,
        sx,
        sy,
      );
    }
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
    initialDabCount = 0,
    initialArcLen = 0,
  ): { bounds: DirtyRect | null; residual: number; dabCount: number; arcLen: number } {
    if (!interp.length) return { bounds: null, residual: initialResidual, dabCount: initialDabCount, arcLen: initialArcLen };
    const baseRadius = Math.max(0.75, profile.base * scaleAvg);
    const defaultSpacing = s.brushType === 'pen'
      ? 0.06
      : s.brushType === 'marker'
        ? 0.07
        : s.brushType === 'brush'
          ? 0.09
          : s.brushType === 'airbrush'
            ? 0.1
            : s.brushType === 'watercolor'
              ? 0.12
              : s.brushType === 'pencil'
                ? 0.1
                : 0.12;
    const spacingRatio = s.spacing !== undefined
      ? Math.max(0.04, Math.min(0.45, s.spacing / 100))
      : defaultSpacing;
    const stepDist = Math.max(0.55, baseRadius * 2 * spacingRatio);
    const isBristleBrush = s.brushType === 'brush';
    const hasJitterRot = s.brushType === 'pencil' || s.brushType === 'watercolor';
    const isTaperedPen = s.brushType === 'pen' && !hasPressure;
    const taperStartDist = Math.min(18, Math.max(6, baseRadius * 2.4));

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let dabCount = initialDabCount;
    let arcLen = initialArcLen;

    const stampDab = (x: number, y: number, p: number, angle: number, curArc: number) => {
      const pVal = Math.max(0.05, Math.min(1, p));
      let pScale = hasPressure && s.pressureSize !== false
        ? profile.min + (profile.max - profile.min) * Math.pow(pVal, profile.exp)
        : 1;
      if (isTaperedPen && curArc < taperStartDist) {
        pScale *= 0.48 + 0.52 * Math.sin((curArc / taperStartDist) * (Math.PI / 2));
      }
      const r = Math.max(0.6, baseRadius * pScale * (s.brushType === 'airbrush' ? 1.35 : 1));
      const alpha = dabAlphaBase * (hasPressure && s.pressureOpacity !== false ? Math.pow(pVal, 0.85) : 1);
      ctx.globalAlpha = Math.max(0.02, Math.min(1, alpha));

      if (isBristleBrush) {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(angle);
        ctx.drawImage(tip, -r, -r, r * 2, r * 2);
        ctx.restore();
      } else if (hasJitterRot) {
        const jitter = ((dabCount * 2654435761) & 1023) * 0.00613592;
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(jitter);
        ctx.drawImage(tip, -r, -r, r * 2, r * 2);
        ctx.restore();
      } else {
        ctx.drawImage(tip, x - r, y - r, r * 2, r * 2);
      }
      dabCount++;
      if (x - r < minX) minX = x - r;
      if (y - r < minY) minY = y - r;
      if (x + r > maxX) maxX = x + r;
      if (y + r > maxY) maxY = y + r;
    };

    if (stampStart) {
      const initAngle = interp.length > 1
        ? Math.atan2(interp[1].y - interp[0].y, interp[1].x - interp[0].x)
        : 0;
      stampDab(interp[0].x, interp[0].y, interp[0].p ?? 0.5, initAngle, arcLen);
    }

    let residual = initialResidual;
    for (let i = 1; i < interp.length; i++) {
      const a = interp[i - 1], b = interp[i];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const segLen = Math.hypot(dx, dy);
      if (segLen < 1e-4) continue;
      const angle = Math.atan2(dy, dx);
      let d = stepDist - residual;
      while (d <= segLen) {
        const t = d / segLen;
        stampDab(
          a.x + dx * t,
          a.y + dy * t,
          (a.p ?? 0.5) + ((b.p ?? 0.5) - (a.p ?? 0.5)) * t,
          angle,
          arcLen + d,
        );
        d += stepDist;
      }
      arcLen += segLen;
      residual = segLen - (d - stepDist);
    }

    if (maxX < minX || maxY < minY) return { bounds: null, residual, dabCount, arcLen };
    const pad = s.brushType === 'watercolor' ? 4 : 2;
    const bounds = clampRect({ x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 }, ctx.canvas.width, ctx.canvas.height);
    return { bounds, residual, dabCount, arcLen };
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
      const { bounds } = this.stampInterpolatedList(ctx, interp, s, tip, profile, hasPressure, scaleAvg, dabAlphaBase, 0, true, 0, 0);
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
    getCompositeSample?: () => Uint8ClampedArray | null,
    isFinal = false,
  ): DirtyRect | null {
    const sig = liveSessionSignature(d, alphaLock);
    const liveMode = getLiveStrokeMode(d);
    const sx = d.scaleX ?? 1, sy = d.scaleY ?? 1;
    const tx = d.x ?? 0, ty = d.y ?? 0;
    const scaleAvg = (sx + sy) / 2;
    const opacity = shapeOpacity(d);

    let session = this.liveSession;
    const matchesExisting = Boolean(
      session &&
      liveMode !== null &&
      session.mode === liveMode &&
      session.shapeId === d.id &&
      session.layerId === (d.layerId ?? DEFAULT_BOARD_LAYER) &&
      session.layerVersion === entry.version &&
      session.signature === sig &&
      d.points.length >= Math.max(1, session.finalizedEndIdx + 1),
    );

    if (!session || !matchesExisting || liveMode === null) {
      if (liveMode === null) {
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
          getCompositeSample,
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
      const rad = Math.max(2, d.width * 0.55 * scaleAvg);
      const diam = Math.max(4, Math.ceil(rad * 2));
      const carryCanvases: HTMLCanvasElement[] = [];
      if (liveMode === 'smudge') {
        for (let c = 0; c < copyCount; c++) {
          const cc = document.createElement('canvas');
          cc.width = diam;
          cc.height = diam;
          carryCanvases.push(cc);
        }
      }
      session = {
        shapeId: d.id,
        layerId: d.layerId ?? DEFAULT_BOARD_LAYER,
        layerVersion: entry.version,
        signature: sig,
        alphaLock,
        finalizedEndIdx: -1,
        residuals: new Array(copyCount).fill(0),
        dabCounts: new Array(copyCount).fill(0),
        arcLengths: new Array(copyCount).fill(0),
        pixelCells: new Array(copyCount).fill(null),
        carryCanvases,
        dirtyRect: null,
        tipRect: null,
        lastOpacity: opacity,
        mode: liveMode,
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
    const targetEndIdx = d.points.length - 1;

    // 1. Incremental Pixel Art Brush
    if (session.mode === 'pixel') {
      const cell = Math.max(1, Math.round(d.width * scaleAvg));
      strokeCtx.save();
      strokeCtx.fillStyle = d.color;
      let stepRect: DirtyRect | null = null;
      if (d.points.length === 1 && session.finalizedEndIdx < 0) {
        for (let c = 0; c < symmetryLists.length; c++) {
          const { bounds, lastCell } = this.stepPixelSegment(strokeCtx, symmetryLists[c], cell, null);
          session.pixelCells[c] = lastCell;
          stepRect = unionRects(stepRect, bounds);
        }
        session.finalizedEndIdx = 0;
        session.dirtyRect = unionRects(session.dirtyRect, stepRect);
      } else if (d.points.length >= 2 && targetEndIdx > session.finalizedEndIdx) {
        const fromIdx = Math.max(0, session.finalizedEndIdx);
        for (let c = 0; c < symmetryLists.length; c++) {
          const segPts = symmetryLists[c].slice(fromIdx, targetEndIdx + 1);
          const { bounds, lastCell } = this.stepPixelSegment(strokeCtx, segPts, cell, session.pixelCells[c]);
          session.pixelCells[c] = lastCell;
          stepRect = unionRects(stepRect, bounds);
        }
        session.finalizedEndIdx = targetEndIdx;
        session.dirtyRect = unionRects(session.dirtyRect, stepRect);
      }
      strokeCtx.restore();

      const opacityChanged = Math.abs(opacity - session.lastOpacity) > 0.001;
      session.lastOpacity = opacity;
      const dirtyOnScratch = clampRect(opacityChanged ? session.dirtyRect : stepRect, width, height);
      if (dirtyOnScratch) {
        const { x, y, w, h } = dirtyOnScratch;
        scratchCtx.save();
        scratchCtx.beginPath();
        scratchCtx.rect(x, y, w, h);
        scratchCtx.clip();
        scratchCtx.clearRect(x, y, w, h);
        scratchCtx.drawImage(entry.canvas, x, y, w, h, x, y, w, h);
        applyClipPolygon(scratchCtx, d.clipPolygon, tx, ty, sx, sy);
        if (alphaLock) scratchCtx.globalCompositeOperation = 'source-atop';
        scratchCtx.globalAlpha = opacity;
        scratchCtx.drawImage(strokeCanvas, x, y, w, h, x, y, w, h);
        scratchCtx.restore();
      }
      return dirtyOnScratch;
    }

    // 2. Incremental Pro Smudge Brush (mutates scratchCanvas directly per step!)
    if (session.mode === 'smudge') {
      const rad = Math.max(2, d.width * 0.55 * scaleAvg);
      const diam = Math.max(4, Math.ceil(rad * 2));
      const stepDist = Math.max(1.2, rad * 0.22);
      const hardness01 = Math.max(0.05, Math.min(1, (d.hardness ?? 30) / 100));
      const flow01 = Math.max(0.05, Math.min(1, (d.flow ?? 68) / 100));
      const carryWeight = 0.4 + 0.52 * flow01;
      const pickupWeight = 1 - carryWeight;
      const depositAlpha = Math.max(0.08, Math.min(0.95, opacity * (0.35 + 0.65 * flow01)));
      const softMask = this.tipLib.getSoftMaskTip(hardness01);

      let stepRect: DirtyRect | null = null;
      if (d.points.length === 1 && session.finalizedEndIdx < 0) {
        for (let c = 0; c < symmetryLists.length; c++) {
          const carryCtx = session.carryCanvases[c]?.getContext('2d');
          if (carryCtx && symmetryLists[c].length) {
            copyPatchClamped(scratchCanvas, symmetryLists[c][0].x, symmetryLists[c][0].y, diam, carryCtx);
          }
        }
        session.finalizedEndIdx = 0;
      } else if (d.points.length >= 2 && targetEndIdx > session.finalizedEndIdx) {
        const fromIdx = Math.max(0, session.finalizedEndIdx);
        const initializeCarry = session.finalizedEndIdx < 0;
        for (let c = 0; c < symmetryLists.length; c++) {
          const segPts = buildFinalizedSegments(symmetryLists[c], fromIdx, targetEndIdx, Boolean(d.smoothing), false);
          const carry = session.carryCanvases[c];
          if (segPts.length && carry) {
            const { bounds, residual } = this.stepSmudgeSegment(
              scratchCtx,
              scratchCanvas,
              carry,
              segPts,
              d,
              rad,
              diam,
              stepDist,
              pickupWeight,
              depositAlpha,
              softMask,
              alphaLock,
              tx,
              ty,
              sx,
              sy,
              session.residuals[c] ?? 0,
              initializeCarry,
            );
            session.residuals[c] = residual;
            stepRect = unionRects(stepRect, bounds);
          }
        }
        session.finalizedEndIdx = targetEndIdx;
        session.dirtyRect = unionRects(session.dirtyRect, stepRect);
      }
      return stepRect;
    }

    // 3. Incremental Pro Blur Brush (mutates scratchCanvas directly per step!)
    if (session.mode === 'blur') {
      const rad = Math.max(3, d.width * 0.6 * scaleAvg);
      const diam = Math.max(6, Math.ceil(rad * 2));
      const hardness01 = Math.max(0.05, Math.min(1, (d.hardness ?? 25) / 100));
      const flow01 = Math.max(0.05, Math.min(1, (d.flow ?? 60) / 100));
      const blurPx = Math.max(1.5, Math.min(18, rad * 0.38 * (0.4 + 0.6 * flow01)));
      const pad = Math.ceil(blurPx * 2.5) + 2;
      const stepDist = Math.max(2, rad * 0.32);
      const dabAlpha = Math.max(0.1, Math.min(0.9, opacity * flow01 * 0.72));
      const softMask = this.tipLib.getSoftMaskTip(hardness01);

      let stepRect: DirtyRect | null = null;
      if (d.points.length === 1 && session.finalizedEndIdx < 0) {
        for (let c = 0; c < symmetryLists.length; c++) {
          const { bounds } = this.stepBlurSegment(
            scratchCtx,
            scratchCanvas,
            symmetryLists[c],
            d,
            rad,
            diam,
            blurPx,
            pad,
            stepDist,
            dabAlpha,
            softMask,
            alphaLock,
            tx,
            ty,
            sx,
            sy,
            0,
            true,
          );
          stepRect = unionRects(stepRect, bounds);
        }
        session.finalizedEndIdx = 0;
        session.dirtyRect = unionRects(session.dirtyRect, stepRect);
      } else if (d.points.length >= 2 && targetEndIdx > session.finalizedEndIdx) {
        const fromIdx = Math.max(0, session.finalizedEndIdx);
        const stampStart = session.finalizedEndIdx < 0;
        for (let c = 0; c < symmetryLists.length; c++) {
          const segPts = buildFinalizedSegments(symmetryLists[c], fromIdx, targetEndIdx, Boolean(d.smoothing), false);
          if (segPts.length) {
            const { bounds, residual } = this.stepBlurSegment(
              scratchCtx,
              scratchCanvas,
              segPts,
              d,
              rad,
              diam,
              blurPx,
              pad,
              stepDist,
              dabAlpha,
              softMask,
              alphaLock,
              tx,
              ty,
              sx,
              sy,
              session.residuals[c] ?? 0,
              stampStart,
            );
            session.residuals[c] = residual;
            stepRect = unionRects(stepRect, bounds);
          }
        }
        session.finalizedEndIdx = targetEndIdx;
        session.dirtyRect = unionRects(session.dirtyRect, stepRect);
      }
      return stepRect;
    }

    // 4. Incremental Stamp Brushes (Pencil, Pen, Brush, Airbrush, Watercolor, Marker, Eraser)
    const isEraser = d.tool === 'eraser';
    const hardness01 = isEraser
      ? Math.max(0.05, Math.min(1, (d.hardness ?? 85) / 100))
      : Math.max(0, Math.min(1, (d.hardness ?? profile.defaultHardness) / 100));
    const flow01 = isEraser ? 1 : Math.max(0.02, Math.min(1, (d.flow ?? profile.defaultFlow) / 100));
    const dabAlphaBase = isEraser
      ? 1
      : d.brushType === 'airbrush'
        ? flow01 * 0.34
        : d.brushType === 'watercolor'
          ? flow01 * 0.55
          : d.brushType === 'pencil'
            ? flow01 * 0.78
            : flow01;
    const tipColor = isEraser || d.brushType === 'pencil' || d.brushType === 'watercolor' ? '#000000' : d.color;
    const tip = this.tipLib.getTip(tipColor, hardness01, isEraser ? 'pen' : d.brushType);

    let stepRect: DirtyRect | null = null;
    if (d.points.length === 1 && session.finalizedEndIdx < 0) {
      for (let c = 0; c < symmetryLists.length; c++) {
        const pts = symmetryLists[c];
        const { bounds, dabCount, arcLen } = this.stampInterpolatedList(
          strokeCtx, pts, d, tip, profile, hasPressure, scaleAvg, dabAlphaBase, 0, true, 0, 0,
        );
        session.dabCounts[c] = dabCount;
        session.arcLengths[c] = arcLen;
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
          const { bounds, residual, dabCount, arcLen } = this.stampInterpolatedList(
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
            session.dabCounts[c] ?? 0,
            session.arcLengths[c] ?? 0,
          );
          session.residuals[c] = residual;
          session.dabCounts[c] = dabCount;
          session.arcLengths[c] = arcLen;
          stepRect = unionRects(stepRect, bounds);
        }
      }
      session.finalizedEndIdx = toIdx;
      session.dirtyRect = unionRects(session.dirtyRect, stepRect);
    }

    // Tail segment finalization (on commit) or live preview (mid-stroke)
    let currentTipRect: DirtyRect | null = null;
    if (isFinal && hasSubdivide && d.points.length >= 2) {
      for (let c = 0; c < symmetryLists.length; c++) {
        const tailPts = buildTailSegment(symmetryLists[c], Boolean(d.smoothing), hasSubdivide);
        if (tailPts.length >= 2) {
          const { bounds, residual, dabCount, arcLen } = this.stampInterpolatedList(
            strokeCtx,
            tailPts,
            d,
            tip,
            profile,
            hasPressure,
            scaleAvg,
            dabAlphaBase,
            session.residuals[c] ?? 0,
            false,
            session.dabCounts[c] ?? 0,
            session.arcLengths[c] ?? 0,
          );
          session.residuals[c] = residual;
          session.dabCounts[c] = dabCount;
          session.arcLengths[c] = arcLen;
          stepRect = unionRects(stepRect, bounds);
        }
      }
      session.dirtyRect = unionRects(session.dirtyRect, stepRect);
    }

    let tailLists: BoardPoint[][] | null = null;
    let tailApproxRect: DirtyRect | null = null;
    if (!isFinal && hasSubdivide && d.points.length >= 2) {
      tailLists = [];
      const pad = Math.max(8, profile.base * scaleAvg * (d.brushType === 'airbrush' ? 1.5 : 1.1) + 6);
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let c = 0; c < symmetryLists.length; c++) {
        const tailPts = buildTailSegment(symmetryLists[c], Boolean(d.smoothing), hasSubdivide);
        tailLists.push(tailPts);
        for (let k = 0; k < tailPts.length; k++) {
          const p = tailPts[k];
          if (p.x < minX) minX = p.x;
          if (p.y < minY) minY = p.y;
          if (p.x > maxX) maxX = p.x;
          if (p.y > maxY) maxY = p.y;
        }
      }
      if (maxX >= minX) {
        tailApproxRect = clampRect({ x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 }, width, height);
      }
    }

    const opacityChanged = Math.abs(opacity - session.lastOpacity) > (isFinal ? 0.001 : 0.03);
    if (opacityChanged || isFinal) {
      session.lastOpacity = opacity;
    }
    // Expand watercolor transfer slightly so outer-edge wet-rim re-evaluates cleanly without inner seams
    const expandedStep = d.brushType === 'watercolor' && stepRect
      ? clampRect({ x: stepRect.x - 3, y: stepRect.y - 3, w: stepRect.w + 6, h: stepRect.h + 6 }, width, height)
      : stepRect;
    const dirtyOnScratch = clampRect(
      unionRects(
        unionRects(session.tipRect, tailApproxRect),
        opacityChanged ? session.dirtyRect : expandedStep,
      ),
      width,
      height,
    );

    const hasLiveTail = Boolean(!isFinal && tailLists && tailLists.some(t => t.length >= 2));
    const tipBuf = hasLiveTail ? this.ensureTipBuffer(width, height) : null;
    if (dirtyOnScratch) {
      const { x, y, w, h } = dirtyOnScratch;
      let sourceStrokeCtx = strokeCtx;
      let sourceStrokeCanvas = strokeCanvas;

      if (tipBuf && tailLists) {
        const copyRect = d.brushType === 'watercolor'
          ? (clampRect({ x: x - 3, y: y - 3, w: w + 6, h: h + 6 }, width, height) ?? dirtyOnScratch)
          : dirtyOnScratch;
        tipBuf.ctx.save();
        tipBuf.ctx.globalAlpha = 1;
        tipBuf.ctx.globalCompositeOperation = 'source-over';
        tipBuf.ctx.clearRect(copyRect.x, copyRect.y, copyRect.w, copyRect.h);
        tipBuf.ctx.drawImage(strokeCanvas, copyRect.x, copyRect.y, copyRect.w, copyRect.h, copyRect.x, copyRect.y, copyRect.w, copyRect.h);
        tipBuf.ctx.restore();
        for (let c = 0; c < symmetryLists.length; c++) {
          const tailPts = tailLists[c];
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
              session.dabCounts[c] ?? 0,
              session.arcLengths[c] ?? 0,
            );
            currentTipRect = unionRects(currentTipRect, bounds);
          }
        }
        sourceStrokeCtx = tipBuf.ctx;
        sourceStrokeCanvas = tipBuf.canvas;
      }

      scratchCtx.save();
      scratchCtx.beginPath();
      scratchCtx.rect(x, y, w, h);
      scratchCtx.clip();
      scratchCtx.clearRect(x, y, w, h);
      scratchCtx.drawImage(entry.canvas, x, y, w, h, x, y, w, h);
      scratchCtx.restore();

      if (isEraser) {
        scratchCtx.save();
        applyClipPolygon(scratchCtx, d.clipPolygon, tx, ty, sx, sy);
        scratchCtx.globalCompositeOperation = 'destination-out';
        scratchCtx.globalAlpha = opacity;
        scratchCtx.drawImage(sourceStrokeCanvas, x, y, w, h, x, y, w, h);
        scratchCtx.restore();
      } else {
        applySurfaceTransfer(
          sourceStrokeCtx,
          scratchCtx,
          dirtyOnScratch,
          d.brushType,
          d.color,
          opacity,
          alphaLock,
          d.clipPolygon,
          tx,
          ty,
          sx,
          sy,
        );
      }
    }
    session.tipRect = currentTipRect;

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

  private buildCompositeSampleForBucket(
    layers: readonly BoardLayer[],
    currentLayerId: string,
    currentLayerCanvas: HTMLCanvasElement,
    width: number,
    height: number,
  ): Uint8ClampedArray | null {
    const comp = document.createElement('canvas');
    comp.width = width;
    comp.height = height;
    const cCtx = comp.getContext('2d');
    if (!cCtx) return null;
    for (const l of layers) {
      if (l.hidden || l.deleted) continue;
      const src = l.id === currentLayerId ? currentLayerCanvas : this.layerCache.get(l.id)?.canvas;
      if (!src) continue;
      cCtx.save();
      cCtx.globalAlpha = Math.max(0, Math.min(100, l.opacity ?? 100)) / 100;
      if (l.blendMode && l.blendMode !== 'normal') cCtx.globalCompositeOperation = l.blendMode;
      cCtx.drawImage(src, l.x, l.y);
      cCtx.restore();
    }
    return cCtx.getImageData(0, 0, width, height).data;
  }

  private ensureLayerEntry(
    layer: BoardLayer,
    committedShapes: readonly BoardShape[],
    width: number,
    height: number,
    scratch: { scratchCanvas: HTMLCanvasElement; scratchCtx: CanvasRenderingContext2D; strokeCanvas: HTMLCanvasElement; strokeCtx: CanvasRenderingContext2D },
    skipRebuild: boolean,
    allLayers?: readonly BoardLayer[],
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

    const getCompositeSample = allLayers
      ? () => this.buildCompositeSampleForBucket(allLayers, layer.id, entry!.canvas, width, height)
      : undefined;

    if (!isPrefixMatch) {
      entry.ctx.clearRect(0, 0, width, height);
      entry.alphaLock = alphaLock;
      for (const s of committedShapes) {
        this.renderShapeOntoLayerCtx(
          entry.ctx,
          entry.canvas,
          scratch.strokeCtx,
          scratch.strokeCanvas,
          s,
          width,
          height,
          alphaLock,
          null,
          getCompositeSample,
        );
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
        this.liveSession.layerId === layer.id &&
        this.liveSession.layerVersion === entry.version &&
        this.liveSession.alphaLock === alphaLock &&
        committedShapes[startIdx].id === this.liveSession.shapeId
      ) {
        const committed = committedShapes[startIdx];
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
          getCompositeSample,
          true,
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
          null,
          getCompositeSample,
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
      const synced = this.ensureLayerEntry(view, committedShapes, width, height, scratch, isResizing, layers);
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

  /** Returns the raw RGBA pixel buffer of a single layer directly from its cached canvas (for Magic Wand). */
  getLayerPixelData(
    layerId: string,
    layers: readonly BoardLayer[],
    shapes: readonly BoardShape[],
    boardWidth: number,
    boardHeight: number,
  ): Uint8ClampedArray | null {
    const scratch = this.ensureScratch(boardWidth, boardHeight);
    if (!scratch) return null;
    const layer = layers.find(l => l.id === layerId);
    if (!layer) return null;
    const layerShapes = shapes.filter(s => !s.hidden && (s.layerId ?? DEFAULT_BOARD_LAYER) === layerId);
    const synced = this.ensureLayerEntry(layer, layerShapes, boardWidth, boardHeight, scratch, false, layers);
    if (!synced) return null;
    return synced.entry.ctx.getImageData(0, 0, boardWidth, boardHeight).data;
  }

  /** Returns the composited RGBA pixel buffer across all visible layers (for Magic Wand Sample-All). */
  getCompositePixelData(
    layers: readonly BoardLayer[],
    shapes: readonly BoardShape[],
    boardWidth: number,
    boardHeight: number,
  ): Uint8ClampedArray | null {
    const sync = this.syncLayers(null, layers, shapes, new Map(), null, null, boardWidth, boardHeight, '#ffffff', true);
    if (!sync) return null;
    const comp = document.createElement('canvas');
    comp.width = boardWidth;
    comp.height = boardHeight;
    const ctx = comp.getContext('2d');
    if (!ctx) return null;
    for (const item of sync.layers) {
      ctx.save();
      ctx.globalAlpha = item.opacity;
      if (item.blendMode !== 'normal') ctx.globalCompositeOperation = item.blendMode;
      ctx.drawImage(item.canvas, item.x, item.y);
      ctx.restore();
    }
    return ctx.getImageData(0, 0, boardWidth, boardHeight).data;
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
    const synced = this.ensureLayerEntry(layer, layerShapes, boardWidth, boardHeight, scratch, false, layers);
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

  /** Renders the complete board scene onto a target 2D canvas (used for WYSIWYG PNG export and direct 2D targets). */
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
