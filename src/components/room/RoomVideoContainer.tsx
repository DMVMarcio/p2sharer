import React, { useMemo } from 'react';
import { useRoom } from '../../hooks/useRoom';
import { useStore } from '../../hooks/useStore';
import { VideoCard } from './VideoCard';
import { ParticipantCard } from './ParticipantCard';
import { RoomSlotInfo } from '../../core/types';

export const RoomVideoContainer: React.FC = () => {
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

  const featuredSlot =
    filteredSlots.find((s) => s.peerId === pinnedPeerId) ||
    filteredSlots[0] ||
    roomSlots.find((s) => s.peerId === pinnedPeerId) ||
    roomSlots[0];

  const renderSlotCard = (
    slot: RoomSlotInfo,
    isFeatured = false,
    inTray = false,
    isSelectedFeatured = false
  ) => {
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
    <div className="video-container" id="room-video-container">
      {/* GRID VIEW */}
      <div
        className={`streams-grid-wrapper layout-grid ${layoutMode !== 'grid' ? 'hidden' : ''}`}
        id="streams-grid-wrapper"
      >
        {filteredSlots.length > 0 ? (
          filteredSlots.map((slot) => renderSlotCard(slot, false, false, false))
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
        )}
      </div>

      {/* SPOTLIGHT STAGE */}
      <div
        className={`spotlight-stage ${layoutMode !== 'spotlight' ? 'hidden' : ''}`}
        id="spotlight-stage"
      >
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
          <div className="spotlight-tray-strip" id="spotlight-tray-strip">
            {filteredSlots.map((slot) =>
              renderSlotCard(slot, false, true, slot.peerId === featuredSlot?.peerId)
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
