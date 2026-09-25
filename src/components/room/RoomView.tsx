import React from 'react';
import { StreamHeaderBar } from './StreamHeaderBar';
import { RoomVideoContainer } from './RoomVideoContainer';
import { RoomSidebar } from './RoomSidebar';

export const RoomView: React.FC = () => {
  return (
    <section className="view active" id="view-group-room">
      <div className="room-layout" id="room-layout-container">
        <div className="stream-area">
          <StreamHeaderBar />
          <RoomVideoContainer />
        </div>
        <RoomSidebar />
      </div>
    </section>
  );
};
