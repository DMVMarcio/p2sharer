import { roomService } from '../../services/room_service';
import { NicknameField } from '../common/NicknameField';
import { NICKNAME_STYLE_KEY } from '../../core/nickname_style';
import { t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import React, { useState } from 'react';
import { useFormSubmit } from '../../hooks/useFormSubmit';
import { useModal } from '../../hooks/useModal';
import { stateStore } from '../../core/state_store';
import { showToast } from '../../hooks/useToast';

export const UsernameModal: React.FC = () => {
  useLocale();
  const [nicknameStyle, setNicknameStyle] = useState(() => stateStore.nicknameStyle);
  const { closeModal, isClosing } = useModal();
  const [val, setVal] = useState(
    () => stateStore.username || `User_${Math.floor(1000 + Math.random() * 9000)}`
  );

  const handleSave = () => {
    const trimmed = val.trim();
    if (!trimmed) {
      showToast(t("message.6e96f7800777"));
      return;
    }
    stateStore.set((s) => {
      s.username = trimmed;
      s.nicknameStyle = nicknameStyle;
    });
    localStorage.setItem('p2sharer_username', trimmed);
    localStorage.setItem(NICKNAME_STYLE_KEY, JSON.stringify(nicknameStyle));
    roomService.roomManager?.refreshProfile();
    closeModal();
    showToast(t("message.de936d0d1b4d", { v0: trimmed }));
  };

  const { submit, pending } = useFormSubmit(handleSave, isClosing);

  return (
    <div className={`modal-overlay ${isClosing ? 'closing' : ''}`} id="modal-username">
      <form autoComplete="off" onSubmit={submit} aria-busy={pending} className="modal-card">
        <div className="modal-header">
          <div className="modal-header-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/>
              <circle cx="12" cy="7" r="4"/>
            </svg>
          </div>
          <h2>{t("message.9e74ff12ab50")}</h2>
        </div>
        <div className="modal-body">
          <p>{t("message.647904045700")}</p>
          <NicknameField id="input-username" name={val} onNameChange={setVal} appearance={nicknameStyle}
            onAppearanceChange={setNicknameStyle} placeholder={t("message.6541e1023005")} autoFocus disabled={pending || isClosing} />
        </div>
        <div className="modal-footer">
          <button className="btn btn-primary" id="btn-save-username" type="submit" disabled={pending || isClosing}>
            {t("message.63e2bbaf1c92")}</button>
        </div>
      </form>
    </div>
  );
};
