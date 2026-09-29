import React, { useMemo, useRef, useLayoutEffect, useEffect, useState } from 'react';
import { roomAppsService } from '../../apps/room_apps_service';
import { RoomAppSlot } from '../../apps/RoomAppSlot';
import { PersistentRoomApps } from '../../apps/PersistentRoomApps';
import type { RoomAppInstance } from '../../apps/types';
import { useRoom } from '../../hooks/useRoom';
import { useStore } from '../../hooks/useStore';
import { VideoCard } from './VideoCard';
import { ParticipantCard } from './ParticipantCard';
import { RoomSlotInfo } from '../../core/types';

export const RoomVideoContainer: React.FC = () => {
  const [, setAppsTick] = useState(0);
  const appVisibilityRef = useRef('');
  useEffect(() => roomAppsService.subscribe(() => {
    const ids = roomAppsService.getInstances().map((instance) => instance.id).join(',');
    const joinedIds = roomAppsService.getJoinedInstances().map((instance) => instance.id).join(',');
    const visibility = `${ids}|${joinedIds}`;
    if (visibility !== appVisibilityRef.current) {
      appVisibilityRef.current = visibility;
      setAppsTick((tick) => tick + 1);
    }
  }), []);
  const appInstances = roomAppsService.getInstances();
  const {
    roomSlots,
    layoutMode,
    pinnedPeerId,
    isSpotlightTrayCollapsed,
    toggleSpotlightTray,
    streamFilter,
    setStreamFilter,
  } = useRoom();
  const subscribedStreams = useStore((s) => s.subscribedStreams);

  const gridWrapperRef = useRef<HTMLDivElement | null>(null);
  const videoContainerRef = useRef<HTMLDivElement | null>(null);
  const trayStripRef = useRef<HTMLDivElement | null>(null);
  const prevGridRectsRef = useRef<Map<string, DOMRect>>(new Map());
  const prevTrayRectsRef = useRef<Map<string, DOMRect>>(new Map());

  // FLIP animation helper: smoothly slides existing cards to new positions when peers join or leave
  const applyFlipAnimation = (
    container: HTMLElement | null,
    prevRectsMap: Map<string, DOMRect>
  ) => {
    if (!container) return;

    const cards = container.querySelectorAll<HTMLElement>('[data-peer-id]');
    const currentRects = new Map<string, DOMRect>();

    cards.forEach((card) => {
      const peerId = card.getAttribute('data-peer-id');
      if (peerId) {
        currentRects.set(peerId, card.getBoundingClientRect());
      }
    });

    cards.forEach((card) => {
      const peerId = card.getAttribute('data-peer-id');
      if (!peerId) return;

      const prevRect = prevRectsMap.get(peerId);
      const currentRect = currentRects.get(peerId);

      if (prevRect && currentRect) {
        const dx = prevRect.left - currentRect.left;
        const dy = prevRect.top - currentRect.top;

        if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
          // Invert: visually position element back at previous coordinates
          card.style.transform = `translate(${dx}px, ${dy}px)`;
          card.style.transition = 'none';

          // Play: smoothly animate to new coordinates
          requestAnimationFrame(() => {
            card.style.transition = 'transform 0.45s cubic-bezier(0.16, 1, 0.3, 1)';
            card.style.transform = '';
            const onEnd = () => {
              card.style.transition = '';
              card.removeEventListener('transitionend', onEnd);
            };
            card.addEventListener('transitionend', onEnd);
          });
        }
      }
    });

    prevRectsMap.clear();
    currentRects.forEach((rect, id) => prevRectsMap.set(id, rect));
  };

  const shouldRenderVideo = (slot: RoomSlotInfo): boolean => {
    return Boolean(
      (slot.isLocal && slot.isStreaming && slot.stream) ||
      (!slot.isLocal && slot.isStreaming && subscribedStreams.has(slot.peerId) && slot.stream)
    );
  };

  const filteredSlots = useMemo(() => {
    return roomSlots.filter((slot) => {
      if (streamFilter === 'streaming') {
        return slot.isStreaming;
      }
      if (streamFilter === 'watching') {
        return !slot.isLocal && slot.isStreaming && subscribedStreams.has(slot.peerId);
      }
      return true;
    });
  }, [roomSlots, streamFilter, subscribedStreams]);

  const visibleApps = streamFilter === 'watching' ? roomAppsService.getJoinedInstances() : appInstances;
  const entries: Array<RoomSlotInfo | RoomAppInstance> = [...filteredSlots, ...visibleApps];
  const entryId = (entry: RoomSlotInfo | RoomAppInstance) => 'peerId' in entry ? entry.peerId : `app:${entry.id}`;
  const slotIdsKey = entries.map(entryId).join(',');

  const prevSlotIdsKeyRef = useRef(slotIdsKey);
  const prevLayoutModeRef = useRef(layoutMode);

  useLayoutEffect(() => {
    const idsChanged = prevSlotIdsKeyRef.current !== slotIdsKey;
    const modeChanged = prevLayoutModeRef.current !== layoutMode;
    prevSlotIdsKeyRef.current = slotIdsKey;
    prevLayoutModeRef.current = layoutMode;

    if (!idsChanged && !modeChanged) {
      return;
    }

    if (layoutMode === 'grid') {
      applyFlipAnimation(gridWrapperRef.current, prevGridRectsRef.current);
    } else {
      prevGridRectsRef.current.clear();
    }

    if (layoutMode === 'spotlight') {
      applyFlipAnimation(trayStripRef.current, prevTrayRectsRef.current);
    } else {
      prevTrayRectsRef.current.clear();
    }
  }, [slotIdsKey, layoutMode]);

  const featuredSlot = entries.find((s) => entryId(s) === pinnedPeerId) || entries[0];

  const renderSlotCard = (
    slot: RoomSlotInfo | RoomAppInstance,
    isFeatured = false,
    inTray = false,
    isSelectedFeatured = false
  ) => {
    if (!('peerId' in slot)) return <RoomAppSlot key={slot.id} instance={slot}
      role={inTray ? 'tray' : isFeatured ? 'featured' : 'grid'} selected={isSelectedFeatured} />;
    if (shouldRenderVideo(slot)) {
      return (
        <VideoCard
          key={slot.peerId}
          slot={slot}
          isFeatured={isFeatured}
          inTray={inTray}
          isSelectedFeatured={isSelectedFeatured}
        />
      );
    }
    return (
      <ParticipantCard
        key={slot.peerId}
        slot={slot}
        isFeatured={isFeatured}
        inTray={inTray}
        isSelectedFeatured={isSelectedFeatured}
      />
    );
  };

  return (
    <div className="video-container" id="room-video-container" ref={videoContainerRef}>
      {/* GRID VIEW */}
      <div
        ref={gridWrapperRef}
        className={`streams-grid-wrapper layout-grid ${layoutMode !== 'grid' ? 'hidden' : ''}`}
        id="streams-grid-wrapper"
      >
        {layoutMode === 'grid' && (
          entries.length > 0 ? (
            entries.map((slot) => renderSlotCard(slot, false, false, false))
          ) : (
            <div className="stream-filter-empty-state">
              <p className="filter-empty-title">Nenhum participante com o filtro selecionado.</p>
              <button
                className="btn btn-sm btn-outline filter-empty-btn"
                onClick={() => setStreamFilter('all')}
              >
                Mostrar todos ({roomSlots.length})
              </button>
            </div>
          )
        )}
      </div>

      {/* SPOTLIGHT STAGE */}
      <div
        className={`spotlight-stage ${layoutMode !== 'spotlight' ? 'hidden' : ''}`}
        id="spotlight-stage"
      >
        {layoutMode === 'spotlight' && (
          <>
            {/* Featured Area */}
            <div className="spotlight-featured-area" id="spotlight-featured-area">
              {featuredSlot ? (
                renderSlotCard(featuredSlot, true, false, false)
              ) : (
                <div className="stream-filter-empty-state">
                  <p className="filter-empty-title">Nenhuma transmissão selecionada.</p>
                  <button
                    className="btn btn-sm btn-outline filter-empty-btn"
                    onClick={() => setStreamFilter('all')}
                  >
                    Mostrar todos ({roomSlots.length})
                  </button>
                </div>
              )}
            </div>

            {/* Bottom Tray */}
            <div
              className={`spotlight-tray-container ${isSpotlightTrayCollapsed ? 'collapsed' : ''}`}
              id="spotlight-tray-container"
            >
              <button
                className="btn-toggle-spotlight-tray"
                id="btn-toggle-spotlight-tray"
                aria-label="Minimizar / Expandir miniaturas"
                onClick={toggleSpotlightTray}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <polyline points="6 9 12 15 18 9"/>
                </svg>
              </button>
              <div ref={trayStripRef} className="spotlight-tray-strip" id="spotlight-tray-strip">
                {entries.map((slot) =>
                  renderSlotCard(slot, false, true, entryId(slot) === (featuredSlot && entryId(featuredSlot)))
                )}
              </div>
            </div>
          </>
        )}
      </div>
      <PersistentRoomApps instances={appInstances} layoutMode={layoutMode}
        featuredId={layoutMode === 'spotlight' && featuredSlot ? entryId(featuredSlot) : undefined}
        layoutKey={`${slotIdsKey}:${layoutMode}:${pinnedPeerId}:${isSpotlightTrayCollapsed}:${streamFilter}`}
        rootRef={videoContainerRef} />
    </div>
  );
};
