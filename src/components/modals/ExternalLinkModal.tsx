import React, { useEffect, useRef } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { ExternalLink } from 'lucide-react';
import { modalManager, useModal } from '../../hooks/useModal';
import { showToast } from '../../hooks/useToast';

export const ExternalLinkModal: React.FC = () => {
  const { closeModal, isClosing } = useModal();
  const destination = modalManager.getExternalLinkUrl();
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeModal();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [closeModal]);

  const proceed = () => {
    if (!destination) return;
    closeModal();
    void openUrl(destination).catch(() => showToast('Não foi possível abrir o link.'));
  };

  return (
    <div className={`modal-overlay ${isClosing ? 'closing' : ''}`} role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) closeModal();
    }}>
      <div className="modal-card external-link-modal" role="dialog" aria-modal="true" aria-labelledby="external-link-title" aria-describedby="external-link-description">
        <div className="modal-header">
          <div className="modal-header-icon"><ExternalLink size={20} aria-hidden="true" /></div>
          <div>
            <h2 id="external-link-title">Abrir site externo</h2>
            <p className="modal-subtitle" id="external-link-description">Você está indo para um site externo ao P2Sharer.</p>
          </div>
          <button type="button" className="btn-close" aria-label="Cancelar" onClick={closeModal}>&times;</button>
        </div>
        <div className="modal-body">
          <p>Confira o endereço antes de prosseguir:</p>
          <div className="external-link-address" aria-label="Endereço de destino">{destination}</div>
        </div>
        <div className="modal-footer">
          <button ref={cancelRef} type="button" className="btn btn-secondary" onClick={closeModal}>Cancelar</button>
          <button type="button" className="btn btn-primary" onClick={proceed}>Prosseguir</button>
        </div>
      </div>
    </div>
  );
};
