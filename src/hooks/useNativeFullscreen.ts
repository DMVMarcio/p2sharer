import { useEffect, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { NativeFullscreenSession, type WindowPlacement } from '../core/native_fullscreen';

export function useNativeFullscreen() {
  const sessionRef = useRef<NativeFullscreenSession | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const native = isTauri() ? getCurrentWindow() : null;
    const session = new NativeFullscreenSession(native ? {
      isFullscreen: () => native.isFullscreen(),
      setFullscreen: value => native.setFullscreen(value),
      capturePlacement: () => invoke<WindowPlacement>('capture_window_placement'),
      restorePlacement: placement => invoke('restore_window_placement', { placement }),
    } : null);
    sessionRef.current = session;
    return () => { session.dispose(); if (sessionRef.current === session) sessionRef.current = null; };
  }, []);
  return { fullscreen,
    enterFullscreen: async () => { const session = sessionRef.current; if (session) { const active = await session.enter(); if (sessionRef.current === session) setFullscreen(active); window.dispatchEvent(new window.Event('p2sharer-native-fullscreen-changed')); } },
    exitFullscreen: async () => { const session = sessionRef.current; if (session) { await session.exit(); if (sessionRef.current === session) setFullscreen(false); window.dispatchEvent(new window.Event('p2sharer-native-fullscreen-changed')); } },
  };
}
