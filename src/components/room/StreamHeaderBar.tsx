import React from 'react';
import { useRoom } from '../../hooks/useRoom';
import { useModal } from '../../hooks/useModal';
import { useStore } from '../../hooks/useStore';

export const StreamHeaderBar: React.FC = () => {
  const {
    roomSlots,
    isSharingScreen,
    stopScreenSharing,
    leaveRoom,
    streamFilter,
    setStreamFilter,
  } = useRoom();
  const { openModal } = useModal();
  const subscribedStreams = useStore((s) => s.subscribedStreams);

  const totalCount = roomSlots.length;
  const streamingCount = roomSlots.filter((s) => s.isStreaming).length;
  const watchingCount = roomSlots.filter(
    (s) => !s.isLocal && s.isStreaming && subscribedStreams.has(s.peerId)
  ).length;

  const handleToggleTransmission = () => {
    if (isSharingScreen) {
      stopScreenSharing();
    } else {
      openModal('screenPicker');
    }
  };

  return (
    <div className="stream-header-bar">
      {/* Stream Filter Controls on Left */}
      <div className="stream-filter-group" role="group" aria-label="Filtro de visualização">
        <button
          type="button"
          className={`btn-stream-filter ${streamFilter === 'all' ? 'active' : ''} custom-tooltip-container`}
          onClick={() => setStreamFilter('all')}
          aria-label="Mostrar todos os participantes da sala"
        >
          <span>Todos</span>
          <span className="filter-count-badge">{totalCount}</span>
          <span className="custom-tooltip tooltip-compact">Mostrar todos os participantes ({totalCount})</span>
        </button>

        <button
          type="button"
          className={`btn-stream-filter ${streamFilter === 'streaming' ? 'active' : ''} custom-tooltip-container`}
          onClick={() => setStreamFilter(streamFilter === 'streaming' ? 'all' : 'streaming')}
          aria-label="Mostrar apenas participantes transmitindo tela"
        >
          <span className="filter-live-dot"></span>
          <span>Transmitindo</span>
          <span className="filter-count-badge">{streamingCount}</span>
          <span className="custom-tooltip tooltip-compact">Mostrar participantes transmitindo ({streamingCount})</span>
        </button>

        <button
          type="button"
          className={`btn-stream-filter ${streamFilter === 'watching' ? 'active' : ''} custom-tooltip-container`}
          onClick={() => setStreamFilter(streamFilter === 'watching' ? 'all' : 'watching')}
          aria-label="Mostrar apenas telas que você está assistindo"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8z"/>
            <circle cx="12" cy="12" r="3"/>
          </svg>
          <span>Assistindo</span>
          <span className="filter-count-badge">{watchingCount}</span>
          <span className="custom-tooltip tooltip-compact">Mostrar telas que você assiste ({watchingCount})</span>
        </button>
      </div>

      <div className="stream-actions">
        {/* Transmission Button */}
        <button
          className={`btn btn-sm btn-compact custom-tooltip-container ${isSharingScreen ? 'btn-danger' : 'btn-outline'}`}
          id="btn-toggle-share-screen"
          onClick={handleToggleTransmission}
          aria-label={isSharingScreen ? 'Parar Transmissão' : 'Transmitir'}
        >
          <span className={`stream-sharing-indicator ${isSharingScreen ? 'active' : ''}`} id="stream-sharing-dot"></span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M13 3H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-3"/>
            <path d="M8 21h8"/>
            <path d="M12 17v4"/>
            <path d="m17 8 5-5"/>
            <path d="M17 3h5v5"/>
          </svg>
          <span className="btn-text" id="label-share-screen">
            {isSharingScreen ? 'Parar Transmissão' : 'Transmitir'}
          </span>
          <span className="custom-tooltip tooltip-compact">
            {isSharingScreen ? 'Parar transmissão de tela' : 'Compartilhar Tela ou Janela'}
          </span>
        </button>

        {/* Audio Filter Config */}
        <button
          className="btn btn-sm btn-outline btn-compact custom-tooltip-container"
          id="btn-open-audio-filter"
          onClick={() => openModal('audioFilter')}
          aria-label="Configurar filtros de áudio"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="4" x2="4" y1="21" y2="14"/>
            <line x1="4" x2="4" y1="10" y2="3"/>
            <line x1="12" x2="12" y1="21" y2="12"/>
            <line x1="12" x2="12" y1="8" y2="3"/>
            <line x1="20" x2="20" y1="21" y2="16"/>
            <line x1="20" x2="20" y1="12" y2="3"/>
            <line x1="1" x2="7" y1="14" y2="14"/>
            <line x1="9" x2="15" y1="8" y2="8"/>
            <line x1="17" x2="23" y1="16" y2="16"/>
          </svg>
          <span className="btn-text">Áudio</span>
          <span className="custom-tooltip tooltip-compact">
            Configurar filtros de áudio (ignorar Discord)
          </span>
        </button>

        {/* Room Security / Password Button */}
        <button
          className="btn btn-sm btn-outline btn-compact custom-tooltip-container"
          id="btn-open-room-security"
          onClick={() => openModal('roomSecurity')}
          aria-label="Segurança da Sala"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
            <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
          </svg>
          <span className="btn-text" id="label-room-security">Senha</span>
          <span className="custom-tooltip tooltip-compact">
            Segurança da Sala (Definir / Alterar Senha)
          </span>
        </button>

        {/* Leave Room */}
        <button
          className="btn btn-sm btn-danger btn-compact custom-tooltip-container"
          id="btn-leave-room"
          onClick={leaveRoom}
          aria-label="Sair da Sala"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
            <polyline points="16 17 21 12 16 7"/>
            <line x1="21" x2="9" y1="12" y2="12"/>
          </svg>
          <span className="btn-text">Sair</span>
          <span className="custom-tooltip tooltip-compact tooltip-align-right">
            Sair da Sala
          </span>
        </button>
      </div>
    </div>
  );
};
