import { t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import React from 'react';
import { UnreadChatBadge } from './UnreadChatBadge';
import { StreamHeaderBar } from './StreamHeaderBar';
import { RoomVideoContainer } from './RoomVideoContainer';
import { RoomSidebar } from './RoomSidebar';
import { ChatFileRequests } from './ChatFileRequests';
import { useRoom } from '../../hooks/useRoom';

export const RoomView: React.FC = () => {
  useLocale();
  const { isSidebarCollapsed, toggleSidebar, unreadChatMessages } = useRoom();

  return (
    <section className="view active" id="view-group-room">
      <div className="room-layout" id="room-layout-container">
        <div className="stream-area">
          <StreamHeaderBar />
          <RoomVideoContainer />
        </div>

        {/* Hoverable lateral sidebar toggle arrow */}
        <div
          className={`sidebar-toggle-edge ${isSidebarCollapsed ? 'collapsed' : 'expanded'} ${unreadChatMessages > 0 ? 'has-unread' : ''}`}
        >
          <button
            type="button"
            className="sidebar-edge-toggle-btn"
            id="btn-sidebar-edge-toggle"
            onClick={toggleSidebar}
            aria-label={isSidebarCollapsed ? t("message.86d416fc47cf") : t("message.182641374267")}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              {isSidebarCollapsed ? (
                <polyline points="15 18 9 12 15 6" />
              ) : (
                <polyline points="9 18 15 12 9 6" />
              )}
            </svg>
            {isSidebarCollapsed && <UnreadChatBadge count={unreadChatMessages} />}
          </button>
        </div>

        <RoomSidebar />
      </div>
      <ChatFileRequests />
    </section>
  );
};
