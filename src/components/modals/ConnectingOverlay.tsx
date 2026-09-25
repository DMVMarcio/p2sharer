import React from 'react';
import { useRoom } from '../../hooks/useRoom';

export const ConnectingOverlay: React.FC = () => {
  const { connectingOverlay, hideConnecting, leaveRoom, currentRoomPassword } = useRoom();

  if (!connectingOverlay.visible) return null;

  const handleCancel = () => {
    hideConnecting();
    leaveRoom();
  };

  return (
    <div className="connecting-overlay" id="connecting-overlay">
      <div className="connecting-card">
        <div className="connecting-spinner-wrapper">
          <div className="connecting-spinner"></div>
        </div>
        <h2 className="connecting-title" id="connecting-title">
          {connectingOverlay.title || 'Entrando na sala...'}
        </h2>
        <p className="connecting-subtitle" id="connecting-subtitle">
          {connectingOverlay.subtitle || 'Estabelecendo sinalização e túnel P2P criptografado...'}
        </p>
        <div className="connecting-room-badge" id="connecting-room-code">
          SALA: {connectingOverlay.roomCode}
          {currentRoomPassword ? ' (Protegida)' : ''}
        </div>
        <button className="btn btn-secondary btn-cancel-connect" id="btn-cancel-connecting" onClick={handleCancel}>
          <span>Cancelar</span>
        </button>
      </div>
    </div>
  );
};
