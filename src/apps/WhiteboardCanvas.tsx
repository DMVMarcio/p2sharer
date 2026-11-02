import { useEffect, useLayoutEffect, useId, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import {
  ImagePlus, ZoomIn, ZoomOut, Maximize2, FlipHorizontal, Grid, Trash2, CheckSquare,
  Maximize, Minimize, SlidersHorizontal,
} from 'lucide-react';
import { useContextMenu } from '../components/common/ContextMenu';
import { TooltipButton } from '../components/common/TooltipButton';
import { StreamPointerGlyph } from '../components/room/StreamPointerGlyph';
import { WhiteboardLayerArt } from './WhiteboardLayerArt';
import {
  BOARD_MAX_POINTS, DEFAULT_BOARD_LAYER, boardBrushWidth, boardLayerBounds, hitBoardLayer,
  type BoardLayer, type BoardPoint, type BoardShape,
} from './whiteboard_scene';
import type { BoardCursor, WhiteboardModel } from './whiteboard_model';
import type { BoardSettings } from './WhiteboardToolbar';
import { computeFloodMask, selectionMaskToPolygon } from './whiteboard_raster';
import { WhiteboardCanvas2DRenderer } from './whiteboard_canvas2d';
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
};
type ResizePreview = { id: string; layer: BoardLayer; shapes: BoardShape[]; bounds: BoardBox };
type TextDraft = { x: number; y: number; layerId: string; value: string };

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
  activeLayer,
  settings,
  spaceHeld = false,
  altHeld = false,
  viewport,
  onViewport,
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
  activeLayer: string;
  settings: BoardSettings;
  spaceHeld?: boolean;
  altHeld?: boolean;
  viewport: BoardViewport;
  onViewport(viewport: BoardViewport): void;
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
  const rasterCanvasRef = useRef<HTMLCanvasElement>(null);
  const canvas2dRendererRef = useRef(new WhiteboardCanvas2DRenderer());
  const [canvas2dActive, setCanvas2dActive] = useState(false);
  const menu = useContextMenu();
  const { width: boardWidth, height: boardHeight, backgroundColor, transparent } = model.canvasSettings;
  const navigation = useWhiteboardViewport(root, viewport, onViewport, boardWidth, boardHeight);
  const gesture = useRef<Gesture | null>(null);
  const [draft, setDraft] = useState<BoardShape | null>(null);
  const [selectionDraft, setSelectionDraft] = useState<BoardPoint[] | null>(null);
  const [textDraft, setTextDraft] = useState<TextDraft | null>(null);
  const [moving, setMoving] = useState<BoardLayer | null>(null);
  const [resizing, setResizing] = useState<ResizePreview | null>(null);
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const [cursorScreen, setCursorScreen] = useState<BoardPoint | null>(null);
  const [mirrorView, setMirrorView] = useState(false);
  const [showGrid, setShowGrid] = useState(false);
  const physicalScreen = useRef<BoardPoint | null>(null);
  const current = useRef({ settings, compact, spaceHeld, altHeld });
  current.current = { settings, compact, spaceHeld, altHeld };
  const lastSent = useRef(0), latestCursor = useRef<Cursor | null>(null);

  const screenPoint = (event: { clientX: number; clientY: number }): BoardPoint => {
    const bounds = root.current!.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  };
  const worldPoint = (p: BoardPoint): BoardPoint => {
    const view = navigation.current.current;
    return { x: (p.x - view.x) / view.zoom, y: (p.y - view.y) / view.zoom };
  };

  // Decode cached base64 PNG images into model.raster.decodedImages and canvas2dRenderer when running in a browser context
  useEffect(() => {
    if (typeof document === 'undefined') return;
    for (const [hash, raw] of model.images) {
      if (model.raster.decodedImages.has(hash)) continue;
      if (typeof Image === 'undefined') continue;
      const img = new Image();
      img.onload = () => {
        try {
          canvas2dRendererRef.current.registerImage(hash, img);
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
        } catch { /* ignore in mock environments */ }
      };
      img.src = `data:image/png;base64,${raw}`;
    }
  }, [model, model.images.size]);

  const publish = (value: Cursor | null, screen: BoardPoint | null = physicalScreen.current, force = false) => {
    const wire = value?.draft && value.draft.points.length > BOARD_MAX_POINTS
      ? { ...value, draft: { ...value.draft, points: value.draft.points.slice(-BOARD_MAX_POINTS) } }
      : value;
    latestCursor.current = wire;
    setCursor(value);
    setCursorScreen(value ? screen : null);
    if (force || performance.now() - lastSent.current >= 40) {
      model.presence(wire);
      lastSent.current = performance.now();
    }
  };
  const leave = () => { physicalScreen.current = null; publish(null, null, true); };
  const cancel = () => {
    navigation.stop();
    gesture.current = null;
    setDraft(null);
    setSelectionDraft(null);
    setMoving(null);
    setResizing(null);
    leave();
  };

  useEffect(() => {
    const heartbeat = setInterval(() => { if (latestCursor.current) model.presence(latestCursor.current); }, 800);
    const blur = () => cancel(), visibility = () => { if (document.hidden) cancel(); };
    window.addEventListener('blur', blur);
    document.addEventListener('visibilitychange', visibility);
    return () => {
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

  useLayoutEffect(() => {
    let measured = false;
    const center = () => {
      const w = root.current?.clientWidth || 800, h = root.current?.clientHeight || 500;
      const zoom = compact ? Math.min(w / boardWidth, h / boardHeight) : 1;
      navigation.set({ x: w / 2 - (boardWidth * zoom) / 2, y: h / 2 - (boardHeight * zoom) / 2, zoom });
    };
    center();
    const observer = new ResizeObserver(() => {
      if (compact || !measured) center();
      else navigation.set(navigation.current.current);
      measured = true;
    });
    if (root.current) observer.observe(root.current);
    return () => observer.disconnect();
  }, [model, identity, compact, onViewport, boardWidth, boardHeight]);

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
  }, [spaceHeld, altHeld, viewport.x, viewport.y, viewport.zoom, settings.tool, settings.width, settings.color, compact]);

  // Render scene onto the hardware-accelerated 2D pixel canvas at exact board resolution
  useLayoutEffect(() => {
    const canvasEl = rasterCanvasRef.current;
    if (!canvasEl) return;
    const draftsByLayer = new Map<string, BoardShape[]>();
    for (const [id, c] of model.cursors) {
      if (id !== actor && c.draft) {
        const lid = c.draft.layerId ?? DEFAULT_BOARD_LAYER;
        const arr = draftsByLayer.get(lid) ?? [];
        arr.push(c.draft);
        draftsByLayer.set(lid, arr);
      }
    }
    if (draft) {
      const lid = draft.layerId ?? DEFAULT_BOARD_LAYER;
      const arr = draftsByLayer.get(lid) ?? [];
      arr.push(draft);
      draftsByLayer.set(lid, arr);
    }
    const ok = canvas2dRendererRef.current.renderScene(
      canvasEl,
      model.layers,
      model.shapes,
      draftsByLayer,
      moving,
      resizing,
      boardWidth,
      boardHeight,
      backgroundColor,
      transparent,
    );
    if (ok !== canvas2dActive) setCanvas2dActive(ok);
  });

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
  }, [model, onViewport]);

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

  const update = (event: ReactPointerEvent<HTMLDivElement>, final = false) => {
    if (compact) return;
    const screen = screenPoint(event), g = gesture.current;
    physicalScreen.current = screen;
    let point = worldPoint(screen), drawing: BoardShape | undefined;
    if (g && g.pointer === event.pointerId) {
      if (g.mode === 'pan') {
        navigation.set({ ...g.viewport, x: g.viewport.x + screen.x - g.start.x, y: g.viewport.y + screen.y - g.start.y });
        point = worldPoint(screen);
      } else if (g.mode === 'eyedropper') {
        if (boardContains(point, boardWidth, boardHeight)) {
          const picked = model.sampleColor(point.x, point.y, true, activeLayer);
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
        setMoving(layer);
      } else if (g.mode === 'resize' && g.original && g.handle && g.initialBounds) {
        const nextBounds = resizeBoardBounds(g.initialBounds, g.handle, point, event.shiftKey, boardWidth, boardHeight);
        g.targetBounds = nextBounds;
        const preview = scaleBoardLayer(g.original, model.shapes, g.initialBounds, nextBounds);
        g.layer = preview.layer;
        setResizing({ id: g.original.id, layer: preview.layer, shapes: preview.shapes, bounds: nextBounds });
      } else if (g.mode === 'select' && g.selectionPoints) {
        const clamped = clampBoardPoint(point, boardWidth, boardHeight);
        if (settings.tool === 'lasso') {
          const prev = g.selectionPoints[g.selectionPoints.length - 1];
          if (Math.hypot(clamped.x - prev.x, clamped.y - prev.y) >= 2 / viewport.zoom) {
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
        const coalesced = !final && typeof event.nativeEvent?.getCoalescedEvents === 'function' ? event.nativeEvent.getCoalescedEvents() : [];
        const samples = coalesced.length ? coalesced : [event];
        let points = g.draft.points;
        let lastLocal: BoardPoint = points[points.length - 1];
        for (const sample of samples) {
          const sampleWorld = clampBoardPoint(worldPoint(screenPoint(sample)), boardWidth, boardHeight);
          const p = pointerPressure(sample, final);
          let local: BoardPoint = {
            x: Math.round((sampleWorld.x - g.layer.x) * 100) / 100,
            y: Math.round((sampleWorld.y - g.layer.y) * 100) / 100,
            ...(p !== undefined ? { p } : {}),
          };
          if (g.stabilizer && !final && !event.shiftKey) {
            const stabilized = g.stabilizer.sample(local, sample.timeStamp || event.timeStamp, settings.smoothing);
            local = {
              x: Math.round(stabilized.x * 100) / 100,
              y: Math.round(stabilized.y * 100) / 100,
              ...(stabilized.p !== undefined ? { p: stabilized.p } : {}),
            };
          }
          if (g.draft.tool === 'brush' || g.draft.tool === 'eraser') {
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
              if (Math.hypot(local.x - points[points.length - 1].x, local.y - points[points.length - 1].y) >= .5 / viewport.zoom) {
                points = [...points, local];
              } else if (local.p !== undefined && (points[points.length - 1].p === undefined || Math.abs(local.p - points[points.length - 1].p!) >= 0.02)) {
                points = [...points.slice(0, -1), { ...points[points.length - 1], p: local.p }];
              }
            }
          } else {
            const origin = g.localStart ?? points[0];
            const mode = g.draft.tool === 'line' || g.draft.tool === 'gradient' ? 'line' : 'rect';
            const [a, b] = constrainShapeEndpoints(origin, local, event.shiftKey, event.altKey, mode);
            lastLocal = b;
            points = [a, b];
          }
        }
        drawing = { ...g.draft, points };
        g.draft = drawing;
        setDraft(drawing);
        point = { x: lastLocal.x + g.layer.x, y: lastLocal.y + g.layer.y };
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
    const screen = screenPoint(event), point = worldPoint(screen);
    if (spaceHeld) {
      navigation.stop();
      root.current?.setPointerCapture(event.pointerId);
      gesture.current = { pointer: event.pointerId, mode: 'pan', spacePan: true, start: screen, viewport: navigation.current.current };
      update(event);
      return;
    }

    // Eyedropper tool or Alt-held temporary eyedropper
    if (event.button === 0 && (settings.tool === 'eyedropper' || altHeld || event.altKey)) {
      if (boardContains(point, boardWidth, boardHeight)) {
        const picked = model.sampleColor(point.x, point.y, true, activeLayer);
        onPickColor?.(picked);
      }
      navigation.stop();
      root.current?.setPointerCapture(event.pointerId);
      gesture.current = { pointer: event.pointerId, mode: 'eyedropper', start: point, viewport };
      return;
    }

    const layer = model.layers.find(l => l.id === activeLayer);

    // Ctrl-drag temporary layer move from any tool (like Photoshop/FireAlpaca)
    if (event.button === 0 && (event.ctrlKey || event.metaKey) && settings.tool !== 'pointer') {
      const hitCtrl = [...model.layers].reverse().find(l => !l.hidden && !l.locked && hitBoardLayer(model.shapes, l, point, 5 / viewport.zoom)) ??
        (layer && !layer.hidden && !layer.locked ? layer : undefined);
      if (hitCtrl) {
        navigation.stop();
        root.current?.setPointerCapture(event.pointerId);
        onSelect(hitCtrl.id);
        gesture.current = { pointer: event.pointerId, mode: 'move', start: point, original: hitCtrl, layer: hitCtrl, viewport };
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
        const sampleBuf = settings.fillSample === 'all'
          ? model.getCompositePixels(undefined, false)
          : model.getLayerPixels(activeLayer);
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
        viewport,
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

    // Paint Bucket tool (Flood Fill on click)
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
        const hasRelevantShapes = settings.fillSample === 'all'
          ? model.shapes.some(s => !s.hidden)
          : model.shapes.some(s => !s.hidden && (s.layerId ?? DEFAULT_BOARD_LAYER) === layer.id);
        let clipPolygon = activeClipLocal;
        if (!clipPolygon && hasRelevantShapes) {
          const sampleBuf = settings.fillSample === 'all'
            ? model.getCompositePixels(undefined, false)
            : model.getLayerPixels(layer.id);
          const mask = computeFloodMask(
            sampleBuf,
            boardWidth,
            boardHeight,
            settings.fillSample === 'all' ? point.x : localSeed.x,
            settings.fillSample === 'all' ? point.y : localSeed.y,
            settings.fillTolerance ?? 32,
            settings.fillContiguous !== false,
            settings.fillExpand ?? 1,
          );
          const floodPoly = selectionMaskToPolygon(mask, boardWidth, boardHeight).map(p => ({
            x: Math.round((p.x - (settings.fillSample === 'all' ? layer.x : 0)) * 100) / 100,
            y: Math.round((p.y - (settings.fillSample === 'all' ? layer.y : 0)) * 100) / 100,
          }));
          if (floodPoly.length >= 3) clipPolygon = floodPoly;
        }
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
          ...(clipPolygon ? { clipPolygon } : {}),
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
      ? hitBoardResizeHandle(activeBounds, point, 10 / viewport.zoom)
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
        viewport,
      };
      update(event);
      return;
    }
    const hit = settings.tool === 'pointer' && event.button === 0
      ? [...model.layers].reverse().find(l => hitBoardLayer(model.shapes, l, point, 5 / viewport.zoom)) ??
        (activeSelected && activeBounds && point.x >= activeBounds.x && point.x <= activeBounds.x + activeBounds.width &&
          point.y >= activeBounds.y && point.y <= activeBounds.y + activeBounds.height ? activeSelected : undefined)
      : undefined;
    if (event.button === 1 || (settings.tool === 'pointer' && !hit)) {
      gesture.current = { pointer: event.pointerId, mode: 'pan', start: screen, viewport: navigation.current.current };
      if (event.button === 0) onSelect(null);
    } else if (hit) {
      onSelect(hit.id);
      gesture.current = { pointer: event.pointerId, mode: 'move', start: point, original: hit, layer: hit, viewport };
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
      const strokeColor = settings.tool === 'brush' && settings.brushType === 'smudge'
        ? (() => {
            const hasShapes = model.shapes.some(s => !s.hidden && (s.layerId ?? DEFAULT_BOARD_LAYER) === layer.id);
            return hasShapes ? model.sampleColor(point.x, point.y, true, layer.id) : settings.color;
          })()
        : settings.color;
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
        viewport,
        stabilizer: ['brush', 'eraser'].includes(settings.tool) ? new BrushStabilizer(local, event.timeStamp) : undefined,
      };
      setDraft(shape);
    }
    update(event);
  };

  const up = (event: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || g.pointer !== event.pointerId) return;
    update(event, true);
    try {
      if (g.mode === 'select') {
        const pts = g.selectionPoints ?? [];
        onSelectionChange?.(pts.length >= 3 ? pts.slice(0, 256) : null);
      } else if (g.mode !== 'eyedropper') {
        const live = g.layer && model.layers.find(l => l.id === g.layer!.id);
        if (g.mode === 'draw' && g.draft && live && !live.locked && !live.hidden && live.x === g.layer!.x && live.y === g.layer!.y) {
          model.put(g.draft);
        }
        if (g.mode === 'move' && g.layer && live && live === g.original && (live.x !== g.layer.x || live.y !== g.layer.y)) {
          model.updateLayer(g.layer);
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
        }
      }
    } catch (error) {
      onError(error);
    }
    gesture.current = null;
    setDraft(null);
    setSelectionDraft(null);
    setMoving(null);
    setResizing(null);
    if (root.current?.hasPointerCapture(event.pointerId)) root.current.releasePointerCapture(event.pointerId);
    publish({
      ...worldPoint(screenPoint(event)),
      tool: spaceHeld ? 'pointer' : altHeld ? 'eyedropper' : settings.tool,
      width: boardBrushWidth(settings.width),
      color: settings.color,
    }, screenPoint(event), true);
  };

  const selectedLayer = model.layers.find(l => l.id === selected && !l.hidden);
  const bounds = resizing && selectedLayer && resizing.id === selectedLayer.id
    ? resizing.bounds
    : selectedLayer
      ? boardLayerBounds(model.shapes, moving ?? selectedLayer)
      : null;

  const cursorGlyph = (id: string, c: Cursor, own = false) => (
    <StreamPointerGlyph
      key={id}
      name={own ? '' : participantName(id)}
      color={c.color}
      interpolate={!own}
      shape={
        c.tool === 'hand'
          ? 'hand'
          : c.tool === 'move'
            ? 'move'
            : c.tool === 'pointer' || c.tool === 'eyedropper' || c.tool === 'bucket' || c.tool === 'text' || c.tool.startsWith('select') || c.tool === 'lasso' || c.tool === 'wand'
              ? 'pointer'
              : 'brush'
      }
      diameter={c.width * viewport.zoom}
      style={{
        left: own ? cursorScreen?.x : c.x,
        top: own ? cursorScreen?.y : c.y,
        ...(!own ? { transform: `scale(${1 / viewport.zoom})`, transformOrigin: '0 0' } : {}),
      }}
    />
  );

  const imageHref = (hash: string) => model.imageUrl(hash);
  const activeSelectionPoly = selectionDraft ?? selectionPolygon;

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
      <div
        className="whiteboard-raster-stage"
        aria-hidden="true"
        style={{
          transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
          width: boardWidth,
          height: boardHeight,
        }}
      >
        <canvas
          ref={rasterCanvasRef}
          width={boardWidth}
          height={boardHeight}
          className={`whiteboard-raster-canvas ${showGrid ? 'show-grid' : ''}`}
        />
      </div>

      <svg className="whiteboard-art" aria-hidden="true">
        <defs>
          <clipPath id={clipId}>
            <rect width={boardWidth} height={boardHeight} />
          </clipPath>
          <filter id="wb-filter-pencil" x="-10%" y="-10%" width="120%" height="120%">
            <feTurbulence type="fractalNoise" baseFrequency="0.75" numOctaves="3" result="grain" />
            <feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -0.58 1.18" in="grain" result="tooth" />
            <feComposite in="SourceGraphic" in2="tooth" operator="in" />
          </filter>
          <filter id="wb-filter-watercolor" x="-15%" y="-15%" width="130%" height="130%">
            <feTurbulence type="turbulence" baseFrequency="0.035" numOctaves="2" result="wash" />
            <feDisplacementMap in="SourceGraphic" in2="wash" scale="2.4" xChannelSelector="R" yChannelSelector="G" />
          </filter>
        </defs>
        <g transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.zoom})`}>
          <rect
            className="whiteboard-paper"
            width={boardWidth}
            height={boardHeight}
            fill={canvas2dActive ? 'none' : (transparent ? 'none' : backgroundColor)}
          />
          <g clipPath={`url(#${clipId})`}>
            <g className="whiteboard-svg-layers" opacity={canvas2dActive ? 0 : undefined}>
              {(() => {
                const visibleLayers = model.layers.filter(l => !l.hidden);
                let currentBaseLayerId: string | null = null;
                let currentBaseView: BoardLayer | null = null;
                let currentBaseShapes: BoardShape[] = [];
                return visibleLayers.map((layer, idx) => {
                  const view = resizing?.id === layer.id ? resizing.layer : moving?.id === layer.id ? moving : layer;
                  const shapes = resizing?.id === layer.id ? resizing.shapes : model.shapes.filter(s => (s.layerId ?? DEFAULT_BOARD_LAYER) === layer.id);
                  const drafts = [...model.cursors]
                    .filter(([id, c]) => id !== actor && c.draft && (c.draft.layerId ?? DEFAULT_BOARD_LAYER) === layer.id && !shapes.some(s => s.id === c.draft!.id))
                    .map(([, c]) => c.draft!);
                  const allShapes = [...shapes, ...drafts, ...(draft?.layerId === layer.id ? [draft] : [])];
                  const layerOpacity = (view.opacity ?? 100) / 100;
                  const isClipped = Boolean(view.clipping) && currentBaseLayerId !== null && currentBaseView !== null;
                  if (!view.clipping) {
                    currentBaseLayerId = layer.id;
                    currentBaseView = view;
                    currentBaseShapes = allShapes;
                  }
                  const needsClipDef = !view.clipping && visibleLayers.slice(idx + 1).some(next => next.clipping);
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
                            <g transform={`translate(${view.x} ${view.y})`}>
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
                        transform={`translate(${view.x} ${view.y})`}
                        opacity={layerOpacity < 1 ? layerOpacity : undefined}
                        style={view.blendMode && view.blendMode !== 'normal' ? { mixBlendMode: view.blendMode } : undefined}
                      >
                        <WhiteboardLayerArt
                          shapes={allShapes}
                          imageHref={imageHref}
                          canvasWidth={boardWidth}
                          canvasHeight={boardHeight}
                          alphaLock={Boolean(view.alphaLock)}
                        />
                      </g>
                    </g>
                  );
                });
              })()}
            </g>

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
                      d="M 16 0 L 0 0 0 16"
                      fill="none"
                      stroke="rgba(100, 116, 139, 0.36)"
                      strokeWidth={1 / viewport.zoom}
                    />
                  </pattern>
                  {viewport.zoom >= 5 && (
                    <pattern
                      id={`${clipId}-grid-pixel`}
                      width={1}
                      height={1}
                      patternUnits="userSpaceOnUse"
                    >
                      <path
                        d="M 1 0 L 0 0 0 1"
                        fill="none"
                        stroke="rgba(148, 163, 184, 0.28)"
                        strokeWidth={0.75 / viewport.zoom}
                      />
                    </pattern>
                  )}
                </defs>
                {viewport.zoom >= 5 && (
                  <rect width={boardWidth} height={boardHeight} fill={`url(#${clipId}-grid-pixel)`} />
                )}
                <rect width={boardWidth} height={boardHeight} fill={`url(#${clipId}-grid-major)`} />
              </g>
            )}

            {!compact && settings.symmetry && settings.symmetry !== 'none' && (
              <g className="whiteboard-symmetry-guides">
                {(settings.symmetry === 'vertical' || settings.symmetry === 'quad' || settings.symmetry === 'radial') && (
                  <line
                    x1={boardWidth / 2}
                    y1={0}
                    x2={boardWidth / 2}
                    y2={boardHeight}
                    stroke="var(--accent-color)"
                    strokeWidth={1.25 / viewport.zoom}
                    strokeDasharray={`${6 / viewport.zoom} ${4 / viewport.zoom}`}
                  />
                )}
                {(settings.symmetry === 'horizontal' || settings.symmetry === 'quad' || settings.symmetry === 'radial') && (
                  <line
                    x1={0}
                    y1={boardHeight / 2}
                    x2={boardWidth}
                    y2={boardHeight / 2}
                    stroke="var(--accent-color)"
                    strokeWidth={1.25 / viewport.zoom}
                    strokeDasharray={`${6 / viewport.zoom} ${4 / viewport.zoom}`}
                  />
                )}
              </g>
            )}

            {!compact && activeSelectionPoly && activeSelectionPoly.length >= 2 && (
              <g className="whiteboard-selection-marquee">
                <polygon
                  points={activeSelectionPoly.map(p => `${p.x},${p.y}`).join(' ')}
                  fill="rgba(59, 130, 246, 0.08)"
                  fillRule="evenodd"
                  stroke="#ffffff"
                  strokeWidth={1.5 / viewport.zoom}
                />
                <polygon
                  className="whiteboard-marching-ants"
                  points={activeSelectionPoly.map(p => `${p.x},${p.y}`).join(' ')}
                  fill="none"
                  stroke="#2563eb"
                  strokeWidth={1.5 / viewport.zoom}
                  strokeDasharray={`${5 / viewport.zoom} ${5 / viewport.zoom}`}
                />
              </g>
            )}

            {!compact && !draft && bounds && (
              <g className="whiteboard-selection-box">
                <rect
                  x={bounds.x}
                  y={bounds.y}
                  width={bounds.width}
                  height={bounds.height}
                  fill="none"
                  stroke="var(--accent-color)"
                  strokeWidth={1.25 / viewport.zoom}
                  strokeDasharray={`${4 / viewport.zoom} ${3 / viewport.zoom}`}
                />
                {selectedLayer && !selectedLayer.locked && boardResizeHandles(bounds).map(item => (
                  <rect
                    key={item.handle}
                    data-resize-handle={item.handle}
                    x={item.x - 4.5 / viewport.zoom}
                    y={item.y - 4.5 / viewport.zoom}
                    width={9 / viewport.zoom}
                    height={9 / viewport.zoom}
                    rx={2 / viewport.zoom}
                    fill="#ffffff"
                    stroke="var(--accent-color)"
                    strokeWidth={1.5 / viewport.zoom}
                  />
                ))}
              </g>
            )}
          </g>
        </g>
      </svg>

      {!compact && textDraft && (
        <textarea
          autoComplete="off"
          autoFocus
          className="whiteboard-text-input"
          aria-label={t('whiteboard.text')}
          value={textDraft.value}
          style={{
            left: viewport.x + textDraft.x * viewport.zoom,
            top: viewport.y + textDraft.y * viewport.zoom,
            fontSize: Math.max(12, (settings.fontSize ?? 28) * viewport.zoom),
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
          className="whiteboard-remote-cursors"
          style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})` }}
        >
          {[...model.cursors].filter(([id]) => id !== actor).map(([id, c]) => cursorGlyph(id, c))}
        </div>
        {!compact && cursor && cursorGlyph(name, cursor, true)}
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
          <span className="whiteboard-navigation-hint">{Math.round(viewport.zoom * 100)}%</span>
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
            onClick={() => setShowGrid(v => !v)}
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
