import React, { useState } from 'react';
import { useModal } from '../../hooks/useModal';
import { useRoom } from '../../hooks/useRoom';
import { showToast } from '../../hooks/useToast';

export const RoomSecurityModal: React.FC = () => {
  const { closeModal, isClosing } = useModal();
  const { currentRoomCode, currentRoomInvite, currentRoomPassword, updateRoomPassword, isRoomHost } = useRoom();

  const [password, setPassword] = useState(() => currentRoomPassword);
  const [showPassword, setShowPassword] = useState(false);

  const handleSave = async () => {
    if (!isRoomHost) { showToast('Somente o anfitrião pode alterar a senha da sala.'); return; }
    const finalPass = password.trim();
    const oldPassword = currentRoomPassword;

    if (!await updateRoomPassword(finalPass)) { showToast('Não foi possível alterar a senha da sala.'); return; }
    closeModal();

    if (finalPass) {
      showToast('Senha da sala alterada e sincronizada com os participantes.', 4000);
    } else if (oldPassword && !finalPass) {
      showToast('Senha removida: a sala agora é pública.', 4000);
    } else {
      showToast('Configurações de segurança da sala salvas.');
    }
  };

  return (
    <div className={`modal-overlay ${isClosing ? 'closing' : ''}`} id="modal-room-security">
      <div className="modal-card">
        <div className="modal-header">
          <div className="modal-header-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
              <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
            </svg>
          </div>
          <div>
            <h2>Configurações da Sala</h2>
            <p className="modal-subtitle">
              Consulte o convite e configure o acesso.
            </p>
          </div>
          <button className="btn-close" id="btn-close-room-security" onClick={closeModal}>
            &times;
          </button>
        </div>

        <div className="modal-body">
          <div className="room-security-info-box">
            <div className="security-info-row">
              <span className="security-info-label">Identificador:</span>
              <span className="security-info-value" id="sec-modal-room-code">
                {currentRoomCode}
              </span>
            </div>
            <div className="security-info-row">
              <span className="security-info-label">Status Atual:</span>
              <span className="security-info-status" id="sec-modal-current-status">
                {currentRoomPassword ? (
                  <>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                      <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                    </svg>
                    <span>Protegida por senha</span>
                  </>
                ) : (
                  <>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                      <path d="M7 11V7a5 5 0 0 1 9.9-1"/>
                    </svg>
                    <span>Pública (Sem Senha)</span>
                  </>
                )}
              </span>
            </div>
          </div>

          {currentRoomInvite && <div className="room-save-controls">
            <button className="btn btn-secondary" onClick={() => {
              void navigator.clipboard.writeText(currentRoomInvite).then(() => showToast('Convite copiado!'));
            }}>Copiar convite</button>
          </div>}

          <div className="form-group" style={{ marginTop: '16px' }}>
            <label className="form-label" htmlFor="input-room-security-password">
              <span>Nova Senha da Sala:</span>
              <span className="label-hint">Deixe vazio para tornar pública</span>
            </label>
            <div className="input-with-action">
              <input
                type={showPassword ? 'text' : 'password'}
                id="input-room-security-password"
                className="text-input"
                placeholder="Digite uma nova senha..."
                maxLength={40}
                disabled={!isRoomHost}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSave();
                }}
                autoFocus
              />
              <button
                type="button"
                className="btn btn-sm btn-outline btn-inline-action"
                id="btn-toggle-security-password-visibility"
                aria-label="Mostrar / Ocultar Senha"
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
            {!isRoomHost && <p className="field-info-text">Somente o anfitrião pode alterar a senha da sala.</p>}
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn btn-secondary" id="btn-cancel-room-security" onClick={closeModal}>
            Fechar
          </button>
          <button className="btn btn-primary" id="btn-save-room-security" onClick={() => void handleSave()} disabled={!isRoomHost}>
            <span>Atualizar Senha da Sala</span>
          </button>
        </div>
      </div>
    </div>
  );
};
