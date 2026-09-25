import React from 'react';
import { StreamHeaderBar } from './StreamHeaderBar';
import { RoomVideoContainer } from './RoomVideoContainer';
import { RoomSidebar } from './RoomSidebar';
import { useRoom } from '../../hooks/useRoom';

export const RoomView: React.FC = () => {
  const { isSidebarCollapsed, toggleSidebar } = useRoom();

  return (
    <section className="view active" id="view-group-room">
      <div className="room-layout" id="room-layout-container">
        <div className="stream-area">
          <StreamHeaderBar />
          <RoomVideoContainer />
        </div>

        {/* Hoverable lateral sidebar toggle arrow */}
        <div
          className={`sidebar-toggle-edge ${isSidebarCollapsed ? 'collapsed' : 'expanded'}`}
          title={isSidebarCollapsed ? 'Abrir Chat e Participantes' : 'Ocultar Chat'}
        >
          <button
            type="button"
            className="sidebar-edge-toggle-btn"
            id="btn-sidebar-edge-toggle"
            onClick={toggleSidebar}
            aria-label={isSidebarCollapsed ? 'Abrir Chat e Participantes' : 'Ocultar Chat'}
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
          </button>
        </div>

        <RoomSidebar />
      </div>
    </section>
  );
};
