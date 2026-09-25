import { useEffect, useCallback } from 'react';
import { stateStore } from '../core/state_store';
import { ThemeMode } from '../core/types';
import { useStore } from './useStore';

export const ACCENT_COLORS = [
  { id: 'cyan', label: 'Ciano', color: '#06b6d4' },
  { id: 'sky', label: 'Azul Celeste', color: '#0284c7' },
  { id: 'blue', label: 'Azul', color: '#3b82f6' },
  { id: 'indigo', label: 'Índigo', color: '#6366f1' },
  { id: 'violet', label: 'Violeta', color: '#8b5cf6' },
  { id: 'purple', label: 'Roxo', color: '#a855f7' },
  { id: 'fuchsia', label: 'Fúcsia', color: '#d946ef' },
  { id: 'pink', label: 'Rosa', color: '#ec4899' },
  { id: 'rose', label: 'Rose', color: '#f43f5e' },
  { id: 'red', label: 'Vermelho', color: '#ef4444' },
  { id: 'orange', label: 'Laranja', color: '#f97316' },
  { id: 'amber', label: 'Âmbar', color: '#f59e0b' },
  { id: 'lime', label: 'Lima', color: '#84cc16' },
  { id: 'emerald', label: 'Esmeralda', color: '#10b981' },
  { id: 'teal', label: 'Verde Água', color: '#14b8a6' },
  { id: 'zinc', label: 'Monocromático', color: '#a1a1aa' },
];

export function useAppTheme() {
  const currentThemeMode = useStore((s) => s.currentThemeMode);
  const currentAccentColor = useStore((s) => s.currentAccentColor);

  const applyThemeMode = useCallback((mode: ThemeMode) => {
    stateStore.set((s) => {
      s.currentThemeMode = mode;
    });

    let effectiveTheme = mode;
    if (mode === 'system') {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      effectiveTheme = prefersDark ? 'dark' : 'light';
    }
    document.documentElement.setAttribute('data-theme', effectiveTheme);
    localStorage.setItem('p2sharer_theme_mode', mode);
  }, []);

  const applyAccentColor = useCallback((accent: string) => {
    stateStore.set((s) => {
      s.currentAccentColor = accent;
    });
    document.documentElement.setAttribute('data-accent', accent);
    localStorage.setItem('p2sharer_accent_color', accent);
  }, []);

  // Initialize and handle system theme media query listener
  useEffect(() => {
    let effectiveTheme = currentThemeMode;
    if (currentThemeMode === 'system') {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      effectiveTheme = mediaQuery.matches ? 'dark' : 'light';

      const handleChange = (e: MediaQueryListEvent) => {
        if (stateStore.currentThemeMode === 'system') {
          document.documentElement.setAttribute('data-theme', e.matches ? 'dark' : 'light');
        }
      };

      mediaQuery.addEventListener('change', handleChange);
      document.documentElement.setAttribute('data-theme', effectiveTheme);
      return () => mediaQuery.removeEventListener('change', handleChange);
    } else {
      document.documentElement.setAttribute('data-theme', currentThemeMode);
    }
  }, [currentThemeMode]);

  useEffect(() => {
    document.documentElement.setAttribute('data-accent', currentAccentColor);
  }, [currentAccentColor]);

  return {
    themeMode: currentThemeMode,
    accentColor: currentAccentColor,
    setThemeMode: applyThemeMode,
    setAccentColor: applyAccentColor,
  };
}
