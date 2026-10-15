import { useEffect, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { PhysicalPosition, PhysicalSize } from '@tauri-apps/api/dpi';
import { NativeFullscreenSession } from '../core/native_fullscreen';

export function useNativeFullscreen() {
  const sessionRef = useRef<NativeFullscreenSession | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const native = isTauri() ? getCurrentWindow() : null;
    const session = new NativeFullscreenSession(native ? {
      isFullscreen: () => native.isFullscreen(),
      setFullscreen: value => native.setFullscreen(value),
      capturePlacement: async () => {
        const [position, size, maximized] = await Promise.all([native.outerPosition(), native.innerSize(), native.isMaximized()]);
        return { x: position.x, y: position.y, width: size.width, height: size.height, maximized };
      },
      restorePlacement: async placement => {
        if (placement.maximized) await native.maximize();
        else {
          if (await native.isMaximized()) await native.unmaximize();
          await native.setSize(new PhysicalSize(placement.width, placement.height));
          await native.setPosition(new PhysicalPosition(placement.x, placement.y));
        }
      },
    } : null);
    sessionRef.current = session;
    return () => { session.dispose(); if (sessionRef.current === session) sessionRef.current = null; };
  }, []);
  return { fullscreen,
    enterFullscreen: async () => { const session = sessionRef.current; if (session) { const active = await session.enter(); if (sessionRef.current === session) setFullscreen(active); window.dispatchEvent(new window.Event('p2sharer-native-fullscreen-changed')); } },
    exitFullscreen: async () => { const session = sessionRef.current; if (session) { await session.exit(); if (sessionRef.current === session) setFullscreen(false); window.dispatchEvent(new window.Event('p2sharer-native-fullscreen-changed')); } },
  };
}
