import { t } from '../i18n';
import { useLocale } from '../hooks/useLocale';
import React, { useCallback, useMemo } from 'react';
import type { RoomAppInstance } from './types';
import { RoomAppCard } from './RoomAppCard';
import { usePersistentSlotPlacements } from '../components/room/usePersistentSlotPlacements';

interface Props {
  instances: RoomAppInstance[];
  layoutMode: 'grid' | 'spotlight';
  featuredId?: string;
  layoutKey: string;
  draggingId?: string | null;
  rootRef: React.RefObject<HTMLDivElement | null>;
  slotsRef: React.RefObject<Map<string, HTMLDivElement>>;
}

export const PersistentRoomApps: React.FC<Props> = ({ instances, layoutMode, featuredId, layoutKey, draggingId, rootRef, slotsRef }) => {
  useLocale();
  const instanceIds = useMemo(() => instances.map((instance) => instance.id), [instances]);
  const resolveSlotKey = useCallback((id: string) => {
    const role = layoutMode === 'grid' ? 'grid' : featuredId === `app:${id}` ? 'featured' : 'tray';
    return `${role}:${id}`;
  }, [layoutMode, featuredId]);

  const placements = usePersistentSlotPlacements({
    keys: instanceIds,
    resolveSlotKey,
    layoutKey,
    rootRef,
    slotsRef,
  });

  return <div className="room-app-layer" aria-label={t("message.791e1b0c7eaf")}>
    {instances.map((instance) => {
      const placement = placements[instance.id];
      const isFeatured = layoutMode === 'spotlight' && featuredId === `app:${instance.id}`;
      return <RoomAppCard key={instance.id} instance={instance} isFeatured={isFeatured}
        compact={!isFeatured} layoutDraggable={!isFeatured} style={placement ? { ...placement,
          zIndex: draggingId === `app:${instance.id}` ? 40 : 5 } : { left: -10000, top: -10000, width: 1, height: 1,
          visibility: 'hidden', pointerEvents: 'none' }} />;
    })}
  </div>;
};
