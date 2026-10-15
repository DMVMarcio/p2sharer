import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { StreamPointerGlyph } from '../components/room/StreamPointerGlyph';
import { WhiteboardShape } from './WhiteboardShape';
import { BOARD_MAX_POINTS, boardCoordinate, hitBoardShape, shapeBounds, type BoardPoint, type BoardShape } from './whiteboard_scene';
import type { BoardCursor, WhiteboardModel } from './whiteboard_model';
import type { BoardSettings } from './WhiteboardToolbar';
import { t } from '../i18n';

export interface BoardViewport { x: number; y: number; zoom: number }
type Gesture = { pointer: number; start: BoardPoint; mode: 'pan' | 'move' | 'draw'; original?: BoardShape; draft?: BoardShape; viewport: BoardViewport };
export function WhiteboardCanvas({ model, settings, viewport, onViewport, selected, onSelect, compact, actor, name, participantName, onError, resetView }: {
  model: WhiteboardModel; settings: BoardSettings; viewport: BoardViewport; onViewport(viewport: BoardViewport): void;
  selected: string | null; onSelect(id: string | null): void; compact: boolean; actor: string; name: string;
  participantName(actor: string): string; onError(error: unknown): void;
  resetView: number;
}) {
  const root = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const framed = useRef(false);
  const [draft, setDraft] = useState<BoardShape | null>(null);
  const [cursor, setCursor] = useState<Omit<BoardCursor, 'seenAt'> | null>(null);
  const current = useRef({ viewport, settings, compact }); current.current = { viewport, settings, compact };
  const lastSent = useRef(0), latestCursor = useRef<typeof cursor>(null);
  const screenPoint = (event: { clientX: number; clientY: number }): BoardPoint => {
    const bounds = root.current!.getBoundingClientRect(); return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  };
  const worldPoint = (p: BoardPoint): BoardPoint => ({ x: (p.x - viewport.x) / viewport.zoom, y: (p.y - viewport.y) / viewport.zoom });
  const publish = (value: typeof cursor, force = false) => {
    latestCursor.current = value; setCursor(value);
    if (force || performance.now() - lastSent.current >= 40) { model.presence(value); lastSent.current = performance.now(); }
  };
  const cancel = () => { gesture.current = null; setDraft(null); publish(null, true); };
  useEffect(() => {
    const heartbeat = setInterval(() => { if (latestCursor.current) model.presence(latestCursor.current); }, 800);
    const blur = () => cancel();
    const visibility = () => { if (document.hidden) cancel(); };
    window.addEventListener('blur', blur); document.addEventListener('visibilitychange', visibility);
    return () => { clearInterval(heartbeat); model.presence(null); window.removeEventListener('blur', blur); document.removeEventListener('visibilitychange', visibility); };
  }, [model]);
  useEffect(() => { if (compact) cancel(); }, [compact]);
  const identity = model.identity?.id;
  useEffect(() => {
    const fit = () => {
      const shapes = model.shapes.filter(s => !s.hidden), element = root.current;
      if (!element) return;
      if (!shapes.length) { onViewport({ x: 60, y: 60, zoom: 1 }); return; }
      const boxes = shapes.map(shapeBounds), padding = 60;
      const left = Math.min(...boxes.map(b => b.x)), top = Math.min(...boxes.map(b => b.y));
      const width = Math.max(...boxes.map(b => b.x + b.width)) - left;
      const height = Math.max(...boxes.map(b => b.y + b.height)) - top;
      const w = element.clientWidth || 800, h = element.clientHeight || 500;
      const zoom = Math.max(.1, Math.min(1, (w - padding) / Math.max(1, width), (h - padding) / Math.max(1, height)));
      onViewport({ x: (w - width * zoom) / 2 - left * zoom, y: (h - height * zoom) / 2 - top * zoom, zoom });
      framed.current = true;
    };
    fit();
    const update = () => { if (compact || !framed.current) fit(); };
    model.document.on('update', update);
    const observer = new ResizeObserver(() => { if (compact) fit(); });
    if (root.current) observer.observe(root.current);
    return () => { observer.disconnect(); model.document.off('update', update); };
  }, [model, identity, resetView, compact, onViewport]);
  useEffect(() => {
    const previous = latestCursor.current;
    if (previous && !gesture.current) publish({ ...previous, tool: settings.tool, width: settings.width, color: settings.color }, true);
  }, [settings.tool, settings.width, settings.color]);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (current.current.compact || gesture.current) return;
      event.preventDefault(); event.stopPropagation();
      const previous = current.current.viewport, bounds = element.getBoundingClientRect();
      const factor = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1;
      let next: BoardViewport;
      if (event.ctrlKey || event.metaKey) {
        const zoom = Math.max(.1, Math.min(4, previous.zoom * Math.exp(-event.deltaY * factor * .002)));
        const x = event.clientX - bounds.left, y = event.clientY - bounds.top;
        next = { x: x - (x - previous.x) * zoom / previous.zoom, y: y - (y - previous.y) * zoom / previous.zoom, zoom };
      } else next = { ...previous, x: previous.x - (event.shiftKey ? event.deltaY : event.deltaX) * factor, y: previous.y - (event.shiftKey ? 0 : event.deltaY) * factor };
      onViewport(next); publish(null, true);
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [model, onViewport]);
  const update = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (compact) return;
    const screen = screenPoint(event), g = gesture.current;
    let point = worldPoint(screen);
    let drawing: BoardShape | undefined;
    if (g && g.pointer === event.pointerId) {
      if (g.mode === 'pan') {
        const next = { ...g.viewport, x: g.viewport.x + screen.x - g.start.x, y: g.viewport.y + screen.y - g.start.y };
        onViewport(next); point = { x: (screen.x - next.x) / next.zoom, y: (screen.y - next.y) / next.zoom };
      }
      else if (g.draft && g.mode === 'move' && g.original) {
        drawing = { ...g.original, x: g.original.x + point.x - g.start.x, y: g.original.y + point.y - g.start.y };
        if (!boardCoordinate(drawing.x) || !boardCoordinate(drawing.y)) return;
        g.draft = drawing; setDraft(drawing);
      } else if (g.draft) {
        if (!boardCoordinate(point.x) || !boardCoordinate(point.y)) return;
        let points = g.draft.points;
        if (g.draft.tool === 'brush') {
          if (Math.hypot(point.x - points[points.length - 1].x, point.y - points[points.length - 1].y) >= .5 / viewport.zoom) {
            if (points.length >= BOARD_MAX_POINTS) points = points.filter((_, index) => index % 2 === 0);
            points = [...points, point];
          }
        } else points = [points[0], point];
        drawing = { ...g.draft, points }; g.draft = drawing; setDraft(drawing);
      }
    }
    publish({ ...point, tool: g?.mode === 'pan' ? 'hand' : settings.tool, width: settings.width, color: settings.color,
      ...(drawing ? { draft: drawing } : {}) });
  };
  const down = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (compact || gesture.current || ![0, 1].includes(event.button)) return;
    event.preventDefault(); event.stopPropagation(); root.current?.focus();
    framed.current = true;
    const screen = screenPoint(event), point = worldPoint(screen);
    if (!boardCoordinate(point.x) || !boardCoordinate(point.y)) return;
    root.current?.setPointerCapture(event.pointerId);
    const hit = settings.tool === 'pointer' && event.button === 0 ? [...model.shapes].reverse().find(shape => hitBoardShape(shape, point, 5 / viewport.zoom)) : undefined;
    if (event.button === 1 || settings.tool === 'pointer' && !hit) {
      gesture.current = { pointer: event.pointerId, mode: 'pan', start: screen, viewport };
      if (event.button === 0) onSelect(null);
    } else if (hit) {
      onSelect(hit.id); gesture.current = { pointer: event.pointerId, mode: 'move', start: point, original: hit, draft: hit, viewport };
    } else if (settings.tool !== 'pointer') {
      const shape: BoardShape = { id: crypto.randomUUID(), tool: settings.tool, points: settings.tool === 'brush' ? [point] : [point, point],
        color: settings.color, width: settings.width, filled: settings.filled, x: 0, y: 0,
        order: (model.shapes[model.shapes.length - 1]?.order ?? 0) + 1, hidden: false, locked: false };
      gesture.current = { pointer: event.pointerId, mode: 'draw', start: point, draft: shape, viewport }; setDraft(shape); onSelect(shape.id);
    }
    update(event);
  };
  const up = (event: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || g.pointer !== event.pointerId) return;
    update(event);
    if (g.draft) {
      // A remote edit/deletion during a drag cancels this stale local move.
      const unchanged = !g.original || model.shapes.find(s => s.id === g.original!.id) === g.original;
      const moved = !g.original || g.draft.x !== g.original.x || g.draft.y !== g.original.y;
      if (unchanged && moved) try { model.put(g.draft); } catch (error) { onError(error); }
    }
    gesture.current = null; setDraft(null);
    if (root.current?.hasPointerCapture(event.pointerId)) root.current.releasePointerCapture(event.pointerId);
    publish({ ...worldPoint(screenPoint(event)), tool: settings.tool, width: settings.width, color: settings.color }, true);
  };
  const selection = draft?.id === selected ? draft : model.shapes.find(s => s.id === selected && !s.hidden);
  const bounds = selection ? shapeBounds(selection) : null;
  const cursorGlyph = (id: string, c: Omit<BoardCursor, 'seenAt'>, own = false) => <StreamPointerGlyph key={id}
    name={own ? '' : participantName(id)} color={c.color} interpolate={!own} shape={c.tool === 'hand' ? 'hand' : c.tool === 'pointer' ? 'pointer' : 'brush'}
    diameter={c.width * viewport.zoom} style={{ left: c.x * viewport.zoom + viewport.x, top: c.y * viewport.zoom + viewport.y }} />;
  return <div ref={root} className={`whiteboard-canvas ${compact ? 'compact' : 'virtual-cursor'}`} tabIndex={compact ? -1 : 0}
    role="region" aria-label={t('whiteboard.scene')} onPointerDown={down} onPointerMove={update} onPointerUp={up}
    onPointerCancel={cancel} onLostPointerCapture={() => { if (gesture.current) cancel(); }}
    onPointerLeave={() => { if (!gesture.current) publish(null, true); }} onContextMenu={event => event.preventDefault()}>
    <svg className="whiteboard-art" aria-hidden="true">
      <g transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.zoom})`}>
        {model.shapes.filter(shape => !shape.hidden && shape.id !== draft?.id).map(shape => <WhiteboardShape key={shape.id} shape={shape} />)}
        {draft && <WhiteboardShape shape={draft} />}
        {[...model.cursors].filter(([id, c]) => id !== actor && c.draft && !model.shapes.some(s => s.id === c.draft!.id)).map(([id, c]) => <g key={id} opacity={.65}><WhiteboardShape shape={c.draft!} /></g>)}
        {!compact && bounds && <rect x={bounds.x - 5 / viewport.zoom} y={bounds.y - 5 / viewport.zoom}
          width={bounds.width + 10 / viewport.zoom} height={bounds.height + 10 / viewport.zoom} fill="none" stroke="var(--accent-color)" strokeWidth={1 / viewport.zoom} strokeDasharray={`${4 / viewport.zoom} ${3 / viewport.zoom}`} />}
      </g>
    </svg>
    <div className="whiteboard-cursors" aria-hidden="true">
      {[...model.cursors].filter(([id]) => id !== actor).map(([id, c]) => cursorGlyph(id, c))}
      {!compact && cursor && cursorGlyph(name, cursor, true)}
    </div>
    {!compact && <div className="whiteboard-navigation-hint">{t('whiteboard.navigation')} · {Math.round(viewport.zoom * 100)}%</div>}
  </div>;
}
