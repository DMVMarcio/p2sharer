import React from 'react';
import { useRoom } from '../../hooks/useRoom';

export const ParticipantsPane: React.FC = () => {
  const { username, peers, roomSlots, isCreator } = useRoom();

  const getSlotColor = (peerId: string, isLocal: boolean): string => {
    const slot = roomSlots.find((s) => s.isLocal === isLocal || s.peerId === peerId);
    return slot?.color || 'var(--accent-color)';
  };

  const getInitial = (name: string): string => {
    return (name || 'U').trim().charAt(0).toUpperCase();
  };

  const localColor = getSlotColor('local', true);

  return (
    <div className="sidebar-tab-content active" id="tab-content-participants">
      <div className="participants-list" id="participants-list">
        {/* Local user */}
        <div className="participant-item">
          <div className="participant-item-identity">
            <div
              className="participant-item-avatar"
              style={{ backgroundColor: localColor }}
            >
              <span className="participant-item-avatar-letter">{getInitial(username)}</span>
            </div>
            <div className="participant-item-text">
              <span className="participant-item-name">{username || 'Usuário'}</span>
              <span className="badge-you">VOCÊ</span>
              {isCreator && <span className="badge-host">HOST</span>}
            </div>
          </div>
          <span className="user-status-dot online"></span>
        </div>

        {/* Remote peers */}
        {peers.map((p) => {
          const color = getSlotColor(p.id, false);
          const slot = roomSlots.find((s) => s.peerId === p.id);
          const isStreaming = slot?.isStreaming;

          return (
            <div key={p.id} className="participant-item">
              <div className="participant-item-identity">
                <div
                  className="participant-item-avatar"
                  style={{ backgroundColor: color }}
                >
                  <span className="participant-item-avatar-letter">{getInitial(p.username)}</span>
                </div>
                <div className="participant-item-text">
                  <span className="participant-item-name">{p.username}</span>
                  {p.isCreator && <span className="badge-host">HOST</span>}
                  {isStreaming && <span className="badge-live-stream-mini">AO VIVO</span>}
                </div>
              </div>
              <span
                className={`user-status-dot ${p.connectionState === 'connected' ? 'online' : 'connecting'}`}
                title={p.connectionState === 'connected' ? 'Conectado' : 'Conectando'}
              ></span>
            </div>
          );
        })}
      </div>
    </div>
  );
};
