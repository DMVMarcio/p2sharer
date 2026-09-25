import React, { useState } from 'react';
import { useRoom } from '../../hooks/useRoom';
import { ChatPane } from './ChatPane';
import { ParticipantsPane } from './ParticipantsPane';

export const RoomSidebar: React.FC = () => {
  const { isSidebarCollapsed, peers } = useRoom();
  const [activeTab, setActiveTab] = useState<'chat' | 'participants'>('chat');

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
          Chat da Sala
        </button>
        <button
          className={`tab-btn ${activeTab === 'participants' ? 'active' : ''}`}
          id="tab-btn-participants"
          onClick={() => setActiveTab('participants')}
        >
          Pessoas (<span id="count-participants">{totalParticipants}</span>)
        </button>
      </div>

      {activeTab === 'chat' ? <ChatPane /> : <ParticipantsPane />}
    </aside>
  );
};
