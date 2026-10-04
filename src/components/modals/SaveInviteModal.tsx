import { t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import React, { useState } from 'react';
import { BookmarkPlus, Eye, EyeOff } from 'lucide-react';
import { compareRoomInvites, parseRoomInvite } from '../../core/room_invite';
import { verifyRoomInvite } from '../../core/room_invite_validation';
import { savedRooms } from '../../core/saved_rooms';
import { useFormSubmit } from '../../hooks/useFormSubmit';
import { useModal } from '../../hooks/useModal';
import { showToast } from '../../hooks/useToast';

export const SaveInviteModal: React.FC = () => {
  useLocale();
  const { closeModal, isClosing } = useModal();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (busy) return;
    const invite = await verifyRoomInvite(code);
    if (!invite) { showToast(t("message.5348364ca0b6")); return; }
    setBusy(true);
    try {
      const existing = await savedRooms.get(invite.roomId);
      if (existing && parseRoomInvite(existing.invite)?.rootKey !== invite.rootKey) {
        showToast(t("message.801d8b7098fe"));
        return;
      }
      const remembered = password.trim() || existing?.password;
      const existingInvite = existing ? parseRoomInvite(existing.invite) : null;
      const versionOrder = existingInvite ? compareRoomInvites(existingInvite, invite) : -1;
      if (versionOrder === 0 && existing?.invite !== code.trim()) {
        showToast(t("message.3b1c350d9ca6"));
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
      showToast(t("message.14005848dc1b"));
    } catch (error) {
      console.error('[Rooms] Could not save invitation:', error);
      showToast(t("message.657f2b97bedf"));
    } finally {
      setBusy(false);
    }
  };

  const { submit, pending } = useFormSubmit(save, isClosing);

  return (
    <div className={`modal-overlay ${isClosing ? 'closing' : ''}`}>
      <form autoComplete="off" onSubmit={submit} aria-busy={pending} className="modal-card" role="dialog" aria-modal="true" aria-labelledby="save-invite-title">
        <div className="modal-header">
          <div className="modal-header-icon"><BookmarkPlus size={20} /></div>
          <div>
            <h2 id="save-invite-title">{t("message.2e84ec959672")}</h2>
            <p className="modal-subtitle">{t("message.f69356539a53")}</p>
          </div>
          <button type="button" className="btn-close" aria-label={t("message.0f2bd88ef0ac")} onClick={closeModal}>&times;</button>
        </div>
        <div className="modal-body">
          <div className="form-group">
            <label className="form-label" htmlFor="save-invite-code">{t("message.f0d3f5598471")}</label>
            <input autoComplete="off" className="text-input" id="save-invite-code" value={code}
              placeholder={t("message.7202cdb2b6f5")} autoFocus
              onChange={(event) => setCode(event.target.value)} />
          </div>
          <div className="form-group saved-room-form-field">
            <label className="form-label" htmlFor="save-invite-name">{t("message.6611aa8abff0")}</label>
            <input autoComplete="off" className="text-input" id="save-invite-name" maxLength={80} value={name}
              onChange={(event) => setName(event.target.value)} />
          </div>
          <div className="form-group saved-room-form-field">
            <label className="form-label" htmlFor="save-invite-password">{t("message.2734fc1fb054")}</label>
            <div className="input-with-action">
              <input autoComplete="off" className="text-input" id="save-invite-password" maxLength={128}
                type={showPassword ? 'text' : 'password'} value={password}
                onChange={(event) => setPassword(event.target.value)} />
              <button type="button" className="btn btn-sm btn-outline btn-inline-action btn-inline-action-icon"
                aria-label={showPassword ? t("message.cc92e25d5427") : t("message.1f16e9e90444")}
                onClick={() => setShowPassword(!showPassword)}>
                {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button type="button" className="btn btn-secondary" onClick={closeModal}>{t("message.bb9dbb406dcb")}</button>
          <button type="submit" className="btn btn-primary" disabled={busy || pending || isClosing}>
            {t("message.2e84ec959672")}</button>
        </div>
      </form>
    </div>
  );
};
