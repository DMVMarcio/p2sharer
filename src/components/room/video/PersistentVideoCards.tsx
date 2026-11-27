import React, { useCallback, useMemo } from 'react';
import type { RoomSlotInfo } from '../../../core/types';
import { VideoCard } from './VideoCard';
import { usePersistentSlotPlacements } from './usePersistentSlotPlacements';

interface Props {
  slots: RoomSlotInfo[];
  layoutMode: 'grid' | 'spotlight';
  featuredId?: string;
  layoutKey: string;
  draggingId?: string | null;
  draggableCount: number;
  rootRef: React.RefObject<HTMLDivElement | null>;
  slotsRef: React.RefObject<Map<string, HTMLDivElement>>;
  overlays?: React.ReactNode;
}

/** Keeps active VideoCard and <video> decoders mounted across grid, spotlight, and tray transitions. */
export const PersistentVideoCards: React.FC<Props> = ({
  slots,
  layoutMode,
  featuredId,
  layoutKey,
  draggingId,
  draggableCount,
  rootRef,
  slotsRef,
  overlays,
}) => {
  const slotIds = useMemo(() => slots.map((slot) => slot.peerId), [slots]);
  const resolveSlotKey = useCallback((peerId: string) => {
    const role = layoutMode === 'grid' ? 'grid' : featuredId === peerId ? 'featured' : 'tray';
    return `${role}:${peerId}`;
  }, [layoutMode, featuredId]);

  const placements = usePersistentSlotPlacements({
    keys: slotIds,
    resolveSlotKey,
    layoutKey,
    rootRef,
    slotsRef,
  });

  return (
    <div className="room-video-layer">
      {slots.map((slot) => {
        const placement = placements[slot.peerId];
        const isFeatured = layoutMode === 'spotlight' && featuredId === slot.peerId;
        const inTray = layoutMode === 'spotlight' && !isFeatured;
        return (
          <VideoCard
            key={slot.peerId}
            slot={slot}
            isFeatured={isFeatured}
            inTray={inTray}
            isSelectedFeatured={false}
            layoutDraggable={!isFeatured && draggableCount > 1}
            resizable={!isFeatured && !inTray}
            hidden={!placement}
            style={placement ? {
              ...placement,
              zIndex: draggingId === slot.peerId ? 40 : 5,
            } : {
              left: -10000,
              top: -10000,
              width: 1,
              height: 1,
              visibility: 'hidden',
              pointerEvents: 'none',
            }}
          >
            {isFeatured ? overlays : null}
          </VideoCard>
        );
      })}
    </div>
  );
};
