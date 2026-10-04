import React, { useEffect, useState } from 'react';
import { useRoom } from '../../hooks/useRoom';
import { useModal } from '../../hooks/useModal';
import { showToast } from '../../hooks/useToast';
import { Tooltip } from '../common/Tooltip';
import { BookmarkCheck, BookmarkPlus } from 'lucide-react';
import { parseRoomInvite } from '../../core/room_invite';
import { savedRooms, type SavedRoom } from '../../core/saved_rooms';
import { useAppUpdates } from '../../hooks/useAppUpdates';
import { appUpdates } from '../../services/app_updates';

export const AppHeader: React.FC = () => {
  const update = useAppUpdates();
  const { currentRoomCode, currentRoomInvite, currentRoomName, currentRoomPassword, username, isInRoom } = useRoom();
  const { openModal } = useModal();
  const [savedRecord, setSavedRecord] = useState<SavedRoom | null>(null);
  const [savingRoom, setSavingRoom] = useState(false);

  useEffect(() => {
    const roomId = parseRoomInvite(currentRoomInvite)?.roomId;
    let active = true;
    const reload = () => {
      if (!roomId) { setSavedRecord(null); return; }
      void savedRooms.get(roomId).then((record) => {
        if (active) setSavedRecord(record ?? null);
      }).catch((error) => console.warn('[Rooms] Could not load room save state:', error));
    };
    reload();
    const unsubscribe = savedRooms.subscribe(reload);
    return () => { active = false; unsubscribe(); };
  }, [currentRoomInvite]);

  const handleCopyRoomCode = () => {
    const copyText = currentRoomInvite || currentRoomCode;
    navigator.clipboard
      .writeText(copyText)
      .then(() => showToast('Código copiado!'))
      .catch(() => {});
  };

  const toggleSavedRoom = async () => {
    const roomId = parseRoomInvite(currentRoomInvite)?.roomId;
    if (!roomId || savingRoom) return;
    setSavingRoom(true);
    try {
      const record = await savedRooms.get(roomId);
      if (!record) throw new Error('Room record is missing');
      const saved = !record.saved;
      await savedRooms.put({ ...record, saved, password: saved ? record.password : undefined });
      showToast(saved ? 'Sala salva neste dispositivo.' : 'Sala removida das salvas.');
    } catch (error) {
      console.warn('[Rooms] Could not toggle saved room:', error);
      showToast('Não foi possível atualizar a sala salva.');
    } finally {
      setSavingRoom(false);
    }
  };

  return (
    <header className="app-header" data-tauri-drag-region>
      <div className="header-room-info">
        {isInRoom && (
          <Tooltip
            content={`Copiar convite autenticado (${currentRoomName || currentRoomCode})`}
          >
            <button
              className="room-code-header-pill"
              id="header-room-code-pill"
              onClick={handleCopyRoomCode}
              aria-label="Copiar convite da sala"
            >
              <span className="header-pill-label">SALA</span>
              <strong id="display-room-code">{currentRoomName || currentRoomCode}</strong>
              <span
                className="room-lock-icon"
                id="header-room-lock-icon"
              >
                {currentRoomPassword ? (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                    <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                  </svg>
                ) : (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
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
          </Tooltip>
        )}
        {isInRoom && currentRoomInvite && (
          <Tooltip content={savedRecord?.saved ? 'Remover sala das salvas' : 'Salvar sala neste dispositivo'}>
            <button className={`btn-icon-header ${savedRecord?.saved ? 'is-saved' : ''}`}
              onClick={() => void toggleSavedRoom()}
              aria-label={savedRecord?.saved ? 'Remover sala das salvas' : 'Salvar sala'}
              aria-pressed={Boolean(savedRecord?.saved)} disabled={savingRoom || !savedRecord}>
              {savedRecord?.saved ? <BookmarkCheck size={16} /> : <BookmarkPlus size={16} />}
            </button>
          </Tooltip>
        )}

        {update.version && <Tooltip content={`Atualização ${update.version} disponível`}>
          <button type="button" className="btn btn-secondary btn-sm app-update-badge"
            onClick={appUpdates.open} aria-label={`Atualização ${update.version} disponível`}>
            Atualização
          </button>
        </Tooltip>}
      </div>

      <div className="header-user-info">
        <button
          className="user-pill"
          id="user-pill"
          onClick={() => openModal('settings')}
          aria-label="Configurações e Perfil"
        >
          <span className="user-status-dot"></span>
          <span id="current-username-display">{username || 'Usuário'}</span>
        </button>

        <button
          className="btn-icon-header"
          id="btn-open-settings"
          onClick={() => openModal('settings')}
          aria-label="Configurações"
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
