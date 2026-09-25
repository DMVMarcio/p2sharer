import React from 'react';
import { useRoom } from '../../hooks/useRoom';
import { useModal } from '../../hooks/useModal';
import { showToast } from '../../hooks/useToast';
import logoImg from '../../assets/logo.png';

export const AppHeader: React.FC = () => {
  const { currentRoomCode, currentRoomPassword, username, isInRoom } = useRoom();
  const { openModal } = useModal();

  const handleCopyRoomCode = () => {
    const copyText = currentRoomPassword
      ? `Sala: ${currentRoomCode} | Senha: ${currentRoomPassword}`
      : currentRoomCode;
    navigator.clipboard
      .writeText(copyText)
      .then(() => showToast('Código copiado!'))
      .catch(() => {});
  };

  return (
    <header className="app-header" data-tauri-drag-region>
      <div className="logo-group">
        <div className="logo-icon-clean">
          <img src={logoImg} alt="P2Sharer Logo" className="app-header-logo" width="22" height="22" />
        </div>
        <span className="logo-title">P2Sharer</span>
      </div>

      <div className="header-user-info">
        {isInRoom && (
          <button
            className="room-code-header-pill"
            id="header-room-code-pill"
            onClick={handleCopyRoomCode}
            title={
              currentRoomPassword
                ? `Clique para copiar o código e senha da sala (${currentRoomCode})`
                : `Clique para copiar o código da sala (${currentRoomCode})`
            }
          >
            <span className="header-pill-label">SALA</span>
            <strong id="display-room-code">{currentRoomCode}</strong>
            <span
              className="room-lock-icon"
              id="header-room-lock-icon"
              title={
                currentRoomPassword
                  ? `Protegida por Senha: ${currentRoomPassword}`
                  : 'Sala Pública (Sem Senha)'
              }
            >
              {currentRoomPassword ? (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                  <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                </svg>
              ) : (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                  <path d="M7 11V7a5 5 0 0 1 9.9-1"/>
                </svg>
              )}
            </span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect width="14" height="14" x="8" y="8" rx="2" ry="2"/>
              <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>
            </svg>
          </button>
        )}

        <button
          className="user-pill"
          id="user-pill"
          onClick={() => openModal('settings')}
          title="Configurações e Perfil"
        >
          <span className="user-status-dot"></span>
          <span id="current-username-display">{username || 'Usuário'}</span>
        </button>

        <button
          className="btn-icon-header"
          id="btn-open-settings"
          onClick={() => openModal('settings')}
          title="Configurações"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
            <circle cx="12" cy="12" r="3"/>
          </svg>
        </button>
      </div>
    </header>
  );
};
