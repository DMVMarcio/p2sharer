import { useEffect, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { NativeFullscreenSession } from '../core/native_fullscreen';

export function useNativeFullscreen() {
  const sessionRef = useRef<NativeFullscreenSession | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const session = new NativeFullscreenSession(isTauri() ? getCurrentWindow() : null);
    sessionRef.current = session;
    return () => { session.dispose(); if (sessionRef.current === session) sessionRef.current = null; };
  }, []);
  return { fullscreen,
    enterFullscreen: async () => { const session = sessionRef.current; if (session) { const active = await session.enter(); if (sessionRef.current === session) setFullscreen(active); } },
    exitFullscreen: async () => { const session = sessionRef.current; if (session) { await session.exit(); if (sessionRef.current === session) setFullscreen(false); } },
  };
}
