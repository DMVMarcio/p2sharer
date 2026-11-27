export const MIN_ZOOM = 1.0;
export const MAX_ZOOM = 5.0;
export const ZOOM_STEP = 0.25;

export interface PanOffset {
  x: number;
  y: number;
}

export function clampZoom(zoom: number): number {
  if (typeof zoom !== 'number' || isNaN(zoom) || !isFinite(zoom) || zoom < MIN_ZOOM) {
    return MIN_ZOOM;
  }
  if (zoom > MAX_ZOOM) {
    return MAX_ZOOM;
  }
  return Math.round(zoom * 100) / 100;
}

export function calculatePanBounds(
  zoom: number,
  containerWidth: number,
  containerHeight: number
): { maxX: number; maxY: number } {
  if (zoom <= MIN_ZOOM || containerWidth <= 0 || containerHeight <= 0) {
    return { maxX: 0, maxY: 0 };
  }
  return {
    maxX: Math.max(0, ((zoom - 1) * containerWidth) / 2),
    maxY: Math.max(0, ((zoom - 1) * containerHeight) / 2),
  };
}

export function clampPanOffset(
  pan: PanOffset,
  zoom: number,
  containerWidth: number,
  containerHeight: number
): PanOffset {
  if (zoom <= MIN_ZOOM || containerWidth <= 0 || containerHeight <= 0) {
    return { x: 0, y: 0 };
  }

  const { maxX, maxY } = calculatePanBounds(zoom, containerWidth, containerHeight);
  return {
    x: Math.min(maxX, Math.max(-maxX, pan.x)),
    y: Math.min(maxY, Math.max(-maxY, pan.y)),
  };
}

export interface FocalZoomParams {
  currentZoom: number;
  nextZoom: number;
  cursorX: number;
  cursorY: number;
  containerWidth: number;
  containerHeight: number;
  currentPan: PanOffset;
}

export function calculateFocalZoom(params: FocalZoomParams): { zoom: number; pan: PanOffset } {
  const {
    currentZoom,
    nextZoom,
    cursorX,
    cursorY,
    containerWidth,
    containerHeight,
    currentPan,
  } = params;

  const targetZoom = clampZoom(nextZoom);
  if (targetZoom <= MIN_ZOOM) {
    return { zoom: MIN_ZOOM, pan: { x: 0, y: 0 } };
  }

  if (containerWidth <= 0 || containerHeight <= 0) {
    return { zoom: targetZoom, pan: { x: 0, y: 0 } };
  }

  // Cursor position relative to container center
  const cx = cursorX - containerWidth / 2;
  const cy = cursorY - containerHeight / 2;

  // Zoom ratio
  const ratio = currentZoom > 0 ? targetZoom / currentZoom : 1;

  // Keep cursor focal point stationary
  const rawPanX = cx - (cx - currentPan.x) * ratio;
  const rawPanY = cy - (cy - currentPan.y) * ratio;

  const clampedPan = clampPanOffset(
    { x: rawPanX, y: rawPanY },
    targetZoom,
    containerWidth,
    containerHeight
  );

  return {
    zoom: targetZoom,
    pan: clampedPan,
  };
}

export function stepZoom(currentZoom: number, direction: 1 | -1, step = ZOOM_STEP): number {
  const raw = currentZoom + direction * step;
  if (raw <= 1.05) return MIN_ZOOM;
  return clampZoom(raw);
}
