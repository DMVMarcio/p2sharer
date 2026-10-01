import React, { useState } from 'react';
import { BookmarkPlus, Eye, EyeOff } from 'lucide-react';
import { compareRoomInvites, parseRoomInvite } from '../../core/room_invite';
import { verifyRoomInvite } from '../../core/room_invite_validation';
import { savedRooms } from '../../core/saved_rooms';
import { useFormSubmit } from '../../hooks/useFormSubmit';
import { useModal } from '../../hooks/useModal';
import { showToast } from '../../hooks/useToast';

export const SaveInviteModal: React.FC = () => {
  const { closeModal, isClosing } = useModal();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (busy) return;
    const invite = await verifyRoomInvite(code);
    if (!invite) { showToast('Cole um convite autenticado válido.'); return; }
    setBusy(true);
    try {
      const existing = await savedRooms.get(invite.roomId);
      if (existing && parseRoomInvite(existing.invite)?.rootKey !== invite.rootKey) {
        showToast('Este identificador já está salvo com outra identidade de sala.');
        return;
      }
      const remembered = password.trim() || existing?.password;
      const existingInvite = existing ? parseRoomInvite(existing.invite) : null;
      const versionOrder = existingInvite ? compareRoomInvites(existingInvite, invite) : -1;
      if (versionOrder === 0 && existing?.invite !== code.trim()) {
        showToast('Esta versão do convite não corresponde à sala salva.');
        return;
      }
      const retainNewer = versionOrder >= 0;
      await savedRooms.put({
        ...existing,
        roomId: invite.roomId,
        invite: retainNewer ? existing!.invite : code.trim(),
        name: retainNewer ? existing!.name : invite.version === 4 ? invite.name : existing?.name ?? invite.roomId.slice(0, 8),
        customName: name.trim() || existing?.customName,
        saved: true,
        owned: existing?.owned ?? false,
        protected: existing?.protected ?? true,
        password: remembered,
      });
      closeModal();
      showToast('Convite salvo neste dispositivo.');
    } catch (error) {
      console.error('[Rooms] Could not save invitation:', error);
      showToast('Não foi possível salvar o convite.');
    } finally {
      setBusy(false);
    }
  };

  const { submit, pending } = useFormSubmit(save, isClosing);

  return (
    <div className={`modal-overlay ${isClosing ? 'closing' : ''}`}>
      <form onSubmit={submit} aria-busy={pending} className="modal-card" role="dialog" aria-modal="true" aria-labelledby="save-invite-title">
        <div className="modal-header">
          <div className="modal-header-icon"><BookmarkPlus size={20} /></div>
          <div>
            <h2 id="save-invite-title">Salvar convite</h2>
            <p className="modal-subtitle">Guarde uma sala para entrar depois.</p>
          </div>
          <button type="button" className="btn-close" aria-label="Fechar" onClick={closeModal}>&times;</button>
        </div>
        <div className="modal-body">
          <div className="form-group">
            <label className="form-label" htmlFor="save-invite-code">Código de convite</label>
            <input className="text-input" id="save-invite-code" value={code}
              placeholder="Cole o convite p2s4..." autoFocus
              onChange={(event) => setCode(event.target.value)} />
          </div>
          <div className="form-group saved-room-form-field">
            <label className="form-label" htmlFor="save-invite-name">Nome neste dispositivo (opcional)</label>
            <input className="text-input" id="save-invite-name" maxLength={80} value={name}
              onChange={(event) => setName(event.target.value)} />
          </div>
          <div className="form-group saved-room-form-field">
            <label className="form-label" htmlFor="save-invite-password">Senha para entrada automática (opcional)</label>
            <div className="input-with-action">
              <input className="text-input" id="save-invite-password" maxLength={128}
                type={showPassword ? 'text' : 'password'} value={password}
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
          <button type="button" className="btn btn-secondary" onClick={closeModal}>Cancelar</button>
          <button type="submit" className="btn btn-primary" disabled={busy || pending || isClosing}>
            Salvar convite
          </button>
        </div>
      </form>
    </div>
  );
};
