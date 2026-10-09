import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type KeyboardEvent } from 'react';
import { moveOrderedItem } from '../core/ordered_items.ts';

interface Drag {
  id: string; pointerId: number; initial: string[]; x: number; y: number;
  offsetX: number; offsetY: number; handle: HTMLButtonElement;
}

// Pointer and keyboard sorting share one draft; only a completed gesture is persisted.
export function useSortableGrid(ids: string[], onCommit: (ids: string[]) => boolean | void) {
  const gridRef = useRef<HTMLDivElement>(null);
  const cardElements = useRef(new Map<string, HTMLElement>());
  const cardCallbacks = useRef(new Map<string, (element: HTMLElement | null) => void>());
  const cardRef = (id: string) => {
    let callback = cardCallbacks.current.get(id);
    if (!callback) {
      callback = element => {
        if (element) cardElements.current.set(id, element);
        else { cardElements.current.delete(id); cardCallbacks.current.delete(id); }
      };
      cardCallbacks.current.set(id, callback);
    }
    return callback;
  };
  const [order, setOrder] = useState(ids);
  const orderRef = useRef(order);
  const commitRef = useRef(onCommit);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const previousRects = useRef(new Map<string, DOMRect>());
  const animations = useRef(new Map<HTMLElement, Animation>());
  const idsKey = JSON.stringify(ids);
  commitRef.current = onCommit;

  const cards = () => orderRef.current.map(id => cardElements.current.get(id))
    .filter((element): element is HTMLElement => Boolean(element));
  const measure = () => {
    previousRects.current = new Map(cards().map((node) => [node.dataset.sortableId!, node.getBoundingClientRect()]));
  };
  const changeOrder = (next: string[]) => {
    if (next === orderRef.current) return;
    measure();
    orderRef.current = next;
    setOrder(next);
  };
  const layoutRect = (node: HTMLElement) => {
    const grid = gridRef.current!;
    const bounds = grid.getBoundingClientRect();
    return { left: bounds.left + grid.clientLeft + node.offsetLeft - grid.scrollLeft,
      top: bounds.top + grid.clientTop + node.offsetTop - grid.scrollTop,
      width: node.offsetWidth, height: node.offsetHeight };
  };
  const paintDrag = () => {
    const drag = dragRef.current;
    const node = cards().find((entry) => entry.dataset.sortableId === drag?.id);
    if (!drag || !node) return;
    const rect = layoutRect(node);
    node.style.transform = `translate3d(${drag.x - drag.offsetX - rect.left}px, ${drag.y - drag.offsetY - rect.top}px, 0)`;
  };
  const finish = (cancel: boolean) => {
    const drag = dragRef.current;
    if (!drag) return;
    measure();
    dragRef.current = null;
    if (drag.handle.hasPointerCapture?.(drag.pointerId)) drag.handle.releasePointerCapture(drag.pointerId);
    setDraggingId(null);
    if (cancel) changeOrder(drag.initial);
    else if (JSON.stringify(orderRef.current) !== JSON.stringify(drag.initial) &&
      commitRef.current(orderRef.current) === false) changeOrder(drag.initial);
    drag.handle.focus({ preventScroll: true });
  };

  useLayoutEffect(() => {
    if (JSON.stringify(orderRef.current) === idsKey) return;
    if (dragRef.current) finish(true);
    changeOrder(ids);
  }, [idsKey]);

  useLayoutEffect(() => {
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const transition = getComputedStyle(gridRef.current || document.documentElement).getPropertyValue('--transition-normal').trim();
    const duration = reducedMotion ? 0 : parseFloat(transition) * 1000;
    const easing = transition.slice(transition.indexOf(' ') + 1);
    for (const node of cards()) {
      const previous = previousRects.current.get(node.dataset.sortableId!);
      const rect = layoutRect(node);
      animations.current.get(node)?.cancel();
      animations.current.delete(node);
      if (node.dataset.sortableId === dragRef.current?.id) continue;
      node.style.transform = '';
      if (previous && duration && node.animate && (previous.left !== rect.left || previous.top !== rect.top)) {
        const animation = node.animate([
          { transform: `translate(${previous.left - rect.left}px, ${previous.top - rect.top}px)` },
          { transform: 'translate(0, 0)' },
        ], { duration, easing });
        animations.current.set(node, animation);
        animation.onfinish = () => animations.current.delete(node);
      }
    }
    paintDrag();
    previousRects.current.clear();
  }, [order, draggingId]);

  useEffect(() => {
    let frame = 0;
    const move = (event: globalThis.PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      drag.x = event.clientX;
      drag.y = event.clientY;
    };
    const tick = () => {
      const drag = dragRef.current;
      if (drag && gridRef.current) {
        let scrollHost: HTMLElement | null = gridRef.current.parentElement;
        while (scrollHost && !/auto|scroll/.test(getComputedStyle(scrollHost).overflowY)) scrollHost = scrollHost.parentElement;
        if (scrollHost) {
          const rect = scrollHost.getBoundingClientRect();
          const edge = 48;
          const speed = drag.y < rect.top + edge ? -Math.min(12, (rect.top + edge - drag.y) / 4)
            : drag.y > rect.bottom - edge ? Math.min(12, (drag.y - rect.bottom + edge) / 4) : 0;
          if (speed) scrollHost.scrollTop += speed;
        }
        const nodes = cards();
        const active = nodes.find((node) => node.dataset.sortableId === drag.id);
        if (active) {
          const x = drag.x - drag.offsetX + active.offsetWidth / 2;
          const y = drag.y - drag.offsetY + active.offsetHeight / 2;
          let closest = drag.id;
          let distance = Infinity;
          for (const node of nodes) {
            const rect = layoutRect(node);
            const next = (x - rect.left - rect.width / 2) ** 2 + (y - rect.top - rect.height / 2) ** 2;
            if (next < distance) { distance = next; closest = node.dataset.sortableId!; }
          }
          changeOrder(moveOrderedItem(orderRef.current, drag.id, orderRef.current.indexOf(closest)));
        }
        paintDrag();
      }
      frame = requestAnimationFrame(tick);
    };
    const up = (event: globalThis.PointerEvent) => {
      if (event.pointerId === dragRef.current?.pointerId) finish(false);
    };
    const cancel = () => finish(true);
    const escape = (event: globalThis.KeyboardEvent) => {
      if (dragRef.current && event.key === 'Escape') { event.preventDefault(); finish(true); }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('blur', cancel);
    window.addEventListener('keydown', escape);
    if (draggingId) frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('keydown', escape);
    };
  }, [draggingId]);

  useEffect(() => () => { animations.current.forEach((animation) => animation.cancel()); }, []);

  const handleProps = (id: string) => ({
    onPointerDown: (event: PointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0 || orderRef.current.length < 2) return;
      event.preventDefault();
      const node = cardElements.current.get(id);
      if (!node) return;
      measure();
      animations.current.get(node)?.cancel();
      const rect = node.getBoundingClientRect();
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = { id, pointerId: event.pointerId, initial: [...orderRef.current],
        x: event.clientX, y: event.clientY, offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top, handle: event.currentTarget };
      setDraggingId(id);
    },
    onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => {
      if (dragRef.current || event.altKey || event.ctrlKey || event.metaKey) return;
      const nodes = cards();
      const columns = nodes.filter((node) => node.offsetTop === nodes[0]?.offsetTop).length || 1;
      const index = orderRef.current.indexOf(id);
      const offsets: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns };
      const target = event.key === 'Home' ? 0 : event.key === 'End' ? orderRef.current.length - 1
        : offsets[event.key] !== undefined ? index + offsets[event.key] : undefined;
      if (target === undefined) return;
      event.preventDefault();
      const next = moveOrderedItem(orderRef.current, id, target);
      if (next !== orderRef.current && commitRef.current(next) !== false) changeOrder(next);
    },
  });
  return { gridRef, cardRef, order, draggingId, handleProps };
}
