import React from 'react';
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
  } = useRoom();
  const subscribedStreams = useStore((s) => s.subscribedStreams);

  const shouldRenderVideo = (slot: RoomSlotInfo): boolean => {
    return Boolean(
      (slot.isLocal && slot.isStreaming && slot.stream) ||
      (!slot.isLocal && slot.isStreaming && subscribedStreams.has(slot.peerId) && slot.stream)
    );
  };

  const renderSlotCard = (slot: RoomSlotInfo, isFeatured = false) => {
    if (shouldRenderVideo(slot)) {
      return <VideoCard key={slot.peerId} slot={slot} isFeatured={isFeatured} />;
    }
    return <ParticipantCard key={slot.peerId} slot={slot} isFeatured={isFeatured} />;
  };

  const featuredSlot =
    roomSlots.find((s) => s.peerId === pinnedPeerId) || roomSlots[0];
  const otherSlots = roomSlots.filter((s) => s.peerId !== featuredSlot?.peerId);

  return (
    <div className="video-container" id="room-video-container">
      {/* GRID VIEW */}
      <div
        className={`streams-grid-wrapper layout-grid ${layoutMode !== 'grid' ? 'hidden' : ''}`}
        id="streams-grid-wrapper"
      >
        {roomSlots.map((slot) => renderSlotCard(slot, false))}
      </div>

      {/* SPOTLIGHT STAGE */}
      <div
        className={`spotlight-stage ${layoutMode !== 'spotlight' ? 'hidden' : ''}`}
        id="spotlight-stage"
      >
        {/* Featured Area */}
        <div className="spotlight-featured-area" id="spotlight-featured-area">
          {featuredSlot && renderSlotCard(featuredSlot, true)}
        </div>

        {/* Bottom Tray */}
        <div
          className={`spotlight-tray-container ${isSpotlightTrayCollapsed ? 'collapsed' : ''}`}
          id="spotlight-tray-container"
        >
          <button
            className="btn-toggle-spotlight-tray"
            id="btn-toggle-spotlight-tray"
            title="Minimizar / Expandir miniaturas"
            onClick={toggleSpotlightTray}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </button>
          <div className="spotlight-tray-strip" id="spotlight-tray-strip">
            {otherSlots.map((slot) => renderSlotCard(slot, false))}
          </div>
        </div>
      </div>
    </div>
  );
};
