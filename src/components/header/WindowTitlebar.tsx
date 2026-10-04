import React, { useEffect, useMemo, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Minus, Square, Copy, X } from 'lucide-react';
import { Tooltip } from '../common/Tooltip';
import logoImg from '../../assets/logo.png';

/** Main-window chrome; detached media windows keep their existing controls. */
export const WindowTitlebar: React.FC = () => {
  const nativeWindow = useMemo(() => isTauri() ? getCurrentWindow() : null, []);
  const [maximized, setMaximized] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [focused, setFocused] = useState(true);

  useEffect(() => {
    if (!nativeWindow) return;
    let disposed = false;
    let revision = 0;
    const listeners: Array<() => void> = [];
    const report = (error: unknown) => console.warn('[Window] Could not read window state:', error);
    const refresh = async () => {
      const request = ++revision;
      const [isMaximized, isFullscreen, isFocused] = await Promise.all([
        nativeWindow.isMaximized(), nativeWindow.isFullscreen(), nativeWindow.isFocused(),
      ]);
      if (!disposed && request === revision) {
        setMaximized(isMaximized);
        setFullscreen(isFullscreen);
        setFocused(isFocused);
      }
    };
    const retain = (registration: Promise<() => void>) => {
      void registration.then((unlisten) => {
        if (disposed) unlisten(); else listeners.push(unlisten);
      }).catch(report);
    };
    retain(nativeWindow.onResized(() => { void refresh().catch(report); }));
    retain(nativeWindow.onFocusChanged(() => { void refresh().catch(report); }));
    void refresh().catch(report);
    return () => { disposed = true; listeners.forEach((unlisten) => unlisten()); };
  }, [nativeWindow]);

  if (!nativeWindow || fullscreen) return null;
  const run = (action: 'minimize' | 'toggleMaximize' | 'close') => {
    void nativeWindow[action]().catch((error) => console.warn('[Window] Window action failed:', error));
  };

  return (
    <div className={`window-titlebar ${focused ? '' : 'is-inactive'}`}>
      <div className="window-titlebar-drag" data-tauri-drag-region>
        <img src={logoImg} width="16" height="16" alt="" draggable={false} data-tauri-drag-region />
        <span data-tauri-drag-region>P2Sharer</span>
      </div>
      <div className="window-caption-controls" role="group" aria-label="Controles da janela">
        <Tooltip content="Minimizar">
          <button type="button" className="btn window-caption-button" aria-label="Minimizar"
            onClick={() => run('minimize')}><Minus size={12} aria-hidden="true" /></button>
        </Tooltip>
        <Tooltip content={maximized ? 'Restaurar' : 'Maximizar'}>
          <button type="button" className="btn window-caption-button" aria-label={maximized ? 'Restaurar' : 'Maximizar'}
            onClick={() => run('toggleMaximize')}>
            {maximized ? <Copy size={11} aria-hidden="true" /> : <Square size={11} aria-hidden="true" />}
          </button>
        </Tooltip>
        <Tooltip content="Fechar">
          <button type="button" className="btn window-caption-button window-caption-close" aria-label="Fechar"
            onClick={() => run('close')}><X size={14} aria-hidden="true" /></button>
        </Tooltip>
      </div>
    </div>
  );
};
