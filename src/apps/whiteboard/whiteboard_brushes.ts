import type { BoardBrushType, BoardPoint } from './whiteboard_scene.ts';
import { parseHexRgb } from './whiteboard_raster.ts';

export interface BrushStudioPreset {
  opacity: number;
  flow: number;
  hardness: number;
  spacing: number;
}

export const BRUSH_STUDIO_PRESETS: Record<BoardBrushType, BrushStudioPreset> = {
  pencil: { opacity: 92, flow: 75, hardness: 65, spacing: 10 },
  pen: { opacity: 100, flow: 100, hardness: 98, spacing: 6 },
  brush: { opacity: 100, flow: 85, hardness: 72, spacing: 9 },
  airbrush: { opacity: 75, flow: 22, hardness: 5, spacing: 10 },
  watercolor: { opacity: 68, flow: 45, hardness: 35, spacing: 12 },
  marker: { opacity: 85, flow: 90, hardness: 88, spacing: 7 },
  pixel: { opacity: 100, flow: 100, hardness: 100, spacing: 10 },
  smudge: { opacity: 100, flow: 68, hardness: 30, spacing: 12 },
  blur: { opacity: 100, flow: 60, hardness: 25, spacing: 18 },
};

const PAPER_SIZE = 256;
let pencilPaperGrain: Uint8Array | null = null;
let watercolorPaperGrain: Uint8Array | null = null;

