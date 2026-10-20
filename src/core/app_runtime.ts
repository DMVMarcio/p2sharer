import { invoke, isTauri } from '@tauri-apps/api/core';
import { initFrontendLogger } from './logger';
import { startMediaDiagnostics } from './media_diagnostics';
import { MediaCoordinator } from '../p2p/media_coordinator';

let initialized = false;

/** Shared startup for the desktop entry and the lazily loaded web app. */
export function initializeAppRuntime() {
  if (initialized) return;
  initialized = true;
  initFrontendLogger();
  if (isTauri()) void invoke('disable_browser_shortcuts').catch(error => console.warn('Browser shortcut configuration failed:', error));
  MediaCoordinator.initGlobalWebRtcMunging();
  void startMediaDiagnostics();
}
