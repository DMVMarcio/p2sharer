import { useEffect, useLayoutEffect, useId, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { StreamPointerGlyph } from '../components/room/StreamPointerGlyph';
import { WhiteboardLayerArt } from './WhiteboardLayerArt';
import { BOARD_MAX_POINTS, DEFAULT_BOARD_LAYER, boardBrushWidth, boardLayerBounds, hitBoardLayer, type BoardLayer, type BoardPoint, type BoardShape } from './whiteboard_scene';
import type { BoardCursor, WhiteboardModel } from './whiteboard_model';
import type { BoardSettings } from './WhiteboardToolbar';
import { t } from '../i18n';
import { BOARD_WIDTH, BOARD_HEIGHT, boardContains, clampBoardPoint, containBoardLayer, BrushStabilizer, type BoardViewport } from './whiteboard_interaction';
import { useWhiteboardViewport } from './useWhiteboardViewport';

type Cursor = Omit<BoardCursor, 'seenAt'>;
type Gesture = { pointer: number; start: BoardPoint; mode: 'pan' | 'move' | 'draw'; original?: BoardLayer; layer?: BoardLayer; draft?: BoardShape; viewport: BoardViewport; stabilizer?: BrushStabilizer };
export function WhiteboardCanvas({ model, activeLayer, settings, viewport, onViewport, selected, onSelect, compact, actor, name, participantName, onError }: {
  model: WhiteboardModel; activeLayer: string; settings: BoardSettings; viewport: BoardViewport; onViewport(viewport: BoardViewport): void;
  selected: string | null; onSelect(id: string | null): void; compact: boolean; actor: string; name: string;
  participantName(actor: string): string; onError(error: unknown): void;
}) {
  const root = useRef<HTMLDivElement>(null), clipId = useId();
  const navigation = useWhiteboardViewport(root, viewport, onViewport);
  const gesture = useRef<Gesture | null>(null);
  const [draft, setDraft] = useState<BoardShape | null>(null);
  const [moving, setMoving] = useState<BoardLayer | null>(null);
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const [cursorScreen, setCursorScreen] = useState<BoardPoint | null>(null);
  const physicalScreen = useRef<BoardPoint | null>(null);
  const current = useRef({ settings, compact }); current.current = { settings, compact };
  const lastSent = useRef(0), latestCursor = useRef<Cursor | null>(null);
  const screenPoint = (event: { clientX: number; clientY: number }): BoardPoint => {
    const bounds = root.current!.getBoundingClientRect(); return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  };
  const worldPoint = (p: BoardPoint): BoardPoint => {
    const view = navigation.current.current; return { x: (p.x - view.x) / view.zoom, y: (p.y - view.y) / view.zoom };
  };
  const publish = (value: Cursor | null, screen: BoardPoint | null = physicalScreen.current, force = false) => {
    latestCursor.current = value; setCursor(value); setCursorScreen(value ? screen : null);
    if (force || performance.now() - lastSent.current >= 40) { model.presence(value); lastSent.current = performance.now(); }
  };
  const leave = () => { physicalScreen.current = null; publish(null, null, true); };
  const cancel = () => { navigation.stop(); gesture.current = null; setDraft(null); setMoving(null); leave(); };
  useEffect(() => {
    const heartbeat = setInterval(() => { if (latestCursor.current) model.presence(latestCursor.current); }, 800);
    const blur = () => cancel(), visibility = () => { if (document.hidden) cancel(); };
    window.addEventListener('blur', blur); document.addEventListener('visibilitychange', visibility);
    return () => { clearInterval(heartbeat); model.presence(null); window.removeEventListener('blur', blur); document.removeEventListener('visibilitychange', visibility); };
  }, [model]);
  useEffect(() => { if (compact) cancel(); }, [compact]);
  const identity = model.identity?.id;
  useLayoutEffect(() => {
    let measured = false;
    const center = () => {
      const w = root.current?.clientWidth || 800, h = root.current?.clientHeight || 500;
      const zoom = compact ? Math.min(w / BOARD_WIDTH, h / BOARD_HEIGHT) : 1;
      navigation.set({ x: w / 2 - BOARD_WIDTH * zoom / 2, y: h / 2 - BOARD_HEIGHT * zoom / 2, zoom });
    };
    center();
    const observer = new ResizeObserver(() => {
      if (compact || !measured) center(); else navigation.set(navigation.current.current);
      measured = true;
    });
    if (root.current) observer.observe(root.current);
    return () => observer.disconnect();
  }, [model, identity, compact, onViewport]);
  useEffect(() => {
    const screen = physicalScreen.current;
    if (screen && !gesture.current && !compact) publish({ ...worldPoint(screen), tool: settings.tool, width: boardBrushWidth(settings.width), color: settings.color }, screen);
  }, [viewport.x, viewport.y, viewport.zoom, settings.tool, settings.width, settings.color, compact]);
  useEffect(() => {
    const element = root.current; if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (current.current.compact || gesture.current) return;
      event.preventDefault(); event.stopPropagation(); physicalScreen.current = screenPoint(event);
      const factor = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1;
      navigation.zoom(Math.max(-400, Math.min(400, event.deltaY * factor)), physicalScreen.current);
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [model, onViewport]);
  const update = (event: ReactPointerEvent<HTMLDivElement>, final = false) => {
    if (compact) return;
    const screen = screenPoint(event), g = gesture.current; physicalScreen.current = screen;
    let point = worldPoint(screen), drawing: BoardShape | undefined;
    if (g && g.pointer === event.pointerId) {
      if (g.mode === 'pan') {
        navigation.set({ ...g.viewport, x: g.viewport.x + screen.x - g.start.x, y: g.viewport.y + screen.y - g.start.y }); point = worldPoint(screen);
      } else if (g.mode === 'move' && g.original) {
        const layer = containBoardLayer({ ...g.original, x: g.original.x + point.x - g.start.x, y: g.original.y + point.y - g.start.y }, model.shapes);
        g.layer = layer; setMoving(layer);
      } else if (g.draft && g.layer) {
        point = clampBoardPoint(point);
        let local = { x: point.x - g.layer.x, y: point.y - g.layer.y };
        if (g.stabilizer && !final) local = g.stabilizer.sample(local, event.timeStamp, settings.smoothing);
        let points = g.draft.points;
        if (g.draft.tool === 'brush' || g.draft.tool === 'eraser') {
          if (Math.hypot(local.x - points[points.length - 1].x, local.y - points[points.length - 1].y) >= .5 / viewport.zoom) {
            if (points.length >= BOARD_MAX_POINTS) points = points.filter((_, index) => index % 2 === 0);
            points = [...points, local];
          }
        } else points = [points[0], local];
        drawing = { ...g.draft, points }; g.draft = drawing; setDraft(drawing);
        point = { x: local.x + g.layer.x, y: local.y + g.layer.y };
      }
    }
    const view = navigation.current.current;
    const display = g?.mode === 'draw' ? { x: point.x * view.zoom + view.x, y: point.y * view.zoom + view.y } : screen;
    publish({ ...point, tool: g?.mode === 'pan' ? 'hand' : g?.mode === 'move' ? 'move' : settings.tool,
      width: boardBrushWidth(settings.width), color: settings.color, ...(drawing ? { draft: drawing } : {}) }, display);
  };
  const down = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (compact || gesture.current || ![0, 1].includes(event.button)) return;
    event.preventDefault(); event.stopPropagation(); root.current?.focus();
    const screen = screenPoint(event), point = worldPoint(screen);
    const layer = model.layers.find(l => l.id === activeLayer);
    if (event.button === 0 && settings.tool !== 'pointer' && (!boardContains(point) || !layer || layer.locked || layer.hidden)) return;
    navigation.stop(); root.current?.setPointerCapture(event.pointerId);
    const hit = settings.tool === 'pointer' && event.button === 0 ? [...model.layers].reverse().find(l => hitBoardLayer(model.shapes, l, point, 5 / viewport.zoom)) : undefined;
    if (event.button === 1 || settings.tool === 'pointer' && !hit) {
      gesture.current = { pointer: event.pointerId, mode: 'pan', start: screen, viewport: navigation.current.current };
      if (event.button === 0) onSelect(null);
    } else if (hit) {
      onSelect(hit.id); gesture.current = { pointer: event.pointerId, mode: 'move', start: point, original: hit, layer: hit, viewport };
    } else if (settings.tool !== 'pointer' && layer) {
      onSelect(null);
      const local = { x: point.x - layer.x, y: point.y - layer.y };
      const shape: BoardShape = { id: crypto.randomUUID(), layerId: layer.id, tool: settings.tool,
        points: settings.tool === 'brush' || settings.tool === 'eraser' ? [local] : [local, local], color: settings.color,
        width: boardBrushWidth(settings.width), filled: settings.filled, smoothing: settings.smoothing, x: 0, y: 0,
        order: (model.shapes[model.shapes.length - 1]?.order ?? 0) + 1, hidden: false, locked: false };
      gesture.current = { pointer: event.pointerId, mode: 'draw', start: point, layer, draft: shape, viewport,
        stabilizer: ['brush', 'eraser'].includes(settings.tool) ? new BrushStabilizer(local, event.timeStamp) : undefined }; setDraft(shape);
    }
    update(event);
  };
  const up = (event: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current; if (!g || g.pointer !== event.pointerId) return;
    update(event, true);
    try {
      const live = g.layer && model.layers.find(l => l.id === g.layer!.id);
      if (g.mode === 'draw' && g.draft && live && !live.locked && !live.hidden && live.x === g.layer!.x && live.y === g.layer!.y) model.put(g.draft);
      if (g.mode === 'move' && g.layer && live && live === g.original && (live.x !== g.layer.x || live.y !== g.layer.y)) model.updateLayer(g.layer);
    } catch (error) { onError(error); }
    gesture.current = null; setDraft(null); setMoving(null);
    if (root.current?.hasPointerCapture(event.pointerId)) root.current.releasePointerCapture(event.pointerId);
    publish({ ...worldPoint(screenPoint(event)), tool: settings.tool, width: boardBrushWidth(settings.width), color: settings.color }, screenPoint(event), true);
  };
  const selectedLayer = model.layers.find(l => l.id === selected && !l.hidden);
  const bounds = selectedLayer ? boardLayerBounds(model.shapes, moving ?? selectedLayer) : null;
  const cursorGlyph = (id: string, c: Cursor, own = false) => <StreamPointerGlyph key={id} name={own ? '' : participantName(id)} color={c.color}
    interpolate={!own} shape={c.tool === 'hand' ? 'hand' : c.tool === 'move' ? 'move' : c.tool === 'pointer' ? 'pointer' : 'brush'} diameter={c.width * viewport.zoom}
    style={{ left: own ? cursorScreen?.x : c.x, top: own ? cursorScreen?.y : c.y,
      ...(!own ? { transform: `scale(${1 / viewport.zoom})`, transformOrigin: '0 0' } : {}) }} />;
  return <div ref={root} className={`whiteboard-canvas ${compact ? 'compact' : 'virtual-cursor'}`} tabIndex={compact ? -1 : 0}
    role="region" aria-label={t('whiteboard.scene')} aria-description={t('whiteboard.navigation')} onPointerDown={down} onPointerMove={event => update(event)} onPointerUp={up}
    onPointerCancel={cancel} onLostPointerCapture={() => { if (gesture.current) cancel(); }} onPointerLeave={() => { if (!gesture.current) leave(); }} onContextMenu={event => event.preventDefault()}>
    <svg className="whiteboard-art" aria-hidden="true"><defs><clipPath id={clipId}><rect width={BOARD_WIDTH} height={BOARD_HEIGHT} /></clipPath></defs>
      <g transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.zoom})`}>
        <rect className="whiteboard-paper" width={BOARD_WIDTH} height={BOARD_HEIGHT} fill="#ffffff" />
        <g clipPath={`url(#${clipId})`}>
          {model.layers.filter(l => !l.hidden).map(layer => {
            const view = moving?.id === layer.id ? moving : layer;
            const shapes = model.shapes.filter(s => (s.layerId ?? DEFAULT_BOARD_LAYER) === layer.id);
            const drafts = [...model.cursors].filter(([id, c]) => id !== actor && c.draft && (c.draft.layerId ?? DEFAULT_BOARD_LAYER) === layer.id && !shapes.some(s => s.id === c.draft!.id)).map(([, c]) => c.draft!);
            return <g key={layer.id} data-board-layer={layer.id} transform={`translate(${view.x} ${view.y})`}>
              <WhiteboardLayerArt shapes={[...shapes, ...drafts, ...(draft?.layerId === layer.id ? [draft] : [])]} />
            </g>;
          })}
          {!compact && !draft && !moving && bounds && <rect x={bounds.x - 5 / viewport.zoom} y={bounds.y - 5 / viewport.zoom} width={bounds.width + 10 / viewport.zoom} height={bounds.height + 10 / viewport.zoom}
            fill="none" stroke="var(--accent-color)" strokeWidth={1 / viewport.zoom} strokeDasharray={`${4 / viewport.zoom} ${3 / viewport.zoom}`} />}
        </g>
      </g>
    </svg>
    <div className="whiteboard-cursors" aria-hidden="true">
      <div className="whiteboard-remote-cursors" style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})` }}>
        {[...model.cursors].filter(([id]) => id !== actor).map(([id, c]) => cursorGlyph(id, c))}
      </div>
      {!compact && cursor && cursorGlyph(name, cursor, true)}</div>
    {!compact && <div className="whiteboard-navigation-hint">{Math.round(viewport.zoom * 100)}%</div>}
  </div>;
}