function hash2D(ix: number, iy: number, seed: number): number {
  let n = ((ix & 255) * 374761393 + (iy & 255) * 668265263 + seed * 1442695041) | 0;
  n = (n ^ (n >>> 13)) * 1274126177;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

function periodicValueNoise(x: number, y: number, period: number, seed: number): number {
  const gx = x * period;
  const gy = y * period;
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const fx = gx - x0;
  const fy = gy - y0;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const xm0 = ((x0 % period) + period) % period;
  const ym0 = ((y0 % period) + period) % period;
  const xm1 = (xm0 + 1) % period;
  const ym1 = (ym0 + 1) % period;
  const v00 = hash2D(xm0, ym0, seed);
  const v10 = hash2D(xm1, ym0, seed);
  const v01 = hash2D(xm0, ym1, seed);
  const v11 = hash2D(xm1, ym1, seed);
  const a = v00 + (v10 - v00) * ux;
  const b = v01 + (v11 - v01) * ux;
  return a + (b - a) * uy;
}

/** Deterministic 256x256 seamless world-space graphite paper tooth heightmap (0..255). */
export function getPencilPaperGrain(): Uint8Array {
  if (pencilPaperGrain) return pencilPaperGrain;
  const out = new Uint8Array(PAPER_SIZE * PAPER_SIZE);
  for (let y = 0; y < PAPER_SIZE; y++) {
    const ny = y / PAPER_SIZE;
    for (let x = 0; x < PAPER_SIZE; x++) {
      const nx = x / PAPER_SIZE;
      const coarse = periodicValueNoise(nx, ny, 16, 11);
      const mid = periodicValueNoise(nx, ny, 48, 29);
      const fine = periodicValueNoise(nx, ny, 128, 73);
      // Subtle diagonal cold-press weave
      const weave = 0.5 + 0.5 * Math.sin((x + y * 0.65) * 0.49087385);
      const val = coarse * 0.28 + mid * 0.36 + fine * 0.26 + weave * 0.1;
      out[y * PAPER_SIZE + x] = Math.max(0, Math.min(255, Math.round(val * 255)));
    }
  }
  pencilPaperGrain = out;
  return out;
}

/** Deterministic 256x256 seamless world-space cold-press watercolor granulation map (0..255). */
export function getWatercolorPaperGrain(): Uint8Array {
  if (watercolorPaperGrain) return watercolorPaperGrain;
  const out = new Uint8Array(PAPER_SIZE * PAPER_SIZE);
  for (let y = 0; y < PAPER_SIZE; y++) {
    const ny = y / PAPER_SIZE;
    for (let x = 0; x < PAPER_SIZE; x++) {
      const nx = x / PAPER_SIZE;
      const blotch = periodicValueNoise(nx, ny, 8, 101);
      const fibers = periodicValueNoise(nx, ny, 24, 211);
      const grain = periodicValueNoise(nx, ny, 64, 307);
      const val = blotch * 0.45 + fibers * 0.35 + grain * 0.2;
      out[y * PAPER_SIZE + x] = Math.max(0, Math.min(255, Math.round(val * 255)));
    }
  }
  watercolorPaperGrain = out;
  return out;
}

const TIP_SIZE = 128;

export class BrushTipLibrary {
  private tipCache = new Map<string, HTMLCanvasElement>();
  private softMaskCache = new Map<string, HTMLCanvasElement>();

  getTip(
    color: string,
    hardness01: number,
    brushType: BoardBrushType | undefined,
  ): HTMLCanvasElement {
    const hKey = Math.round(Math.max(0, Math.min(1, hardness01)) * 20) / 20;
    const key = `${color}:${hKey}:${brushType ?? 'brush'}`;
    const existing = this.tipCache.get(key);
    if (existing) {
      // Refresh LRU position
      this.tipCache.delete(key);
      this.tipCache.set(key, existing);
      return existing;
    }

    const size = TIP_SIZE;
    const half = size / 2;
    const tip = document.createElement('canvas');
    tip.width = size;
    tip.height = size;
    const ctx = tip.getContext('2d')!;
    const [r, g, b] = parseHexRgb(color);

    if (brushType === 'marker') {
      // Bevelled -35 deg felt chisel nib with soft anti-aliased edges
      ctx.save();
      ctx.translate(half, half);
      ctx.rotate(-0.61);
      const w = size * 0.78;
      const h = size * 0.28;
      const radius = h * 0.28;
      ctx.beginPath();
      ctx.roundRect(-w / 2, -h / 2, w, h, radius);
      ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
      ctx.fill();
      ctx.restore();
    } else if (brushType === 'brush') {
      // Multi-bristle bundle: 22 overlapping soft bristles in a subtly elliptical bundle
      const imgData = ctx.createImageData(size, size);
      const data = imgData.data;
      const bristles: Array<{ cx: number; cy: number; rx: number; ry: number; weight: number }> = [];
      for (let i = 0; i < 22; i++) {
        const s1 = hash2D(i, 1, 17);
        const s2 = hash2D(i, 2, 31);
        const s3 = hash2D(i, 3, 53);
        const angle = (i / 22) * Math.PI * 2 + s1 * 0.4;
        const ring = i < 6 ? 0.22 * s2 : 0.42 + 0.34 * s2;
        const cx = Math.cos(angle) * ring * 0.72;
        const cy = Math.sin(angle) * ring * 0.92;
        const br = 0.16 + 0.12 * s3;
        bristles.push({ cx, cy, rx: br * 1.15, ry: br * 0.95, weight: 0.72 + 0.28 * s1 });
      }
      const coreSoft = 0.3 + 0.65 * hKey;
      for (let y = 0; y < size; y++) {
        const ny = (y + 0.5 - half) / half;
        for (let x = 0; x < size; x++) {
          const nx = (x + 0.5 - half) / half;
          const envDist = Math.hypot(nx / 0.96, ny / 0.96);
          if (envDist >= 1) continue;
          let sum = 0;
          for (let k = 0; k < bristles.length; k++) {
            const br = bristles[k];
            const d = Math.hypot((nx - br.cx) / br.rx, (ny - br.cy) / br.ry);
            if (d < 1) {
              const t = 1 - d;
              sum += t * t * (3 - 2 * t) * br.weight;
            }
          }
          const env = envDist > coreSoft
            ? Math.max(0, 1 - (envDist - coreSoft) / Math.max(0.02, 1 - coreSoft))
            : 1;
          const alpha = Math.min(1, sum * 0.52) * env * env;
          if (alpha <= 0.002) continue;
          const idx = (y * size + x) * 4;
          data[idx] = r;
          data[idx + 1] = g;
          data[idx + 2] = b;
          data[idx + 3] = Math.round(alpha * 255);
        }
      }
      ctx.putImageData(imgData, 0, 0);
    } else if (brushType === 'airbrush') {
      // True Gaussian mist with deterministic micro-dither to prevent concentric 8-bit banding
      const imgData = ctx.createImageData(size, size);
      const data = imgData.data;
      const sigmaSq = 0.22 + (1 - hKey) * 0.16;
      for (let y = 0; y < size; y++) {
        const ny = (y + 0.5 - half) / half;
        for (let x = 0; x < size; x++) {
          const nx = (x + 0.5 - half) / half;
          const r2 = nx * nx + ny * ny;
          if (r2 >= 1) continue;
          const edge = (1 - r2);
          const gauss = Math.exp(-r2 / sigmaSq) * edge * edge;
          const dither = (hash2D(x, y, 97) - 0.5) * (1 / 255);
          const a = Math.max(0, Math.min(1, gauss + dither));
          if (a <= 0.001) continue;
          const idx = (y * size + x) * 4;
          data[idx] = r;
          data[idx + 1] = g;
          data[idx + 2] = b;
          data[idx + 3] = Math.round(a * 255);
        }
      }
      ctx.putImageData(imgData, 0, 0);
    } else if (brushType === 'watercolor') {
      // Soft organic wet wash dab without harsh outer bubble ring
      const imgData = ctx.createImageData(size, size);
      const data = imgData.data;
      for (let y = 0; y < size; y++) {
        const ny = (y + 0.5 - half) / half;
        for (let x = 0; x < size; x++) {
          const nx = (x + 0.5 - half) / half;
          const ang = Math.atan2(ny, nx);
          const wobble = 0.92 + 0.06 * Math.sin(ang * 3 + 0.8) + 0.04 * Math.cos(ang * 5 - 1.2);
          const dist = Math.hypot(nx, ny) / wobble;
          if (dist >= 1) continue;
          const softEdge = Math.max(0.15, hKey * 0.85);
          const falloff = dist <= softEdge
            ? 1
            : Math.max(0, 1 - (dist - softEdge) / Math.max(0.05, 1 - softEdge));
          const smooth = falloff * falloff * (3 - 2 * falloff);
          const idx = (y * size + x) * 4;
          data[idx] = r;
          data[idx + 1] = g;
          data[idx + 2] = b;
          data[idx + 3] = Math.round(smooth * 215);
        }
      }
      ctx.putImageData(imgData, 0, 0);
    } else if (brushType === 'pencil') {
      // Organic slightly irregular graphite lead core (paper grain is applied in world space on transfer)
      const imgData = ctx.createImageData(size, size);
      const data = imgData.data;
      const innerHard = 0.32 + 0.5 * hKey;
      for (let y = 0; y < size; y++) {
        const ny = (y + 0.5 - half) / half;
        for (let x = 0; x < size; x++) {
          const nx = (x + 0.5 - half) / half;
          const ang = Math.atan2(ny, nx);
          const shapeMod = 0.92 + 0.05 * Math.sin(ang * 3 + 0.4) + 0.03 * Math.cos(ang * 7 - 0.9);
          const dist = Math.hypot(nx, ny) / shapeMod;
          if (dist >= 1) continue;
          const t = dist <= innerHard ? 1 : 1 - (dist - innerHard) / Math.max(0.05, 1 - innerHard);
          const smooth = t * t * (3 - 2 * t);
          const idx = (y * size + x) * 4;
          data[idx] = r;
          data[idx + 1] = g;
          data[idx + 2] = b;
          data[idx + 3] = Math.round(smooth * 255);
        }
      }
      ctx.putImageData(imgData, 0, 0);
    } else {
      // 'pen' (supersampled crisp AA ink nib), default round brush, or soft eraser
      const effHard = brushType === 'pen'
        ? Math.max(0.88, hKey)
        : Math.max(0.02, Math.min(0.98, hKey));
      const imgData = ctx.createImageData(size, size);
      const data = imgData.data;
      const inner = effHard * 0.94;
      for (let y = 0; y < size; y++) {
        const ny = (y + 0.5 - half) / half;
        for (let x = 0; x < size; x++) {
          const nx = (x + 0.5 - half) / half;
          const dist = Math.hypot(nx, ny);
          if (dist >= 1) continue;
          let alpha = 1;
          if (dist > inner) {
            const t = (dist - inner) / Math.max(0.015, 1 - inner);
            alpha = Math.max(0, 1 - t * t * (3 - 2 * t));
          }
          const idx = (y * size + x) * 4;
          data[idx] = r;
          data[idx + 1] = g;
          data[idx + 2] = b;
          data[idx + 3] = Math.round(alpha * 255);
        }
      }
      ctx.putImageData(imgData, 0, 0);
    }

    if (this.tipCache.size >= 128) {
      const oldest = this.tipCache.keys().next().value;
      if (oldest) this.tipCache.delete(oldest);
    }
    this.tipCache.set(key, tip);
    return tip;
  }

  /** Smooth radial white-alpha mask for soft smudge & blur feathering (no hard circular cutouts). */
  getSoftMaskTip(hardness01: number): HTMLCanvasElement {
    const hKey = Math.round(Math.max(0, Math.min(1, hardness01)) * 20) / 20;
    const key = String(hKey);
    const existing = this.softMaskCache.get(key);
    if (existing) return existing;

    const size = TIP_SIZE;
    const half = size / 2;
    const tip = document.createElement('canvas');
    tip.width = size;
    tip.height = size;
    const ctx = tip.getContext('2d')!;
    const imgData = ctx.createImageData(size, size);
    const data = imgData.data;
    const inner = hKey * 0.72;
    for (let y = 0; y < size; y++) {
      const ny = (y + 0.5 - half) / half;
      for (let x = 0; x < size; x++) {
        const nx = (x + 0.5 - half) / half;
        const dist = Math.hypot(nx, ny);
        if (dist >= 1) continue;
        let alpha = 1;
        if (dist > inner) {
          const t = (dist - inner) / Math.max(0.05, 1 - inner);
          const fall = Math.max(0, 1 - t);
          alpha = fall * fall * (3 - 2 * fall);
        }
        const idx = (y * size + x) * 4;
        data[idx] = 255;
        data[idx + 1] = 255;
        data[idx + 2] = 255;
        data[idx + 3] = Math.round(alpha * 255);
      }
    }
    ctx.putImageData(imgData, 0, 0);

    if (this.softMaskCache.size >= 32) {
      const oldest = this.softMaskCache.keys().next().value;
      if (oldest) this.softMaskCache.delete(oldest);
    }
    this.softMaskCache.set(key, tip);
    return tip;
  }
}

let transferCanvas: HTMLCanvasElement | null = null;
let transferCtx: CanvasRenderingContext2D | null = null;

function ensureTransferBuffer(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  if (typeof document === 'undefined') return null;
  if (!transferCanvas || transferCanvas.width < w || transferCanvas.height < h) {
    transferCanvas = document.createElement('canvas');
    transferCanvas.width = Math.max(w, transferCanvas.width || 0);
    transferCanvas.height = Math.max(h, transferCanvas.height || 0);
    transferCtx = transferCanvas.getContext('2d');
  }
  if (!transferCtx) return null;
  return { canvas: transferCanvas, ctx: transferCtx };
}

/**
 * Transfers an accumulated stroke density buffer (`strokeCtx`) onto `targetCtx` inside `rect`,
 * applying seamless world-space paper tooth for `pencil` and cold-press granulation + true
 * outer-perimeter wet-edge pigment pooling for `watercolor`.
 */
export function applySurfaceTransfer(
  strokeCtx: CanvasRenderingContext2D,
  targetCtx: CanvasRenderingContext2D,
  rect: { x: number; y: number; w: number; h: number },
  brushType: BoardBrushType | undefined,
  color: string,
  opacity: number,
  alphaLock: boolean,
  clipPolygon?: readonly BoardPoint[],
  tx = 0,
  ty = 0,
  sx = 1,
  sy = 1,
): void {
  const { x, y, w, h } = rect;
  if (w <= 0 || h <= 0) return;

  if (brushType !== 'pencil' && brushType !== 'watercolor') {
    targetCtx.save();
    if (clipPolygon?.length) {
      targetCtx.beginPath();
      clipPolygon.forEach((p, idx) => {
        const px = tx + p.x * sx, py = ty + p.y * sy;
        if (idx === 0) targetCtx.moveTo(px, py);
        else targetCtx.lineTo(px, py);
      });
      targetCtx.closePath();
      targetCtx.clip('evenodd');
    }
    if (alphaLock) {
      targetCtx.globalCompositeOperation = 'source-atop';
    } else if (brushType === 'marker') {
      targetCtx.globalCompositeOperation = 'multiply';
    }
    targetCtx.globalAlpha = brushType === 'marker' ? Math.max(0.05, Math.min(1, opacity * 0.82)) : opacity;
    targetCtx.drawImage(strokeCtx.canvas, x, y, w, h, x, y, w, h);
    targetCtx.restore();
    return;
  }

  const buf = ensureTransferBuffer(w, h);
  if (!buf) return;
  const [cr, cg, cb] = parseHexRgb(color);
  const cw = strokeCtx.canvas.width;
  const ch = strokeCtx.canvas.height;

  if (brushType === 'pencil') {
    const grain = getPencilPaperGrain();
    const srcImg = strokeCtx.getImageData(x, y, w, h);
    const dstImg = buf.ctx.createImageData(w, h);
    const src = srcImg.data;
    const dst = dstImg.data;
    for (let row = 0; row < h; row++) {
      const py = (y + row) & 255;
      const gRow = py * PAPER_SIZE;
      const rOff = row * w;
      for (let col = 0; col < w; col++) {
        const idx4 = (rOff + col) * 4;
        const a = src[idx4 + 3];
        if (a === 0) continue;
        const density = a / 255;
        const tooth = grain[gRow + ((x + col) & 255)] / 255;
        // Soft threshold: light strokes catch paper peaks, heavy strokes fill paper valleys
        const cov = Math.max(0, Math.min(1, (density * 1.48 - (1 - tooth) * 0.72) / 0.58));
        if (cov <= 0.004) continue;
        dst[idx4] = cr;
        dst[idx4 + 1] = cg;
        dst[idx4 + 2] = cb;
        dst[idx4 + 3] = Math.round(cov * opacity * 255);
      }
    }
    buf.ctx.putImageData(dstImg, 0, 0);
  } else {
    // Watercolor: cold-press granulation + true outer-perimeter wet-edge pigment pooling
    const pad = 2;
    const sx0 = Math.max(0, x - pad);
    const sy0 = Math.max(0, y - pad);
    const sx1 = Math.min(cw, x + w + pad);
    const sy1 = Math.min(ch, y + h + pad);
    const sw = sx1 - sx0;
    const sh = sy1 - sy0;
    const grain = getWatercolorPaperGrain();
    const srcImg = strokeCtx.getImageData(sx0, sy0, sw, sh);
    const dstImg = buf.ctx.createImageData(w, h);
    const src = srcImg.data;
    const dst = dstImg.data;
    const ox = x - sx0;
    const oy = y - sy0;

    for (let row = 0; row < h; row++) {
      const syLocal = oy + row;
      const py = (y + row) & 255;
      const gRow = py * PAPER_SIZE;
      const rOff = row * w;
      for (let col = 0; col < w; col++) {
        const sxLocal = ox + col;
        const cAlpha = src[(syLocal * sw + sxLocal) * 4 + 3];
        if (cAlpha === 0) continue;
        const left = sxLocal >= 2 ? src[(syLocal * sw + (sxLocal - 2)) * 4 + 3] : 0;
        const right = sxLocal + 2 < sw ? src[(syLocal * sw + (sxLocal + 2)) * 4 + 3] : 0;
        const up = syLocal >= 2 ? src[((syLocal - 2) * sw + sxLocal) * 4 + 3] : 0;
        const down = syLocal + 2 < sh ? src[((syLocal + 2) * sw + sxLocal) * 4 + 3] : 0;
        const minNeighbor = Math.min(left, right, up, down);
        const rimFactor = Math.max(0, (cAlpha - minNeighbor) / 255);
        const gran = grain[gRow + ((x + col) & 255)] / 255;
        const density = cAlpha / 255;
        const modAlpha = Math.max(
          0,
          Math.min(1, density * (0.76 + 0.28 * gran + 0.34 * rimFactor) * opacity),
        );
        const shade = Math.max(0.76, 1 - rimFactor * 0.24 - (1 - gran) * 0.08);
        const idx4 = (rOff + col) * 4;
        dst[idx4] = Math.round(cr * shade);
        dst[idx4 + 1] = Math.round(cg * shade);
        dst[idx4 + 2] = Math.round(cb * shade);
        dst[idx4 + 3] = Math.round(modAlpha * 255);
      }
    }
    buf.ctx.putImageData(dstImg, 0, 0);
  }

  targetCtx.save();
  if (clipPolygon?.length) {
    targetCtx.beginPath();
    clipPolygon.forEach((p, idx) => {
      const px = tx + p.x * sx, py = ty + p.y * sy;
      if (idx === 0) targetCtx.moveTo(px, py);
      else targetCtx.lineTo(px, py);
    });
    targetCtx.closePath();
    targetCtx.clip('evenodd');
  }
  if (alphaLock) {
    targetCtx.globalCompositeOperation = 'source-atop';
  } else if (brushType === 'watercolor') {
    targetCtx.globalCompositeOperation = 'multiply';
  }
  targetCtx.drawImage(buf.canvas, 0, 0, w, h, x, y, w, h);
  targetCtx.restore();
}

const previewTipLib = new BrushTipLibrary();

/** Renders an authentic brush tip preview into the toolbar 28x28 preview canvas. */
export function drawBrushPreviewCanvas(
  canvas: HTMLCanvasElement,
  opts: {
    tool: string;
    brushType: BoardBrushType;
    color: string;
    width: number;
    opacity: number;
    hardness: number;
  },
): boolean {
  const ctx = canvas.getContext('2d');
  if (!ctx || typeof ctx.clearRect !== 'function' || typeof ctx.createImageData !== 'function') {
    return false;
  }
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const diameter = Math.max(4, Math.min(w - 4, opts.width * 0.34 + 3));
  const half = diameter / 2;
  const cx = w / 2;
  const cy = h / 2;

  if (opts.tool === 'eraser') {
    ctx.save();
    ctx.strokeStyle = '#64748b';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 2]);
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(2.5, half - 1), 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    return true;
  }

  if (opts.tool === 'brush' && opts.brushType === 'pixel') {
    ctx.save();
    ctx.fillStyle = opts.color;
    ctx.globalAlpha = Math.max(0.15, opts.opacity / 100);
    const side = Math.max(4, Math.round(diameter * 0.85));
    ctx.fillRect(Math.round(cx - side / 2), Math.round(cy - side / 2), side, side);
    ctx.restore();
    return true;
  }

  if (opts.tool === 'brush' && (opts.brushType === 'smudge' || opts.brushType === 'blur')) {
    ctx.save();
    const mask = previewTipLib.getSoftMaskTip(opts.hardness / 100);
    ctx.globalAlpha = 0.65;
    ctx.drawImage(mask, cx - half, cy - half, diameter, diameter);
    ctx.strokeStyle = opts.brushType === 'smudge' ? '#3b82f6' : '#0ea5e9';
    ctx.lineWidth = 1.25;
    ctx.setLineDash([2.5, 2]);
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(3, half - 1), 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    return true;
  }

  const tip = previewTipLib.getTip(
    opts.color,
    opts.hardness / 100,
    opts.tool === 'brush' ? opts.brushType : 'pen',
  );
  ctx.save();
  ctx.globalAlpha = Math.max(0.18, opts.opacity / 100);
  ctx.drawImage(tip, cx - half, cy - half, diameter, diameter);
  ctx.restore();
  return true;
}
