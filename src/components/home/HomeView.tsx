import { t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import React from 'react';
import { ArrowUpRight, LogIn, Plus } from 'lucide-react';
import logo from '../../assets/logo.svg';
import { useModal } from '../../hooks/useModal';
import { useRoom } from '../../hooks/useRoom';
import { SavedRoomsSection } from './SavedRoomsSection';
import { AppVersion } from '../common/AppVersion';
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
    roomService.pendingJoinPassword = '';
    roomService.pendingJoinError = '';
    if (!username) {
      openModal('username');
    } else {
      openModal('joinRoom');
    }
  };

  return (
    <section className="view active" id="view-home">
      <div className="hero-container">
        <div className="home-hero">
          <div className="hero-text">
            <span className="hero-eyebrow">P2Sharer</span>
            <h1 className="hero-title">{t('home.headline')}</h1>
            <p className="hero-subtitle">{t('home.description')}</p>
            <div className="hero-actions">
              <button className="btn btn-primary" id="btn-create-room-direct" onClick={handleCreateRoom}>
                <Plus size={18} aria-hidden="true" />
                <span>{t("message.bb0f3686fc7e")}</span>
                <ArrowUpRight size={18} aria-hidden="true" />
              </button>
              <button className="btn btn-secondary" id="btn-start-join-flow" onClick={handleJoinRoom}>
                <LogIn size={18} aria-hidden="true" />
                <span>{t("message.ce76754cde67")}</span>
              </button>
            </div>
            <p className="hero-note">{t('home.inviteHint')}</p>
          </div>
          <div className="hero-brand" aria-hidden="true">
            <img src={logo} alt="" className="hero-logo" />
          </div>
        </div>
        <SavedRoomsSection />
      </div>
      <footer className="home-version"><AppVersion compact /></footer>
    </section>
  );
};
