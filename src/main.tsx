import { initializeAppRuntime } from './core/app_runtime';
import { StreamPointerOverlay } from './components/room/StreamPointerOverlay';
import React from 'react';
import { reactErrorHandlers } from './core/logger';
import ReactDOM from 'react-dom/client';
import App from './App';
import { AppContextMenu } from './components/common/AppContextMenu';
import '@fontsource-variable/plus-jakarta-sans/wght.css';
import '@fontsource-variable/jetbrains-mono/wght.css';
import '@fontsource/boogaloo/400.css';
import '@fontsource/jacquard-24/400.css';
import '@fontsource/honk/400.css';
import '@fontsource/faster-one/400.css';
import '@fontsource/exile/400.css';
import '@fontsource/nunito/400.css';
import '@fontsource/nunito/700.css';
import '@fontsource/pacifico/400.css';
import '@fontsource/syne/400.css';
import '@fontsource/syne/700.css';
import '@fontsource/permanent-marker/400.css';
import '@fontsource/bangers/400.css';
import '@fontsource/silkscreen/400.css';
import '@fontsource/silkscreen/700.css';
import '@fontsource/cinzel/400.css';
import '@fontsource/cinzel/700.css';
import './style.css';
import './components/room/stream_pointer.css';
import './apps/apps.css';
import { initializeLanguage } from './i18n';

// Initialize global WebRTC SDP bitrate munging at startup before any peer connection is created
initializeAppRuntime();

if (new URLSearchParams(window.location.search).has('pointerOverlay')) document.documentElement.classList.add('stream-pointer-desktop');

const rootElement = document.getElementById('root');
void initializeLanguage().then(() => {
  if (rootElement) {
    ReactDOM.createRoot(rootElement, reactErrorHandlers).render(
      <React.StrictMode>
        {new URLSearchParams(window.location.search).has('pointerOverlay') ? <StreamPointerOverlay /> : <AppContextMenu><App /></AppContextMenu>}
      </React.StrictMode>
    );
  }
});
