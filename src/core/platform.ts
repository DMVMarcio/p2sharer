import type { AppPlatform } from './types';

/**
 * Detects whether the current runtime is inside native Tauri desktop.
 */
function isTauriContext(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean(
    ('__TAURI_INTERNALS__' in window) ||
    ('__TAURI__' in window) ||
    (window as unknown as { isTauri?: boolean }).isTauri
  );
}

/**
 * Detects the client runtime platform:
 * - 'desktop': Native Tauri desktop application
 * - 'mobile': Browser on a mobile device (Android/iOS)
 * - 'web': Standard browser on desktop/laptop
 */
export function getLocalPlatform(): AppPlatform {
  if (isTauriContext()) {
    return 'desktop';
  }
  if (typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)) {
    return 'mobile';
  }
  return 'web';
}

/**
 * Detects if the current client is running on a mobile device or touch/small viewport.
 */
export function isMobileDevice(): boolean {
  if (typeof window === 'undefined') return false;
  if (getLocalPlatform() === 'mobile') return true;
  if (typeof window.matchMedia === 'function') {
    if (window.matchMedia('(hover: none) and (pointer: coarse)').matches) return true;
    if (window.matchMedia('(max-width: 900px)').matches) return true;
    if (window.matchMedia('(max-height: 540px)').matches) return true;
  }
  return window.innerWidth <= 900 || window.innerHeight <= 540;
}
