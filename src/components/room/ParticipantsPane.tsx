import React from 'react';
import { useRoom } from '../../hooks/useRoom';

export const ParticipantsPane: React.FC = () => {
  const { username, peers } = useRoom();

  return (
    <div className="sidebar-tab-content active" id="tab-content-participants">
      <div className="participants-list" id="participants-list">
        {/* Local user */}
        <div className="participant-item">
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span>{username || 'Usuário'}</span>
            <span className="badge-you">VOCÊ</span>
          </div>
          <span className="user-status-dot"></span>
        </div>

        {/* Remote peers */}
        {peers.map((p) => (
          <div key={p.id} className="participant-item">
            <span>{p.username}</span>
            <span className="user-status-dot"></span>
          </div>
        ))}
      </div>
    </div>
  );
};
