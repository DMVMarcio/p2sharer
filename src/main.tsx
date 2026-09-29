import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import '@fontsource-variable/plus-jakarta-sans/wght.css';
import '@fontsource-variable/jetbrains-mono/wght.css';
import './style.css';
import './apps/apps.css';
import { MediaCoordinator } from './p2p/media_coordinator';

// Initialize global WebRTC SDP bitrate munging at startup before any peer connection is created
MediaCoordinator.initGlobalWebRtcMunging();

const rootElement = document.getElementById('root');
if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}
