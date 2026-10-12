import React from 'react';
import { t } from '../../i18n';
import type { CardResizeEdge } from '../../core/room_card_layout';

const EDGES: CardResizeEdge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

interface Props {
  id: string;
  cardRef: React.RefCallback<HTMLDivElement>;
  style?: React.CSSProperties;
  dragging: boolean;
  resizable: boolean;
  children: React.ReactNode;
}

/** Invisible edge hit areas resize the real card; its body remains the drag surface. */
export function RoomCardFrame({ id, cardRef, style, dragging, resizable, children }: Props) {
  return <div ref={cardRef} data-sortable-id={id} tabIndex={0} aria-label={t('room.cards.gestures')}
    className={`room-card-frame ${dragging ? 'is-dragging' : ''}`} style={style}>
    {children}
    {resizable && EDGES.map(edge => <span key={edge} aria-hidden="true" className={`room-card-edge room-card-edge-${edge}`}
      data-room-resize={edge} />)}
  </div>;
}

export function RoomCardPlaceholder({ style }: { style?: React.CSSProperties }) {
  return <div className="room-card-placeholder" role="status" aria-label={t('room.cards.dropPreview')} style={style} />;
}
