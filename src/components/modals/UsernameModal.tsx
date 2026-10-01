import React, { useState } from 'react';
import { useFormSubmit } from '../../hooks/useFormSubmit';
import { useModal } from '../../hooks/useModal';
import { stateStore } from '../../core/state_store';
import { showToast } from '../../hooks/useToast';

export const UsernameModal: React.FC = () => {
  const { closeModal, isClosing } = useModal();
  const [val, setVal] = useState(
    () => stateStore.username || `User_${Math.floor(1000 + Math.random() * 9000)}`
  );

  const handleSave = () => {
    const trimmed = val.trim();
    if (!trimmed) {
      showToast('Por favor, digite um nome válido.');
      return;
    }
    stateStore.set((s) => {
      s.username = trimmed;
    });
    localStorage.setItem('p2sharer_username', trimmed);
    closeModal();
    showToast(`Nome salvo: ${trimmed}`);
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
          <h2>Definir seu Nome / Apelido</h2>
        </div>
        <div className="modal-body">
          <p>Como você deseja ser identificado pelos outros participantes da sala?</p>
          <input autoComplete="off"
            type="text"
            id="input-username"
            className="text-input"
            placeholder="Ex: Marcos, Player1, etc."
            maxLength={25}
            value={val}
            onChange={(e) => setVal(e.target.value)}
            autoFocus
          />
        </div>
        <div className="modal-footer">
          <button className="btn btn-primary" id="btn-save-username" type="submit" disabled={pending || isClosing}>
            Continuar
          </button>
        </div>
      </form>
    </div>
  );
};
