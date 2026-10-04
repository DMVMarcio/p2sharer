import { t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import React, { useState } from 'react';
import { useFormSubmit } from '../../hooks/useFormSubmit';
import { useModal } from '../../hooks/useModal';
import { useRoom } from '../../hooks/useRoom';
import { showToast } from '../../hooks/useToast';

export const RoomSecurityModal: React.FC = () => {
  useLocale();
  const { closeModal, isClosing } = useModal();
  const { currentRoomCode, currentRoomName, currentRoomPassword,
    updateRoomName, updateRoomPassword, isRoomHost } = useRoom();

  const [name, setName] = useState(() => currentRoomName);
  const [password, setPassword] = useState(() => currentRoomPassword);
  const [showPassword, setShowPassword] = useState(false);

  const handleSave = async () => {
    if (!isRoomHost) { showToast(t("message.d5b821ebbd15")); return; }
    const finalName = name.trim();
    if (!finalName || finalName.length > 80) { showToast(t("message.e7b0dfd1473f")); return; }
    const finalPass = password.trim();
    const oldPassword = currentRoomPassword;

    if (finalName !== currentRoomName && !await updateRoomName(finalName)) {
      showToast(t("message.02a4133c9995")); return;
    }
    if (finalPass !== oldPassword && !await updateRoomPassword(finalPass)) {
      showToast(t("message.7a7e235c15fa")); return;
    }
    closeModal();

    if (finalPass) {
      showToast(t("message.89f84f0bf28a"), 4000);
    } else if (oldPassword && !finalPass) {
      showToast(t("message.8374fc2ef03e"), 4000);
    } else {
      showToast(t("message.2c4bbfd95e13"));
    }
  };

  const { submit, pending } = useFormSubmit(handleSave, isClosing);

  return (
    <div className={`modal-overlay ${isClosing ? 'closing' : ''}`} id="modal-room-security">
      <form autoComplete="off" onSubmit={submit} aria-busy={pending} className="modal-card">
        <div className="modal-header">
          <div className="modal-header-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
              <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
            </svg>
          </div>
          <div>
            <h2>{t("message.7efe8d00498f")}</h2>
            <p className="modal-subtitle">
              {t("message.f14c5062b294")}</p>
          </div>
          <button type="button" className="btn-close" id="btn-close-room-security" onClick={closeModal}>
            &times;
          </button>
        </div>

        <div className="modal-body">
          <div className="room-security-info-box">
            <div className="security-info-row">
              <span className="security-info-label">{t("message.d14c1f4dfb99")}</span>
              <span className="security-info-value" id="sec-modal-room-code">
                {currentRoomCode}
              </span>
            </div>
            <div className="security-info-row">
              <span className="security-info-label">{t("message.f997e78693a1")}</span>
              <span className="security-info-status" id="sec-modal-current-status">
                {currentRoomPassword ? (
                  <>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                      <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                    </svg>
                    <span>{t("message.b7ceb0729ce2")}</span>
                  </>
                ) : (
                  <>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                      <path d="M7 11V7a5 5 0 0 1 9.9-1"/>
                    </svg>
                    <span>{t("message.e941f7b734a0")}</span>
                  </>
                )}
              </span>
            </div>
          </div>

          <div className="form-group" style={{ marginTop: '16px' }}>
            <label className="form-label" htmlFor="input-room-security-name">{t("message.c59a35b4105b")}</label>
            <input autoComplete="off" id="input-room-security-name" className="text-input" maxLength={80}
              value={name} disabled={!isRoomHost}
              onChange={(event) => setName(event.target.value)} />
          </div>

          <div className="form-group" style={{ marginTop: '16px' }}>
            <label className="form-label" htmlFor="input-room-security-password">
              <span>{t("message.732368bacb17")}</span>
              <span className="label-hint">{t("message.cfc15aaf818e")}</span>
            </label>
            <div className="input-with-action">
              <input autoComplete="off"
                type={showPassword ? 'text' : 'password'}
                id="input-room-security-password"
                className="text-input"
                placeholder={t("message.a25d2dda8036")}
                maxLength={40}
                disabled={!isRoomHost}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
              />
              <button
                type="button"
                className="btn btn-sm btn-outline btn-inline-action"
                id="btn-toggle-security-password-visibility"
                aria-label={t("message.d7d229c67924")}
                onClick={() => setShowPassword(!showPassword)}
              >
                <span id="icon-sec-pass-toggle">
                  {showPassword ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
                      <line x1="1" y1="1" x2="23" y2="23"/>
                    </svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                      <circle cx="12" cy="12" r="3"/>
                    </svg>
                  )}
                </span>
              </button>
            </div>
            {!isRoomHost && <p className="field-info-text">{t("message.d5b821ebbd15")}</p>}
          </div>
        </div>

        <div className="modal-footer">
          <button type="button" className="btn btn-secondary" id="btn-cancel-room-security" onClick={closeModal}>
            {t("message.0f2bd88ef0ac")}</button>
          <button className="btn btn-primary" id="btn-save-room-security" type="submit" disabled={pending || isClosing || !isRoomHost}>
            <span>{t("message.aa8464858f9e")}</span>
          </button>
        </div>
      </form>
    </div>
  );
};
