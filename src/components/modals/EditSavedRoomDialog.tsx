import { t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
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
  useLocale();
  const [name, setName] = useState(room.customName ?? room.name);
  const [nameCustomized, setNameCustomized] = useState(Boolean(room.customName));
  const [inviteCode, setInviteCode] = useState(room.invite);
  const [password, setPassword] = useState(room.password ?? '');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (busy) return;
    const nextName = name.trim();
    if (!nextName) { showToast(t("message.f8c6a5d991cd")); return; }
    const nextInvite = await verifyRoomInvite(inviteCode);
    if (!nextInvite) { showToast(t("message.5348364ca0b6")); return; }
    if (nextInvite.roomId === room.roomId &&
        nextInvite.rootKey !== parseRoomInvite(room.invite)?.rootKey) {
      showToast(t("message.fc11d706c669"));
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
        showToast(t("message.e3fc89f91ba3"));
        return;
      }
      const nextPassword = password.trim();
      if (nextInvite.roomId !== room.roomId) {
        if (await savedRooms.get(nextInvite.roomId)) {
          showToast(t("message.da8fbc860300"));
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
      showToast(t("message.029c27a8024d"));
      onClose();
    } catch (error) {
      console.warn('[Rooms] Could not edit saved room:', error);
      showToast(t("message.d94a6e24bf10"));
    } finally {
      setBusy(false);
    }
  };

  const { submit, pending } = useFormSubmit(save);

  return createPortal(
    <div className="modal-overlay" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <form autoComplete="off" onSubmit={submit} aria-busy={pending} className="modal-card" role="dialog" aria-modal="true" aria-labelledby="edit-saved-room-title">
        <div className="modal-header">
          <div><h2 id="edit-saved-room-title">{t("message.4c6b05644363")}</h2></div>
          <button type="button" className="btn-close" aria-label={t("message.0f2bd88ef0ac")} onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          <div className="form-group">
            <label className="form-label" htmlFor="saved-room-name">{t("message.5086900635fe")}</label>
            <input autoComplete="off" className="text-input" id="saved-room-name" maxLength={80}
              value={name} onChange={(event) => {
                setName(event.target.value);
                setNameCustomized(true);
              }} autoFocus />
          </div>
          <div className="form-group saved-room-form-field">
            <label className="form-label" htmlFor="saved-room-invite">{t("message.f0d3f5598471")}</label>
            <input autoComplete="off" className="text-input" id="saved-room-invite" value={inviteCode}
              onChange={(event) => setInviteCode(event.target.value)} />
          </div>
          <div className="form-group saved-room-edit-password">
            <label className="form-label" htmlFor="saved-room-password">{t("message.5e9be5241e3a")}</label>
            <div className="input-with-action">
              <input autoComplete="off" className="text-input" id="saved-room-password" maxLength={128}
                type={showPassword ? 'text' : 'password'} value={password}
                placeholder={t("message.1de741ddd83f")}
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
          <button type="button" className="btn btn-secondary" onClick={onClose}>{t("message.bb9dbb406dcb")}</button>
          <button type="submit" className="btn btn-primary" disabled={busy || pending}>{t("message.aef7cd5b2081")}</button>
        </div>
      </form>
    </div>, document.body,
  );
};
