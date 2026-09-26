import React from 'react';
import { RoomSlotInfo } from '../../core/types';
import { useRoom } from '../../hooks/useRoom';
import { useStore } from '../../hooks/useStore';
import { Tooltip } from '../common/Tooltip';
import { WatchersTooltipContent } from './WatchersTooltipContent';

interface ParticipantCardProps {
  slot: RoomSlotInfo;
  isFeatured?: boolean;
  inTray?: boolean;
  isSelectedFeatured?: boolean;
}

export const ParticipantCard: React.FC<ParticipantCardProps> = ({
  slot,
  isFeatured = false,
  inTray = false,
  isSelectedFeatured = false,
}) => {
  const { togglePin, requestStream, username } = useRoom();
  const subscribedStreams = useStore((s) => s.subscribedStreams);

  const isSubscribed = subscribedStreams.has(slot.peerId);
  const watchers = slot.watchers || [];
  const watchersCount = watchers.length;

  const handleCardClick = () => {
    togglePin(slot.peerId);
  };

  const handleWatchClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    requestStream(slot.peerId);
  };

  return (
    <div
      className={`participant-card ${isFeatured ? 'featured' : ''} ${inTray ? 'in-tray' : ''} ${isSelectedFeatured ? 'selected-featured' : ''}`}
      data-peer-id={slot.peerId}
      style={{ '--user-color': slot.color } as React.CSSProperties}
      onClick={handleCardClick}
    >
      {/* Featured badge when in tray */}
      {inTray && isSelectedFeatured && (
        <span className="selected-featured-badge">
          <span className="selected-featured-badge-dot"></span>
        </span>
      )}

      {/* If remote and is streaming but not subscribed, show AO VIVO and watchers (omitted in bottom tray) */}
      {!inTray && !slot.isLocal && slot.isStreaming && !isSubscribed && (
        <>
          <span className="badge-live-stream">
            <span className="badge-live-dot"></span>AO VIVO
          </span>
          {watchersCount > 0 && (
            <Tooltip
              interactive
              tooltipClassName="watchers-tooltip"
              content={<WatchersTooltipContent watchers={watchers} currentUsername={username} />}
            >
              <div
                className="badge-live-watchers"
                onClick={(e) => e.stopPropagation()}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8z"/>
                  <circle cx="12" cy="12" r="3"/>
                </svg>
                <span>{watchersCount} assistindo</span>
              </div>
            </Tooltip>
          )}
        </>
      )}

      <div className="participant-avatar-badge">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>
        </svg>
      </div>

      <div className="participant-name-row">
        <span className="participant-avatar-label">{slot.senderName}</span>
        {slot.isLocal && <span className="badge-you">VOCÊ</span>}
      </div>

      {!inTray && slot.isLocal && !slot.isStreaming && (
        <div className="participant-status-text">Você não está transmitindo</div>
      )}

      {!inTray && !slot.isLocal && !slot.isStreaming && (
        <div className="participant-status-text">Sem transmissão</div>
      )}

      {!inTray && !slot.isLocal && slot.isStreaming && isSubscribed && !slot.stream && (
        <div className="participant-status-text" style={{ color: 'var(--accent-color)' }}>
          Conectando transmissão...
        </div>
      )}

      {!slot.isLocal && slot.isStreaming && !isSubscribed && (
        <div className="participant-action-row">
          <button className="btn-watch-stream" onClick={handleWatchClick}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="5 3 19 12 5 21 5 3"/>
            </svg>
            <span>Assistir Transmissão</span>
          </button>
        </div>
      )}
    </div>
  );
};
