import React, { useState } from 'react';
import { useFormSubmit } from '../../hooks/useFormSubmit';
import { useModal } from '../../hooks/useModal';
import { useRoom } from '../../hooks/useRoom';
import { showToast } from '../../hooks/useToast';
import { parseRoomInvite } from '../../core/room_invite';
import { verifyRoomInvite } from '../../core/room_invite_validation';
import { roomService } from '../../services/room_service';

export const JoinRoomModal: React.FC = () => {
  const { closeModal, isClosing } = useModal();
  const { joinRoom } = useRoom();

  const [code, setCode] = useState(() => roomService.pendingJoinInvite);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const handleConfirm = async () => {
    if (!parseRoomInvite(code) || !await verifyRoomInvite(code)) {
      showToast('Cole um convite autenticado válido.'); return;
    }
    const asOwner = roomService.pendingJoinAsOwner;
    roomService.pendingJoinInvite = '';
    roomService.pendingJoinAsOwner = false;
    closeModal();
    joinRoom(code.trim(), password.trim(), asOwner);
    showToast('Conectando à sala...');
  };

  const { submit, pending } = useFormSubmit(handleConfirm, isClosing);

  return (
    <div className={`modal-overlay ${isClosing ? 'closing' : ''}`} id="modal-join-room-dialog">
      <form onSubmit={submit} aria-busy={pending} className="modal-card">
        <div className="modal-header">
          <div className="modal-header-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/>
              <polyline points="10 17 15 12 10 7"/>
              <line x1="15" x2="3" y1="12" y2="12"/>
            </svg>
          </div>
          <div>
            <h2>Entrar em uma Sala de Grupo</h2>
            <p className="modal-subtitle">Cole o convite autenticado e, se necessário, informe a senha.</p>
          </div>
          <button type="button" className="btn-close" id="btn-close-join-dialog" onClick={closeModal}>
            &times;
          </button>
        </div>

        <div className="modal-body">
          <div className="form-group">
            <label className="form-label" htmlFor="input-join-room-code-dialog">
              Convite da Sala:
            </label>
            <input
              type="text"
              id="input-join-room-code-dialog"
              className="text-input"
              placeholder="Cole o convite p2s4..."
              style={{ fontFamily: 'var(--font-mono)', fontSize: '15px', fontWeight: 700 }}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoFocus
            />
          </div>

          <div className="form-group" style={{ marginTop: '14px' }}>
            <label className="form-label" htmlFor="input-join-room-password-dialog">
              <span>Senha da Sala:</span>
              <span className="label-hint">Deixe em branco se a sala for pública</span>
            </label>
            <div className="input-with-action">
              <input
                type={showPassword ? 'text' : 'password'}
                id="input-join-room-password-dialog"
                className="text-input"
                placeholder="Digite a senha (se houver)..."
                maxLength={40}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <button
                type="button"
                className="btn btn-sm btn-outline btn-inline-action"
                id="btn-toggle-join-password-visibility"
                aria-label="Mostrar / Ocultar Senha"
                onClick={() => setShowPassword(!showPassword)}
              >
                <span id="icon-join-pass-toggle">
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
          </div>
        </div>

        <div className="modal-footer">
          <button type="button" className="btn btn-secondary" id="btn-cancel-join-dialog" onClick={closeModal}>
            Cancelar
          </button>
          <button className="btn btn-primary" id="btn-confirm-join-dialog" type="submit" disabled={pending || isClosing}>
            <span>Entrar na Sala</span>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="5" x2="19" y1="12" y2="12"/>
              <polyline points="12 5 19 12 12 19"/>
            </svg>
          </button>
        </div>
      </form>
    </div>
  );
};
