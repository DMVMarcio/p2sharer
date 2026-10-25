import { isTauri } from '@tauri-apps/api/core';
import type { AppPlatform } from './types';

/**
 * Detects the client runtime platform:
 * - 'desktop': Native Tauri desktop application
 * - 'mobile': Browser on a mobile device (Android/iOS)
 * - 'web': Standard browser on desktop/laptop
 */
export function getLocalPlatform(): AppPlatform {
  if (typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || isTauri())) {
    return 'desktop';
  }
  if (typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)) {
    return 'mobile';
  }
  return 'web';
}
