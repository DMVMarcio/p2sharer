import { useRef, type KeyboardEvent, type PointerEvent } from 'react';

interface Props {
  axis: 'width' | 'height';
  label: string;
  controls: string;
  size: number;
  minimum: number;
  maximum: number;
  change: (value: number) => void;
}

/** Panels anchored to the right/bottom grow against pointer movement. */
export function PanelResizeHandle({ axis, label, controls, size, minimum, maximum, change }: Props) {
  const gesture = useRef<{ pointer: number; origin: number; size: number } | null>(null);
  const coordinate = (event: PointerEvent) => axis === 'width' ? event.clientX : event.clientY;
  const finish = (event: PointerEvent, cancel = false) => {
    if (gesture.current?.pointer !== event.pointerId) return;
    if (cancel) change(gesture.current.size);
    gesture.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const key = (event: KeyboardEvent) => {
    const increase = axis === 'width' ? 'ArrowLeft' : 'ArrowUp';
    const decrease = axis === 'width' ? 'ArrowRight' : 'ArrowDown';
    const next = event.key === increase ? size + (event.shiftKey ? 50 : 10)
      : event.key === decrease ? size - (event.shiftKey ? 50 : 10)
      : event.key === 'Home' ? minimum : event.key === 'End' ? maximum : null;
    if (next === null) return;
    event.preventDefault(); event.stopPropagation(); change(next);
  };
  return <div className={`panel-resize-handle panel-resize-${axis}`} role="separator" tabIndex={0}
    aria-label={label} aria-controls={controls} aria-orientation={axis === 'width' ? 'vertical' : 'horizontal'}
    aria-valuemin={minimum} aria-valuemax={maximum} aria-valuenow={size} onKeyDown={key}
    onPointerDown={(event) => {
      if (event.button !== 0) return;
      event.preventDefault(); event.stopPropagation(); event.currentTarget.focus();
      gesture.current = { pointer: event.pointerId, origin: coordinate(event), size };
      event.currentTarget.setPointerCapture(event.pointerId);
    }} onPointerMove={(event) => {
      const current = gesture.current;
      if (current?.pointer !== event.pointerId) return;
      change(current.size + current.origin - coordinate(event));
    }} onPointerUp={(event) => finish(event)} onPointerCancel={(event) => finish(event, true)}
    onLostPointerCapture={() => { gesture.current = null; }} />;
}
