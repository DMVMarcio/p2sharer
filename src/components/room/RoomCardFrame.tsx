import React, { useEffect, useRef } from 'react';
import { GripVertical, MoveDiagonal2 } from 'lucide-react';
import { TooltipButton } from '../common/TooltipButton';
import { t } from '../../i18n';

interface Props {
  id: string;
  cardRef: React.RefCallback<HTMLDivElement>;
  style?: React.CSSProperties;
  dragging: boolean;
  handleProps: React.ButtonHTMLAttributes<HTMLButtonElement>;
  size?: number;
  onResize?: (size: number) => void;
  children: React.ReactNode;
}

/** Layout gestures stay on dedicated handles so video controls and app editors retain input. */
export function RoomCardFrame({ id, cardRef, style, dragging, handleProps, size = 1, onResize, children }: Props) {
  const resize = useRef<{ pointerId: number; x: number; width: number; initial: number; button: HTMLButtonElement } | null>(null);
  const callback = useRef(onResize);
  callback.current = onResize;
  const finish = (cancel: boolean) => {
    const gesture = resize.current;
    if (!gesture) return;
    resize.current = null;
    if (cancel) callback.current?.(gesture.initial);
    if (gesture.button.hasPointerCapture(gesture.pointerId)) gesture.button.releasePointerCapture(gesture.pointerId);
  };
  useEffect(() => {
    const cancel = () => finish(true);
    const escape = (event: KeyboardEvent) => {
      if (resize.current && event.key === 'Escape') { event.preventDefault(); cancel(); }
    };
    window.addEventListener('blur', cancel);
    window.addEventListener('keydown', escape);
    return () => { cancel(); window.removeEventListener('blur', cancel); window.removeEventListener('keydown', escape); };
  }, []);
  return <div ref={cardRef} data-sortable-id={id}
    className={`room-card-frame ${dragging ? 'is-dragging' : ''}`} style={style}>
    {children}
    <TooltipButton tooltip={t('room.cards.reorder')} className="btn room-card-drag-handle"
      {...handleProps} onClick={event => event.stopPropagation()}><GripVertical size={16} /></TooltipButton>
    {onResize && <TooltipButton tooltip={t('room.cards.resize')} className="btn room-card-resize-handle"
      onClick={event => event.stopPropagation()}
      onDoubleClick={() => onResize(1)}
      onPointerDown={event => {
        if (event.button !== 0) return;
        event.preventDefault(); event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        resize.current = { pointerId: event.pointerId, x: event.clientX,
          width: event.currentTarget.parentElement!.getBoundingClientRect().width, initial: size, button: event.currentTarget };
      }}
      onPointerMove={event => {
        const gesture = resize.current;
        if (!gesture || gesture.pointerId !== event.pointerId) return;
        onResize(Math.max(.4, Math.min(2.5, gesture.initial * (1 + (event.clientX - gesture.x) / gesture.width))));
      }}
      onPointerUp={() => finish(false)} onPointerCancel={() => finish(true)} onLostPointerCapture={() => finish(true)}
      onKeyDown={event => {
        const direction = { ArrowLeft: -.1, ArrowDown: -.1, ArrowRight: .1, ArrowUp: .1 }[event.key];
        if (event.key === 'Home' || direction !== undefined) {
          event.preventDefault(); onResize(event.key === 'Home' ? 1 : Math.max(.4, Math.min(2.5, size + direction!)));
        }
      }}><MoveDiagonal2 size={14} /></TooltipButton>}
  </div>;
}
