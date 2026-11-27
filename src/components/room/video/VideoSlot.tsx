import React, { useCallback } from 'react';
import type { RoomSlotInfo } from '../../../core/types';

interface Props {
  slot: RoomSlotInfo;
  role: 'grid' | 'featured' | 'tray';
  selected?: boolean;
  registerSlot: (key: string, element: HTMLDivElement | null) => void;
}

/** Registers geometry for a persistent video card while preserving the lightweight tray placeholder for the featured slot. */
export const VideoSlot: React.FC<Props> = ({ slot, role, selected = false, registerSlot }) => {
  const slotRef = useCallback((element: HTMLDivElement | null) => {
    registerSlot(`${role}:${slot.peerId}`, element);
  }, [registerSlot, role, slot.peerId]);

  return (
    <div
      ref={slotRef}
      className={`room-video-slot ${selected ? 'selected-featured' : ''}`}
      data-room-video-slot={slot.peerId}
      data-room-video-role={role}
    >
      {selected && role === 'tray' && (
        <>
          <div className="tray-featured-placeholder">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="5 3 19 12 5 21 5 3" />
            </svg>
          </div>
          <span className="selected-featured-badge">
            <span className="selected-featured-badge-dot" />
          </span>
        </>
      )}
    </div>
  );
};
