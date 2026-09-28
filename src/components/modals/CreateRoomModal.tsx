import React, { useState } from 'react';
import { useModal } from '../../hooks/useModal';
import { useRoom } from '../../hooks/useRoom';
import { showToast } from '../../hooks/useToast';
import { createAuthenticatedInvite, parseRoomInvite } from '../../core/room_invite';
import { savedRooms } from '../../core/saved_rooms';

export const CreateRoomModal: React.FC = () => {
  const { closeModal, isClosing } = useModal();
  const { joinRoom } = useRoom();

  const [name, setName] = useState('Minha sala');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const handleConfirm = async () => {
    const finalPass = password.trim();
    try {
      const roomName = name.trim() || 'Minha sala';
      const { invite, identity } = await createAuthenticatedInvite(roomName);
      const roomId = parseRoomInvite(invite)!.roomId;
      await savedRooms.put({ roomId, invite, name: roomName,
        saved: true, owned: true, protected: Boolean(finalPass), password: finalPass || undefined, identity });
      closeModal();
      joinRoom(invite, finalPass, true);
      showToast('Sala autenticada criada e salva!');
    } catch (error) {
      console.error('[Rooms] Failed to create room:', error);
      showToast('Não foi possível criar a sala.');
    }
  };

  return (
    <div className={`modal-overlay ${isClosing ? 'closing' : ''}`} id="modal-create-room-dialog">
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
            <p className="modal-subtitle">O convite autenticado será gerado ao criar a sala.</p>
          </div>
          <button className="btn-close" id="btn-close-create-dialog" onClick={closeModal}>
            &times;
          </button>
        </div>

        <div className="modal-body">
          <div className="form-group">
            <label className="form-label" htmlFor="input-create-room-name-dialog">Nome da sala neste dispositivo:</label>
            <input id="input-create-room-name-dialog" className="text-input" maxLength={80}
              value={name} onChange={(event) => setName(event.target.value)} />
          </div>

          <div className="form-group" style={{ marginTop: '14px' }}>
            <label className="form-label" htmlFor="input-create-room-password-dialog">
              <span>Senha de Proteção (Opcional):</span>
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
                className="btn btn-sm btn-outline btn-inline-action btn-inline-action-icon"
                id="btn-toggle-create-password-visibility"
                aria-label="Mostrar / Ocultar Senha"
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
