import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { Eye, EyeOff } from 'lucide-react';
import { savedRooms, type SavedRoom } from '../../core/saved_rooms';
import { compareRoomInvites, parseRoomInvite } from '../../core/room_invite';
import { verifyRoomInvite } from '../../core/room_invite_validation';
import { showToast } from '../../hooks/useToast';
import { useFormSubmit } from '../../hooks/useFormSubmit';

interface EditSavedRoomDialogProps {
  room: SavedRoom;
  onClose: () => void;
}

export const EditSavedRoomDialog: React.FC<EditSavedRoomDialogProps> = ({ room, onClose }) => {
  const [name, setName] = useState(room.customName ?? room.name);
  const [nameCustomized, setNameCustomized] = useState(Boolean(room.customName));
  const [inviteCode, setInviteCode] = useState(room.invite);
  const [password, setPassword] = useState(room.password ?? '');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (busy) return;
    const nextName = name.trim();
    if (!nextName) { showToast('Digite um nome para a sala.'); return; }
    const nextInvite = await verifyRoomInvite(inviteCode);
    if (!nextInvite) { showToast('Cole um convite autenticado válido.'); return; }
    if (nextInvite.roomId === room.roomId &&
        nextInvite.rootKey !== parseRoomInvite(room.invite)?.rootKey) {
      showToast('Este identificador pertence a outra identidade de sala.');
      return;
    }
    setBusy(true);
    try {
      const current = await savedRooms.get(room.roomId);
      if (!current) throw new Error('Room record is missing');
      const currentInvite = parseRoomInvite(current.invite)!;
      const versionOrder = compareRoomInvites(nextInvite, currentInvite);
      if (nextInvite.roomId === room.roomId && (versionOrder < 0 ||
          (versionOrder === 0 && inviteCode.trim() !== current.invite))) {
        showToast('Este convite é anterior à versão salva neste dispositivo.');
        return;
      }
      const nextPassword = password.trim();
      if (nextInvite.roomId !== room.roomId) {
        if (await savedRooms.get(nextInvite.roomId)) {
          showToast('Este convite já pertence a outra sala salva.');
          return;
        }
        await savedRooms.put({ roomId: nextInvite.roomId, invite: inviteCode.trim(),
          name: nextInvite.version === 4 ? nextInvite.name : nextInvite.roomId.slice(0, 8),
          customName: nameCustomized ? nextName : undefined,
          saved: true, owned: false, protected: true,
          password: nextPassword || undefined });
        if (current.owned) {
          await savedRooms.put({ ...current, saved: false });
        } else {
          await savedRooms.remove(current.roomId);
        }
      } else {
        await savedRooms.put({ ...current, invite: inviteCode.trim(),
          name: nextInvite.version === 4 ? nextInvite.name : current.name,
          customName: nameCustomized ? nextName : undefined,
          password: nextPassword || undefined,
          protected: Boolean(nextPassword) || current.protected });
      }
      showToast('Sala salva atualizada.');
      onClose();
    } catch (error) {
      console.warn('[Rooms] Could not edit saved room:', error);
      showToast('Não foi possível atualizar a sala salva.');
    } finally {
      setBusy(false);
    }
  };

  const { submit, pending } = useFormSubmit(save);

  return createPortal(
    <div className="modal-overlay" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <form onSubmit={submit} aria-busy={pending} className="modal-card" role="dialog" aria-modal="true" aria-labelledby="edit-saved-room-title">
        <div className="modal-header">
          <div><h2 id="edit-saved-room-title">Editar sala salva</h2></div>
          <button type="button" className="btn-close" aria-label="Fechar" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          <div className="form-group">
            <label className="form-label" htmlFor="saved-room-name">Nome</label>
            <input className="text-input" id="saved-room-name" maxLength={80}
              value={name} onChange={(event) => {
                setName(event.target.value);
                setNameCustomized(true);
              }} autoFocus />
          </div>
          <div className="form-group saved-room-form-field">
            <label className="form-label" htmlFor="saved-room-invite">Código de convite</label>
            <input className="text-input" id="saved-room-invite" value={inviteCode}
              onChange={(event) => setInviteCode(event.target.value)} />
          </div>
          <div className="form-group saved-room-edit-password">
            <label className="form-label" htmlFor="saved-room-password">Senha salva para entrar</label>
            <div className="input-with-action">
              <input className="text-input" id="saved-room-password" maxLength={128}
                type={showPassword ? 'text' : 'password'} value={password}
                placeholder="Deixe vazio para não lembrar"
                onChange={(event) => setPassword(event.target.value)} />
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
          <button type="submit" className="btn btn-primary" disabled={busy || pending}>Salvar</button>
        </div>
      </form>
    </div>, document.body,
  );
};
