import { t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import React from 'react';
import { useModal } from '../../hooks/useModal';
import { useRoom } from '../../hooks/useRoom';
import { SavedRoomsSection } from './SavedRoomsSection';
import { roomService } from '../../services/room_service';

export const HomeView: React.FC = () => {
  useLocale();
  const { openModal } = useModal();
  const { username } = useRoom();

  const handleCreateRoom = () => {
    if (!username) {
      openModal('username');
    } else {
      openModal('createRoom');
    }
  };

  const handleJoinRoom = () => {
    roomService.pendingJoinInvite = '';
    roomService.pendingJoinAsOwner = false;
    if (!username) {
      openModal('username');
    } else {
      openModal('joinRoom');
    }
  };

  return (
    <section className="view active" id="view-home">
      <div className="hero-container">
        <div className="hero-text">
          <h1 className="hero-title">{t("message.fec4d35dc061")}</h1>
          <p className="hero-subtitle">
            {t("message.4d3e94d0c285")}</p>
        </div>

        <div className="action-cards-grid">
          {/* Card Create Room */}
          <div className="action-card" id="card-action-host">
            <div className="card-icon-wrapper">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
                <circle cx="9" cy="7" r="4"/>
                <path d="M22 21v-2a4 4 0 0 0-3-3.87"/>
                <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
              </svg>
            </div>
            <h2 className="card-title">{t("message.05c0432bf1ae")}</h2>
            <p className="card-desc">
              {t("message.8e648ce77c35")}</p>
            <div className="card-footer">
              <button className="btn btn-primary" id="btn-create-room-direct" onClick={handleCreateRoom}>
                <span>{t("message.bb0f3686fc7e")}</span>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="5" x2="19" y1="12" y2="12"/>
                  <polyline points="12 5 19 12 12 19"/>
                </svg>
              </button>
            </div>
          </div>

          {/* Card Join Room */}
          <div className="action-card" id="card-action-join">
            <div className="card-icon-wrapper">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/>
                <polyline points="10 17 15 12 10 7"/>
                <line x1="15" x2="3" y1="12" y2="12"/>
              </svg>
            </div>
            <h2 className="card-title">{t("message.d2979e7d0cf4")}</h2>
            <p className="card-desc">
              {t("message.75b5ed8c34b1")}</p>
            <div className="card-footer">
              <button className="btn btn-secondary" id="btn-start-join-flow" onClick={handleJoinRoom}>
                <span>{t("message.ce76754cde67")}</span>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="5" x2="19" y1="12" y2="12"/>
                  <polyline points="12 5 19 12 12 19"/>
                </svg>
              </button>
            </div>
          </div>
        </div>
        <SavedRoomsSection />
      </div>
    </section>
  );
};
