import { t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import React, { useEffect, useMemo, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Minus, Square, Copy, X } from 'lucide-react';
import { Tooltip } from '../common/Tooltip';
import logoImg from '../../assets/logo.svg';
import { AppUpdateButton } from './AppUpdateButton';
import { useStore } from '../../hooks/useStore';
import { roomService } from '../../services/room_service';

/** Main-window chrome; detached media windows keep their existing controls. */
export const WindowTitlebar: React.FC<{ onVisibilityChange: (visible: boolean) => void }> = ({ onVisibilityChange }) => {
  useLocale();
  const nativeWindow = useMemo(() => isTauri() ? getCurrentWindow() : null, []);
  const title = useStore((state) => state.currentRoomCode && state.roomSlots.length > 0
    ? `P2Sharer - ${state.currentRoomName || state.currentRoomCode}`
    : t("message.80801012506c"));
  const [maximized, setMaximized] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [focused, setFocused] = useState(true);

  useEffect(() => {
    document.title = title;
    if (nativeWindow) {
      void nativeWindow.setTitle(title).catch((error) => console.warn('[Window] Could not update window title:', error));
    }
  }, [nativeWindow, title]);

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
    let closing = false;
    retain(nativeWindow.onCloseRequested(async event => {
      event.preventDefault();
      if (closing) return;
      closing = true;
      try { await roomService.leaveRoom(); }
      catch (error) { console.warn('[Window] Room shutdown failed:', error); }
      await nativeWindow.destroy();
    }));
    void refresh().catch(report);
    return () => { disposed = true; listeners.forEach((unlisten) => unlisten()); };
  }, [nativeWindow]);

  useEffect(() => { onVisibilityChange(Boolean(nativeWindow) && !fullscreen); }, [nativeWindow, fullscreen, onVisibilityChange]);

  if (!nativeWindow || fullscreen) return null;
  const run = (action: 'minimize' | 'toggleMaximize' | 'close') => {
    void nativeWindow[action]().catch((error) => console.warn('[Window] Window action failed:', error));
  };

  return (
    <div className={`window-titlebar ${focused ? '' : 'is-inactive'}`} onContextMenu={(event) => {
      event.preventDefault();
      event.stopPropagation();
      void invoke('show_window_menu').catch((error) => console.warn('[Window] Could not open system menu:', error));
    }}>
      <div className="window-titlebar-drag" data-tauri-drag-region>
        <img src={logoImg} width="16" height="16" alt="" draggable={false} data-tauri-drag-region />
        <span className="window-titlebar-title" data-tauri-drag-region>{title}</span>
      </div>
      <div className="window-titlebar-actions"><AppUpdateButton /></div>
      <div className="window-caption-controls" role="group" aria-label={t("message.a64ca0dc164b")}>
        <Tooltip content={t("message.3fc5f90b27f1")}>
          <button type="button" className="btn window-caption-button" aria-label={t("message.3fc5f90b27f1")}
            onClick={() => run('minimize')}><Minus size={12} aria-hidden="true" /></button>
        </Tooltip>
        <Tooltip content={maximized ? t("message.eda02893d340") : t("message.092b9ccfbf63")}>
          <button type="button" className="btn window-caption-button" aria-label={maximized ? t("message.eda02893d340") : t("message.092b9ccfbf63")}
            onClick={() => run('toggleMaximize')}>
            {maximized ? <Copy size={11} aria-hidden="true" /> : <Square size={11} aria-hidden="true" />}
          </button>
        </Tooltip>
        <Tooltip content={t("message.0f2bd88ef0ac")}>
          <button type="button" className="btn window-caption-button window-caption-close" aria-label={t("message.0f2bd88ef0ac")}
            onClick={() => run('close')}><X size={14} aria-hidden="true" /></button>
        </Tooltip>
      </div>
    </div>
  );
};
