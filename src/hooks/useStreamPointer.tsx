import { useEffect, useRef, useState, type RefObject } from 'react';
import { emitTo, listen } from '@tauri-apps/api/event';
import { streamPointerPosition, validStreamPointerState, type StreamPointerState, type StreamPointerPacket } from '../core/stream_pointer';
import { roomService } from '../services/room_service';
import { streamPointerView, type StreamPointerScene } from '../services/stream_pointer_view';
import { StreamPointerVideoLayer } from '../components/room/StreamPointerVideoLayer';

export function useStreamPointer(container: RefObject<HTMLDivElement | null>,
  video: RefObject<HTMLVideoElement | null>, peerId: string, available: boolean, stream: MediaStream | null | undefined,
  pip = false, displayAvailable = available) {
  const [enabled, setEnabled] = useState(false);
  const [indicator, setIndicator] = useState<{ x: number; y: number } | null>(null);
  const lastSent = useRef(0);
  useEffect(() => { setEnabled(false); }, [peerId, stream, available]);
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
    let point: { x: number; y: number } | null = null;
    const send = (packet: StreamPointerPacket) => {
      if (pip) void emitTo('main', 'stream-pointer-send', { peerId, packet }).catch(console.warn);
      else roomService.sendStreamPointer(packet, peerId);
    };
    const leave = () => { if (point) send({ kind: 'leave' }); point = null; setIndicator(null); video.current?.classList.remove('stream-pointer-active-cursor'); };
    const move = (event: PointerEvent) => {
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
      if (position && event.button === 0) send({ kind: 'ping', ...position });
    };
    // Pointing owns primary clicks; it never forwards native input or starts a pan drag.
    const down = (event: MouseEvent) => { if (event.target === video.current && event.button === 0) event.stopPropagation(); };
    const heartbeat = setInterval(() => { if (point) send({ kind: 'move', ...point }); }, 800);
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerleave', leave);
    element.addEventListener('click', click, true);
    element.addEventListener('dblclick', down, true);
    element.addEventListener('mousedown', down, true);
    window.addEventListener('blur', leave);
    document.addEventListener('visibilitychange', leave);
    return () => {
      leave(); clearInterval(heartbeat);
      element.removeEventListener('pointermove', move); element.removeEventListener('pointerleave', leave);
      element.removeEventListener('click', click, true); element.removeEventListener('dblclick', down, true);
      element.removeEventListener('mousedown', down, true);
      window.removeEventListener('blur', leave); document.removeEventListener('visibilitychange', leave);
    };
  }, [enabled, available, peerId, stream, pip, container, video]);
  return { enabled, toggle: () => setEnabled((value) => !value),
    indicator: displayAvailable ? <StreamPointerVideoLayer container={container} video={video} peerId={peerId} local={enabled ? indicator : null} /> : null };
}
