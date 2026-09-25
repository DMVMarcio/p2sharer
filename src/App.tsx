import React, { useEffect } from 'react';
import { AppHeader } from './components/header/AppHeader';
import { HomeView } from './components/home/HomeView';
import { RoomView } from './components/room/RoomView';
import { SettingsModal } from './components/modals/SettingsModal';
import { ScreenPickerModal } from './components/modals/ScreenPickerModal';
import { UsernameModal } from './components/modals/UsernameModal';
import { AudioFilterModal } from './components/modals/AudioFilterModal';
import { CreateRoomModal } from './components/modals/CreateRoomModal';
import { JoinRoomModal } from './components/modals/JoinRoomModal';
import { RoomSecurityModal } from './components/modals/RoomSecurityModal';
import { ConnectingOverlay } from './components/modals/ConnectingOverlay';
import { ToastContainer } from './components/common/ToastContainer';
import { useRoom } from './hooks/useRoom';
import { useModal } from './hooks/useModal';
import { useAppTheme } from './hooks/useAppTheme';
import { initFrontendLogger } from './core/logger';
import { stateStore } from './core/state_store';

export const App: React.FC = () => {
  const { isInRoom, stopScreenSharing, leaveRoom, isSharingScreen } = useRoom();
  const { openModal } = useModal();
  useAppTheme(); // Sets data-theme & data-accent

  useEffect(() => {
    initFrontendLogger();

    // Check username on initial load
    if (!stateStore.username) {
      openModal('username');
    }

    const handleBeforeUnload = () => {
      if (isSharingScreen) {
        stopScreenSharing();
      }
      leaveRoom();
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [openModal, isSharingScreen, stopScreenSharing, leaveRoom]);

  return (
    <>
      <AppHeader />
      <main className="app-main" id="app-main">
        {isInRoom ? <RoomView /> : <HomeView />}
      </main>

      {/* Modals & Overlays */}
      <SettingsModal />
      <ScreenPickerModal />
      <UsernameModal />
      <AudioFilterModal />
      <CreateRoomModal />
      <JoinRoomModal />
      <RoomSecurityModal />
      <ConnectingOverlay />

      {/* Global Notifications */}
      <ToastContainer />
    </>
  );
};

export default App;
