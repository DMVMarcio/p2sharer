import React from 'react';
import { RoomSlotInfo } from '../../core/types';
import { useRoom } from '../../hooks/useRoom';
import { useStore } from '../../hooks/useStore';

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

  const getTitle = () => {
    if (inTray) {
      if (isSelectedFeatured) return 'Em destaque no palco (clique para voltar à grade)';
      return 'Clique para destacar este participante no palco';
    }
    if (isFeatured) return 'Clique para voltar à grade';
    if (slot.isLocal) return 'Clique para destacar seu card';
    return 'Clique para destacar este participante';
  };

  return (
    <div
      className={`participant-card ${isFeatured ? 'featured' : ''} ${inTray ? 'in-tray' : ''} ${isSelectedFeatured ? 'selected-featured' : ''}`}
      data-peer-id={slot.peerId}
      style={{ '--user-color': slot.color } as React.CSSProperties}
      title={getTitle()}
      onClick={handleCardClick}
    >
      {/* Featured badge when in tray */}
      {inTray && isSelectedFeatured && (
        <span className="selected-featured-badge" title="Este participante está em destaque">
          <span className="selected-featured-badge-dot"></span>
          <span>EM FOCO</span>
        </span>
      )}

      {/* If remote and is streaming but not subscribed, show AO VIVO and watchers */}
      {!slot.isLocal && slot.isStreaming && !isSubscribed && (
        <>
          <span className="badge-live-stream">
            <span className="badge-live-dot"></span>AO VIVO
          </span>
          {watchersCount > 0 && !inTray && (
            <div
              className="badge-live-watchers custom-tooltip-container"
              onClick={(e) => e.stopPropagation()}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8z"/>
                <circle cx="12" cy="12" r="3"/>
              </svg>
              <span>{watchersCount} assistindo</span>

              <div className="custom-tooltip watchers-tooltip">
                <div className="watchers-tooltip-header">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8z"/>
                    <circle cx="12" cy="12" r="3"/>
                  </svg>
                  <span>
                    {watchersCount === 1 ? '1 pessoa assistindo:' : `${watchersCount} pessoas assistindo:`}
                  </span>
                </div>
                <div className="watchers-tooltip-list">
                  {watchers.map((w) => {
                    const isSelf = w.username === username;
                    return (
                      <div key={w.peerId} className="watchers-tooltip-item">
                        <span className="watchers-tooltip-dot"></span>
                        <span className="watchers-tooltip-name">{w.username}</span>
                        {isSelf && <span className="badge-you">VOCÊ</span>}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
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
