import { t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import React from 'react';
import { MessageSquare, Users, AppWindow, Monitor, Square, Settings2 } from 'lucide-react';
import { stateStore } from '../../core/state_store';
import { useRoom } from '../../hooks/useRoom';
import { useModal } from '../../hooks/useModal';
import { UnreadChatBadge } from './UnreadChatBadge';
import { roomService } from '../../services/room_service';

export const MobileRoomDock: React.FC = () => {
  useLocale();
  const {
    roomSlots,
    peers,
    isSidebarCollapsed,
    sidebarTab,
    unreadChatMessages,
  } = useRoom();
  const { openModal } = useModal();

  const localStreams = roomSlots.filter((slot) => slot.isLocal && slot.isStreaming && slot.mediaId);
  const isBroadcasting = localStreams.length > 0;

  const handleToggleChat = () => {
    stateStore.set((state) => {
      if (state.isSidebarCollapsed) {
        state.isSidebarCollapsed = false;
        state.sidebarTab = 'chat';
        state.unreadChatMessages = 0;
      } else if (state.sidebarTab === 'chat') {
        state.isSidebarCollapsed = true;
      } else {
        state.sidebarTab = 'chat';
        state.unreadChatMessages = 0;
      }
    });
  };

  const handleToggleParticipants = () => {
    stateStore.set((state) => {
      if (state.isSidebarCollapsed) {
        state.isSidebarCollapsed = false;
        state.sidebarTab = 'participants';
      } else if (state.sidebarTab === 'participants') {
        state.isSidebarCollapsed = true;
      } else {
        state.sidebarTab = 'participants';
      }
    });
  };

  const handleToggleTransmission = () => {
    if (isBroadcasting) {
      if (localStreams.length === 1 && localStreams[0].mediaId) {
        void roomService.stopTransmission(localStreams[0].mediaId);
      } else {
        openModal('screenPicker');
      }
    } else {
      stateStore.set((state) => { state.editingStreamId = null; });
      openModal('screenPicker');
    }
  };

  return (
    <nav className="mobile-room-dock" role="navigation" aria-label={t("message.12a023948f61")}>
      <button
        type="button"
        className={`mobile-dock-btn ${!isSidebarCollapsed && sidebarTab === 'chat' ? 'active' : ''}`}
        onClick={handleToggleChat}
        aria-label={t("twitch.chat")}
        aria-expanded={!isSidebarCollapsed && sidebarTab === 'chat'}
      >
        <span className="mobile-dock-icon-wrapper">
          <MessageSquare size={19} aria-hidden="true" />
          {unreadChatMessages > 0 && <UnreadChatBadge count={unreadChatMessages} />}
        </span>
        <span className="mobile-dock-label">{t("twitch.chat")}</span>
      </button>

      <button
        type="button"
        className={`mobile-dock-btn ${!isSidebarCollapsed && sidebarTab === 'participants' ? 'active' : ''}`}
        onClick={handleToggleParticipants}
        aria-label={t("common.people")}
        aria-expanded={!isSidebarCollapsed && sidebarTab === 'participants'}
      >
        <span className="mobile-dock-icon-wrapper">
          <Users size={19} aria-hidden="true" />
          <span className="mobile-dock-badge">{peers.length + 1}</span>
        </span>
        <span className="mobile-dock-label">{t("common.people")}</span>
      </button>

      <button
        type="button"
        className="mobile-dock-btn"
        onClick={() => openModal('apps')}
        aria-label={t("common.apps")}
      >
        <span className="mobile-dock-icon-wrapper">
          <AppWindow size={19} aria-hidden="true" />
        </span>
        <span className="mobile-dock-label">{t("common.apps")}</span>
      </button>

      <button
        type="button"
        className={`mobile-dock-btn ${isBroadcasting ? 'is-broadcasting' : ''}`}
        onClick={handleToggleTransmission}
        aria-label={isBroadcasting ? t("message.6ef17b51fd93") : t("message.85344dae041c")}
      >
        <span className="mobile-dock-icon-wrapper">
          {isBroadcasting ? <Square size={18} fill="currentColor" aria-hidden="true" /> : <Monitor size={19} aria-hidden="true" />}
          {isBroadcasting && <span className="mobile-dock-live-dot" />}
        </span>
        <span className="mobile-dock-label">
          {isBroadcasting ? t("message.6ef17b51fd93") : t("message.85344dae041c")}
        </span>
      </button>

      <button
        type="button"
        className="mobile-dock-btn"
        onClick={() => openModal('roomSecurity')}
        aria-label={t("message.46a6407e52eb")}
      >
        <span className="mobile-dock-icon-wrapper">
          <Settings2 size={19} aria-hidden="true" />
        </span>
        <span className="mobile-dock-label">{t("message.46a6407e52eb")}</span>
      </button>
    </nav>
  );
};
