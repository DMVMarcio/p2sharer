import { t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import React from 'react';
import { stateStore } from '../../core/state_store';
import { UnreadChatBadge } from './UnreadChatBadge';
import { useRoom } from '../../hooks/useRoom';
import { ChatPane } from './ChatPane';
import { ParticipantsPane } from './ParticipantsPane';

export const RoomSidebar: React.FC = () => {
  useLocale();
  const { isSidebarCollapsed, peers, sidebarTab: activeTab, unreadChatMessages } = useRoom();
  const setActiveTab = (tab: 'chat' | 'participants') => stateStore.set((state) => {
    state.sidebarTab = tab;
    if (tab === 'chat' && !state.isSidebarCollapsed) state.unreadChatMessages = 0;
  });

  const totalParticipants = peers.length + 1;

  return (
    <aside
      className={`room-sidebar ${isSidebarCollapsed ? 'collapsed' : ''}`}
      id="room-sidebar"
    >
      <div className="sidebar-tabs">
        <button
          className={`tab-btn ${activeTab === 'chat' ? 'active' : ''}`}
          id="tab-btn-chat"
          onClick={() => setActiveTab('chat')}
        >
          {t("message.2c21c154f25e")}<UnreadChatBadge count={unreadChatMessages} />
        </button>
        <button
          className={`tab-btn ${activeTab === 'participants' ? 'active' : ''}`}
          id="tab-btn-participants"
          onClick={() => setActiveTab('participants')}
        >
          {t("message.a055745d0aa7")}<span id="count-participants">{totalParticipants}</span>)
        </button>
      </div>

      {activeTab === 'chat' ? <ChatPane /> : <ParticipantsPane />}
    </aside>
  );
};
