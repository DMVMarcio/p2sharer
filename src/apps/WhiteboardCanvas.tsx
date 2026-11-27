import { useEffect, useLayoutEffect, useId, useRef, useState, type RefObject } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import {
  ImagePlus, ZoomIn, ZoomOut, Maximize2, FlipHorizontal, Grid, Trash2, CheckSquare,
  Maximize, Minimize, SlidersHorizontal,
} from 'lucide-react';
import { useContextMenu } from '../components/common/ContextMenu';
import { TooltipButton } from '../components/common/TooltipButton';
import { StreamPointerGlyph, type StreamPointerShape } from '../components/room/StreamPointerGlyph';
import { WhiteboardLayerArt } from './WhiteboardLayerArt';
import {
  BOARD_MAX_POINTS, DEFAULT_BOARD_LAYER, boardBrushWidth, boardLayerBounds, hitBoardLayer,
  type BoardLayer, type BoardPoint, type BoardShape,
} from './whiteboard_scene';
import type { BoardCursor, WhiteboardModel } from './whiteboard_model';
import type { BoardSettings } from './WhiteboardToolbar';
import { computeFloodMask, selectionMaskToPolygon } from './whiteboard_raster';
import type { WhiteboardStudioCompositor } from './whiteboard_webgl';
import { t } from '../i18n';
import {
  boardContains, boardResizeHandles, clampBoardPoint, containBoardLayer,
  hitBoardResizeHandle, resizeBoardBounds, scaleBoardLayer, BrushStabilizer,
  type BoardBox, type BoardResizeHandle, type BoardViewport,
} from './whiteboard_interaction';
import { useWhiteboardViewport } from './useWhiteboardViewport';

type Cursor = Omit<BoardCursor, 'seenAt'>;
type Gesture = {
  pointer: number;
  start: BoardPoint;
  localStart?: BoardPoint;
  mode: 'pan' | 'move' | 'resize' | 'draw' | 'select' | 'eyedropper';
  spacePan?: boolean;
  handle?: BoardResizeHandle;
  initialBounds?: BoardBox;
  targetBounds?: BoardBox;
  original?: BoardLayer;
  layer?: BoardLayer;
  draft?: BoardShape;
  selectionPoints?: BoardPoint[];
  viewport: BoardViewport;
  stabilizer?: BrushStabilizer;
  lastEventTime?: number;
  lastRawLocal?: BoardPoint;
  lastShiftKey?: boolean;
};
type ResizePreview = { id: string; layer: BoardLayer; shapes: BoardShape[]; fromBounds: BoardBox; bounds: BoardBox };
type TextDraft = { x: number; y: number; layerId: string; value: string };
export interface WhiteboardCanvasActions {
  fitCanvas: () => void;
  resetZoom: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
}

function toolToBrushStyle(tool: string, brushType?: string): 'round' | 'pixel' | 'blend' {
  if (tool === 'brush') {
    if (brushType === 'pixel') return 'pixel';
    if (brushType === 'smudge' || brushType === 'blur') return 'blend';
  }
  return 'round';
}

function toolToCursorShape(tool: string): StreamPointerShape {
  if (tool === 'hand') return 'hand';
  if (tool === 'move') return 'move';
  if (tool === 'eyedropper') return 'eyedropper';
  if (tool === 'bucket') return 'bucket';
  if (tool === 'text') return 'text';
  if (tool === 'selectRect') return 'selectRect';
  if (tool === 'selectEllipse') return 'selectEllipse';
  if (tool === 'lasso') return 'lasso';
  if (tool === 'wand') return 'wand';
  if (tool === 'pointer') return 'pointer';
  return 'brush';
}

function constrainShapeEndpoints(
  start: BoardPoint,
  current: BoardPoint,
  shiftKey: boolean,
  altKey: boolean,
  mode: 'rect' | 'line',
): [BoardPoint, BoardPoint] {
  let dx = current.x - start.x;
  let dy = current.y - start.y;
  if (mode === 'line') {
    if (shiftKey && (dx !== 0 || dy !== 0)) {
      const len = Math.hypot(dx, dy);
      const snappedAngle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      dx = Math.round(Math.cos(snappedAngle) * len * 100) / 100;
      dy = Math.round(Math.sin(snappedAngle) * len * 100) / 100;
    }
    const end: BoardPoint = { x: Math.round((start.x + dx) * 100) / 100, y: Math.round((start.y + dy) * 100) / 100 };
    const begin: BoardPoint = altKey
      ? { x: Math.round((start.x - dx) * 100) / 100, y: Math.round((start.y - dy) * 100) / 100 }
      : start;
    return [begin, end];
  }
  if (shiftKey) {
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    dx = (dx < 0 ? -1 : 1) * side;
    dy = (dy < 0 ? -1 : 1) * side;
  }
  const end: BoardPoint = { x: Math.round((start.x + dx) * 100) / 100, y: Math.round((start.y + dy) * 100) / 100 };
  const begin: BoardPoint = altKey
    ? { x: Math.round((start.x - dx) * 100) / 100, y: Math.round((start.y - dy) * 100) / 100 }
    : start;
  return [begin, end];
}

function pointerPressure(event: { pointerType?: string; pressure?: number }, final = false): number | undefined {
  if (event.pointerType === 'pen') {
    if (final && (!event.pressure || event.pressure <= 0)) return 0.02;
    if (typeof event.pressure === 'number' && event.pressure > 0) {
      return Math.round(Math.max(0.02, Math.min(1, event.pressure)) * 1000) / 1000;
    }
    return final ? 0.02 : 0.15;
  }
  if (typeof event.pressure === 'number' && event.pressure > 0 && event.pressure !== 0.5) {
    return Math.round(Math.max(0.02, Math.min(1, event.pressure)) * 1000) / 1000;
  }
  return undefined;
}

function buildEllipsePolygon(a: BoardPoint, b: BoardPoint, segments = 36): BoardPoint[] {
  const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
  const rx = Math.abs(b.x - a.x) / 2, ry = Math.abs(b.y - a.y) / 2;
  if (rx < 1 || ry < 1) return [];
  const pts: BoardPoint[] = [];
  for (let i = 0; i < segments; i++) {
    const theta = (i / segments) * Math.PI * 2;
    pts.push({
      x: Math.round((cx + Math.cos(theta) * rx) * 100) / 100,
      y: Math.round((cy + Math.sin(theta) * ry) * 100) / 100,
    });
  }
  return pts;
}

function buildRectPolygon(a: BoardPoint, b: BoardPoint): BoardPoint[] {
  const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
  const y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
  if (x1 - x0 < 1 || y1 - y0 < 1) return [];
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
}

