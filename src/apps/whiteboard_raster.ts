import {
  brushHitPoints, brushProfile, DEFAULT_BOARD_LAYER, expandSymmetryPointLists, shapeOpacity,
  type BoardBlendMode, type BoardLayer, type BoardPoint, type BoardShape,
} from './whiteboard_scene.ts';
import type { BoardBox } from './whiteboard_interaction.ts';

export interface DecodedRasterImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export function parseHexRgb(hex: string): [number, number, number] {
  const clean = hex.startsWith('#') ? hex.slice(1) : hex;
  if (clean.length !== 6) return [0, 0, 0];
  const r = Number.parseInt(clean.slice(0, 2), 16);
  const g = Number.parseInt(clean.slice(2, 4), 16);
  const b = Number.parseInt(clean.slice(4, 6), 16);
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return [0, 0, 0];
  return [r, g, b];
}

export function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${clamp(r)}${clamp(g)}${clamp(b)}`;
}

/** Rasterizes a closed polygon into a binary mask (1 = inside, 0 = outside) within width x height. */
export function polygonToMask(points: BoardPoint[], width: number, height: number): Uint8Array {
  const mask = new Uint8Array(width * height);
  if (points.length < 3) return mask;
  let minY = height, maxY = -1;
  for (const p of points) {
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const y0 = Math.max(0, Math.floor(minY));
  const y1 = Math.min(height - 1, Math.ceil(maxY));
  const nodes: number[] = [];
  for (let y = y0; y <= y1; y++) {
    nodes.length = 0;
    const py = y + 0.5;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const yi = points[i].y, yj = points[j].y;
      if ((yi < py && yj >= py) || (yj < py && yi >= py)) {
        nodes.push(points[i].x + ((py - yi) / (yj - yi)) * (points[j].x - points[i].x));
      }
    }
    nodes.sort((a, b) => a - b);
    const rowOffset = y * width;
    for (let i = 0; i < nodes.length - 1; i += 2) {
      const xStart = Math.max(0, Math.floor(nodes[i]));
      const xEnd = Math.min(width - 1, Math.ceil(nodes[i + 1]));
      for (let x = xStart; x <= xEnd; x++) {
        mask[rowOffset + x] = 255;
      }
    }
  }
  return mask;
}

export function createRectSelectionMask(width: number, height: number, a: BoardPoint, b: BoardPoint): Uint8Array {
  const mask = new Uint8Array(width * height);
  const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x)));
  const x1 = Math.min(width - 1, Math.ceil(Math.max(a.x, b.x)));
  const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y)));
  const y1 = Math.min(height - 1, Math.ceil(Math.max(a.y, b.y)));
  for (let y = y0; y <= y1; y++) {
    const row = y * width;
    for (let x = x0; x <= x1; x++) mask[row + x] = 255;
  }
  return mask;
}

export function createEllipseSelectionMask(width: number, height: number, a: BoardPoint, b: BoardPoint): Uint8Array {
  const mask = new Uint8Array(width * height);
  const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
  const rx = Math.abs(b.x - a.x) / 2, ry = Math.abs(b.y - a.y) / 2;
  if (rx < 0.5 || ry < 0.5) return mask;
  const x0 = Math.max(0, Math.floor(cx - rx));
  const x1 = Math.min(width - 1, Math.ceil(cx + rx));
  const y0 = Math.max(0, Math.floor(cy - ry));
  const y1 = Math.min(height - 1, Math.ceil(cy + ry));
  for (let y = y0; y <= y1; y++) {
    const dy = (y + 0.5 - cy) / ry;
    const row = y * width;
    for (let x = x0; x <= x1; x++) {
      const dx = (x + 0.5 - cx) / rx;
      if (dx * dx + dy * dy <= 1) mask[row + x] = 255;
    }
  }
  return mask;
}

function colorMatches(
  data: Uint8ClampedArray,
  idx4: number,
  sr: number,
  sg: number,
  sb: number,
  sa: number,
  tolerance: number,
): boolean {
  const r = data[idx4], g = data[idx4 + 1], b = data[idx4 + 2], a = data[idx4 + 3];
  if (sa === 0 && a === 0) return true;
  const dr = Math.abs(r - sr), dg = Math.abs(g - sg), db = Math.abs(b - sb), da = Math.abs(a - sa);
  return Math.max(dr, dg, db, da) <= tolerance;
}

/** Computes a flood-fill or global color match mask (0 or 255) for Paint Bucket and Magic Wand. */
export function computeFloodMask(
  sampleData: Uint8ClampedArray,
  width: number,
  height: number,
  seedX: number,
  seedY: number,
  tolerance: number,
  contiguous = true,
  expand = 0,
  clipMask?: Uint8Array | null,
): Uint8Array {
  const mask = new Uint8Array(width * height);
  const sx = Math.max(0, Math.min(width - 1, Math.floor(seedX)));
  const sy = Math.max(0, Math.min(height - 1, Math.floor(seedY)));
  const seedIdx4 = (sy * width + sx) * 4;
  const sr = sampleData[seedIdx4];
  const sg = sampleData[seedIdx4 + 1];
  const sb = sampleData[seedIdx4 + 2];
  const sa = sampleData[seedIdx4 + 3];
  const tol = Math.max(0, Math.min(255, Math.round(tolerance)));

  if (!contiguous) {
    const total = width * height;
    for (let i = 0; i < total; i++) {
      if (clipMask && clipMask[i] === 0) continue;
      if (colorMatches(sampleData, i * 4, sr, sg, sb, sa, tol)) {
        mask[i] = 255;
      }
    }
  } else {
    if (clipMask && clipMask[sy * width + sx] === 0) return mask;
    const visited = new Uint8Array(width * height);
    const stack: number[] = [sx, sy];
    while (stack.length > 0) {
      const y = stack.pop()!;
      const x = stack.pop()!;
      const rowOffset = y * width;
      let lx = x;
      while (
        lx >= 0 &&
        !visited[rowOffset + lx] &&
        (!clipMask || clipMask[rowOffset + lx] > 0) &&
        colorMatches(sampleData, (rowOffset + lx) * 4, sr, sg, sb, sa, tol)
      ) {
        lx--;
      }
      lx++;
      let rx = x;
      while (
        rx < width &&
        !visited[rowOffset + rx] &&
        (!clipMask || clipMask[rowOffset + rx] > 0) &&
        colorMatches(sampleData, (rowOffset + rx) * 4, sr, sg, sb, sa, tol)
      ) {
        rx++;
      }
      rx--;
      let spanAbove = false;
      let spanBelow = false;
      for (let ix = lx; ix <= rx; ix++) {
        const idx = rowOffset + ix;
        visited[idx] = 1;
        mask[idx] = 255;
        if (y > 0) {
          const aboveIdx = (y - 1) * width + ix;
          const matchAbove =
            !visited[aboveIdx] &&
            (!clipMask || clipMask[aboveIdx] > 0) &&
            colorMatches(sampleData, aboveIdx * 4, sr, sg, sb, sa, tol);
          if (!spanAbove && matchAbove) {
            stack.push(ix, y - 1);
            spanAbove = true;
          } else if (spanAbove && !matchAbove) {
            spanAbove = false;
          }
        }
        if (y < height - 1) {
          const belowIdx = (y + 1) * width + ix;
          const matchBelow =
            !visited[belowIdx] &&
            (!clipMask || clipMask[belowIdx] > 0) &&
            colorMatches(sampleData, belowIdx * 4, sr, sg, sb, sa, tol);
          if (!spanBelow && matchBelow) {
            stack.push(ix, y + 1);
            spanBelow = true;
          } else if (spanBelow && !matchBelow) {
            spanBelow = false;
          }
        }
      }
    }
  }

  const expandSteps = Math.max(-10, Math.min(20, Math.round(expand)));
  if (expandSteps !== 0) {
    const total = width * height;
    const dist = new Uint16Array(total);
    const INF = 30000;
    const dilate = expandSteps > 0;
    const radius = Math.abs(expandSteps);
    for (let i = 0; i < total; i++) {
      dist[i] = (dilate ? mask[i] > 0 : mask[i] === 0) ? 0 : INF;
    }
    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        const idx = row + x;
        let d = dist[idx];
        if (x > 0 && dist[idx - 1] + 1 < d) d = dist[idx - 1] + 1;
        if (y > 0 && dist[idx - width] + 1 < d) d = dist[idx - width] + 1;
        dist[idx] = d;
      }
    }
    for (let y = height - 1; y >= 0; y--) {
      const row = y * width;
      for (let x = width - 1; x >= 0; x--) {
        const idx = row + x;
        let d = dist[idx];
        if (x < width - 1 && dist[idx + 1] + 1 < d) d = dist[idx + 1] + 1;
        if (y < height - 1 && dist[idx + width] + 1 < d) d = dist[idx + width] + 1;
        dist[idx] = d;
        if (dilate) {
          if (d <= radius && (!clipMask || clipMask[idx] > 0)) mask[idx] = 255;
        } else {
          if (d <= radius) mask[idx] = 0;
        }
      }
    }
  }
  return mask;
}

export function selectionMaskBounds(mask: Uint8Array, width: number, height: number): BoardBox | null {
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (mask[row + x] > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX || maxY < minY) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** Converts a binary selection mask into a compact hull/contour polygon (up to 128 points) for P2P sync. */
export function selectionMaskToPolygon(mask: Uint8Array, width: number, height: number): BoardPoint[] {
  const bounds = selectionMaskBounds(mask, width, height);
  if (!bounds) return [];
  const stepY = Math.max(1, Math.ceil(bounds.height / 48));
  const leftEdge: BoardPoint[] = [];
  const rightEdge: BoardPoint[] = [];
  for (let y = bounds.y; y < bounds.y + bounds.height; y += stepY) {
    const row = y * width;
    let firstX = -1, lastX = -1;
    for (let x = bounds.x; x < bounds.x + bounds.width; x++) {
      if (mask[row + x] > 0) {
        if (firstX === -1) firstX = x;
        lastX = x + 1;
      }
    }
    if (firstX !== -1) {
      leftEdge.push({ x: firstX, y });
      rightEdge.push({ x: lastX, y });
    }
  }
  const bottomY = bounds.y + bounds.height;
  const lastRow = (bottomY - 1) * width;
  let bFirstX = -1, bLastX = -1;
  for (let x = bounds.x; x < bounds.x + bounds.width; x++) {
    if (mask[lastRow + x] > 0) {
      if (bFirstX === -1) bFirstX = x;
      bLastX = x + 1;
    }
  }
  if (bFirstX !== -1) {
    leftEdge.push({ x: bFirstX, y: bottomY });
    rightEdge.push({ x: bLastX, y: bottomY });
  }
  const poly = [...rightEdge, ...leftEdge.reverse()];
  return poly.length >= 3 ? poly.slice(0, 256) : [
    { x: bounds.x, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
    { x: bounds.x, y: bounds.y + bounds.height },
  ];
}

export function invertSelectionMask(mask: Uint8Array): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = mask[i] > 0 ? 0 : 255;
  return out;
}

/** Alpha-blends a source pixel (sr, sg, sb, sa in 0..255) onto destination buffer at idx4. */
function blendPixelOver(
  dst: Uint8ClampedArray,
  idx4: number,
  sr: number,
  sg: number,
  sb: number,
  sa: number,
  alphaLock = false,
): void {
  if (sa <= 0) return;
  const da = dst[idx4 + 3];
  if (alphaLock) {
    if (da === 0) return;
    const sAlpha = sa / 255;
    dst[idx4] = Math.round(dst[idx4] * (1 - sAlpha) + sr * sAlpha);
    dst[idx4 + 1] = Math.round(dst[idx4 + 1] * (1 - sAlpha) + sg * sAlpha);
    dst[idx4 + 2] = Math.round(dst[idx4 + 2] * (1 - sAlpha) + sb * sAlpha);
    return;
  }
  if (sa >= 255 || da === 0) {
    dst[idx4] = sr;
    dst[idx4 + 1] = sg;
    dst[idx4 + 2] = sb;
    dst[idx4 + 3] = sa;
    return;
  }
  const sA = sa / 255;
  const dA = da / 255;
  const outA = sA + dA * (1 - sA);
  if (outA <= 1e-5) {
    dst[idx4 + 3] = 0;
    return;
  }
  dst[idx4] = Math.round((sr * sA + dst[idx4] * dA * (1 - sA)) / outA);
  dst[idx4 + 1] = Math.round((sg * sA + dst[idx4 + 1] * dA * (1 - sA)) / outA);
  dst[idx4 + 2] = Math.round((sb * sA + dst[idx4 + 2] * dA * (1 - sA)) / outA);
  dst[idx4 + 3] = Math.round(outA * 255);
}

function applyBlendChannel(b: number, s: number, mode: BoardBlendMode): number {
  switch (mode) {
    case 'multiply': return (b * s) / 255;
    case 'screen': return 255 - ((255 - b) * (255 - s)) / 255;
    case 'overlay': return b < 128 ? (2 * b * s) / 255 : 255 - (2 * (255 - b) * (255 - s)) / 255;
    case 'darken': return Math.min(b, s);
    case 'lighten': return Math.max(b, s);
    case 'color-dodge': return s >= 255 ? 255 : Math.min(255, (b * 255) / (255 - s));
    case 'difference': return Math.abs(b - s);
    default: return s;
  }
}

export function rasterizeShapeOntoBuffer(
  target: Uint8ClampedArray,
  width: number,
  height: number,
  shape: BoardShape,
  options: {
    alphaLock?: boolean;
    compositeSample?: Uint8ClampedArray;
    decodedImages?: ReadonlyMap<string, DecodedRasterImage>;
  } = {},
): void {
  if (shape.hidden) return;
  const alphaLock = Boolean(options.alphaLock);
  const clipMask = shape.clipPolygon?.length ? polygonToMask(shape.clipPolygon, width, height) : null;
  const [cr, cg, cb] = parseHexRgb(shape.color);
  const strokeMaxOpacity = shapeOpacity(shape);
  const sx = shape.scaleX ?? 1, sy = shape.scaleY ?? 1;
  const tx = shape.x ?? 0, ty = shape.y ?? 0;
  const mapPt = (p: BoardPoint): BoardPoint => ({
    x: tx + p.x * sx,
    y: ty + p.y * sy,
    ...(p.p !== undefined ? { p: p.p } : {}),
  });

  if (shape.tool === 'clear') {
    if (clipMask) {
      for (let i = 0; i < width * height; i++) {
        if (clipMask[i] > 0) {
          const idx4 = i * 4;
          target[idx4] = 0; target[idx4 + 1] = 0; target[idx4 + 2] = 0; target[idx4 + 3] = 0;
        }
      }
    } else {
      target.fill(0);
    }
    return;
  }

  if (shape.tool === 'bucket') {
    const seed = mapPt(shape.points[0] ?? { x: 0, y: 0 });
    const sampleBuf = shape.fillSample === 'all' && options.compositeSample ? options.compositeSample : target;
    const fillMask = computeFloodMask(
      sampleBuf,
      width,
      height,
      seed.x,
      seed.y,
      shape.fillTolerance ?? 32,
      shape.fillContiguous !== false,
      shape.fillExpand ?? 0,
      clipMask,
    );
    const antiAlias = shape.fillAntiAlias !== false;
    const baseAlpha = Math.round(strokeMaxOpacity * 255);
    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        const idx = row + x;
        let m = fillMask[idx];
        if (m === 0 && antiAlias) {
          let neighbors = 0;
          if (x > 0 && fillMask[idx - 1] > 0) neighbors++;
          if (x < width - 1 && fillMask[idx + 1] > 0) neighbors++;
          if (y > 0 && fillMask[idx - width] > 0) neighbors++;
          if (y < height - 1 && fillMask[idx + width] > 0) neighbors++;
          if (neighbors >= 2 && (!clipMask || clipMask[idx] > 0)) {
            m = neighbors * 52;
          }
        }
        if (m > 0) {
          const effA = Math.round((baseAlpha * m) / 255);
          blendPixelOver(target, idx * 4, cr, cg, cb, effA, alphaLock);
        }
      }
    }
    return;
  }

  if (shape.tool === 'gradient') {
    const a = mapPt(shape.points[0] ?? { x: 0, y: 0 });
    const b = mapPt(shape.points[1] ?? a);
    const [r2, g2, b2] = parseHexRgb(shape.secondaryColor ?? '#ffffff');
    const transparentEnd = Boolean(shape.gradientTransparent);
    const radial = shape.gradientType === 'radial';
    const dx = b.x - a.x, dy = b.y - a.y;
    const lenSq = Math.max(1, dx * dx + dy * dy);
    const rad = Math.sqrt(lenSq);
    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        const idx = row + x;
        if (clipMask && clipMask[idx] === 0) continue;
        const px = x + 0.5 - a.x, py = y + 0.5 - a.y;
        const t = radial
          ? Math.max(0, Math.min(1, Math.hypot(px, py) / rad))
          : Math.max(0, Math.min(1, (px * dx + py * dy) / lenSq));
        const mr = Math.round(cr + ( (transparentEnd ? cr : r2) - cr) * t);
        const mg = Math.round(cg + ( (transparentEnd ? cg : g2) - cg) * t);
        const mb = Math.round(cb + ( (transparentEnd ? cb : b2) - cb) * t);
        const ma = Math.round(strokeMaxOpacity * 255 * (transparentEnd ? 1 - t : 1));
        blendPixelOver(target, idx * 4, mr, mg, mb, ma, alphaLock);
      }
    }
    return;
  }

  if (shape.tool === 'image' && shape.imageHash && options.decodedImages?.has(shape.imageHash)) {
    const img = options.decodedImages.get(shape.imageHash)!;
    const a = mapPt(shape.points[0] ?? { x: 0, y: 0 });
    const b = mapPt(shape.points[1] ?? a);
    const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y);
    const dstW = Math.max(1, Math.abs(b.x - a.x)), dstH = Math.max(1, Math.abs(b.y - a.y));
    const startX = Math.max(0, Math.floor(x0)), endX = Math.min(width - 1, Math.ceil(x0 + dstW));
    const startY = Math.max(0, Math.floor(y0)), endY = Math.min(height - 1, Math.ceil(y0 + dstH));
    for (let y = startY; y <= endY; y++) {
      const uY = (y + 0.5 - y0) / dstH;
      if (uY < 0 || uY >= 1) continue;
      const srcY = Math.min(img.height - 1, Math.max(0, Math.floor((shape.flipY ? 1 - uY : uY) * img.height)));
      const row = y * width;
      for (let x = startX; x <= endX; x++) {
        const idx = row + x;
        if (clipMask && clipMask[idx] === 0) continue;
        const uX = (x + 0.5 - x0) / dstW;
        if (uX < 0 || uX >= 1) continue;
        const srcX = Math.min(img.width - 1, Math.max(0, Math.floor((shape.flipX ? 1 - uX : uX) * img.width)));
        const sIdx = (srcY * img.width + srcX) * 4;
        const sa = Math.round(img.data[sIdx + 3] * strokeMaxOpacity);
        blendPixelOver(target, idx * 4, img.data[sIdx], img.data[sIdx + 1], img.data[sIdx + 2], sa, alphaLock);
      }
    }
    return;
  }

  if (shape.tool === 'rectangle' || shape.tool === 'ellipse') {
    const a = mapPt(shape.points[0] ?? { x: 0, y: 0 });
    const b = mapPt(shape.points[1] ?? a);
    const strokeW = Math.max(1, shape.width * ((sx + sy) / 2));
    const halfW = strokeW / 2;
    const left = Math.min(a.x, b.x), right = Math.max(a.x, b.x);
    const top = Math.min(a.y, b.y), bottom = Math.max(a.y, b.y);
    const x0 = Math.max(0, Math.floor(left - halfW - 1));
    const x1 = Math.min(width - 1, Math.ceil(right + halfW + 1));
    const y0 = Math.max(0, Math.floor(top - halfW - 1));
    const y1 = Math.min(height - 1, Math.ceil(bottom + halfW + 1));
    const baseAlpha = Math.round(strokeMaxOpacity * 255);
    if (shape.tool === 'rectangle') {
      for (let y = y0; y <= y1; y++) {
        const row = y * width;
        for (let x = x0; x <= x1; x++) {
          const idx = row + x;
          if (clipMask && clipMask[idx] === 0) continue;
          const px = x + 0.5, py = y + 0.5;
          const inOuter = px >= left - halfW && px <= right + halfW && py >= top - halfW && py <= bottom + halfW;
          if (!inOuter) continue;
          if (!shape.filled) {
            const inInner = px > left + halfW && px < right - halfW && py > top + halfW && py < bottom - halfW;
            if (inInner) continue;
          }
          blendPixelOver(target, idx * 4, cr, cg, cb, baseAlpha, alphaLock);
        }
      }
    } else {
      const cx = (left + right) / 2, cy = (top + bottom) / 2;
      const rx = Math.max(0.5, (right - left) / 2), ry = Math.max(0.5, (bottom - top) / 2);
      const rxOut = rx + halfW, ryOut = ry + halfW;
      const rxIn = Math.max(0, rx - halfW), ryIn = Math.max(0, ry - halfW);
      for (let y = y0; y <= y1; y++) {
        const row = y * width;
        for (let x = x0; x <= x1; x++) {
          const idx = row + x;
          if (clipMask && clipMask[idx] === 0) continue;
          const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
          const dOut = (dx * dx) / (rxOut * rxOut) + (dy * dy) / (ryOut * ryOut);
          if (dOut > 1) continue;
          if (!shape.filled && rxIn > 0.5 && ryIn > 0.5) {
            const dIn = (dx * dx) / (rxIn * rxIn) + (dy * dy) / (ryIn * ryIn);
            if (dIn < 1) continue;
          }
          blendPixelOver(target, idx * 4, cr, cg, cb, baseAlpha, alphaLock);
        }
      }
    }
    return;
  }

  if (shape.tool === 'text' && shape.text) {
    // Simple bitmap fallback in headless mode so text pixels exist in buffer even without DOM canvas
    const pt = mapPt(shape.points[0] ?? { x: 0, y: 0 });
    const fontSize = Math.max(8, Math.round((shape.fontSize ?? Math.max(14, shape.width * 2)) * ((sx + sy) / 2)));
    const lines = shape.text.split('\n');
    const baseAlpha = Math.round(strokeMaxOpacity * 255);
    lines.forEach((line, lineIdx) => {
      const startY = Math.round(pt.y + lineIdx * fontSize * 1.25);
      for (let charIdx = 0; charIdx < line.length; charIdx++) {
        const code = line.charCodeAt(charIdx);
        if (code <= 32) continue;
        const startX = Math.round(pt.x + charIdx * fontSize * 0.6);
        const charW = Math.max(2, Math.round(fontSize * 0.45));
        const charH = Math.max(4, Math.round(fontSize * 0.78));
        for (let dy = 0; dy < charH; dy++) {
          const py = startY + dy;
          if (py < 0 || py >= height) continue;
          for (let dx = 0; dx < charW; dx++) {
            const px = startX + dx;
            if (px < 0 || px >= width) continue;
            const idx = py * width + px;
            if (clipMask && clipMask[idx] === 0) continue;
            blendPixelOver(target, idx * 4, cr, cg, cb, baseAlpha, alphaLock);
          }
        }
      }
    });
    return;
  }

  // Brush, Eraser, and Line stamp engine
  const mappedPoints = shape.points.map(mapPt);
  const symmetryLists = expandSymmetryPointLists(mappedPoints, shape.symmetry, width / 2, height / 2);
  const hasPressure = shape.points.some(p => p.p !== undefined);
  const profile = brushProfile(shape, hasPressure);
  const baseRadius = Math.max(0.5, (shape.tool === 'line' ? shape.width * 0.5 : profile.base) * ((sx + sy) / 2));
  const hardness = Math.max(0, Math.min(100, shape.hardness ?? profile.defaultHardness)) / 100;
  const flow = Math.max(1, Math.min(100, shape.flow ?? profile.defaultFlow)) / 100;
  const isPixelBrush = shape.brushType === 'pixel';
  const isPencil = shape.brushType === 'pencil';
  const isWatercolor = shape.brushType === 'watercolor';
  const isSmudge = shape.tool === 'brush' && shape.brushType === 'smudge';
  const isBlur = shape.tool === 'brush' && shape.brushType === 'blur';
  const isEraser = shape.tool === 'eraser';
  const spacingRatio = isPixelBrush ? 0.15 : Math.max(0.05, Math.min(1, (shape.spacing ?? (shape.brushType === 'airbrush' ? 12 : 18)) / 100));
  const stepDist = Math.max(0.5, baseRadius * 2 * spacingRatio);

  // Per-stroke alpha accumulation map so overlapping dabs build up smoothly with `flow` and cap at `strokeMaxOpacity`
  const strokeMask = !isSmudge && !isBlur ? new Uint8Array(width * height) : null;
  let minTouchX = width, minTouchY = height, maxTouchX = -1, maxTouchY = -1;
  let mixR = cr, mixG = cg, mixB = cb;

  for (const pts of symmetryLists) {
    const interpolated = brushHitPoints({ ...shape, points: pts });
    const dabs: Array<{ x: number; y: number; p: number }> = [];
    if (interpolated.length > 0) {
      dabs.push({ x: interpolated[0].x, y: interpolated[0].y, p: interpolated[0].p ?? 0.5 });
      let residual = 0;
      for (let i = 1; i < interpolated.length; i++) {
        const a = interpolated[i - 1], b = interpolated[i];
        const segLen = Math.hypot(b.x - a.x, b.y - a.y);
        if (segLen < 1e-4) continue;
        let d = stepDist - residual;
        while (d <= segLen) {
          const t = d / segLen;
          dabs.push({
            x: a.x + (b.x - a.x) * t,
            y: a.y + (b.y - a.y) * t,
            p: (a.p ?? 0.5) + ((b.p ?? 0.5) - (a.p ?? 0.5)) * t,
          });
          d += stepDist;
        }
        residual = segLen - (d - stepDist);
      }
      if (interpolated.length > 1) {
        const last = interpolated[interpolated.length - 1];
        dabs.push({ x: last.x, y: last.y, p: last.p ?? 0.5 });
      }
    }

    // Carry colour for smudge tool
    let carryR = cr, carryG = cg, carryB = cb, carryA = 0, hasCarry = false;

    for (let dabIdx = 0; dabIdx < dabs.length; dabIdx++) {
      const dab = dabs[dabIdx];
      const pVal = Math.max(0.02, Math.min(1, dab.p));
      const pScale = hasPressure && shape.pressureSize !== false
        ? profile.min + (profile.max - profile.min) * Math.pow(pVal, profile.exp)
        : 1;
      const r = isPixelBrush ? Math.max(0.5, shape.width * 0.5) : Math.max(0.5, baseRadius * pScale);
      const dabFlow = flow * (hasPressure && shape.pressureOpacity !== false ? Math.pow(pVal, 0.85) : 1);

      const x0 = Math.max(0, Math.floor(dab.x - r - 1));
      const x1 = Math.min(width - 1, Math.ceil(dab.x + r + 1));
      const y0 = Math.max(0, Math.floor(dab.y - r - 1));
      const y1 = Math.min(height - 1, Math.ceil(dab.y + r + 1));

      if (x0 < minTouchX) minTouchX = x0;
      if (x1 > maxTouchX) maxTouchX = x1;
      if (y0 < minTouchY) minTouchY = y0;
      if (y1 > maxTouchY) maxTouchY = y1;

      if (isWatercolor || isSmudge) {
        const cx = Math.max(0, Math.min(width - 1, Math.round(dab.x)));
        const cy = Math.max(0, Math.min(height - 1, Math.round(dab.y)));
        const cIdx4 = (cy * width + cx) * 4;
        const ca = target[cIdx4 + 3];
        if (isSmudge) {
          if (!hasCarry) {
            carryR = target[cIdx4]; carryG = target[cIdx4 + 1]; carryB = target[cIdx4 + 2]; carryA = ca;
            hasCarry = true;
          } else {
            carryR = Math.round(carryR * 0.72 + target[cIdx4] * 0.28);
            carryG = Math.round(carryG * 0.72 + target[cIdx4 + 1] * 0.28);
            carryB = Math.round(carryB * 0.72 + target[cIdx4 + 2] * 0.28);
            carryA = Math.round(carryA * 0.72 + ca * 0.28);
          }
        } else if (ca > 16) {
          mixR = Math.round(mixR * 0.82 + target[cIdx4] * 0.18);
          mixG = Math.round(mixG * 0.82 + target[cIdx4 + 1] * 0.18);
          mixB = Math.round(mixB * 0.82 + target[cIdx4 + 2] * 0.18);
        }
      }

      for (let y = y0; y <= y1; y++) {
        const row = y * width;
        for (let x = x0; x <= x1; x++) {
          const idx = row + x;
          if (clipMask && clipMask[idx] === 0) continue;
          const dx = x + (isPixelBrush ? 0 : 0.5) - dab.x;
          const dy = y + (isPixelBrush ? 0 : 0.5) - dab.y;
          const dist = Math.hypot(dx, dy);
          if (r <= 0.75) {
            if (Math.abs(Math.round(dab.x) - x) > 0 || Math.abs(Math.round(dab.y) - y) > 0) continue;
          } else if (dist > r) {
            continue;
          }

          let falloff = 1;
          if (!isPixelBrush && r > 0.75) {
            const normD = dist / r;
            if (normD > hardness) {
              const t = (normD - hardness) / Math.max(0.001, 1 - hardness);
              falloff = Math.max(0, (1 - t) * (1 - t) * (1 + 2 * t));
            }
            if (isPencil) {
              // Deterministic fine paper tooth modulation for pencil
              const grain = 0.5 + 0.5 * Math.sin(x * 12.9898 + y * 78.233);
              falloff *= 0.72 + 0.28 * grain;
            }
          }

          const dabAlpha = Math.max(0, Math.min(1, falloff * dabFlow));
          if (dabAlpha <= 0.002) continue;

          if (isSmudge) {
            if (!hasCarry) continue;
            const idx4 = idx * 4;
            const strength = dabAlpha * strokeMaxOpacity * 0.65;
            if (alphaLock && target[idx4 + 3] === 0) continue;
            target[idx4] = Math.round(target[idx4] * (1 - strength) + carryR * strength);
            target[idx4 + 1] = Math.round(target[idx4 + 1] * (1 - strength) + carryG * strength);
            target[idx4 + 2] = Math.round(target[idx4 + 2] * (1 - strength) + carryB * strength);
            if (!alphaLock) {
              target[idx4 + 3] = Math.round(target[idx4 + 3] * (1 - strength) + carryA * strength);
            }
          } else if (isBlur) {
            const idx4 = idx * 4;
            if (target[idx4 + 3] === 0) continue;
            let sumR = 0, sumG = 0, sumB = 0, sumA = 0, count = 0;
            for (let ky = -1; ky <= 1; ky++) {
              const ny = y + ky;
              if (ny < 0 || ny >= height) continue;
              for (let kx = -1; kx <= 1; kx++) {
                const nx = x + kx;
                if (nx < 0 || nx >= width) continue;
                const nIdx4 = (ny * width + nx) * 4;
                sumR += target[nIdx4];
                sumG += target[nIdx4 + 1];
                sumB += target[nIdx4 + 2];
                sumA += target[nIdx4 + 3];
                count++;
              }
            }
            if (count > 0) {
              const strength = dabAlpha * strokeMaxOpacity * 0.5;
              target[idx4] = Math.round(target[idx4] * (1 - strength) + (sumR / count) * strength);
              target[idx4 + 1] = Math.round(target[idx4 + 1] * (1 - strength) + (sumG / count) * strength);
              target[idx4 + 2] = Math.round(target[idx4 + 2] * (1 - strength) + (sumB / count) * strength);
              if (!alphaLock) {
                target[idx4 + 3] = Math.round(target[idx4 + 3] * (1 - strength) + (sumA / count) * strength);
              }
            }
          } else if (strokeMask) {
            const prev = strokeMask[idx] / 255;
            const next = 1 - (1 - prev) * (1 - dabAlpha);
            strokeMask[idx] = Math.min(255, Math.round(next * 255));
          }
        }
      }
    }
  }

  if (strokeMask && maxTouchX >= minTouchX && maxTouchY >= minTouchY) {
    const paintR = isWatercolor ? mixR : cr;
    const paintG = isWatercolor ? mixG : cg;
    const paintB = isWatercolor ? mixB : cb;
    for (let y = minTouchY; y <= maxTouchY; y++) {
      const row = y * width;
      for (let x = minTouchX; x <= maxTouchX; x++) {
        const idx = row + x;
        const m = strokeMask[idx];
        if (m === 0) continue;
        const effAlpha = (m / 255) * strokeMaxOpacity;
        const idx4 = idx * 4;
        if (isEraser) {
          target[idx4 + 3] = Math.max(0, Math.round(target[idx4 + 3] * (1 - effAlpha)));
          if (target[idx4 + 3] === 0) {
            target[idx4] = 0; target[idx4 + 1] = 0; target[idx4 + 2] = 0;
          }
        } else {
          blendPixelOver(target, idx4, paintR, paintG, paintB, Math.round(effAlpha * 255), alphaLock);
        }
      }
    }
  }
}

export function compositeLayersToBuffer(
  layers: readonly BoardLayer[],
  layerBuffers: ReadonlyMap<string, Uint8ClampedArray>,
  width: number,
  height: number,
  backgroundColor?: string | null,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  if (backgroundColor) {
    const [br, bg, bb] = parseHexRgb(backgroundColor);
    for (let i = 0; i < width * height * 4; i += 4) {
      out[i] = br; out[i + 1] = bg; out[i + 2] = bb; out[i + 3] = 255;
    }
  }

  let baseAlphaMask: Uint8Array | null = null;

  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    if (layer.hidden || layer.deleted) continue;
    const layerOpacity = Math.max(0, Math.min(100, layer.opacity ?? 100)) / 100;
    if (layerOpacity <= 0) continue;
    const src = layerBuffers.get(layer.id);
    if (!src) continue;

    const isClipped = Boolean(layer.clipping) && baseAlphaMask !== null;
    if (!layer.clipping) {
      // Check if next visible layer is clipped to this base layer
      const nextVisible = layers.slice(i + 1).find(l => !l.hidden && !l.deleted);
      if (nextVisible?.clipping) {
        baseAlphaMask = new Uint8Array(width * height);
      } else {
        baseAlphaMask = null;
      }
    }

    const ox = Math.round(layer.x ?? 0);
    const oy = Math.round(layer.y ?? 0);
    const mode: BoardBlendMode = layer.blendMode ?? 'normal';

    for (let y = 0; y < height; y++) {
      const sy = y - oy;
      if (sy < 0 || sy >= height) continue;
      const dstRow = y * width;
      const srcRow = sy * width;
      for (let x = 0; x < width; x++) {
        const sx = x - ox;
        if (sx < 0 || sx >= width) continue;
        const dstIdx = dstRow + x;
        const sIdx4 = (srcRow + sx) * 4;
        let sa = src[sIdx4 + 3] * layerOpacity;
        if (!layer.clipping && baseAlphaMask) {
          baseAlphaMask[dstIdx] = Math.round(sa);
        }
        if (sa <= 0) continue;
        if (isClipped && baseAlphaMask) {
          sa = (sa * baseAlphaMask[dstIdx]) / 255;
          if (sa <= 0) continue;
        }
        const dIdx4 = dstIdx * 4;
        const sr = src[sIdx4], sg = src[sIdx4 + 1], sb = src[sIdx4 + 2];
        const da = out[dIdx4 + 3];
        if (da === 0 || mode === 'normal') {
          blendPixelOver(out, dIdx4, sr, sg, sb, Math.round(sa), false);
        } else {
          const dr = out[dIdx4], dg = out[dIdx4 + 1], db = out[dIdx4 + 2];
          const dAlphaFactor = da / 255;
          const br = Math.round(dr * (1 - dAlphaFactor) + applyBlendChannel(dr, sr, mode) * dAlphaFactor);
          const bg = Math.round(dg * (1 - dAlphaFactor) + applyBlendChannel(dg, sg, mode) * dAlphaFactor);
          const bb = Math.round(db * (1 - dAlphaFactor) + applyBlendChannel(db, sb, mode) * dAlphaFactor);
          blendPixelOver(out, dIdx4, br, bg, bb, Math.round(sa), false);
        }
      }
    }
  }
  return out;
}

interface CachedLayerState {
  width: number;
  height: number;
  alphaLock: boolean;
  shapeSignature: string;
  data: Uint8ClampedArray;
}

export class WhiteboardRasterEngine {
  private layerCache = new Map<string, CachedLayerState>();
  readonly decodedImages = new Map<string, DecodedRasterImage>();

  registerDecodedImage(hash: string, image: DecodedRasterImage): void {
    this.decodedImages.set(hash, image);
    this.layerCache.clear();
  }

  clear(): void {
    this.layerCache.clear();
  }

  private shapeKey(s: BoardShape): string {
    const first = s.points[0];
    const last = s.points[s.points.length - 1];
    return `${s.id}:${s.order}:${s.tool}:${s.brushType ?? ''}:${s.color}:${s.secondaryColor ?? ''}:${s.width}:${s.opacity ?? 100}:${s.flow ?? ''}:${s.hardness ?? ''}:${s.filled}:${s.x}:${s.y}:${s.scaleX ?? 1}:${s.scaleY ?? 1}:${s.points.length}:${first?.x ?? 0},${first?.y ?? 0}:${last?.x ?? 0},${last?.y ?? 0}:${s.text ?? ''}:${s.fillTolerance ?? ''}:${s.fillExpand ?? ''}:${s.fillSample ?? ''}`;
  }

  getLayerBuffer(
    layer: BoardLayer,
    shapes: readonly BoardShape[],
    width: number,
    height: number,
    allLayers?: readonly BoardLayer[],
    draftShapes?: readonly BoardShape[],
  ): Uint8ClampedArray {
    const layerShapes = shapes.filter(s => !s.hidden && (s.layerId ?? DEFAULT_BOARD_LAYER) === layer.id);
    const sig = layerShapes.map(s => this.shapeKey(s)).join('|');
    const alphaLock = Boolean(layer.alphaLock);
    let cached = this.layerCache.get(layer.id);

    if (!cached || cached.width !== width || cached.height !== height || cached.alphaLock !== alphaLock || cached.shapeSignature !== sig) {
      const data = new Uint8ClampedArray(width * height * 4);
      for (const s of layerShapes) {
        let compositeSample: Uint8ClampedArray | undefined;
        if (s.tool === 'bucket' && s.fillSample === 'all' && allLayers) {
          const otherBuffers = new Map<string, Uint8ClampedArray>();
          for (const other of allLayers) {
            if (other.id === layer.id) {
              otherBuffers.set(other.id, data);
            } else {
              const priorShapes = shapes.filter(item => item.order < s.order && (item.layerId ?? DEFAULT_BOARD_LAYER) === other.id);
              const buf = new Uint8ClampedArray(width * height * 4);
              for (const ps of priorShapes) {
                rasterizeShapeOntoBuffer(buf, width, height, ps, {
                  alphaLock: Boolean(other.alphaLock),
                  decodedImages: this.decodedImages,
                });
              }
              otherBuffers.set(other.id, buf);
            }
          }
          compositeSample = compositeLayersToBuffer(allLayers, otherBuffers, width, height, null);
        }
        rasterizeShapeOntoBuffer(data, width, height, s, {
          alphaLock,
          compositeSample,
          decodedImages: this.decodedImages,
        });
      }
      cached = { width, height, alphaLock, shapeSignature: sig, data };
      this.layerCache.set(layer.id, cached);
    }

    if (!draftShapes?.length) return cached.data;
    const withDrafts = new Uint8ClampedArray(cached.data);
    for (const draft of draftShapes) {
      rasterizeShapeOntoBuffer(withDrafts, width, height, draft, {
        alphaLock,
        decodedImages: this.decodedImages,
      });
    }
    return withDrafts;
  }

  getCompositeBuffer(
    layers: readonly BoardLayer[],
    shapes: readonly BoardShape[],
    width: number,
    height: number,
    backgroundColor: string | null = '#ffffff',
    draftsByLayer?: ReadonlyMap<string, BoardShape[]>,
  ): Uint8ClampedArray {
    const buffers = new Map<string, Uint8ClampedArray>();
    for (const layer of layers) {
      if (layer.hidden || layer.deleted) continue;
      buffers.set(
        layer.id,
        this.getLayerBuffer(layer, shapes, width, height, layers, draftsByLayer?.get(layer.id)),
      );
    }
    return compositeLayersToBuffer(layers, buffers, width, height, backgroundColor);
  }

  samplePixelHex(
    layers: readonly BoardLayer[],
    shapes: readonly BoardShape[],
    width: number,
    height: number,
    x: number,
    y: number,
    sampleAll = true,
    activeLayerId = DEFAULT_BOARD_LAYER,
    backgroundColor = '#ffffff',
  ): string {
    const px = Math.max(0, Math.min(width - 1, Math.floor(x)));
    const py = Math.max(0, Math.min(height - 1, Math.floor(y)));
    const idx4 = (py * width + px) * 4;
    if (!sampleAll) {
      const layer = layers.find(l => l.id === activeLayerId) ?? layers[0];
      if (!layer) return backgroundColor;
      const lx = Math.max(0, Math.min(width - 1, Math.floor(x - layer.x)));
      const ly = Math.max(0, Math.min(height - 1, Math.floor(y - layer.y)));
      const buf = this.getLayerBuffer(layer, shapes, width, height, layers);
      const lIdx4 = (ly * width + lx) * 4;
      if (buf[lIdx4 + 3] === 0) return backgroundColor;
      return rgbToHex(buf[lIdx4], buf[lIdx4 + 1], buf[lIdx4 + 2]);
    }
    const comp = this.getCompositeBuffer(layers, shapes, width, height, backgroundColor);
    return rgbToHex(comp[idx4], comp[idx4 + 1], comp[idx4 + 2]);
  }
}
