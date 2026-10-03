import React, { useCallback } from 'react';
import { getRoomApp } from './registry';
import { RoomAppIcon } from './RoomAppIcon';
import type { RoomAppInstance } from './types';

interface Props {
  instance: RoomAppInstance;
  role: 'grid' | 'featured' | 'tray';
  selected?: boolean;
  registerSlot: (key: string, element: HTMLDivElement | null) => void;
}

export const RoomAppSlot: React.FC<Props> = ({ instance, role, selected = false, registerSlot }) => {
  const slotRef = useCallback((element: HTMLDivElement | null) => {
    registerSlot(`${role}:${instance.id}`, element);
  }, [registerSlot, role, instance.id]);
  const definition = getRoomApp(instance.kind);
  return <div ref={slotRef} className={`room-app-slot ${selected ? 'selected-featured' : ''}`}
    data-peer-id={`app:${instance.id}`} data-room-app-slot={instance.id} data-room-app-role={role}>
    {selected && role === 'tray' && <div className="room-app-selected-preview">
      <RoomAppIcon kind={instance.kind} size={20} strokeWidth={2} />
      <span>{definition?.label || instance.kind}</span>
    </div>}
  </div>;
};
