import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { Eye, EyeOff } from 'lucide-react';
import { savedRooms, type SavedRoom } from '../../core/saved_rooms';
import { showToast } from '../../hooks/useToast';

interface EditSavedRoomDialogProps {
  room: SavedRoom;
  onClose: () => void;
}

export const EditSavedRoomDialog: React.FC<EditSavedRoomDialogProps> = ({ room, onClose }) => {
  const [name, setName] = useState(room.name);
  const [password, setPassword] = useState(room.password ?? '');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (busy) return;
    const nextName = name.trim();
    if (!nextName) { showToast('Digite um nome para a sala.'); return; }
    setBusy(true);
    try {
      const current = await savedRooms.get(room.roomId);
      if (!current) throw new Error('Room record is missing');
      const nextPassword = password.trim();
      await savedRooms.put({ ...current, name: nextName,
        password: nextPassword || undefined,
        protected: Boolean(nextPassword) || current.protected });
      showToast('Sala salva atualizada.');
      onClose();
    } catch (error) {
      console.warn('[Rooms] Could not edit saved room:', error);
      showToast('Não foi possível atualizar a sala salva.');
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="modal-overlay" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="edit-saved-room-title">
        <div className="modal-header">
          <div><h2 id="edit-saved-room-title">Editar sala salva</h2></div>
          <button type="button" className="btn-close" aria-label="Fechar" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          <div className="form-group">
            <label className="form-label" htmlFor="saved-room-name">Nome</label>
            <input className="text-input" id="saved-room-name" maxLength={80}
              value={name} onChange={(event) => setName(event.target.value)} autoFocus />
          </div>
          <div className="form-group saved-room-edit-password">
            <label className="form-label" htmlFor="saved-room-password">Senha salva para entrar</label>
            <div className="input-with-action">
              <input className="text-input" id="saved-room-password" maxLength={128}
                type={showPassword ? 'text' : 'password'} value={password}
                placeholder="Deixe vazio para não lembrar"
                onChange={(event) => setPassword(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') void save(); }} />
              <button type="button" className="btn btn-sm btn-outline btn-inline-action btn-inline-action-icon"
                aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'}
                onClick={() => setShowPassword(!showPassword)}>
                {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancelar</button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save()}>Salvar</button>
        </div>
      </div>
    </div>, document.body,
  );
};
