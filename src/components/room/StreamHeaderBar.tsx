import { stateStore } from '../../core/state_store';
import React, { useEffect, useState } from 'react';
import { roomAppsService } from '../../apps/room_apps_service';
import { useRoom } from '../../hooks/useRoom';
import { useModal } from '../../hooks/useModal';
import { useStore } from '../../hooks/useStore';
import { Tooltip } from '../common/Tooltip';
import { AppWindow, Square, ChevronDown, Camera, Monitor, Plus } from 'lucide-react';
import { useContextMenu, type ContextMenuAction } from '../common/ContextMenu';
import { roomService } from '../../services/room_service';

export const StreamHeaderBar: React.FC = () => {
  const [appCounts, setAppCounts] = useState(() => ({
    total: roomAppsService.getInstances().length,
    joined: roomAppsService.getJoinedInstances().length,
  }));
  useEffect(() => roomAppsService.subscribe(() => {
    const total = roomAppsService.getInstances().length;
    const joined = roomAppsService.getJoinedInstances().length;
    setAppCounts((previous) => previous.total === total && previous.joined === joined
      ? previous : { total, joined });
  }), []);
  const {
    roomSlots,
    leaveRoom,
    streamFilter,
    setStreamFilter,
  } = useRoom();
  const { openModal } = useModal();
  const openContextMenu = useContextMenu();
  const subscribedStreams = useStore((s) => s.subscribedStreams);

  const totalCount = roomSlots.length + appCounts.total;
  const isBroadcasting = roomSlots.some((slot) => slot.isLocal && slot.isStreaming);
  const streamingCount = roomSlots.filter((s) => s.isStreaming).length + appCounts.total;
  const watchingCount = roomSlots.filter(
    (s) => !s.isLocal && s.isStreaming && subscribedStreams.has(s.peerId)
  ).length + appCounts.joined;

  const startTransmission = () => {
    stateStore.set((state) => { state.editingStreamId = null; });
    openModal('screenPicker');
  };
  const handleToggleTransmission = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (!isBroadcasting) { startTransmission(); return; }
    const actions: ContextMenuAction[] = roomSlots
      .filter((slot) => slot.isLocal && slot.isStreaming && slot.mediaId)
      .map((slot) => {
        const label = slot.mediaLabel || (slot.mediaKind === 'camera' ? 'Câmera' : 'Tela');
        return { id: `edit-${slot.mediaId}`, label,
          icon: slot.mediaKind === 'camera' ? <Camera size={15} /> : <Monitor size={15} />,
          onSelect: () => { roomService.editTransmission(slot.mediaId!); openModal('screenPicker'); },
          secondary: { label: `Parar ${label}`, icon: <Square size={14} />, danger: true,
            onSelect: () => roomService.stopTransmission(slot.mediaId!) } };
      });
    actions.push({ id: 'new-transmission', label: 'Iniciar nova transmissão', icon: <Plus size={15} />,
      separator: true, onSelect: startTransmission });
    const bounds = event.currentTarget.getBoundingClientRect();
    openContextMenu({ currentTarget: event.currentTarget, clientX: bounds.left, clientY: bounds.bottom,
      preventDefault: () => event.preventDefault(), stopPropagation: () => event.stopPropagation() }, actions);
  };

  return (
    <div className="stream-header-bar">
      {/* Stream Filter Controls on Left */}
      <div className="stream-filter-group" role="group" aria-label="Filtro de visualização">
        <Tooltip content={`Mostrar todos os participantes (${totalCount})`}>
          <button
            type="button"
            className={`btn-stream-filter ${streamFilter === 'all' ? 'active' : ''}`}
            onClick={() => setStreamFilter('all')}
            aria-label="Mostrar todos os participantes da sala"
          >
            <span>Todos</span>
            <span className="filter-count-badge">{totalCount}</span>
          </button>
        </Tooltip>

        <Tooltip content={`Mostrar participantes transmitindo (${streamingCount})`}>
          <button
            type="button"
            className={`btn-stream-filter ${streamFilter === 'streaming' ? 'active' : ''}`}
            onClick={() => setStreamFilter(streamFilter === 'streaming' ? 'all' : 'streaming')}
            aria-label="Mostrar apenas participantes transmitindo tela"
          >
            <span className="filter-live-dot"></span>
            <span>Transmitindo</span>
            <span className="filter-count-badge">{streamingCount}</span>
          </button>
        </Tooltip>

        <Tooltip content={`Mostrar telas e atividades que você acompanha (${watchingCount})`}>
          <button
            type="button"
            className={`btn-stream-filter ${streamFilter === 'watching' ? 'active' : ''}`}
            onClick={() => setStreamFilter(streamFilter === 'watching' ? 'all' : 'watching')}
            aria-label="Mostrar apenas telas e atividades que você acompanha"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
            <span>Assistindo</span>
            <span className="filter-count-badge">{watchingCount}</span>
          </button>
        </Tooltip>
      </div>

      <div className="stream-actions">
        <Tooltip content="Abrir biblioteca de Apps">
          <button className="btn btn-sm btn-outline btn-compact" aria-label="Abrir Apps"
            onClick={() => openModal('apps')}><AppWindow size={14} strokeWidth={2} /><span className="btn-text">Apps</span></button>
        </Tooltip>
        {/* Transmission Button */}
        <Tooltip content={isBroadcasting ? 'Gerenciar transmissões' : 'Compartilhar tela, janela ou câmera'}>
          <button
            className="btn btn-sm btn-compact btn-outline"
            id="btn-toggle-share-screen"
            onClick={handleToggleTransmission}
            aria-label={isBroadcasting ? 'Gerenciar transmissões' : 'Transmitir'}
            aria-haspopup={isBroadcasting ? 'menu' : undefined}
          >
            <span className={`stream-sharing-indicator ${isBroadcasting ? 'active' : ''}`} id="stream-sharing-dot"></span>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M13 3H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-3" />
              <path d="M8 21h8" />
              <path d="M12 17v4" />
              <path d="m17 8 5-5" />
              <path d="M17 3h5v5" />
            </svg>
            <span className="btn-text" id="label-share-screen">
              {isBroadcasting ? 'Transmissão' : 'Transmitir'}
            </span>
            {isBroadcasting && <ChevronDown size={12} aria-hidden="true" />}
          </button>
        </Tooltip>

        {/* Audio Filter Config */}
        <Tooltip content="Configurar filtros de áudio">
          <button
            className="btn btn-sm btn-outline btn-compact"
            id="btn-open-audio-filter"
            onClick={() => openModal('audioFilter')}
            aria-label="Configurar filtros de áudio"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="4" x2="4" y1="21" y2="14" />
              <line x1="4" x2="4" y1="10" y2="3" />
              <line x1="12" x2="12" y1="21" y2="12" />
              <line x1="12" x2="12" y1="8" y2="3" />
              <line x1="20" x2="20" y1="21" y2="16" />
              <line x1="20" x2="20" y1="12" y2="3" />
              <line x1="1" x2="7" y1="14" y2="14" />
              <line x1="9" x2="15" y1="8" y2="8" />
              <line x1="17" x2="23" y1="16" y2="16" />
            </svg>
            <span className="btn-text">Áudio</span>
          </button>
        </Tooltip>

        {/* Room settings */}
        <Tooltip content="Configurações da Sala">
          <button
            className="btn btn-sm btn-outline btn-compact"
            id="btn-open-room-security"
            onClick={() => openModal('roomSecurity')}
            aria-label="Configurações da Sala"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
            <span className="btn-text" id="label-room-security">Sala</span>
          </button>
        </Tooltip>

        {/* Leave Room */}
        <Tooltip content="Sair da Sala">
          <button
            className="btn btn-sm btn-danger btn-compact"
            id="btn-leave-room"
            onClick={leaveRoom}
            aria-label="Sair da Sala"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" x2="9" y1="12" y2="12" />
            </svg>
            <span className="btn-text">Sair</span>
          </button>
        </Tooltip>
      </div>
    </div>
  );
};
