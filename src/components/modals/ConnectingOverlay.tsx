import { localizeText, t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import React from 'react';
import { useRoom } from '../../hooks/useRoom';
import { useModal } from '../../hooks/useModal';

export const ConnectingOverlay: React.FC = () => {
  useLocale();
  const { activeModal } = useModal();
  const { connectingOverlay, hideConnecting, leaveRoom, currentRoomPassword } = useRoom();

  if (!connectingOverlay.visible || activeModal === 'joinRoom') return null;

  const handleCancel = () => {
    hideConnecting();
    leaveRoom();
  };

  return (
    <div className="connecting-overlay" id="connecting-overlay">
      <div className="connecting-card">
        <div className="connecting-spinner-wrapper">
          <div className="connecting-spinner"></div>
        </div>
        <h2 className="connecting-title" id="connecting-title">
          {localizeText(connectingOverlay.title) || t("message.ecec62501ea4")}
        </h2>
        <p className="connecting-subtitle" id="connecting-subtitle">
          {localizeText(connectingOverlay.subtitle) || t("message.4077d30835d4")}
        </p>
        <div className="connecting-room-badge" id="connecting-room-code">
          {t("message.87fe74c80d9f")} {connectingOverlay.roomCode}
          {currentRoomPassword ? t('message.7125c04a8c2c') : ''}
        </div>
        <button className="btn btn-secondary btn-cancel-connect" id="btn-cancel-connecting" onClick={handleCancel}>
          <span>{t("message.bb9dbb406dcb")}</span>
        </button>
      </div>
    </div>
  );
};
