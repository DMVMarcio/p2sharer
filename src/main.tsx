import { StreamPointerOverlay } from './components/room/StreamPointerOverlay';
import React from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';

if (isTauri()) void invoke('disable_browser_shortcuts').catch((error) => console.warn('Browser shortcut configuration failed:', error));
import ReactDOM from 'react-dom/client';
import App from './App';
import { AppContextMenu } from './components/common/AppContextMenu';
import '@fontsource-variable/plus-jakarta-sans/wght.css';
import '@fontsource-variable/jetbrains-mono/wght.css';
import './style.css';
import './components/room/stream_pointer.css';
import './apps/apps.css';
import { MediaCoordinator } from './p2p/media_coordinator';

// Initialize global WebRTC SDP bitrate munging at startup before any peer connection is created
MediaCoordinator.initGlobalWebRtcMunging();

if (new URLSearchParams(window.location.search).has('pointerOverlay')) document.documentElement.classList.add('stream-pointer-desktop');

const rootElement = document.getElementById('root');
if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      {new URLSearchParams(window.location.search).has('pointerOverlay') ? <StreamPointerOverlay /> : <AppContextMenu><App /></AppContextMenu>}
    </React.StrictMode>
  );
}
