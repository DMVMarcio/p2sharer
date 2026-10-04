import { t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import React, { useEffect, useRef } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { ExternalLink } from 'lucide-react';
import { modalManager, useModal } from '../../hooks/useModal';
import { showToast } from '../../hooks/useToast';

export const ExternalLinkModal: React.FC = () => {
  useLocale();
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
    void openUrl(destination).catch(() => showToast(t("message.3c3c85fd6b50")));
  };

  return (
    <div className={`modal-overlay ${isClosing ? 'closing' : ''}`} role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) closeModal();
    }}>
      <div className="modal-card external-link-modal" role="dialog" aria-modal="true" aria-labelledby="external-link-title" aria-describedby="external-link-description">
        <div className="modal-header">
          <div className="modal-header-icon"><ExternalLink size={20} aria-hidden="true" /></div>
          <div>
            <h2 id="external-link-title">{t("message.47426cdc9ee3")}</h2>
            <p className="modal-subtitle" id="external-link-description">{t("message.86bbff276c78")}</p>
          </div>
          <button type="button" className="btn-close" aria-label={t("message.bb9dbb406dcb")} onClick={closeModal}>&times;</button>
        </div>
        <div className="modal-body">
          <p>{t("message.776785a9cc05")}</p>
          <div className="external-link-address" aria-label={t("message.534910c40589")}>{destination}</div>
        </div>
        <div className="modal-footer">
          <button ref={cancelRef} type="button" className="btn btn-secondary" onClick={closeModal}>{t("message.bb9dbb406dcb")}</button>
          <button type="button" className="btn btn-primary" onClick={proceed}>{t("message.6dd36999938b")}</button>
        </div>
      </div>
    </div>
  );
};
