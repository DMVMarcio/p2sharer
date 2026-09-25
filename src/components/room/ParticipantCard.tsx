import React from 'react';
import { RoomSlotInfo } from '../../core/types';
import { useRoom } from '../../hooks/useRoom';
import { useStore } from '../../hooks/useStore';

interface ParticipantCardProps {
  slot: RoomSlotInfo;
  isFeatured?: boolean;
}

export const ParticipantCard: React.FC<ParticipantCardProps> = ({ slot, isFeatured = false }) => {
  const { togglePin, requestStream } = useRoom();
  const subscribedStreams = useStore((s) => s.subscribedStreams);

  const isSubscribed = subscribedStreams.has(slot.peerId);
  const watchers = slot.watchers || [];
  const watchersCount = watchers.length;
  const watchersTooltip =
    watchersCount > 0
      ? `Assistindo: ${watchers.map((w) => w.username).join(', ')}`
      : '';

  const handleCardClick = () => {
    togglePin(slot.peerId);
  };

  const handleWatchClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    requestStream(slot.peerId);
  };

  const getTitle = () => {
    if (isFeatured) return 'Clique para voltar à grade';
    if (slot.isLocal) return 'Clique para destacar seu card';
    return 'Clique para destacar este participante';
  };

  return (
    <div
      className={`participant-card ${isFeatured ? 'featured' : ''}`}
      data-peer-id={slot.peerId}
      style={{ '--user-color': slot.color } as React.CSSProperties}
      title={getTitle()}
      onClick={handleCardClick}
    >
      {/* If remote and is streaming but not subscribed, show AO VIVO and watchers */}
      {!slot.isLocal && slot.isStreaming && !isSubscribed && (
        <>
          <span className="badge-live-stream">
            <span className="badge-live-dot"></span>AO VIVO
          </span>
          {watchersCount > 0 && (
            <span className="badge-live-watchers" title={watchersTooltip}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                <circle cx="12" cy="12" r="3"/>
              </svg>
              <span>{watchersCount} assistindo</span>
            </span>
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

      {slot.isLocal && !slot.isStreaming && (
        <div className="participant-status-text">Você não está transmitindo</div>
      )}

      {!slot.isLocal && !slot.isStreaming && (
        <div className="participant-status-text">Sem transmissão</div>
      )}

      {!slot.isLocal && slot.isStreaming && isSubscribed && !slot.stream && (
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
