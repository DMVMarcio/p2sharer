import React from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { NavigationFeedback } from './NavigationFeedback';
import { webRoutes } from './router';
import { initializeLanguage } from '../../src/i18n';
import '@fontsource-variable/plus-jakarta-sans/wght.css';
import '@fontsource-variable/jetbrains-mono/wght.css';
import '../../src/style.css';
import './web.css';

async function start() {
  await initializeLanguage();
  const router = createBrowserRouter(webRoutes());
  createRoot(document.getElementById('root')!).render(<React.StrictMode><NavigationFeedback router={router} /><RouterProvider router={router} /></React.StrictMode>);
}
void start();