export function WhiteboardCanvas({
  model,
  studio,
  engineActive,
  onEngineActiveChange,
  actionsRef,
  activeLayer,
  settings,
  spaceHeld = false,
  altHeld = false,
  viewportRef,
  selected,
  onSelect,
  selectionPolygon = null,
  onSelectionChange,
  onPickColor,
  onOpenCanvasSettings,
  fullscreen = false,
  onToggleFullscreen,
  compact,
  actor,
  name,
  participantName,
  onError,
  onPasteImage,
}: {
  model: WhiteboardModel;
  studio: WhiteboardStudioCompositor;
  engineActive: boolean;
  onEngineActiveChange(active: boolean): void;
  actionsRef?: RefObject<WhiteboardCanvasActions | null>;
  activeLayer: string;
  settings: BoardSettings;
  spaceHeld?: boolean;
  altHeld?: boolean;
  viewportRef: RefObject<BoardViewport>;
  selected: string | null;
  onSelect(id: string | null): void;
  selectionPolygon?: BoardPoint[] | null;
  onSelectionChange?(polygon: BoardPoint[] | null): void;
  onPickColor?(color: string): void;
  onOpenCanvasSettings?(): void;
  fullscreen?: boolean;
  onToggleFullscreen?(): void;
  compact: boolean;
  actor: string;
  name: string;
  participantName(actor: string): string;
  onError(error: unknown): void;
  onPasteImage?(): void;
}) {
  const root = useRef<HTMLDivElement>(null), clipId = useId();
  const viewportCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayGroupRef = useRef<SVGGElement>(null);
  const remoteCursorsRef = useRef<HTMLDivElement>(null);
  const localCursorElRef = useRef<HTMLDivElement>(null);
  const zoomHintRef = useRef<HTMLSpanElement>(null);
  const textDraftRef = useRef<HTMLTextAreaElement>(null);
  const selectionRectRef = useRef<SVGRectElement>(null);
  const selectionHandleRefs = useRef<Array<SVGRectElement | null>>([]);
  const marqueeOuterRef = useRef<SVGPolygonElement>(null);
  const marqueeInnerRef = useRef<SVGPolygonElement>(null);
  const symVRef = useRef<SVGLineElement>(null);
  const symHRef = useRef<SVGLineElement>(null);
  const gridMajorPathRef = useRef<SVGPathElement>(null);
  const gridPixelPathRef = useRef<SVGPathElement>(null);

  const menu = useContextMenu();
  const { width: boardWidth, height: boardHeight, backgroundColor, transparent } = model.canvasSettings;

  const gesture = useRef<Gesture | null>(null);
  const [draft, setDraft] = useState<BoardShape | null>(null);
  const [selectionDraft, setSelectionDraft] = useState<BoardPoint[] | null>(null);
  const [textDraft, setTextDraft] = useState<TextDraft | null>(null);
  const textDraftStateRef = useRef<TextDraft | null>(null);
  textDraftStateRef.current = textDraft;
  const [moving, setMoving] = useState<BoardLayer | null>(null);
  const [resizing, setResizing] = useState<ResizePreview | null>(null);

  const liveDraftRef = useRef<BoardShape | null>(null);
  const liveMovingRef = useRef<BoardLayer | null>(null);
  const liveResizingRef = useRef<ResizePreview | null>(null);
  const liveRafRef = useRef<number | null>(null);
  const loupeRafRef = useRef<number | null>(null);
  const stabilizerRafRef = useRef<number | null>(null);

  const [localCursorMeta, setLocalCursorMeta] = useState<{
    visible: boolean;
    shape: StreamPointerShape;
    color: string;
    showLoupe: boolean;
  }>({ visible: false, shape: 'pointer', color: settings.color, showLoupe: false });
  const localCursorMetaRef = useRef(localCursorMeta);
  localCursorMetaRef.current = localCursorMeta;
  const localCursorPosRef = useRef<{ screen: BoardPoint; world: BoardPoint; worldWidth: number } | null>(null);
  const [, setLoupeTick] = useState(0);

  const [mirrorView, setMirrorView] = useState(false);
  const mirrorViewRef = useRef(mirrorView);
  mirrorViewRef.current = mirrorView;
  const [showGrid, setShowGrid] = useState(false);
  const showGridRef = useRef(showGrid);
  showGridRef.current = showGrid;
  const [gridPixelLevel, setGridPixelLevel] = useState(false);
  const gridPixelLevelRef = useRef(gridPixelLevel);
  gridPixelLevelRef.current = gridPixelLevel;

  const physicalScreen = useRef<BoardPoint | null>(null);
  const current = useRef({ settings, compact, spaceHeld, altHeld, engineActive });
  current.current = { settings, compact, spaceHeld, altHeld, engineActive };
  const lastSent = useRef(0), latestCursor = useRef<Cursor | null>(null);

  const updateSelectionOverlayDom = (box: BoardBox | null, zoom: number) => {
    if (!box) return;
    if (selectionRectRef.current) {
      selectionRectRef.current.setAttribute('x', String(box.x));
      selectionRectRef.current.setAttribute('y', String(box.y));
      selectionRectRef.current.setAttribute('width', String(box.width));
      selectionRectRef.current.setAttribute('height', String(box.height));
      selectionRectRef.current.setAttribute('stroke-width', String(1.25 / zoom));
      selectionRectRef.current.setAttribute('stroke-dasharray', `${4 / zoom} ${3 / zoom}`);
    }
    const handles = boardResizeHandles(box);
    for (let i = 0; i < handles.length; i++) {
      const el = selectionHandleRefs.current[i];
      if (!el) continue;
      const item = handles[i];
      el.setAttribute('x', String(item.x - 4.5 / zoom));
      el.setAttribute('y', String(item.y - 4.5 / zoom));
      el.setAttribute('width', String(9 / zoom));
      el.setAttribute('height', String(9 / zoom));
      el.setAttribute('rx', String(2 / zoom));
      el.setAttribute('stroke-width', String(1.5 / zoom));
    }
  };

  const applyViewportToDom = (view: BoardViewport) => {
    viewportRef.current = view;
    studio.present(view, mirrorViewRef.current);

    if (overlayGroupRef.current) {
      overlayGroupRef.current.setAttribute('transform', `translate(${view.x} ${view.y}) scale(${view.zoom})`);
    }
    if (remoteCursorsRef.current) {
      remoteCursorsRef.current.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`;
      const children = remoteCursorsRef.current.children;
      for (let i = 0; i < children.length; i++) {
        const el = children[i] as HTMLElement;
        el.style.transform = `scale(${1 / view.zoom})`;
        const rawW = Number(el.dataset.worldWidth);
        if (rawW > 0) {
          const brush = el.querySelector('.stream-pointer-brush') as HTMLElement | null;
          if (brush) {
            const d = `${rawW * view.zoom}px`;
            brush.style.width = d;
            brush.style.height = d;
          }
        }
      }
    }
    if (zoomHintRef.current) {
      zoomHintRef.current.textContent = `${Math.round(view.zoom * 100)}%`;
    }
    if (localCursorElRef.current && localCursorPosRef.current && localCursorMetaRef.current.shape === 'brush') {
      const brush = localCursorElRef.current.querySelector('.stream-pointer-brush') as HTMLElement | null;
      if (brush) {
        const px = localCursorPosRef.current.worldWidth * view.zoom;
        const d = `${px}px`;
        brush.style.width = d;
        brush.style.height = d;
        brush.classList.toggle('is-large', px >= 14);
      }
    }
    if (textDraftRef.current && textDraftStateRef.current) {
      textDraftRef.current.style.left = `${view.x + textDraftStateRef.current.x * view.zoom}px`;
      textDraftRef.current.style.top = `${view.y + textDraftStateRef.current.y * view.zoom}px`;
      textDraftRef.current.style.fontSize = `${Math.max(12, (current.current.settings.fontSize ?? 28) * view.zoom)}px`;
    }
    if (marqueeOuterRef.current) {
      marqueeOuterRef.current.setAttribute('stroke-width', String(1.5 / view.zoom));
    }
    if (marqueeInnerRef.current) {
      marqueeInnerRef.current.setAttribute('stroke-width', String(1.5 / view.zoom));
      marqueeInnerRef.current.setAttribute('stroke-dasharray', `${5 / view.zoom} ${5 / view.zoom}`);
    }
    if (symVRef.current) {
      symVRef.current.setAttribute('stroke-width', String(1.25 / view.zoom));
      symVRef.current.setAttribute('stroke-dasharray', `${6 / view.zoom} ${4 / view.zoom}`);
    }
    if (symHRef.current) {
      symHRef.current.setAttribute('stroke-width', String(1.25 / view.zoom));
      symHRef.current.setAttribute('stroke-dasharray', `${6 / view.zoom} ${4 / view.zoom}`);
    }
    if (gridMajorPathRef.current) {
      gridMajorPathRef.current.setAttribute('stroke-width', String(1 / view.zoom));
    }
    if (gridPixelPathRef.current) {
      gridPixelPathRef.current.setAttribute('stroke-width', String(0.75 / view.zoom));
    }
    if (selectionRectRef.current) {
      const x = Number(selectionRectRef.current.getAttribute('x'));
      const y = Number(selectionRectRef.current.getAttribute('y'));
      const w = Number(selectionRectRef.current.getAttribute('width'));
      const h = Number(selectionRectRef.current.getAttribute('height'));
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(w) && Number.isFinite(h)) {
        updateSelectionOverlayDom({ x, y, width: w, height: h }, view.zoom);
      }
    }
    if (showGridRef.current) {
      const nextPixel = view.zoom >= 5;
      if (nextPixel !== gridPixelLevelRef.current) {
        setGridPixelLevel(nextPixel);
      }
    }
  };

  const navigation = useWhiteboardViewport(root, viewportRef.current, applyViewportToDom, boardWidth, boardHeight);

  const screenPoint = (event: { clientX: number; clientY: number }): BoardPoint => {
    const bounds = root.current!.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  };
  const worldPoint = (p: BoardPoint): BoardPoint => {
    const view = navigation.current.current;
    return { x: (p.x - view.x) / view.zoom, y: (p.y - view.y) / view.zoom };
  };

  const getDraftsByLayer = (includeLocalDraft = true): Map<string, BoardShape[]> => {
    const draftsByLayer = new Map<string, BoardShape[]>();
    for (const [id, c] of model.cursors) {
      if (id !== actor && c.draft) {
        const lid = c.draft.layerId ?? DEFAULT_BOARD_LAYER;
        const arr = draftsByLayer.get(lid) ?? [];
        arr.push(c.draft);
        draftsByLayer.set(lid, arr);
      }
    }
    if (includeLocalDraft) {
      const activeDraft = liveDraftRef.current ?? draft;
      if (activeDraft) {
        const lid = activeDraft.layerId ?? DEFAULT_BOARD_LAYER;
        const arr = draftsByLayer.get(lid) ?? [];
        arr.push(activeDraft);
        draftsByLayer.set(lid, arr);
      }
    }
    return draftsByLayer;
  };

  const syncAndPresentScene = (includeLocalDraft = true) => {
    if (!current.current.engineActive) return;
    const ok = studio.syncScene(
      model.layers,
      model.shapes,
      getDraftsByLayer(includeLocalDraft),
      liveMovingRef.current ?? moving,
      liveResizingRef.current ?? resizing,
      boardWidth,
      boardHeight,
      backgroundColor,
      transparent,
    );
    if (ok) {
      studio.present(navigation.current.current, mirrorViewRef.current);
    }
  };

  const scheduleLiveSceneFlush = () => {
    if (liveRafRef.current === null) {
      liveRafRef.current = requestAnimationFrame(() => {
        liveRafRef.current = null;
        syncAndPresentScene(true);
      });
    }
  };

  // Attach WebGL2 / Canvas2D viewport presenter once on mount
  useLayoutEffect(() => {
    const canvasEl = viewportCanvasRef.current;
    if (!canvasEl) return;
    const ok = studio.attachCanvas(canvasEl);
    onEngineActiveChange(ok);
    if (ok && root.current) {
      studio.resizeViewport(root.current.clientWidth || 800, root.current.clientHeight || 500, window.devicePixelRatio || 1);
      syncAndPresentScene(true);
    }
  }, [studio]);

  // Decode cached base64 PNG images into model.raster.decodedImages and studio
  useEffect(() => {
    if (typeof document === 'undefined') return;
    for (const [hash, raw] of model.images) {
      if (model.raster.decodedImages.has(hash)) continue;
      if (typeof Image === 'undefined') continue;
      const img = new Image();
      img.onload = () => {
        try {
          studio.registerImage(hash, img);
          const w = img.naturalWidth || img.width || 1;
          const h = img.naturalHeight || img.height || 1;
          const c = document.createElement('canvas');
          c.width = w;
          c.height = h;
          const ctx = c.getContext('2d');
          if (!ctx) return;
          ctx.drawImage(img, 0, 0, w, h);
          const imageData = ctx.getImageData(0, 0, w, h);
          model.raster.registerDecodedImage(hash, { width: w, height: h, data: imageData.data });
          syncAndPresentScene(true);
        } catch { /* ignore in mock environments */ }
      };
      img.src = `data:image/png;base64,${raw}`;
    }
  }, [model, model.images.size, studio]);

  const publish = (value: Cursor | null, screen: BoardPoint | null = physicalScreen.current, force = false) => {
    const wire = value?.draft && value.draft.points.length > BOARD_MAX_POINTS
      ? { ...value, draft: { ...value.draft, points: value.draft.points.slice(-BOARD_MAX_POINTS) } }
      : value;
    latestCursor.current = wire;

    if (!value || !screen || current.current.compact) {
      localCursorPosRef.current = null;
      if (localCursorMetaRef.current.visible) {
        setLocalCursorMeta(prev => prev.visible ? { ...prev, visible: false, showLoupe: false } : prev);
      }
    } else {
      const shape = toolToCursorShape(value.tool);
      const showLoupe = value.tool === 'eyedropper';
      const zoom = navigation.current.current.zoom;
      localCursorPosRef.current = { screen, world: { x: value.x, y: value.y }, worldWidth: value.width };

      if (localCursorElRef.current) {
        localCursorElRef.current.style.left = `${screen.x}px`;
        localCursorElRef.current.style.top = `${screen.y}px`;
        if (shape === 'brush') {
          const brush = localCursorElRef.current.querySelector('.stream-pointer-brush') as HTMLElement | null;
          if (brush) {
            const px = value.width * zoom;
            const d = `${px}px`;
            brush.style.width = d;
            brush.style.height = d;
            brush.classList.toggle('is-large', px >= 14);
          }
        }
      }

      const prevMeta = localCursorMetaRef.current;
      if (!prevMeta.visible || prevMeta.shape !== shape || prevMeta.color !== value.color || prevMeta.showLoupe !== showLoupe) {
        setLocalCursorMeta({ visible: true, shape, color: value.color, showLoupe });
      } else if (showLoupe) {
        if (current.current.engineActive) {
          if (loupeRafRef.current === null) {
            loupeRafRef.current = requestAnimationFrame(() => {
              loupeRafRef.current = null;
              setLoupeTick(n => n + 1);
            });
          }
        } else {
          setLoupeTick(n => n + 1);
        }
      }
    }

    if (force || performance.now() - lastSent.current >= 40) {
      model.presence(wire);
      lastSent.current = performance.now();
    }
  };

  const stopStabilizerCatchUp = () => {
    if (stabilizerRafRef.current !== null) {
      cancelAnimationFrame(stabilizerRafRef.current);
      stabilizerRafRef.current = null;
    }
  };

  const scheduleStabilizerCatchUp = (targetGesture: Gesture) => {
    if (stabilizerRafRef.current !== null) return;
    let lastFrameTime = performance.now();
    const tick = (now: number) => {
      stabilizerRafRef.current = null;
      const g = gesture.current;
      const activeSettings = current.current.settings;
      if (
        g !== targetGesture ||
        g.mode !== 'draw' ||
        !g.draft ||
        !g.layer ||
        !g.stabilizer ||
        !g.lastRawLocal ||
        g.lastShiftKey ||
        activeSettings.smoothing <= 0 ||
        (g.draft.tool !== 'brush' && g.draft.tool !== 'eraser')
      ) {
        return;
      }
      if (g.stabilizer.distanceTo(g.lastRawLocal) <= 0.35) {
        return;
      }
      const dt = Math.max(4, Math.min(20, now - lastFrameTime));
      lastFrameTime = now;
      const stabilized = g.stabilizer.stepCatchUp(g.lastRawLocal, dt, activeSettings.smoothing);
      const nextPt: BoardPoint = {
        x: Math.round(stabilized.x * 100) / 100,
        y: Math.round(stabilized.y * 100) / 100,
        ...(stabilized.p !== undefined ? { p: stabilized.p } : {}),
      };
      const viewNow = navigation.current.current;
      const pts = g.draft.points;
      const lastPt = pts[pts.length - 1];
      const settled = g.stabilizer.distanceTo(g.lastRawLocal) <= 0.35;
      const minDist = settled ? 0.1 : 0.5 / viewNow.zoom;
      if (Math.hypot(nextPt.x - lastPt.x, nextPt.y - lastPt.y) >= minDist) {
        const nextPoints = [...pts, nextPt];
        const nextDraft = { ...g.draft, points: nextPoints };
        g.draft = nextDraft;
        if (current.current.engineActive) {
          liveDraftRef.current = nextDraft;
          scheduleLiveSceneFlush();
        } else {
          setDraft(nextDraft);
        }
        const worldPt = { x: nextPt.x + g.layer.x, y: nextPt.y + g.layer.y };
        const screenPt = { x: worldPt.x * viewNow.zoom + viewNow.x, y: worldPt.y * viewNow.zoom + viewNow.y };
        const pVal = nextPt.p;
        const activeWidth = boardBrushWidth(activeSettings.width) * (pVal !== undefined && activeSettings.pressureSize !== false ? 0.25 + 0.75 * pVal : 1);
        publish({
          ...worldPt,
          tool: activeSettings.tool,
          width: activeWidth,
          color: activeSettings.color,
          draft: nextDraft,
        }, screenPt);
      }
      if (g.stabilizer.distanceTo(g.lastRawLocal) > 0.35) {
        stabilizerRafRef.current = requestAnimationFrame(tick);
      }
    };
    stabilizerRafRef.current = requestAnimationFrame(tick);
  };

  const leave = () => { physicalScreen.current = null; publish(null, null, true); };
  const cancel = () => {
    stopStabilizerCatchUp();
    navigation.stop();
    if (liveRafRef.current !== null) {
      cancelAnimationFrame(liveRafRef.current);
      liveRafRef.current = null;
    }
    if (loupeRafRef.current !== null) {
      cancelAnimationFrame(loupeRafRef.current);
      loupeRafRef.current = null;
    }
    gesture.current = null;
    liveDraftRef.current = null;
    liveMovingRef.current = null;
    liveResizingRef.current = null;
    setDraft(null);
    setSelectionDraft(null);
    setMoving(null);
    setResizing(null);
    syncAndPresentScene(false);
    leave();
  };

  useEffect(() => {
    const heartbeat = setInterval(() => { if (latestCursor.current) model.presence(latestCursor.current); }, 800);
    const blur = () => cancel(), visibility = () => { if (document.hidden) cancel(); };
    window.addEventListener('blur', blur);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      stopStabilizerCatchUp();
      clearInterval(heartbeat);
      model.presence(null);
      window.removeEventListener('blur', blur);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [model]);

  useEffect(() => { if (compact) cancel(); }, [compact]);

  const identity = model.identity?.id;
  const fitCanvas = (useInitialScale = false) => {
    const w = root.current?.clientWidth || 800, h = root.current?.clientHeight || 500;
    const zoom = compact
      ? Math.min(w / boardWidth, h / boardHeight)
      : useInitialScale
        ? 1
        : Math.min(1, Math.max(0.15, Math.min((w - 80) / boardWidth, (h - 80) / boardHeight)));
    navigation.set({ x: w / 2 - (boardWidth * zoom) / 2, y: h / 2 - (boardHeight * zoom) / 2, zoom });
  };

  if (actionsRef) {
    actionsRef.current = {
      fitCanvas: () => fitCanvas(false),
      resetZoom: () => fitCanvas(true),
      zoomIn: () => {
        const w = root.current?.clientWidth || 800, h = root.current?.clientHeight || 500;
        navigation.zoom(-120, { x: w / 2, y: h / 2 });
      },
      zoomOut: () => {
        const w = root.current?.clientWidth || 800, h = root.current?.clientHeight || 500;
        navigation.zoom(120, { x: w / 2, y: h / 2 });
      },
    };
  }

  useLayoutEffect(() => {
    let measured = false;
    const center = () => {
      const w = root.current?.clientWidth || 800, h = root.current?.clientHeight || 500;
      if (current.current.engineActive) {
        studio.resizeViewport(w, h, window.devicePixelRatio || 1);
      }
      const zoom = compact ? Math.min(w / boardWidth, h / boardHeight) : 1;
      navigation.set({ x: w / 2 - (boardWidth * zoom) / 2, y: h / 2 - (boardHeight * zoom) / 2, zoom });
    };
    center();
    const observer = new ResizeObserver(() => {
      const w = root.current?.clientWidth || 800, h = root.current?.clientHeight || 500;
      if (current.current.engineActive) {
        studio.resizeViewport(w, h, window.devicePixelRatio || 1);
      }
      if (compact || !measured) center();
      else navigation.set(navigation.current.current);
      measured = true;
    });
    if (root.current) observer.observe(root.current);
    return () => observer.disconnect();
  }, [model, identity, compact, boardWidth, boardHeight, studio]);

  useEffect(() => {
    if (!spaceHeld && gesture.current?.spacePan) {
      const pointerId = gesture.current.pointer;
      navigation.stop();
      gesture.current = null;
      if (root.current?.hasPointerCapture(pointerId)) {
        try { root.current.releasePointerCapture(pointerId); } catch { /* ignore */ }
      }
    }
    const screen = physicalScreen.current;
    if (screen && !gesture.current && !compact) {
      publish({
        ...worldPoint(screen),
        tool: spaceHeld ? 'pointer' : altHeld ? 'eyedropper' : settings.tool,
        width: boardBrushWidth(settings.width),
        color: settings.color,
      }, screen);
    }
  }, [spaceHeld, altHeld, settings.tool, settings.width, settings.color, compact]);

  // Stage A + Stage B sync ONLY when scene data, drafts, or visual settings change (never on pan/zoom/cursor)
  useLayoutEffect(() => {
    syncAndPresentScene(true);
  }, [
    studio,
    engineActive,
    model,
    model.revision,
    model.cursorRevision,
    boardWidth,
    boardHeight,
    backgroundColor,
    transparent,
    mirrorView,
    draft,
    moving,
    resizing,
  ]);

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (current.current.compact || gesture.current) return;
      event.preventDefault();
      event.stopPropagation();
      physicalScreen.current = screenPoint(event);
      const factor = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1;
      navigation.zoom(Math.max(-400, Math.min(400, event.deltaY * factor)), physicalScreen.current);
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [model]);

  const commitTextDraft = () => {
    if (!textDraft) return;
    const trimmed = textDraft.value.trim();
    const layer = model.layers.find(l => l.id === textDraft.layerId);
    setTextDraft(null);
    if (!trimmed || !layer || layer.locked || layer.hidden) return;
    try {
      model.put({
        id: crypto.randomUUID(),
        layerId: layer.id,
        tool: 'text',
        points: [{
          x: Math.round((textDraft.x - layer.x) * 100) / 100,
          y: Math.round((textDraft.y - layer.y) * 100) / 100,
        }],
        text: trimmed.slice(0, 500),
        fontSize: settings.fontSize ?? 28,
        fontBold: Boolean(settings.fontBold),
        fontItalic: Boolean(settings.fontItalic),
        color: settings.color,
        width: boardBrushWidth(settings.width),
        opacity: settings.opacity,
        filled: true,
        x: 0,
        y: 0,
        order: (model.shapes[model.shapes.length - 1]?.order ?? 0) + 1,
        hidden: false,
        locked: false,
      });
    } catch (err) {
      onError(err);
    }
  };

  const sampleBoardPixel = (x: number, y: number): string => {
    const px = Math.floor(x);
    const py = Math.floor(y);
    if (px < 0 || py < 0 || px >= boardWidth || py >= boardHeight) {
      return transparent ? '#ffffff' : backgroundColor;
    }
    if (current.current.engineActive) {
      const sampled = studio.samplePixel(
        x,
        y,
        model.layers,
        model.shapes,
        getDraftsByLayer(true),
        liveMovingRef.current ?? moving,
        liveResizingRef.current ?? resizing,
      );
      if (sampled) return sampled;
    }
    return model.sampleColor(x, y, true, activeLayer);
  };

  const sampleLoupePatch = (centerX: number, centerY: number): { grid: string[]; centerHex: string; px: number; py: number } => {
    const radius = 4;
    if (current.current.engineActive) {
      const patch = studio.samplePatch(
        centerX,
        centerY,
        radius,
        model.layers,
        model.shapes,
        getDraftsByLayer(true),
        liveMovingRef.current ?? moving,
        liveResizingRef.current ?? resizing,
      );
      if (patch) return patch;
    }
    const cx = Math.max(0, Math.min(boardWidth - 1, Math.floor(centerX)));
    const cy = Math.max(0, Math.min(boardHeight - 1, Math.floor(centerY)));
    const grid: string[] = [];
    const centerHex = model.sampleColor(cx, cy, true, activeLayer);
    for (let dy = -radius; dy <= radius; dy++) {
      const y = cy + dy;
      for (let dx = -radius; dx <= radius; dx++) {
        const x = cx + dx;
        if (x < 0 || y < 0 || x >= boardWidth || y >= boardHeight) {
          grid.push(transparent ? 'transparent' : backgroundColor);
        } else if (dx === 0 && dy === 0) {
          grid.push(centerHex);
        } else {
          grid.push(model.sampleColor(x, y, true, activeLayer));
        }
      }
    }
    return { grid, centerHex, px: cx, py: cy };
  };

  const update = (event: ReactPointerEvent<HTMLDivElement>, final = false) => {
    if (compact) return;
    const screen = screenPoint(event), g = gesture.current;
    physicalScreen.current = screen;
    const viewNow = navigation.current.current;
    let point = worldPoint(screen), drawing: BoardShape | undefined;
    if (g && g.pointer === event.pointerId) {
      if (g.mode === 'pan') {
        navigation.set({ ...g.viewport, x: g.viewport.x + screen.x - g.start.x, y: g.viewport.y + screen.y - g.start.y });
        point = worldPoint(screen);
      } else if (g.mode === 'eyedropper') {
        if (boardContains(point, boardWidth, boardHeight)) {
          const picked = sampleBoardPixel(point.x, point.y);
          onPickColor?.(picked);
        }
      } else if (g.mode === 'move' && g.original) {
        let dx = point.x - g.start.x;
        let dy = point.y - g.start.y;
        if (event.shiftKey) {
          if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        const layer = containBoardLayer(
          { ...g.original, x: g.original.x + dx, y: g.original.y + dy },
          model.shapes,
          boardWidth,
          boardHeight,
        );
        g.layer = layer;
        if (current.current.engineActive) {
          liveMovingRef.current = layer;
          updateSelectionOverlayDom(boardLayerBounds(model.shapes, layer), viewNow.zoom);
          scheduleLiveSceneFlush();
        } else {
          setMoving(layer);
        }
      } else if (g.mode === 'resize' && g.original && g.handle && g.initialBounds) {
        const nextBounds = resizeBoardBounds(g.initialBounds, g.handle, point, event.shiftKey, boardWidth, boardHeight);
        g.targetBounds = nextBounds;
        const preview = scaleBoardLayer(g.original, model.shapes, g.initialBounds, nextBounds);
        g.layer = preview.layer;
        const resizeObj: ResizePreview = {
          id: g.original.id,
          layer: preview.layer,
          shapes: preview.shapes,
          fromBounds: g.initialBounds,
          bounds: nextBounds,
        };
        if (current.current.engineActive) {
          liveResizingRef.current = resizeObj;
          updateSelectionOverlayDom(nextBounds, viewNow.zoom);
          scheduleLiveSceneFlush();
        } else {
          setResizing(resizeObj);
        }
      } else if (g.mode === 'select' && g.selectionPoints) {
        const clamped = clampBoardPoint(point, boardWidth, boardHeight);
        if (settings.tool === 'lasso') {
          const prev = g.selectionPoints[g.selectionPoints.length - 1];
          if (Math.hypot(clamped.x - prev.x, clamped.y - prev.y) >= 2 / viewNow.zoom) {
            g.selectionPoints = [...g.selectionPoints, clamped];
          }
          setSelectionDraft(g.selectionPoints);
        } else if (settings.tool === 'selectEllipse') {
          const [a, b] = constrainShapeEndpoints(g.start, clamped, event.shiftKey, event.altKey, 'rect');
          const poly = buildEllipsePolygon(
            clampBoardPoint(a, boardWidth, boardHeight),
            clampBoardPoint(b, boardWidth, boardHeight),
          );
          g.selectionPoints = poly;
          setSelectionDraft(poly);
        } else {
          const [a, b] = constrainShapeEndpoints(g.start, clamped, event.shiftKey, event.altKey, 'rect');
          const poly = buildRectPolygon(
            clampBoardPoint(a, boardWidth, boardHeight),
            clampBoardPoint(b, boardWidth, boardHeight),
          );
          g.selectionPoints = poly;
          setSelectionDraft(poly);
        }
      } else if (g.draft && g.layer) {
        stopStabilizerCatchUp();
        const isFreehand = g.draft.tool === 'brush' || g.draft.tool === 'eraser';
        if (final && isFreehand && g.stabilizer && !event.shiftKey && settings.smoothing > 0) {
          const points = g.draft.points;
          const lastLocal = points[points.length - 1];
          drawing = g.draft;
          if (current.current.engineActive) {
            liveDraftRef.current = drawing;
            scheduleLiveSceneFlush();
          } else {
            setDraft(drawing);
          }
          point = { x: lastLocal.x + g.layer.x, y: lastLocal.y + g.layer.y };
        } else {
          const coalesced = !final && typeof event.nativeEvent?.getCoalescedEvents === 'function' ? event.nativeEvent.getCoalescedEvents() : [];
          const samples = coalesced.length ? coalesced : [event];
          const prevTime = g.lastEventTime ?? event.timeStamp;
          let strictlyIncreasing = samples.length > 1;
          if (strictlyIncreasing) {
            let tCheck = prevTime;
            for (const s of samples) {
              if (!s.timeStamp || s.timeStamp <= tCheck) {
                strictlyIncreasing = false;
                break;
              }
              tCheck = s.timeStamp;
            }
          }
          const rawSpan = event.timeStamp - prevTime;
          const synthSpan = Math.max(1, Math.min(20, rawSpan > 0 ? rawSpan : 16));
          let points = g.draft.points;
          let lastLocal: BoardPoint = points[points.length - 1];
          let latestRawLocal: BoardPoint | undefined;
          samples.forEach((sample, idx) => {
            const sampleWorld = clampBoardPoint(worldPoint(screenPoint(sample)), boardWidth, boardHeight);
            const p = pointerPressure(sample, final);
            const rawLocal: BoardPoint = {
              x: Math.round((sampleWorld.x - g.layer!.x) * 100) / 100,
              y: Math.round((sampleWorld.y - g.layer!.y) * 100) / 100,
              ...(p !== undefined ? { p } : {}),
            };
            latestRawLocal = rawLocal;
            let local = rawLocal;
            if (g.stabilizer && !final && !event.shiftKey) {
              const sampleTime = samples.length > 1 && !strictlyIncreasing
                ? prevTime + ((idx + 1) / samples.length) * synthSpan
                : (sample.timeStamp || event.timeStamp);
              const stabilized = g.stabilizer.sample(rawLocal, sampleTime, settings.smoothing);
              local = {
                x: Math.round(stabilized.x * 100) / 100,
                y: Math.round(stabilized.y * 100) / 100,
                ...(stabilized.p !== undefined ? { p: stabilized.p } : {}),
              };
            }
            if (isFreehand) {
              if (event.shiftKey) {
                const origin = g.localStart ?? points[0];
                if (Math.abs(local.x - origin.x) >= Math.abs(local.y - origin.y)) {
                  local = { ...local, y: origin.y };
                } else {
                  local = { ...local, x: origin.x };
                }
                lastLocal = local;
                points = [origin, local];
              } else {
                lastLocal = local;
                if (Math.hypot(local.x - points[points.length - 1].x, local.y - points[points.length - 1].y) >= .5 / viewNow.zoom) {
                  points = [...points, local];
                } else if (local.p !== undefined && (points[points.length - 1].p === undefined || Math.abs(local.p - points[points.length - 1].p!) >= 0.02)) {
                  points = [...points.slice(0, -1), { ...points[points.length - 1], p: local.p }];
                }
              }
            } else {
              const origin = g.localStart ?? points[0];
              const mode = g.draft!.tool === 'line' || g.draft!.tool === 'gradient' ? 'line' : 'rect';
              const [a, b] = constrainShapeEndpoints(origin, local, event.shiftKey, event.altKey, mode);
              lastLocal = b;
              points = [a, b];
            }
          });
          g.lastEventTime = event.timeStamp;
          if (latestRawLocal) g.lastRawLocal = latestRawLocal;
          g.lastShiftKey = event.shiftKey;
          drawing = { ...g.draft, points };
          g.draft = drawing;
          if (current.current.engineActive) {
            liveDraftRef.current = drawing;
            scheduleLiveSceneFlush();
          } else {
            setDraft(drawing);
          }
          point = { x: lastLocal.x + g.layer.x, y: lastLocal.y + g.layer.y };
          if (!final && isFreehand && g.stabilizer && !event.shiftKey && settings.smoothing > 0 && g.lastRawLocal && g.stabilizer.distanceTo(g.lastRawLocal) > 0.35) {
            scheduleStabilizerCatchUp(g);
          }
        }
      }
    }
    const view = navigation.current.current;
    const display = g?.mode === 'draw' ? { x: point.x * view.zoom + view.x, y: point.y * view.zoom + view.y } : screen;
    const p = pointerPressure(event);
    const activeWidth = boardBrushWidth(settings.width) * (p !== undefined && settings.pressureSize !== false ? 0.25 + 0.75 * p : 1);
    publish({
      ...point,
      tool: g?.mode === 'pan'
        ? 'hand'
        : g?.mode === 'move' || g?.mode === 'resize'
          ? 'move'
          : g?.mode === 'eyedropper' || altHeld
            ? 'eyedropper'
            : spaceHeld
              ? 'pointer'
              : settings.tool,
      width: activeWidth,
      color: settings.color,
      ...(drawing ? { draft: drawing } : {}),
    }, display);
  };

  const down = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (compact || gesture.current || ![0, 1].includes(event.button)) return;
    if (textDraft) {
      commitTextDraft();
    }
    event.preventDefault();
    event.stopPropagation();
    root.current?.focus();
    const view = navigation.current.current;
    const screen = screenPoint(event), point = worldPoint(screen);
    if (spaceHeld) {
      navigation.stop();
      root.current?.setPointerCapture(event.pointerId);
      gesture.current = { pointer: event.pointerId, mode: 'pan', spacePan: true, start: screen, viewport: view };
      update(event);
      return;
    }

    // Eyedropper tool or Alt-held temporary eyedropper
    if (event.button === 0 && (settings.tool === 'eyedropper' || altHeld || event.altKey)) {
      if (boardContains(point, boardWidth, boardHeight)) {
        const picked = sampleBoardPixel(point.x, point.y);
        onPickColor?.(picked);
      }
      navigation.stop();
      root.current?.setPointerCapture(event.pointerId);
      gesture.current = { pointer: event.pointerId, mode: 'eyedropper', start: point, viewport: view };
      return;
    }

    const layer = model.layers.find(l => l.id === activeLayer);

    // Ctrl-drag temporary layer move from any tool
    if (event.button === 0 && (event.ctrlKey || event.metaKey) && settings.tool !== 'pointer') {
      const hitCtrl = [...model.layers].reverse().find(l => !l.hidden && !l.locked && hitBoardLayer(model.shapes, l, point, 5 / view.zoom)) ??
        (layer && !layer.hidden && !layer.locked ? layer : undefined);
      if (hitCtrl) {
        navigation.stop();
        root.current?.setPointerCapture(event.pointerId);
        onSelect(hitCtrl.id);
        gesture.current = { pointer: event.pointerId, mode: 'move', start: point, original: hitCtrl, layer: hitCtrl, viewport: view };
        update(event);
        return;
      }
    }

    // Selection tools (Marquee Rect, Marquee Ellipse, Lasso, Magic Wand)
    if (event.button === 0 && ['selectRect', 'selectEllipse', 'lasso', 'wand'].includes(settings.tool)) {
      if (!boardContains(point, boardWidth, boardHeight)) {
        onSelectionChange?.(null);
        return;
      }
      if (settings.tool === 'wand') {
        const hasRelevantShapes = settings.fillSample === 'all'
          ? model.shapes.some(s => !s.hidden)
          : model.shapes.some(s => !s.hidden && (s.layerId ?? DEFAULT_BOARD_LAYER) === activeLayer);
        if (!hasRelevantShapes) {
          onSelectionChange?.([
            { x: 0, y: 0 },
            { x: boardWidth, y: 0 },
            { x: boardWidth, y: boardHeight },
            { x: 0, y: boardHeight },
          ]);
          return;
        }
        const sampleBuf = current.current.engineActive
          ? (settings.fillSample === 'all'
              ? studio.getCompositePixelData(model.layers, model.shapes, boardWidth, boardHeight)
              : studio.getLayerPixelData(activeLayer, model.layers, model.shapes, boardWidth, boardHeight)) ??
            (settings.fillSample === 'all'
              ? model.getCompositePixels(undefined, false)
              : model.getLayerPixels(activeLayer))
          : (settings.fillSample === 'all'
              ? model.getCompositePixels(undefined, false)
              : model.getLayerPixels(activeLayer));
        const mask = computeFloodMask(
          sampleBuf,
          boardWidth,
          boardHeight,
          point.x - (settings.fillSample === 'all' ? 0 : (layer?.x ?? 0)),
          point.y - (settings.fillSample === 'all' ? 0 : (layer?.y ?? 0)),
          settings.fillTolerance ?? 32,
          settings.fillContiguous !== false,
          0,
        );
        const poly = selectionMaskToPolygon(mask, boardWidth, boardHeight).map(p => ({
          x: p.x + (settings.fillSample === 'all' ? 0 : (layer?.x ?? 0)),
          y: p.y + (settings.fillSample === 'all' ? 0 : (layer?.y ?? 0)),
        }));
        onSelectionChange?.(poly.length >= 3 ? poly : null);
        return;
      }
      navigation.stop();
      root.current?.setPointerCapture(event.pointerId);
      const startPt = clampBoardPoint(point, boardWidth, boardHeight);
      gesture.current = {
        pointer: event.pointerId,
        mode: 'select',
        start: startPt,
        selectionPoints: [startPt],
        viewport: view,
      };
      setSelectionDraft([startPt]);
      return;
    }

    // Text tool
    if (event.button === 0 && settings.tool === 'text') {
      if (!boardContains(point, boardWidth, boardHeight) || !layer || layer.locked || layer.hidden) return;
      setTextDraft({ x: Math.round(point.x), y: Math.round(point.y), layerId: layer.id, value: '' });
      return;
    }

    // Paint Bucket tool (true pixel flood fill inside renderer; attaches selection clipPolygon only when active)
    if (event.button === 0 && settings.tool === 'bucket') {
      if (!boardContains(point, boardWidth, boardHeight) || !layer || layer.locked || layer.hidden) return;
      try {
        const localSeed: BoardPoint = {
          x: Math.round((point.x - layer.x) * 100) / 100,
          y: Math.round((point.y - layer.y) * 100) / 100,
        };
        const activeClipLocal = selectionPolygon?.length
          ? selectionPolygon.map(p => ({
              x: Math.round((p.x - layer.x) * 100) / 100,
              y: Math.round((p.y - layer.y) * 100) / 100,
            }))
          : undefined;
        model.put({
          id: crypto.randomUUID(),
          layerId: layer.id,
          tool: 'bucket',
          points: [localSeed],
          color: settings.color,
          width: 1,
          opacity: settings.opacity,
          filled: true,
          fillTolerance: settings.fillTolerance ?? 32,
          fillExpand: settings.fillExpand ?? 1,
          fillContiguous: settings.fillContiguous !== false,
          fillAntiAlias: settings.fillAntiAlias !== false,
          fillSample: settings.fillSample ?? 'layer',
          ...(activeClipLocal ? { clipPolygon: activeClipLocal } : {}),
          x: 0,
          y: 0,
          order: (model.shapes[model.shapes.length - 1]?.order ?? 0) + 1,
          hidden: false,
          locked: false,
        });
      } catch (err) {
        onError(err);
      }
      return;
    }

    if (event.button === 0 && settings.tool !== 'pointer' && (!boardContains(point, boardWidth, boardHeight) || !layer || layer.locked || layer.hidden)) return;
    navigation.stop();
    root.current?.setPointerCapture(event.pointerId);
    const activeSelected = model.layers.find(l => l.id === selected && !l.hidden && !l.locked);
    const activeBounds = activeSelected ? boardLayerBounds(model.shapes, activeSelected) : null;
    const handle = settings.tool === 'pointer' && event.button === 0 && activeBounds
      ? hitBoardResizeHandle(activeBounds, point, 10 / view.zoom)
      : null;
    if (handle && activeSelected && activeBounds) {
      gesture.current = {
        pointer: event.pointerId,
        mode: 'resize',
        handle,
        start: point,
        original: activeSelected,
        layer: activeSelected,
        initialBounds: activeBounds,
        targetBounds: activeBounds,
        viewport: view,
      };
      update(event);
      return;
    }
    const hit = settings.tool === 'pointer' && event.button === 0
      ? [...model.layers].reverse().find(l => hitBoardLayer(model.shapes, l, point, 5 / view.zoom)) ??
        (activeSelected && activeBounds && point.x >= activeBounds.x && point.x <= activeBounds.x + activeBounds.width &&
          point.y >= activeBounds.y && point.y <= activeBounds.y + activeBounds.height ? activeSelected : undefined)
      : undefined;
    if (event.button === 1 || (settings.tool === 'pointer' && !hit)) {
      gesture.current = { pointer: event.pointerId, mode: 'pan', start: screen, viewport: view };
      if (event.button === 0) onSelect(null);
    } else if (hit) {
      onSelect(hit.id);
      gesture.current = { pointer: event.pointerId, mode: 'move', start: point, original: hit, layer: hit, viewport: view };
    } else if (
      settings.tool !== 'pointer' &&
      settings.tool !== 'image' &&
      settings.tool !== 'eyedropper' &&
      !['selectRect', 'selectEllipse', 'lasso', 'wand'].includes(settings.tool) &&
      layer
    ) {
      onSelect(null);
      const p = pointerPressure(event);
      const local: BoardPoint = {
        x: Math.round((point.x - layer.x) * 100) / 100,
        y: Math.round((point.y - layer.y) * 100) / 100,
        ...(p !== undefined ? { p } : {}),
      };
      const localClip = selectionPolygon?.length
        ? selectionPolygon.map(pt => ({
            x: Math.round((pt.x - layer.x) * 100) / 100,
            y: Math.round((pt.y - layer.y) * 100) / 100,
          }))
        : undefined;
      const strokeColor = settings.color;
      const shape: BoardShape = {
        id: crypto.randomUUID(),
        layerId: layer.id,
        tool: settings.tool as BoardShape['tool'],
        ...(settings.tool === 'brush' ? { brushType: settings.brushType } : {}),
        points: settings.tool === 'brush' || settings.tool === 'eraser' ? [local] : [local, local],
        color: strokeColor,
        ...(settings.secondaryColor ? { secondaryColor: settings.secondaryColor } : {}),
        width: boardBrushWidth(settings.width),
        opacity: settings.opacity,
        ...(settings.flow !== undefined ? { flow: settings.flow } : {}),
        ...(settings.hardness !== undefined ? { hardness: settings.hardness } : {}),
        ...(settings.spacing !== undefined ? { spacing: settings.spacing } : {}),
        ...(settings.pressureSize !== undefined ? { pressureSize: settings.pressureSize } : {}),
        ...(settings.pressureOpacity !== undefined ? { pressureOpacity: settings.pressureOpacity } : {}),
        ...(settings.symmetry && settings.symmetry !== 'none' ? { symmetry: settings.symmetry } : {}),
        ...(settings.tool === 'gradient' ? {
          gradientType: settings.gradientType ?? 'linear',
          gradientTransparent: Boolean(settings.gradientTransparent),
        } : {}),
        ...(localClip ? { clipPolygon: localClip } : {}),
        filled: settings.filled,
        smoothing: settings.smoothing,
        x: 0,
        y: 0,
        order: (model.shapes[model.shapes.length - 1]?.order ?? 0) + 1,
        hidden: false,
        locked: false,
      };
      gesture.current = {
        pointer: event.pointerId,
        mode: 'draw',
        start: point,
        localStart: local,
        layer,
        draft: shape,
        viewport: view,
        stabilizer: ['brush', 'eraser'].includes(settings.tool) ? new BrushStabilizer(local, event.timeStamp) : undefined,
        lastEventTime: event.timeStamp,
        lastRawLocal: local,
        lastShiftKey: event.shiftKey,
      };
      if (current.current.engineActive) {
        liveDraftRef.current = shape;
        scheduleLiveSceneFlush();
      } else {
        setDraft(shape);
      }
    }
    update(event);
  };

  const up = (event: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || g.pointer !== event.pointerId) return;
    stopStabilizerCatchUp();
    update(event, true);
    if (liveRafRef.current !== null) {
      cancelAnimationFrame(liveRafRef.current);
      liveRafRef.current = null;
    }
    let committed = false;
    try {
      if (g.mode === 'select') {
        const pts = g.selectionPoints ?? [];
        onSelectionChange?.(pts.length >= 3 ? pts.slice(0, 256) : null);
      } else if (g.mode !== 'eyedropper') {
        const live = g.layer && model.layers.find(l => l.id === g.layer!.id);
        if (g.mode === 'draw' && g.draft && live && !live.locked && !live.hidden && live.x === g.layer!.x && live.y === g.layer!.y) {
          model.put(g.draft);
          committed = true;
        }
        if (g.mode === 'move' && g.layer && live && live === g.original && (live.x !== g.layer.x || live.y !== g.layer.y)) {
          model.updateLayer(g.layer);
          committed = true;
        }
        if (
          g.mode === 'resize' &&
          g.original &&
          g.initialBounds &&
          g.targetBounds &&
          live &&
          !live.locked &&
          !live.hidden &&
          (g.initialBounds.x !== g.targetBounds.x ||
            g.initialBounds.y !== g.targetBounds.y ||
            g.initialBounds.width !== g.targetBounds.width ||
            g.initialBounds.height !== g.targetBounds.height)
        ) {
          model.resizeLayer(g.original.id, g.initialBounds, g.targetBounds);
          committed = true;
        }
      }
    } catch (error) {
      onError(error);
    }
    gesture.current = null;
    liveDraftRef.current = null;
    liveMovingRef.current = null;
    liveResizingRef.current = null;
    if (!current.current.engineActive) {
      setDraft(null);
      setSelectionDraft(null);
      setMoving(null);
      setResizing(null);
    } else {
      if (g.mode === 'select') setSelectionDraft(null);
      if (!committed) syncAndPresentScene(false);
    }
    if (root.current?.hasPointerCapture(event.pointerId)) root.current.releasePointerCapture(event.pointerId);
    publish({
      ...worldPoint(screenPoint(event)),
      tool: spaceHeld ? 'pointer' : altHeld ? 'eyedropper' : settings.tool,
      width: boardBrushWidth(settings.width),
      color: settings.color,
    }, screenPoint(event), true);
  };

  const view = navigation.current.current;
  const selectedLayer = model.layers.find(l => l.id === selected && !l.hidden);
  const activeMoving = liveMovingRef.current ?? moving;
  const activeResizing = liveResizingRef.current ?? resizing;
  const bounds = activeResizing && selectedLayer && activeResizing.id === selectedLayer.id
    ? activeResizing.bounds
    : selectedLayer
      ? boardLayerBounds(model.shapes, activeMoving ?? selectedLayer)
      : null;

  const cursorGlyph = (id: string, c: Cursor) => (
    <StreamPointerGlyph
      key={id}
      name={participantName(id)}
      color={c.color}
      interpolate
      shape={toolToCursorShape(c.tool)}
      diameter={c.width * view.zoom}
      worldWidth={c.width}
      style={{
        left: c.x,
        top: c.y,
        transform: `scale(${1 / view.zoom})`,
        transformOrigin: '0 0',
      }}
    />
  );

  const imageHref = (hash: string) => model.imageUrl(hash);
  const activeSelectionPoly = selectionDraft ?? selectionPolygon;
  const hasLiveDraft = Boolean(liveDraftRef.current ?? draft);

  return (
    <div
      ref={root}
      className={`whiteboard-canvas ${compact ? 'compact' : 'virtual-cursor'} ${mirrorView ? 'is-mirrored' : ''}`}
      tabIndex={compact ? -1 : 0}
      role="region"
      aria-label={t('whiteboard.scene')}
      aria-description={t('whiteboard.navigation')}
      onPointerDown={down}
      onPointerMove={event => update(event)}
      onPointerUp={up}
      onPointerCancel={cancel}
      onLostPointerCapture={() => { if (gesture.current) cancel(); }}
      onPointerLeave={() => { if (!gesture.current) leave(); }}
      onContextMenu={event => {
        event.preventDefault();
        if (!compact) {
          const actions = [];
          if (onPasteImage) {
            actions.push({ id: 'paste-image', label: t('whiteboard.pasteImage'), icon: <ImagePlus size={15} />, onSelect: onPasteImage });
          }
          if (selectionPolygon?.length && onSelectionChange) {
            actions.push({ id: 'deselect', label: t('whiteboard.deselect'), icon: <CheckSquare size={15} />, onSelect: () => onSelectionChange(null) });
            actions.push({
              id: 'clear-selection',
              label: t('whiteboard.clearSelection'),
              icon: <Trash2 size={15} />,
              onSelect: () => {
                try { model.clearLayer(activeLayer, selectionPolygon); } catch (err) { onError(err); }
              },
            });
          }
          if (actions.length) menu(event, actions);
        }
      }}
    >
      <canvas
        ref={viewportCanvasRef}
        className="whiteboard-viewport-canvas"
        aria-hidden="true"
      />

      <svg className="whiteboard-art" aria-hidden="true">
        <defs>
          <clipPath id={clipId}>
            <rect width={boardWidth} height={boardHeight} />
          </clipPath>
          {!engineActive && (
            <>
              <filter id="wb-filter-pencil" x="-10%" y="-10%" width="120%" height="120%">
                <feTurbulence type="fractalNoise" baseFrequency="0.75" numOctaves="3" result="grain" />
                <feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -0.58 1.18" in="grain" result="tooth" />
                <feComposite in="SourceGraphic" in2="tooth" operator="in" />
              </filter>
              <filter id="wb-filter-watercolor" x="-15%" y="-15%" width="130%" height="130%">
                <feTurbulence type="turbulence" baseFrequency="0.035" numOctaves="2" result="wash" />
                <feDisplacementMap in="SourceGraphic" in2="wash" scale="2.4" xChannelSelector="R" yChannelSelector="G" />
              </filter>
            </>
          )}
        </defs>
        <g ref={overlayGroupRef} transform={`translate(${view.x} ${view.y}) scale(${view.zoom})`}>
          <rect
            className="whiteboard-paper"
            width={boardWidth}
            height={boardHeight}
            fill={engineActive ? 'none' : (transparent ? 'none' : backgroundColor)}
            stroke={engineActive ? 'none' : undefined}
          />
          <g clipPath={`url(#${clipId})`}>
            {!engineActive && (
              <g className="whiteboard-svg-layers">
                {(() => {
                  const visibleLayers = model.layers.filter(l => !l.hidden);
                  let currentBaseLayerId: string | null = null;
                  let currentBaseView: BoardLayer | null = null;
                  let currentBaseShapes: BoardShape[] = [];
                  return visibleLayers.map((layer, idx) => {
                    const layerView = resizing?.id === layer.id ? resizing.layer : moving?.id === layer.id ? moving : layer;
                    const shapes = resizing?.id === layer.id ? resizing.shapes : model.shapes.filter(s => (s.layerId ?? DEFAULT_BOARD_LAYER) === layer.id);
                    const drafts = [...model.cursors]
                      .filter(([id, c]) => id !== actor && c.draft && (c.draft.layerId ?? DEFAULT_BOARD_LAYER) === layer.id && !shapes.some(s => s.id === c.draft!.id))
                      .map(([, c]) => c.draft!);
                    const allShapes = [...shapes, ...drafts, ...(draft?.layerId === layer.id ? [draft] : [])];
                    const layerOpacity = (layerView.opacity ?? 100) / 100;
                    const isClipped = Boolean(layerView.clipping) && currentBaseLayerId !== null && currentBaseView !== null;
                    if (!layerView.clipping) {
                      currentBaseLayerId = layer.id;
                      currentBaseView = layerView;
                      currentBaseShapes = allShapes;
                    }
                    const needsClipDef = !layerView.clipping && visibleLayers.slice(idx + 1).some(next => next.clipping);
                    const clipMaskId = isClipped ? `${clipId}-layerclip-${currentBaseLayerId}` : undefined;
                    return (
                      <g key={layer.id}>
                        {needsClipDef && (
                          <defs>
                            <mask
                              id={`${clipId}-layerclip-${layer.id}`}
                              maskUnits="userSpaceOnUse"
                              x={-16000}
                              y={-10000}
                              width={48000}
                              height={30000}
                              style={{ maskType: 'alpha' }}
                            >
                              <g transform={`translate(${layerView.x} ${layerView.y})`}>
                                <WhiteboardLayerArt
                                  shapes={currentBaseShapes}
                                  imageHref={imageHref}
                                  canvasWidth={boardWidth}
                                  canvasHeight={boardHeight}
                                />
                              </g>
                            </mask>
                          </defs>
                        )}
                        <g
                          data-board-layer={layer.id}
                          mask={clipMaskId ? `url(#${clipMaskId})` : undefined}
                          transform={`translate(${layerView.x} ${layerView.y})`}
                          opacity={layerOpacity < 1 ? layerOpacity : undefined}
                          style={layerView.blendMode && layerView.blendMode !== 'normal' ? { mixBlendMode: layerView.blendMode } : undefined}
                        >
                          <WhiteboardLayerArt
                            shapes={allShapes}
                            imageHref={imageHref}
                            canvasWidth={boardWidth}
                            canvasHeight={boardHeight}
                            alphaLock={Boolean(layerView.alphaLock)}
                          />
                        </g>
                      </g>
                    );
                  });
                })()}
              </g>
            )}

            {showGrid && (
              <g className="whiteboard-pixel-grid-overlay" pointerEvents="none">
                <defs>
                  <pattern
                    id={`${clipId}-grid-major`}
                    width={16}
                    height={16}
                    patternUnits="userSpaceOnUse"
                  >
                    <path
                      ref={gridMajorPathRef}
                      d="M 16 0 L 0 0 0 16"
                      fill="none"
                      stroke="rgba(100, 116, 139, 0.36)"
                      strokeWidth={1 / view.zoom}
                    />
                  </pattern>
                  {(gridPixelLevel || view.zoom >= 5) && (
                    <pattern
                      id={`${clipId}-grid-pixel`}
                      width={1}
                      height={1}
                      patternUnits="userSpaceOnUse"
                    >
                      <path
                        ref={gridPixelPathRef}
                        d="M 1 0 L 0 0 0 1"
                        fill="none"
                        stroke="rgba(148, 163, 184, 0.28)"
                        strokeWidth={0.75 / view.zoom}
                      />
                    </pattern>
                  )}
                </defs>
                {(gridPixelLevel || view.zoom >= 5) && (
                  <rect width={boardWidth} height={boardHeight} fill={`url(#${clipId}-grid-pixel)`} />
                )}
                <rect width={boardWidth} height={boardHeight} fill={`url(#${clipId}-grid-major)`} />
              </g>
            )}

            {!compact && settings.symmetry && settings.symmetry !== 'none' && (
              <g className="whiteboard-symmetry-guides">
                {(settings.symmetry === 'vertical' || settings.symmetry === 'quad' || settings.symmetry === 'radial') && (
                  <line
                    ref={symVRef}
                    x1={boardWidth / 2}
                    y1={0}
                    x2={boardWidth / 2}
                    y2={boardHeight}
                    stroke="var(--accent-color)"
                    strokeWidth={1.25 / view.zoom}
                    strokeDasharray={`${6 / view.zoom} ${4 / view.zoom}`}
                  />
                )}
                {(settings.symmetry === 'horizontal' || settings.symmetry === 'quad' || settings.symmetry === 'radial') && (
                  <line
                    ref={symHRef}
                    x1={0}
                    y1={boardHeight / 2}
                    x2={boardWidth}
                    y2={boardHeight / 2}
                    stroke="var(--accent-color)"
                    strokeWidth={1.25 / view.zoom}
                    strokeDasharray={`${6 / view.zoom} ${4 / view.zoom}`}
                  />
                )}
              </g>
            )}

            {!compact && activeSelectionPoly && activeSelectionPoly.length >= 2 && (
              <g className="whiteboard-selection-marquee">
                <polygon
                  ref={marqueeOuterRef}
                  points={activeSelectionPoly.map(p => `${p.x},${p.y}`).join(' ')}
                  fill="rgba(59, 130, 246, 0.08)"
                  fillRule="evenodd"
                  stroke="#ffffff"
                  strokeWidth={1.5 / view.zoom}
                />
                <polygon
                  ref={marqueeInnerRef}
                  className="whiteboard-marching-ants"
                  points={activeSelectionPoly.map(p => `${p.x},${p.y}`).join(' ')}
                  fill="none"
                  stroke="#2563eb"
                  strokeWidth={1.5 / view.zoom}
                  strokeDasharray={`${5 / view.zoom} ${5 / view.zoom}`}
                />
              </g>
            )}

            {!compact && !hasLiveDraft && bounds && (
              <g className="whiteboard-selection-box">
                <rect
                  ref={selectionRectRef}
                  x={bounds.x}
                  y={bounds.y}
                  width={bounds.width}
                  height={bounds.height}
                  fill="none"
                  stroke="var(--accent-color)"
                  strokeWidth={1.25 / view.zoom}
                  strokeDasharray={`${4 / view.zoom} ${3 / view.zoom}`}
                />
                {selectedLayer && !selectedLayer.locked && boardResizeHandles(bounds).map((item, idx) => (
                  <rect
                    key={item.handle}
                    ref={el => { selectionHandleRefs.current[idx] = el; }}
                    data-resize-handle={item.handle}
                    x={item.x - 4.5 / view.zoom}
                    y={item.y - 4.5 / view.zoom}
                    width={9 / view.zoom}
                    height={9 / view.zoom}
                    rx={2 / view.zoom}
                    fill="#ffffff"
                    stroke="var(--accent-color)"
                    strokeWidth={1.5 / view.zoom}
                  />
                ))}
              </g>
            )}
          </g>
        </g>
      </svg>

      {!compact && textDraft && (
        <textarea
          ref={textDraftRef}
          autoComplete="off"
          autoFocus
          className="whiteboard-text-input"
          aria-label={t('whiteboard.text')}
          value={textDraft.value}
          style={{
            left: view.x + textDraft.x * view.zoom,
            top: view.y + textDraft.y * view.zoom,
            fontSize: Math.max(12, (settings.fontSize ?? 28) * view.zoom),
            color: settings.color,
          }}
          onPointerDown={e => e.stopPropagation()}
          onChange={e => setTextDraft({ ...textDraft, value: e.target.value })}
          onBlur={commitTextDraft}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              commitTextDraft();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setTextDraft(null);
            }
          }}
        />
      )}

      <div className="whiteboard-cursors" aria-hidden="true">
        <div
          ref={remoteCursorsRef}
          className="whiteboard-remote-cursors"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}
        >
          {[...model.cursors].filter(([id]) => id !== actor).map(([id, c]) => cursorGlyph(id, c))}
        </div>
        {!compact && localCursorMeta.visible && localCursorPosRef.current && (
          <StreamPointerGlyph
            key={name}
            innerRef={localCursorElRef}
            name=""
            color={localCursorMeta.color}
            interpolate={false}
            shape={localCursorMeta.shape}
            brushStyle={toolToBrushStyle(settings.tool, settings.brushType)}
            diameter={localCursorPosRef.current.worldWidth * view.zoom}
            style={{
              left: localCursorPosRef.current.screen.x,
              top: localCursorPosRef.current.screen.y,
            }}
          />
        )}
        {!compact && localCursorMeta.visible && localCursorMeta.showLoupe && localCursorPosRef.current && (() => {
          const { screen, world } = localCursorPosRef.current;
          const patch = sampleLoupePatch(world.x, world.y);
          const stageW = root.current?.clientWidth || 800;
          const flipX = screen.x + 128 > stageW;
          const flipY = screen.y - 122 < 12;
          return (
            <div
              className="whiteboard-eyedropper-loupe"
              style={{
                left: flipX ? screen.x - 114 : screen.x + 18,
                top: flipY ? screen.y + 18 : screen.y - 114,
              }}
            >
              <div
                className="whiteboard-eyedropper-loupe-ring"
                style={{ borderColor: patch.centerHex }}
              >
                <div className="whiteboard-eyedropper-loupe-grid">
                  {patch.grid.map((cellColor, idx) => (
                    <span
                      key={idx}
                      className={`whiteboard-eyedropper-loupe-cell ${idx === 40 ? 'is-center' : ''}`}
                      style={cellColor !== 'transparent' ? { backgroundColor: cellColor } : undefined}
                    />
                  ))}
                </div>
              </div>
              <span className="whiteboard-eyedropper-loupe-badge">
                <i style={{ backgroundColor: patch.centerHex }} />
                {patch.centerHex.toUpperCase()}
              </span>
            </div>
          );
        })()}
      </div>

      {!compact && (
        <div className="whiteboard-navigation-hud" onPointerDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}>
          <TooltipButton
            tooltip={t('whiteboard.zoomOut')}
            aria-label={t('whiteboard.zoomOut')}
            className="room-app-notepad-tool whiteboard-hud-btn"
            onClick={() => {
              const w = root.current?.clientWidth || 800, h = root.current?.clientHeight || 500;
              navigation.zoom(120, { x: w / 2, y: h / 2 });
            }}
          >
            <ZoomOut size={13} />
          </TooltipButton>
          <span ref={zoomHintRef} className="whiteboard-navigation-hint">{Math.round(view.zoom * 100)}%</span>
          <TooltipButton
            tooltip={t('whiteboard.zoomIn')}
            aria-label={t('whiteboard.zoomIn')}
            className="room-app-notepad-tool whiteboard-hud-btn"
            onClick={() => {
              const w = root.current?.clientWidth || 800, h = root.current?.clientHeight || 500;
              navigation.zoom(-120, { x: w / 2, y: h / 2 });
            }}
          >
            <ZoomIn size={13} />
          </TooltipButton>
          <TooltipButton
            tooltip={t('whiteboard.fitCanvas')}
            aria-label={t('whiteboard.fitCanvas')}
            className="room-app-notepad-tool whiteboard-hud-btn"
            onClick={() => fitCanvas(false)}
          >
            <Maximize2 size={13} />
          </TooltipButton>
          <TooltipButton
            tooltip={t('whiteboard.mirrorView')}
            aria-label={t('whiteboard.mirrorView')}
            aria-pressed={mirrorView}
            className={`room-app-notepad-tool whiteboard-hud-btn ${mirrorView ? 'active' : ''}`}
            onClick={() => setMirrorView(v => !v)}
          >
            <FlipHorizontal size={13} />
          </TooltipButton>
          <TooltipButton
            tooltip={t('whiteboard.pixelGrid')}
            aria-label={t('whiteboard.pixelGrid')}
            aria-pressed={showGrid}
            className={`room-app-notepad-tool whiteboard-hud-btn ${showGrid ? 'active' : ''}`}
            onClick={() => {
              setShowGrid(v => {
                const next = !v;
                if (next) setGridPixelLevel(navigation.current.current.zoom >= 5);
                return next;
              });
            }}
          >
            <Grid size={13} />
          </TooltipButton>
          {(onOpenCanvasSettings || onToggleFullscreen) && (
            <>
              <span className="whiteboard-hud-divider" aria-hidden="true" />
              {onOpenCanvasSettings && (
                <TooltipButton
                  tooltip={t('whiteboard.canvasSettings')}
                  aria-label={t('whiteboard.canvasSettings')}
                  className="room-app-notepad-tool whiteboard-hud-btn"
                  onClick={onOpenCanvasSettings}
                >
                  <SlidersHorizontal size={13} />
                </TooltipButton>
              )}
              {onToggleFullscreen && (
                <TooltipButton
                  tooltip={t(fullscreen ? 'browser.exitFullscreen' : 'browser.fullscreen')}
                  aria-label={t(fullscreen ? 'browser.exitFullscreen' : 'browser.fullscreen')}
                  aria-pressed={fullscreen}
                  className="room-app-notepad-tool whiteboard-hud-btn"
                  onClick={onToggleFullscreen}
                >
                  {fullscreen ? <Minimize size={13} /> : <Maximize size={13} />}
                </TooltipButton>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
