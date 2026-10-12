import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { effectiveTheme, readThemeMode } from '../core/desktop_appearance';
import { t } from '../i18n/index.ts';
import { useEffect, useCallback } from 'react';
import { stateStore } from '../core/state_store';
import { ThemeMode } from '../core/types';
import { useStore } from './useStore';
import { customAccentTokens } from '../core/accent_color';

export const ACCENT_COLORS = [
  { id: 'brown', get label() { return t('color.brown'); }, color: '#a47754' },
  { id: 'navy', get label() { return t('color.navy'); }, color: '#1e40af' },
  { id: 'cyan', get label() { return t("message.c954e4de2019"); }, color: '#06b6d4' },
  { id: 'sky', get label() { return t("message.db6b0018a206"); }, color: '#0284c7' },
  { id: 'blue', get label() { return t("message.b0bf526b23af"); }, color: '#3b82f6' },
  { id: 'indigo', get label() { return t("message.46a5f1fafbac"); }, color: '#6366f1' },
  { id: 'violet', get label() { return t("message.264f2ba06e85"); }, color: '#8b5cf6' },
  { id: 'purple', get label() { return t("message.57a73ede5f6f"); }, color: '#a855f7' },
  { id: 'fuchsia', get label() { return t("message.591dceeb4a25"); }, color: '#d946ef' },
  { id: 'pink', get label() { return t("message.75f9577a1637"); }, color: '#ec4899' },
  { id: 'rose', get label() { return t('color.rose'); }, color: '#f43f5e' },
  { id: 'red', get label() { return t("message.6741b8b5e1c2"); }, color: '#ef4444' },
  { id: 'orange', get label() { return t("message.2b2b4ad00333"); }, color: '#f97316' },
  { id: 'amber', get label() { return t("message.a2c334da46a3"); }, color: '#f59e0b' },
  { id: 'lime', get label() { return t("message.aaf2d054d5f7"); }, color: '#84cc16' },
  { id: 'emerald', get label() { return t("message.f22f3a4a6cd6"); }, color: '#10b981' },
  { id: 'teal', get label() { return t("message.f1d0073c7a6b"); }, color: '#14b8a6' },
  { id: 'zinc', get label() { return t("message.e7c9cc1ea080"); }, color: '#a1a1aa' },
];

export function useAppTheme() {
  const currentThemeMode = useStore((s) => s.currentThemeMode);
  const currentAccentColor = useStore((s) => s.currentAccentColor);

  const applyThemeMode = useCallback((mode: ThemeMode) => {
    stateStore.set((s) => {
      s.currentThemeMode = mode;
    });

    localStorage.setItem('p2sharer_theme_mode', mode);
  }, []);

  const applyAccentColor = useCallback((accent: string) => {
    stateStore.set((s) => {
      s.currentAccentColor = accent;
    });
    localStorage.setItem('p2sharer_accent_color', accent);
  }, []);

  // Shared-origin webviews receive persisted appearance changes without reopening PiP.
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === 'p2sharer_theme_mode') {
        const mode = readThemeMode(event.newValue);
        if (mode !== stateStore.currentThemeMode) stateStore.set(state => { state.currentThemeMode = mode; });
      } else if (event.key === 'p2sharer_accent_color') {
        const accent = event.newValue || 'cyan';
        if (accent !== stateStore.currentAccentColor) stateStore.set(state => { state.currentAccentColor = accent; });
      }
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);

  // Keep native controls and every webview on the same effective appearance.
  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const theme = effectiveTheme(currentThemeMode, mediaQuery.matches);
      document.documentElement.setAttribute('data-theme', theme);
      document.documentElement.style.colorScheme = theme === 'light' ? 'light' : 'dark';
      if (isTauri()) {
        void getCurrentWindow().setTheme(currentThemeMode === 'system' ? null : theme === 'light' ? 'light' : 'dark')
          .catch((error) => console.warn('[Theme] Could not synchronize native appearance:', error));
      }
    };
    apply();
    if (currentThemeMode !== 'system') return;
    mediaQuery.addEventListener('change', apply);
    return () => mediaQuery.removeEventListener('change', apply);
  }, [currentThemeMode]);

  useEffect(() => {
    const root = document.documentElement;
    const tokens = customAccentTokens(currentAccentColor);
    root.setAttribute('data-accent', tokens ? 'custom' : currentAccentColor);
    const accent = ACCENT_COLORS.find(item => item.id === currentAccentColor)?.color ?? currentAccentColor;
    root.style.setProperty('--amoled-accent-text', customAccentTokens(accent)?.['--custom-accent-text'] ?? '#ffffff');
    if (tokens) {
      for (const [key, value] of Object.entries(tokens)) root.style.setProperty(key, value);
    } else {
      for (const key of Object.keys(customAccentTokens('#000000')!)) root.style.removeProperty(key);
    }
  }, [currentAccentColor]);

  return {
    themeMode: currentThemeMode,
    accentColor: currentAccentColor,
    setThemeMode: applyThemeMode,
    setAccentColor: applyAccentColor,
  };
}
