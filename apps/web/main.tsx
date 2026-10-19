import React from 'react';
import { createRoot } from 'react-dom/client';
import { initializeLanguage } from '../../src/i18n';
import '@fontsource-variable/plus-jakarta-sans/wght.css';
import '@fontsource-variable/jetbrains-mono/wght.css';
import '../../src/style.css';
import './web.css';

async function start() {
  await initializeLanguage();
  if (location.pathname === '/app' || location.pathname.startsWith('/app/')) {
    document.documentElement.classList.add('web-app');
    await import('../../src/main');
  } else {
    document.documentElement.classList.add('web-landing');
    const { LandingPage } = await import('./LandingPage');
    createRoot(document.getElementById('root')!).render(<React.StrictMode><LandingPage /></React.StrictMode>);
  }
}
void start();
