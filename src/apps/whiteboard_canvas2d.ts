import {
  brushHitPoints, brushProfile, chiselMarkerPath, DEFAULT_BOARD_LAYER, expandSymmetryPointLists,
  gPenCalligraphicPath, shapeOpacity, type BoardBrushType, type BoardLayer, type BoardPoint, type BoardShape,
} from './whiteboard_scene';
import { computeFloodMask, parseHexRgb } from './whiteboard_raster';

interface LayerCanvasEntry {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  renderedIds: string[];
  width: number;
  height: number;
}

/**
 * Hardware-accelerated HTML5 2D Canvas renderer for the Whiteboard studio.
 * Maintains per-layer offscreen pixel canvases at exact board resolution (e.g. 1920x1080)
 * so zooming in reveals discrete raster pixels (like FireAlpaca, Photoshop, and Magma)
 * while keeping live brush drawing at 120+ FPS by caching committed shapes per layer.
 */
export class WhiteboardCanvas2DRenderer {
  private layerCache = new Map<string, LayerCanvasEntry>();
  private scratchCanvas: HTMLCanvasElement | null = null;
  private scratchCtx: CanvasRenderingContext2D | null = null;
  private strokeCanvas: HTMLCanvasElement | null = null;
  private strokeCtx: CanvasRenderingContext2D | null = null;
  private tipCache = new Map<string, HTMLCanvasElement>();
  private imageElements = new Map<string, HTMLImageElement>();
  private unsupportedCanvas = new WeakSet<HTMLCanvasElement>();

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
    }
    if (!this.strokeCanvas || this.strokeCanvas.width !== width || this.strokeCanvas.height !== height) {
      this.strokeCanvas = document.createElement('canvas');
      this.strokeCanvas.width = width;
      this.strokeCanvas.height = height;
      this.strokeCtx = this.strokeCanvas.getContext('2d');
    }
    if (!this.scratchCtx || !this.strokeCtx || typeof this.scratchCtx.drawImage !== 'function') return null;
    return {
      scratchCanvas: this.scratchCanvas,
      scratchCtx: this.scratchCtx,
      strokeCanvas: this.strokeCanvas,
      strokeCtx: this.strokeCtx,
    };
  }

  registerImage(hash: string, img: HTMLImageElement): void {
    this.imageElements.set(hash, img);
    // Invalidate layer caches so any image shape re-renders once the image finishes decoding
    this.layerCache.clear();
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
      // Chisel nib stamp at -35 degrees
      ctx.save();
      ctx.translate(half, half);
      ctx.rotate(-0.61);
      ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
      ctx.fillRect(-half * 0.85, -half * 0.28, size * 0.85, size * 0.28);
      ctx.restore();
    } else if (brushType === 'watercolor') {
      // Wet watercolor stamp: translucent wash center + subtle pigment pooling at the rim
      const grad = ctx.createRadialGradient(half, half, 0, half, half, half);
      grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0.55)`);
      grad.addColorStop(0.72, `rgba(${r}, ${g}, ${b}, 0.68)`);
      grad.addColorStop(0.9, `rgba(${r}, ${g}, ${b}, 0.88)`);
      grad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, size, size);
    } else if (brushType === 'pencil') {
      // Textured dry graphite stamp with deterministic paper grain
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
      // Radial falloff controlled by hardness (airbrush = ultra soft, pen = crisp, brush = adjustable)
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
  ): void {
    if (s.hidden) return;
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
      return;
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
        // Flood fill on current layer pixels if no precomputed clipPolygon
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
      return;
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
      return;
    }

    if (s.tool === 'text' && s.text) {
      const fontSize = Math.max(8, Math.round((s.fontSize ?? Math.max(14, s.width * 2)) * ((sx + sy) / 2)));
      layerCtx.globalAlpha = opacity;
      layerCtx.fillStyle = s.color;
      layerCtx.font = `${s.fontItalic ? 'italic ' : ''}${s.fontBold ? 'bold ' : ''}${fontSize}px sans-serif`;
      const lines = s.text.split('\n');
      lines.forEach((line, idx) => {
        layerCtx.fillText(line, tx + a.x * sx, ty + a.y * sy + (idx === 0 ? fontSize : fontSize + idx * fontSize * 1.25));
      });
      layerCtx.restore();
      return;
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
      }
      layerCtx.restore();
      return;
    }

    if (s.tool === 'rectangle' || s.tool === 'ellipse' || s.tool === 'line') {
      const ax = tx + a.x * sx, ay = ty + a.y * sy;
      const bx = tx + b.x * sx, by = ty + b.y * sy;
      layerCtx.globalAlpha = opacity;
      layerCtx.strokeStyle = s.color;
      layerCtx.fillStyle = s.color;
      layerCtx.lineWidth = Math.max(1, s.width * ((sx + sy) / 2));
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
      return;
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
      if (hardness01 >= 0.85 && !hasPressure) {
        layerCtx.strokeStyle = '#000000';
        layerCtx.lineWidth = Math.max(1, s.width * scaleAvg);
        layerCtx.lineCap = 'round';
        layerCtx.lineJoin = 'round';
        for (const pts of symmetryLists) {
          layerCtx.beginPath();
          pts.forEach((p, idx) => {
            if (idx === 0) layerCtx.moveTo(p.x, p.y);
            else layerCtx.lineTo(p.x, p.y);
          });
          if (pts.length === 1) layerCtx.lineTo(pts[0].x + 0.01, pts[0].y);
          layerCtx.stroke();
        }
      } else {
        const tip = this.getBrushTipStamp('#000000', hardness01, 'brush');
        this.stampStrokeLists(layerCtx, symmetryLists, s, tip, profile, hasPressure, scaleAvg, 1);
      }
      layerCtx.restore();
      return;
    }

    // 1. Pixel Art Brush: exact integer grid Bresenham squares with 0 anti-aliasing
    if (s.brushType === 'pixel') {
      const cell = Math.max(1, Math.round(s.width * scaleAvg));
      layerCtx.globalAlpha = opacity;
      layerCtx.fillStyle = s.color;
      layerCtx.imageSmoothingEnabled = false;
      for (const pts of symmetryLists) {
        if (!pts.length) continue;
        const visited = new Set<number>();
        const fillCell = (gx: number, gy: number) => {
          const key = (gy + 16384) * 32768 + (gx + 16384);
          if (visited.has(key)) return;
          visited.add(key);
          layerCtx.fillRect(gx * cell - Math.floor(cell / 2), gy * cell - Math.floor(cell / 2), cell, cell);
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
      return;
    }

    // 2. Smudge Brush: pulls and blends underlying layer pixels along the stroke
    if (s.brushType === 'smudge') {
      const rad = Math.max(2, s.width * 0.55 * scaleAvg);
      const diam = rad * 2;
      const stepDist = Math.max(1, rad * 0.28);
      const strength = Math.max(0.15, Math.min(0.85, ((s.flow ?? 65) / 100) * opacity));
      // Use a small 64x64 carry buffer to pull pixels smoothly
      const carry = this.getBrushTipStamp(s.color, 0.35, 'brush');
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
            prev = { x: nx, y: ny };
          }
        }
      }
      void carry;
      layerCtx.restore();
      return;
    }

    // 3. Blur Brush: softens underlying pixels along the stroke
    if (s.brushType === 'blur') {
      const rad = Math.max(3, s.width * 0.65 * scaleAvg);
      strokeCtx.clearRect(0, 0, width, height);
      strokeCtx.save();
      strokeCtx.filter = `blur(${Math.max(2, Math.round(rad * 0.45))}px)`;
      strokeCtx.drawImage(layerCanvas, 0, 0);
      strokeCtx.restore();

      layerCtx.save();
      layerCtx.beginPath();
      for (const pts of symmetryLists) {
        pts.forEach((p, idx) => {
          if (idx === 0) layerCtx.moveTo(p.x, p.y);
          else layerCtx.lineTo(p.x, p.y);
        });
      }
      layerCtx.lineWidth = rad * 2;
      layerCtx.lineCap = 'round';
      layerCtx.lineJoin = 'round';
      // Clip to a temporary mask by drawing blurred copy along stroke dabs
      for (const pts of symmetryLists) {
        const interp = brushHitPoints({ ...s, points: pts });
        for (const pt of interp) {
          layerCtx.save();
          layerCtx.beginPath();
          layerCtx.arc(pt.x, pt.y, rad, 0, Math.PI * 2);
          layerCtx.clip();
          layerCtx.globalAlpha = opacity * 0.45;
          layerCtx.drawImage(strokeCanvas, 0, 0);
          layerCtx.restore();
        }
      }
      layerCtx.restore();
      layerCtx.restore();
      return;
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
      for (const pts of symmetryLists) {
        const sub: BoardShape = { ...s, points: pts, x: 0, y: 0, scaleX: 1, scaleY: 1, width: s.width * scaleAvg };
        const d = s.brushType === 'marker' ? chiselMarkerPath(sub) : gPenCalligraphicPath(sub);
        if (d) {
          layerCtx.fill(new Path2D(d), 'nonzero');
        }
      }
      layerCtx.restore();
      layerCtx.restore();
      return;
    }

    // 5. Stamp-based brushes: Pencil, Brush (Oil/Acrylic), Airbrush, Watercolor
    const hardness01 = Math.max(0, Math.min(1, (s.hardness ?? profile.defaultHardness) / 100));
    const flow01 = Math.max(0.02, Math.min(1, (s.flow ?? profile.defaultFlow) / 100));
    const tip = this.getBrushTipStamp(s.color, hardness01, s.brushType);

    // Draw dabs onto strokeCanvas first so overlapping dabs build up with `flow` and cap cleanly at stroke `opacity`
    strokeCtx.clearRect(0, 0, width, height);
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
  ): { x: number; y: number; w: number; h: number } | null {
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

    for (const pts of symmetryLists) {
      const interp = brushHitPoints({ ...s, points: pts });
      if (!interp.length) continue;

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

      stampDab(interp[0].x, interp[0].y, interp[0].p ?? 0.5);
      let residual = 0;
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
    }

    if (maxX < minX || maxY < minY) return null;
    const x0 = Math.max(0, Math.floor(minX - 2));
    const y0 = Math.max(0, Math.floor(minY - 2));
    const x1 = Math.min(ctx.canvas.width, Math.ceil(maxX + 2));
    const y1 = Math.min(ctx.canvas.height, Math.ceil(maxY + 2));
    if (x1 <= x0 || y1 <= y0) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  renderScene(
    targetCanvas: HTMLCanvasElement,
    layers: readonly BoardLayer[],
    shapes: readonly BoardShape[],
    draftsByLayer: ReadonlyMap<string, BoardShape[]>,
    movingLayer: BoardLayer | null,
    resizingPreview: { id: string; layer: BoardLayer; shapes: BoardShape[] } | null,
    width: number,
    height: number,
    backgroundColor: string,
    transparent: boolean,
  ): boolean {
    if (this.unsupportedCanvas.has(targetCanvas)) return false;
    const ctx = targetCanvas.getContext('2d');
    if (!ctx || typeof ctx.clearRect !== 'function' || typeof ctx.save !== 'function' || typeof ctx.createRadialGradient !== 'function') {
      this.unsupportedCanvas.add(targetCanvas);
      return false;
    }
    const scratch = this.ensureScratch(width, height);
    if (!scratch) return false;
    const { scratchCanvas, scratchCtx, strokeCanvas, strokeCtx } = scratch;

    ctx.clearRect(0, 0, width, height);
    if (!transparent) {
      ctx.fillStyle = backgroundColor;
      ctx.fillRect(0, 0, width, height);
    }

    const activeIds = new Set(layers.map(l => l.id));
    for (const cachedId of this.layerCache.keys()) {
      if (!activeIds.has(cachedId)) this.layerCache.delete(cachedId);
    }

    let baseLayerCanvas: HTMLCanvasElement | null = null;
    let baseLayerView: BoardLayer | null = null;

    for (const rawLayer of layers) {
      if (rawLayer.hidden || rawLayer.deleted) continue;
      const view = resizingPreview?.id === rawLayer.id
        ? resizingPreview.layer
        : movingLayer?.id === rawLayer.id
          ? movingLayer
          : rawLayer;
      const layerOpacity = Math.max(0, Math.min(100, view.opacity ?? 100)) / 100;
      if (layerOpacity <= 0) continue;

      const committedShapes = resizingPreview?.id === rawLayer.id
        ? resizingPreview.shapes
        : shapes.filter(s => !s.hidden && (s.layerId ?? DEFAULT_BOARD_LAYER) === rawLayer.id);

      let entry = this.layerCache.get(rawLayer.id);
      if (!entry || entry.width !== width || entry.height !== height) {
        const c = document.createElement('canvas');
        c.width = width;
        c.height = height;
        const lCtx = c.getContext('2d');
        if (!lCtx) continue;
        entry = { canvas: c, ctx: lCtx, renderedIds: [], width, height };
        this.layerCache.set(rawLayer.id, entry);
      }

      // Check if we can incrementally append new shapes or need to rebuild this layer's canvas
      const nextIds = committedShapes.map(s => `${s.id}:${s.order}:${s.x}:${s.y}:${s.scaleX ?? 1}:${s.scaleY ?? 1}:${s.points.length}:${s.points[0]?.x ?? 0}:${s.points[0]?.y ?? 0}:${s.color}:${s.opacity ?? 100}`);
      const isPrefixMatch = !resizingPreview &&
        entry.renderedIds.length <= nextIds.length &&
        entry.renderedIds.every((id, idx) => id === nextIds[idx]);

      if (!isPrefixMatch) {
        entry.ctx.clearRect(0, 0, width, height);
        for (const s of committedShapes) {
          this.renderShapeOntoLayerCtx(entry.ctx, entry.canvas, strokeCtx, strokeCanvas, s, width, height, Boolean(view.alphaLock));
        }
        entry.renderedIds = nextIds;
      } else if (entry.renderedIds.length < nextIds.length) {
        for (let i = entry.renderedIds.length; i < committedShapes.length; i++) {
          this.renderShapeOntoLayerCtx(entry.ctx, entry.canvas, strokeCtx, strokeCanvas, committedShapes[i], width, height, Boolean(view.alphaLock));
        }
        entry.renderedIds = nextIds;
      }

      const liveDrafts = draftsByLayer.get(rawLayer.id) ?? [];
      let sourceCanvas = entry.canvas;
      if (liveDrafts.length > 0) {
        scratchCtx.clearRect(0, 0, width, height);
        scratchCtx.drawImage(entry.canvas, 0, 0);
        for (const d of liveDrafts) {
          this.renderShapeOntoLayerCtx(scratchCtx, scratchCanvas, strokeCtx, strokeCanvas, d, width, height, Boolean(view.alphaLock));
        }
        sourceCanvas = scratchCanvas;
      }

      const isClipped = Boolean(view.clipping) && baseLayerCanvas !== null && baseLayerView !== null;
      if (!view.clipping) {
        baseLayerCanvas = sourceCanvas;
        baseLayerView = view;
      }

      ctx.save();
      ctx.globalAlpha = layerOpacity;
      if (view.blendMode && view.blendMode !== 'normal') {
        ctx.globalCompositeOperation = view.blendMode;
      }

      if (isClipped && baseLayerCanvas && baseLayerView) {
        // Composite clipped layer restricted to the base layer's alpha channel
        strokeCtx.clearRect(0, 0, width, height);
        strokeCtx.drawImage(baseLayerCanvas, baseLayerView.x, baseLayerView.y);
        strokeCtx.globalCompositeOperation = 'source-in';
        strokeCtx.drawImage(sourceCanvas, view.x, view.y);
        strokeCtx.globalCompositeOperation = 'source-over';
        ctx.drawImage(strokeCanvas, 0, 0);
      } else {
        ctx.drawImage(sourceCanvas, view.x, view.y);
      }
      ctx.restore();
    }

    return true;
  }
}
