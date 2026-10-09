import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type RefObject } from 'react';
import { moveOrderedItem } from '../core/ordered_items';
import { placeCardAtPoint, resizeCardScale, type CardLayout, type CardResizeEdge } from '../core/room_card_layout';

interface Options {
  mode: 'grid' | 'spotlight';
  ids: string[];
  layout: CardLayout;
  sizes: Record<string, number>;
  rootRef: RefObject<HTMLDivElement | null>;
  surfaceRef: RefObject<HTMLDivElement | null>;
  onOrder: (ids: string[], rows?: string[][]) => void;
  onResize: (id: string, size: number) => void;
}

interface Gesture {
  id: string; pointerId: number; edge?: CardResizeEdge; active: boolean;
  startX: number; startY: number; x: number; y: number; rect: DOMRect;
  size: number; initial: string[]; targets: CardLayout;
  trayTargets: Array<{ id: string; center: number }>;
  order: string[]; rows?: string[][];
}

/** Keep one keyed card alive while its empty destination participates in the draft layout. */
export function useRoomCardGestures(options: Options) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const nodes = useRef(new Map<string, HTMLDivElement>());
  const callbacks = useRef(new Map<string, (node: HTMLDivElement | null) => void>());
  const pending = useRef<Gesture | null>(null);
  const suppressClick = useRef<{ id: string; until: number } | null>(null);
  const [draft, setDraft] = useState<Gesture | null>(null);
  const cardRef = (id: string) => {
    let callback = callbacks.current.get(id);
    if (!callback) {
      callback = node => { if (node) nodes.current.set(id, node); else nodes.current.delete(id); };
      callbacks.current.set(id, callback);
    }
    return callback;
  };
  const finish = (cancel: boolean) => {
    const gesture = pending.current;
    if (!gesture) return;
    pending.current = null;
    const current = optionsRef.current;
    if (gesture.active) {
      suppressClick.current = { id: gesture.id, until: Date.now() + 350 };
      if (gesture.edge) {
        if (cancel) current.onResize(gesture.id, gesture.size);
      } else if (!cancel) current.onOrder(gesture.order, gesture.rows);
      nodes.current.get(gesture.id)?.focus({ preventScroll: true });
    }
    if (current.rootRef.current?.hasPointerCapture?.(gesture.pointerId)) current.rootRef.current.releasePointerCapture(gesture.pointerId);
    setDraft(null);
  };
  const update = (event: globalThis.PointerEvent) => {
    const gesture = pending.current;
    const current = optionsRef.current;
    if (!gesture || event.pointerId !== gesture.pointerId || !current.surfaceRef.current) return;
    gesture.x = event.clientX; gesture.y = event.clientY;
    if (!gesture.active && Math.hypot(gesture.x - gesture.startX, gesture.y - gesture.startY) < 5) return;
    if (!gesture.active) {
      gesture.active = true;
      current.rootRef.current?.setPointerCapture?.(gesture.pointerId);
    }
    event.preventDefault();
    if (gesture.edge) {
      current.onResize(gesture.id, resizeCardScale(gesture.size, gesture.rect.width, gesture.rect.height,
        gesture.edge, gesture.x - gesture.startX, gesture.y - gesture.startY));
    } else {
      const bounds = current.surfaceRef.current.getBoundingClientRect();
      if (current.mode === 'grid') {
        gesture.rows = placeCardAtPoint(gesture.targets, gesture.id, gesture.x - bounds.left, gesture.y - bounds.top);
        gesture.order = gesture.rows.flat();
      } else {
        const x = gesture.x - bounds.left + current.surfaceRef.current.scrollLeft;
        let nearest = gesture.id; let distance = Infinity;
        for (const target of gesture.trayTargets) {
          if (Math.abs(x - target.center) < distance) { distance = Math.abs(x - target.center); nearest = target.id; }
        }
        gesture.order = moveOrderedItem(gesture.initial, gesture.id, gesture.initial.indexOf(nearest));
      }
    }
    setDraft({ ...gesture });
  };
  const updateRef = useRef(update);
  const finishRef = useRef(finish);
  updateRef.current = update; finishRef.current = finish;
  useEffect(() => {
    const move = (event: globalThis.PointerEvent) => updateRef.current(event);
    const up = (event: globalThis.PointerEvent) => {
      if (event.pointerId !== pending.current?.pointerId) return;
      if (pending.current.active) updateRef.current(event);
      finishRef.current(false);
    };
    const cancel = () => finishRef.current(true);
    const escape = (event: globalThis.KeyboardEvent) => {
      if (pending.current && event.key === 'Escape') { event.preventDefault(); cancel(); }
    };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', escape);
    window.addEventListener('blur', cancel);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', escape);
      window.removeEventListener('blur', cancel);
      pending.current = null;
      callbacks.current.clear();
    };
  }, []);
  const membershipKey = JSON.stringify(options.ids);
  useEffect(() => { finishRef.current(true); }, [options.mode, membershipKey]);
  const activeId = draft?.active && !draft.edge ? draft.id : null;
  useEffect(() => {
    if (!activeId) return;
    let frame = 0;
    const tick = () => {
      const gesture = pending.current;
      const current = optionsRef.current;
      const surface = current.surfaceRef.current;
      const host = current.mode === 'grid' ? surface?.parentElement : surface;
      if (gesture?.active && host) {
        const bounds = host.getBoundingClientRect();
        const speed = (position: number, start: number, end: number) => position < start + 40 ? -Math.min(12, (start + 40 - position) / 4)
          : position > end - 40 ? Math.min(12, (position - end + 40) / 4) : 0;
        const before = current.mode === 'grid' ? host.scrollTop : host.scrollLeft;
        if (current.mode === 'grid') host.scrollTop += speed(gesture.y, bounds.top, bounds.bottom);
        else host.scrollLeft += speed(gesture.x, bounds.left, bounds.right);
        if (before !== (current.mode === 'grid' ? host.scrollTop : host.scrollLeft)) updateRef.current({ pointerId: gesture.pointerId,
          clientX: gesture.x, clientY: gesture.y, preventDefault() {} } as globalThis.PointerEvent);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [activeId]);
  const identity = (target: EventTarget | null) => target instanceof Element
    ? target.closest<HTMLElement>('[data-sortable-id], [data-room-layout-id]')?.dataset : undefined;
  const onPointerDownCapture = (event: ReactPointerEvent<HTMLDivElement>) => {
    suppressClick.current = null;
    if (event.button !== 0 || event.shiftKey || pending.current || !(event.target instanceof Element)) return;
    const data = identity(event.target);
    const id = data?.sortableId || data?.roomLayoutId;
    const node = id && nodes.current.get(id);
    if (!id || !node) return;
    const edge = event.target.closest<HTMLElement>('[data-room-resize]')?.dataset.roomResize as CardResizeEdge | undefined;
    if (!edge && (event.target.closest('.is-stream-pointer-active, .stream-overlay') ||
      event.target.closest('button:not(.room-app-focus-overlay), input, textarea, a, [role="button"], [role="slider"], [contenteditable="true"], .stream-zoom-bar'))) return;
    if (edge && options.mode !== 'grid' || !edge && options.ids.length < 2) return;
    event.preventDefault();
    const bounds = options.surfaceRef.current?.getBoundingClientRect();
    const gesture: Gesture = { id, pointerId: event.pointerId, edge, active: !!edge,
      startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY,
      rect: node.getBoundingClientRect(), size: options.sizes[id] ?? 1, initial: [...options.ids], targets: options.layout,
      trayTargets: options.ids.map(key => {
        const rect = nodes.current.get(key)?.getBoundingClientRect();
        return { id: key, center: rect ? rect.left + rect.width / 2 - (bounds?.left ?? 0) + (options.surfaceRef.current?.scrollLeft ?? 0) : 0 };
      }), order: [...options.ids] };
    pending.current = gesture;
    if (edge) { options.rootRef.current?.setPointerCapture?.(event.pointerId); setDraft({ ...gesture }); }
  };
  const onKeyDownCapture = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!event.altKey || event.ctrlKey || event.metaKey || pending.current || !(event.target instanceof Element) ||
      event.target.closest('input, textarea, [contenteditable="true"]')) return;
    const data = identity(event.target); const id = data?.sortableId || data?.roomLayoutId;
    if (!id) return;
    const offset = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[event.key];
    if (offset === undefined) return;
    event.preventDefault(); event.stopPropagation();
    if (event.shiftKey && options.mode === 'grid') options.onResize(id, Math.max(.4, Math.min(2.5, (options.sizes[id] ?? 1) + offset * .1)));
    else options.onOrder(moveOrderedItem(options.ids, id, options.ids.indexOf(id) + offset));
  };
  const floatingStyle = (): CSSProperties | undefined => {
    if (!draft || draft.edge || !options.surfaceRef.current) return;
    const bounds = options.surfaceRef.current.getBoundingClientRect();
    return { position: 'absolute', left: draft.rect.left + draft.x - draft.startX - bounds.left + options.surfaceRef.current.scrollLeft,
      top: draft.rect.top + draft.y - draft.startY - bounds.top + options.surfaceRef.current.scrollTop,
      width: draft.rect.width, height: draft.rect.height };
  };
  return { cardRef, draft, draggingId: draft && !draft.edge ? draft.id : null, floatingStyle,
    rootProps: { onPointerDownCapture, onKeyDownCapture,
      onClickCapture: (event: ReactMouseEvent<HTMLDivElement>) => {
        const suppression = suppressClick.current;
        const data = identity(event.target);
        if (suppression && Date.now() <= suppression.until &&
          ((data?.sortableId || data?.roomLayoutId) === suppression.id || event.target === event.currentTarget)) {
          suppressClick.current = null; event.preventDefault(); event.stopPropagation();
        }
      },
      onLostPointerCapture: (event: ReactPointerEvent<HTMLDivElement>) => { if (event.pointerId === pending.current?.pointerId) finish(true); },
      onContextMenuCapture: () => finish(true),
      onDragStartCapture: (event: React.DragEvent<HTMLDivElement>) => { if (pending.current) event.preventDefault(); },
    } };
}
