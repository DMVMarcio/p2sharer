import type { ThemeMode } from './types.ts';

/** Host-injected platform metadata is presentation-only, never an authorization boundary. */
export function getDesktopPlatform(): string {
  return (globalThis as typeof globalThis & { __P2SHARER_PLATFORM__?: string }).__P2SHARER_PLATFORM__ ?? 'browser';
}

export function readThemeMode(stored: string | null, platform = getDesktopPlatform()): ThemeMode {
  if (stored === 'dark' || stored === 'light' || stored === 'system' || stored === 'amoled') return stored;
  return platform === 'macos' ? 'amoled' : 'dark';
}

export function effectiveTheme(mode: ThemeMode, systemDark: boolean): Exclude<ThemeMode, 'system'> {
  return mode === 'system' ? (systemDark ? 'dark' : 'light') : mode;
}
