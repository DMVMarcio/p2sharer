import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import { emitTo, listen } from '@tauri-apps/api/event';
import { STREAM_DRAWING_MAX_POINTS, streamPointerPosition, validStreamPointerState, type StreamDrawing, type StreamPointerState, type StreamPointerPacket } from '../core/stream_pointer';
import { roomService } from '../services/room_service';
import { streamPointerView, type StreamPointerScene } from '../services/stream_pointer_view';
import { StreamDrawingToolbar, type DrawingSettings } from '../components/room/StreamDrawingToolbar';
import { StreamPointerVideoLayer } from '../components/room/StreamPointerVideoLayer';

let activePointerSurface: HTMLElement | null = null;

export function useStreamPointer(container: RefObject<HTMLDivElement | null>,
  video: RefObject<HTMLVideoElement | null>, peerId: string, available: boolean, stream: MediaStream | null | undefined,
  pip = false, displayAvailable = available) {
  const [enabled, setEnabled] = useState(false);
  const [indicator, setIndicator] = useState<{ x: number; y: number } | null>(null);
  const [settings, setSettings] = useState<DrawingSettings>({ tool: null, color: '#ef4444', size: 3 });
  const [draft, setDraft] = useState<StreamDrawing | null>(null);
  const [textDraft, setTextDraft] = useState<StreamDrawing | null>(null);
  const editingText = useRef(false);
  const scene = useSyncExternalStore(streamPointerView.subscribe, () => streamPointerView.get(peerId));
  const drawingAllowed = scene.drawingAllowed !== false;
  const history = scene.history?.find(entry => entry.peerId === scene.localPeerId);
  const config = useRef({ settings, drawingAllowed, history });
  config.current = { settings, drawingAllowed, history };
  const transmit = (packet: StreamPointerPacket) => {
    if (pip) void emitTo('main', 'stream-pointer-send', { peerId, packet }).catch(console.warn);
    else roomService.sendStreamPointer(packet, peerId);
  };
  const lastSent = useRef(0);
  useEffect(() => { setEnabled(false); setSettings(s => ({ ...s, tool: null })); setDraft(null); setTextDraft(null); editingText.current = false; }, [peerId, stream, available]);
  useEffect(() => {
    if (!enabled || !drawingAllowed) { editingText.current = false; setTextDraft(null); }
  }, [enabled, drawingAllowed]);
  const confirmText = (drawing: StreamDrawing) => {
    if (!editingText.current) return;
    editingText.current = false;
    setTextDraft(null);
    if (enabled && config.current.drawingAllowed && drawing.text?.trim()) transmit({ kind: 'draw', id: crypto.randomUUID(), drawing });
  };
  useEffect(() => {
    if (!displayAvailable) return;
    if (!pip) { roomService.refreshStreamPointerView(peerId); return; }
    let disposed = false;
    const subscription = listen<{ peerId: string; snapshot: StreamPointerState; identity: Omit<StreamPointerScene, 'visuals'> }>('stream-pointer-view', ({ payload }) => {
      if (!disposed && payload?.peerId === peerId && validStreamPointerState(payload.snapshot)) streamPointerView.set(peerId, payload.snapshot, payload.identity);
    });
    void subscription.then(() => {
      if (!disposed) return emitTo('main', 'stream-pointer-ready', { peerId });
    }).catch(console.warn);
    return () => { disposed = true; void subscription.then((unlisten) => unlisten()); };
  }, [peerId, displayAvailable, pip]);

  useEffect(() => {
    const element = container.current;
    if (!enabled || !available || !element) { setIndicator(null); return; }
    const hadTabIndex = element.hasAttribute('tabindex');
    if (!hadTabIndex) element.tabIndex = -1;
    const focusSurface = () => { activePointerSurface = element; element.focus({ preventScroll: true }); };
    let point: { x: number; y: number } | null = null;
    const send = (packet: StreamPointerPacket) => {
      if (pip) void emitTo('main', 'stream-pointer-send', { peerId, packet }).catch(console.warn);
      else roomService.sendStreamPointer(packet, peerId);
    };
    let drawing: StreamDrawing | null = null;
    let drawingPointer: number | null = null;
    const cancel = () => {
      if (drawingPointer !== null && video.current?.hasPointerCapture(drawingPointer)) video.current.releasePointerCapture(drawingPointer);
      drawing = null; drawingPointer = null; setDraft(null);
    };
    const leave = () => { if (point) send({ kind: 'leave' }); point = null; setIndicator(null); video.current?.classList.remove('stream-pointer-active-cursor'); };
    const move = (event: PointerEvent) => {
      if (event.target === video.current) activePointerSurface = element;
      if (drawing && event.pointerId === drawingPointer) {
        if (!config.current.drawingAllowed) { cancel(); return; }
        const v = video.current;
        const p = v && streamPointerPosition(v.getBoundingClientRect(), v.videoWidth, v.videoHeight, event.clientX, event.clientY);
        if (p) {
          if (drawing.tool === 'brush') {
            if (drawing.points.length >= STREAM_DRAWING_MAX_POINTS) drawing.points = drawing.points.filter((_, i) => i % 2 === 0);
            drawing.points.push(p);
          } else drawing.points = [drawing.points[0], p];
          setDraft({ ...drawing, points: [...drawing.points] });
        }
      }
      const v = video.current;
      if (!v || event.target !== v || document.hidden) { leave(); return; }
      const nextPoint = streamPointerPosition(v.getBoundingClientRect(), v.videoWidth, v.videoHeight, event.clientX, event.clientY);
      if (!nextPoint) { leave(); return; }
      point = nextPoint;
      v.classList.add('stream-pointer-active-cursor');
      const bounds = element.getBoundingClientRect();
      setIndicator({ x: event.clientX - bounds.left, y: event.clientY - bounds.top });
      if (Date.now() - lastSent.current >= 40) { send({ kind: 'move', ...point }); lastSent.current = Date.now(); }
    };
    const click = (event: MouseEvent) => {
      if (event.target !== video.current) return;
      event.preventDefault(); event.stopPropagation();
      const v = video.current;
      const position = v && streamPointerPosition(v.getBoundingClientRect(), v.videoWidth, v.videoHeight, event.clientX, event.clientY);
      if (!config.current.settings.tool && position && event.button === 0) send({ kind: 'ping', ...position });
    };
    // Pointing owns primary clicks; it never forwards native input or starts a pan drag.
    const down = (event: MouseEvent) => { if (event.target === video.current && event.button === 0) { if (!editingText.current) focusSurface(); event.stopPropagation(); } };
    const drawDown = (event: PointerEvent) => {
      const v = video.current;
      const { settings: options, drawingAllowed } = config.current;
      if (!v || event.target !== v || event.button !== 0 || !options.tool || !drawingAllowed) return;
      const position = streamPointerPosition(v.getBoundingClientRect(), v.videoWidth, v.videoHeight, event.clientX, event.clientY);
      if (!position) return;
      if (editingText.current) {
        event.preventDefault(); event.stopPropagation();
        element.querySelector<HTMLTextAreaElement>('.stream-drawing-text-editor')?.focus({ preventScroll: true });
        focusSurface(); return;
      }
      event.preventDefault(); event.stopPropagation(); focusSurface();
      const next: StreamDrawing = { tool: options.tool, color: options.color, size: options.size, points: [position] };
      if (options.tool === 'text') { editingText.current = true; setTextDraft(next); return; }
      drawing = next; drawingPointer = event.pointerId;
      v.setPointerCapture(event.pointerId); setDraft(next);
    };
    const drawUp = (event: PointerEvent) => {
      if (!drawing || event.pointerId !== drawingPointer) return;
      move(event);
      if (drawing && config.current.drawingAllowed) send({ kind: 'draw', id: crypto.randomUUID(), drawing });
      cancel();
    };
    const key = (event: KeyboardEvent) => {
      const focused = document.activeElement;
      if (!event.ctrlKey || event.altKey || event.metaKey || !config.current.drawingAllowed ||
        document.querySelector('[role="dialog"]:not([inert]), [role="menu"]:not([inert])') ||
        focused instanceof Element && focused.closest('input, textarea, [contenteditable="true"], [role="textbox"]')) return;
      if (!element.contains(focused) && activePointerSurface !== element) return;
      const direction = event.key.toLowerCase() === 'y' || event.key.toLowerCase() === 'z' && event.shiftKey ? 'redo'
        : event.key.toLowerCase() === 'z' ? 'undo' : null;
      if (!direction) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if ((config.current.history?.[direction] ?? 0) > 0) send({ kind: direction });
    };
    const activate = () => { activePointerSurface = element; };
    const outsideText = (event: PointerEvent) => {
      if (!editingText.current || event.target === video.current ||
        event.target instanceof Element && event.target.closest('.stream-drawing-text-editor, [role="menu"]')) return;
      const editor = element.querySelector<HTMLTextAreaElement>('.stream-drawing-text-editor');
      editor?.focus({ preventScroll: true }); editor?.blur();
    };
    document.addEventListener('pointerdown', outsideText, true);
    element.addEventListener('focusin', activate);
    window.addEventListener('keydown', key);
    element.addEventListener('pointerdown', drawDown, true);
    element.addEventListener('pointerup', drawUp, true);
    element.addEventListener('pointercancel', cancel);
    element.addEventListener('lostpointercapture', cancel);
    const deactivate = () => { cancel(); leave(); };
    const heartbeat = setInterval(() => { if (point) send({ kind: 'move', ...point }); }, 800);
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerleave', leave);
    element.addEventListener('click', click, true);
    element.addEventListener('dblclick', down, true);
    element.addEventListener('mousedown', down, true);
    window.addEventListener('blur', deactivate);
    document.addEventListener('visibilitychange', deactivate);
    return () => {
      cancel();
      document.removeEventListener('pointerdown', outsideText, true);
      window.removeEventListener('keydown', key);
      element.removeEventListener('focusin', activate);
      if (activePointerSurface === element) activePointerSurface = null;
      if (!hadTabIndex) element.removeAttribute('tabindex');
      element.removeEventListener('pointerdown', drawDown, true);
      element.removeEventListener('pointerup', drawUp, true);
      element.removeEventListener('pointercancel', cancel);
      element.removeEventListener('lostpointercapture', cancel);
      leave(); clearInterval(heartbeat);
      element.removeEventListener('pointermove', move); element.removeEventListener('pointerleave', leave);
      element.removeEventListener('click', click, true); element.removeEventListener('dblclick', down, true);
      element.removeEventListener('mousedown', down, true);
      window.removeEventListener('blur', deactivate); document.removeEventListener('visibilitychange', deactivate);
    };
  }, [enabled, available, peerId, stream, pip, container, video]);
  return { enabled, toggle: () => setEnabled((value) => !value),
    toolbar: enabled && available && drawingAllowed ? <StreamDrawingToolbar settings={settings} onChange={setSettings} onClear={() => transmit({ kind: 'clear' })} onUndo={() => transmit({ kind: 'undo' })} onRedo={() => transmit({ kind: 'redo' })} canUndo={(history?.undo ?? 0) > 0} canRedo={(history?.redo ?? 0) > 0} /> : null,
    indicator: displayAvailable ? <StreamPointerVideoLayer container={container} video={video} peerId={peerId} local={enabled ? indicator : null} draft={drawingAllowed ? draft : null}
      textDraft={enabled && drawingAllowed ? textDraft : null} onTextConfirm={confirmText} /> : null };
}
