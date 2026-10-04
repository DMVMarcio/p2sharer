import React, { useEffect } from 'react';
import { AppHeader } from './components/header/AppHeader';
import { WindowTitlebar } from './components/header/WindowTitlebar';
import { HomeView } from './components/home/HomeView';
import { RoomView } from './components/room/RoomView';
import { SettingsModal } from './components/modals/SettingsModal';
import { ScreenPickerModal } from './components/modals/ScreenPickerModal';
import { UsernameModal } from './components/modals/UsernameModal';
import { AudioFilterModal } from './components/modals/AudioFilterModal';
import { CreateRoomModal } from './components/modals/CreateRoomModal';
import { JoinRoomModal } from './components/modals/JoinRoomModal';
import { SaveInviteModal } from './components/modals/SaveInviteModal';
import { RoomSecurityModal } from './components/modals/RoomSecurityModal';
import { ExternalLinkModal } from './components/modals/ExternalLinkModal';
import { AppsModal } from './components/modals/AppsModal';
import { ConnectingOverlay } from './components/modals/ConnectingOverlay';
import { ToastContainer } from './components/common/ToastContainer';
import { useRoom } from './hooks/useRoom';
import { useModal } from './hooks/useModal';
import { useAppTheme } from './hooks/useAppTheme';
import { initFrontendLogger } from './core/logger';
import { stateStore } from './core/state_store';
import { PipView } from './components/room/PipView';
import { YouTubePipView } from './apps/YouTubePipView';
import { RoomAppWindow } from './apps/RoomAppWindow';
import { AppUpdateDialog } from './components/modals/AppUpdateDialog';
import { startAutomaticUpdateChecks } from './services/app_updates';

export const App: React.FC = () => {
  useAppTheme(); // Sets data-theme & data-accent

  const pipPeerId = typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search).get('pip')
    : null;

  if (pipPeerId) {
    if (pipPeerId.startsWith('app-')) return <RoomAppWindow instanceId={pipPeerId.slice(4)} />;
    if (pipPeerId.startsWith('youtube-'))
      return <YouTubePipView instanceId={pipPeerId.slice('youtube-'.length)} />;
    return <PipView peerId={pipPeerId} />;
  }

  return <MainApp />;
};

const MainApp: React.FC = () => {
  const { isInRoom, stopScreenSharing, leaveRoom, isSharingScreen } = useRoom();
  const { openModal, activeModal } = useModal();

  useEffect(startAutomaticUpdateChecks, []);

  useEffect(() => {
    initFrontendLogger();
  }, []);

  useEffect(() => {
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
  }, [isSharingScreen, stopScreenSharing, leaveRoom]);

  return (
    <>
      <WindowTitlebar />
      <AppHeader />
      <main className="app-main" id="app-main">
        {isInRoom ? <RoomView /> : <HomeView />}
      </main>

      {/* Modals & Overlays */}
      {activeModal === 'settings' && <SettingsModal />}
      {activeModal === 'screenPicker' && <ScreenPickerModal />}
      {activeModal === 'username' && <UsernameModal />}
      {activeModal === 'audioFilter' && <AudioFilterModal />}
      {activeModal === 'createRoom' && <CreateRoomModal />}
      {activeModal === 'joinRoom' && <JoinRoomModal />}
      {activeModal === 'saveInvite' && <SaveInviteModal />}
      {activeModal === 'roomSecurity' && <RoomSecurityModal />}
      {activeModal === 'externalLink' && <ExternalLinkModal />}
      {activeModal === 'apps' && <AppsModal />}
      <ConnectingOverlay />
      <AppUpdateDialog />

      {/* Global Notifications */}
      <ToastContainer />
    </>
  );
};

export default App;
