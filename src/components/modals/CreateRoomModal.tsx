import React, { useState, useEffect } from 'react';
import { useModal } from '../../hooks/useModal';
import { useRoom } from '../../hooks/useRoom';
import { generateRandomRoomSlug } from '../../p2p/group_room';
import { showToast } from '../../hooks/useToast';

export const CreateRoomModal: React.FC = () => {
  const { isOpen, closeModal } = useModal();
  const { joinRoom } = useRoom();

  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    if (isOpen('createRoom')) {
      setCode(generateRandomRoomSlug());
      setPassword('');
      setShowPassword(false);
    }
  }, [isOpen]);

  if (!isOpen('createRoom')) return null;

  const handleRegenCode = () => {
    setCode(generateRandomRoomSlug());
  };

  const handleConfirm = () => {
    const finalCode = code.trim() || generateRandomRoomSlug();
    const finalPass = password.trim();

    closeModal();
    joinRoom(finalCode, finalPass, true);

    if (finalPass) {
      showToast(`Sala "${finalCode}" criada com proteção por senha!`);
    } else {
      showToast(`Sala "${finalCode}" criada!`);
    }
  };

  return (
    <div className="modal-overlay" id="modal-create-room-dialog">
      <div className="modal-card">
        <div className="modal-header">
          <div className="modal-header-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
              <circle cx="9" cy="7" r="4"/>
              <path d="M22 21v-2a4 4 0 0 0-3-3.87"/>
              <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
            </svg>
          </div>
          <div>
            <h2>Criar Nova Sala</h2>
            <p className="modal-subtitle">Escolha o código e configure uma senha opcional para sua sala.</p>
          </div>
          <button className="btn-close" id="btn-close-create-dialog" onClick={closeModal}>
            &times;
          </button>
        </div>

        <div className="modal-body">
          <div className="form-group">
            <label className="form-label" htmlFor="input-create-room-code-dialog">
              Código / Nome da Sala:
            </label>
            <div className="input-with-action">
              <input
                type="text"
                id="input-create-room-code-dialog"
                className="text-input"
                placeholder="Ex: cyber-falcon-482"
                style={{ fontFamily: 'var(--font-mono)', fontSize: '15px', fontWeight: 700 }}
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
              <button
                type="button"
                className="btn btn-sm btn-outline btn-inline-action"
                id="btn-regen-room-code"
                title="Gerar outro código aleatório"
                onClick={handleRegenCode}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/>
                </svg>
                <span>Regerar</span>
              </button>
            </div>
          </div>

          <div className="form-group" style={{ marginTop: '14px' }}>
            <label className="form-label" htmlFor="input-create-room-password-dialog">
              <span>Senha de Proteção (Opcional):</span>
              <span className="label-hint">Deixe em branco para sala pública</span>
            </label>
            <div className="input-with-action">
              <input
                type={showPassword ? 'text' : 'password'}
                id="input-create-room-password-dialog"
                className="text-input"
                placeholder="Ex: 1234, segredo..."
                maxLength={40}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <button
                type="button"
                className="btn btn-sm btn-outline btn-inline-action"
                id="btn-toggle-create-password-visibility"
                title="Mostrar / Ocultar Senha"
                onClick={() => setShowPassword(!showPassword)}
              >
                <span id="icon-create-pass-toggle">
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
            <p className="field-info-text">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="16" x2="12" y2="12"/>
                <line x1="12" y1="8" x2="12.01" y2="8"/>
              </svg>
              Salas com o mesmo código e senhas diferentes são 100% isoladas criptograficamente.
            </p>
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn btn-secondary" id="btn-cancel-create-dialog" onClick={closeModal}>
            Cancelar
          </button>
          <button className="btn btn-primary" id="btn-confirm-create-dialog" onClick={handleConfirm}>
            <span>Criar Sala e Entrar</span>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="5" x2="19" y1="12" y2="12"/>
              <polyline points="12 5 19 12 12 19"/>
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
};
