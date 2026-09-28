import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { parseRoomInvite } from '../../core/room_invite';
import { savedRooms, type SavedRoom } from '../../core/saved_rooms';
import { showToast } from '../../hooks/useToast';

interface RoomSaveDialogProps {
  invite: string;
  password: string;
  record: SavedRoom | null;
  onClose: () => void;
}

export const RoomSaveDialog: React.FC<RoomSaveDialogProps> = ({ invite, password, record, onClose }) => {
  const [rememberPassword, setRememberPassword] = useState(record?.password !== undefined);
  const [busy, setBusy] = useState(false);
  const roomId = parseRoomInvite(invite)?.roomId;

  const updateSaved = async (saved: boolean) => {
    if (!roomId || busy) return;
    setBusy(true);
    try {
      const current = await savedRooms.get(roomId);
      if (!current) throw new Error('Room record is missing');
      await savedRooms.put({ ...current, saved,
        password: saved && rememberPassword && password ? password : undefined });
      showToast(saved ? 'Sala salva neste dispositivo.' : 'Sala removida das salvas.');
      onClose();
    } catch (error) {
      console.warn('[Rooms] Could not update saved room:', error);
      showToast('Não foi possível atualizar a sala salva.');
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="modal-overlay" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div className="modal-card room-save-dialog" role="dialog" aria-modal="true" aria-labelledby="room-save-title">
        <div className="modal-header">
          <div>
            <h2 id="room-save-title">{record?.saved ? 'Sala salva' : 'Salvar sala'}</h2>
            <p className="modal-subtitle">Acesse esta sala pela tela inicial.</p>
          </div>
          <button type="button" className="btn-close" aria-label="Fechar" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          {password && <label className="form-label room-remember-password">
            <input type="checkbox" checked={rememberPassword}
              onChange={(event) => setRememberPassword(event.target.checked)} />
            Lembrar senha para entrar automaticamente
          </label>}
        </div>
        <div className="modal-footer">
          {record?.saved && <button type="button" className="btn btn-secondary" disabled={busy}
            onClick={() => void updateSaved(false)}>Remover das salvas</button>}
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancelar</button>
          <button type="button" className="btn btn-primary" disabled={busy}
            onClick={() => void updateSaved(true)}>{record?.saved ? 'Salvar alterações' : 'Salvar sala'}</button>
        </div>
      </div>
    </div>, document.body,
  );
};
