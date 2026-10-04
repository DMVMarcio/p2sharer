import { localizeError, localizeText, t } from '../i18n';
import { useLocale } from '../hooks/useLocale';
import React, { Suspense, lazy, useEffect, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { ExternalLink, Pin, X } from 'lucide-react';
import { TooltipButton } from '../components/common/TooltipButton';
import { ToastContainer } from '../components/common/ToastContainer';
import { getRoomApp, type RoomAppViewProps } from './registry';
import { roomAppsService } from './room_apps_service';
import { appWindowEvent, appWindowPeerId, sendAppWindow, type AppWindowMessage } from './app_window';
import { stateStore } from '../core/state_store';

export const RoomAppWindow: React.FC<{ instanceId: string }> = ({ instanceId }) => {
  const language = useLocale();
  const [View, setView] = useState<React.LazyExoticComponent<React.ComponentType<RoomAppViewProps>> | null>(null);
  const [label, setLabel] = useState('App');
  const [error, setError] = useState('');
  const [alwaysOnTop, setAlwaysOnTop] = useState(true);
  useEffect(() => {
    const title = localizeText(label);
    document.title = title;
    if (isTauri()) void getCurrentWindow().setTitle(title).catch(console.warn);
  }, [label, language]);
  useEffect(() => {
    let disposed = false;
    let remove: (() => void) | undefined;
    let initialized = false;
    void listen<AppWindowMessage>(appWindowEvent(instanceId), ({ payload: message }) => {
      if (disposed || message.type !== 'state' || message.instance.id !== instanceId) return;
      const definition = getRoomApp(message.instance.kind);
      if (!definition) return;
      if (!initialized) {
        initialized = true;
        roomAppsService.attach((event) => {
          if (event.kind === 'data' && event.id === instanceId)
            void sendAppWindow(instanceId, 'main', { type: 'update', payload: event.payload }).catch(console.warn);
        }, message.actor);
        roomAppsService.initializeLocalView(message.instance);
        stateStore.set((state) => { state.username = message.username; });
        setLabel(definition.label);
        setView(() => lazy(definition.loadView));
      }
      roomAppsService.applyLocalView(instanceId, message.snapshot, message.participants, message.receivedAt);
    }).then((unlisten) => {
      if (disposed) { unlisten(); return; }
      remove = unlisten;
      void sendAppWindow(instanceId, 'main', { type: 'ready' }).catch((reason) => setError(localizeError(reason)));
    }).catch((reason) => setError(localizeError(reason)));
    return () => { disposed = true; remove?.(); roomAppsService.reset(); };
  }, [instanceId]);
  const close = () => void sendAppWindow(instanceId, 'main', { type: 'restore' }).catch(console.warn);
  return <><div className="room-app-window">
    <div className="pip-top-bar" data-tauri-drag-region>
      <div className="pip-top-left" data-tauri-drag-region><ExternalLink size={16} />
        <span className="pip-title" data-tauri-drag-region>{localizeText(label)}</span></div>
      <div className="pip-top-right">
        <TooltipButton tooltip={t("message.5a2e134fd61f")} aria-label={t("message.5a2e134fd61f")} aria-pressed={alwaysOnTop}
          className={`pip-header-btn ${alwaysOnTop ? 'active' : ''}`} onClick={async () => {
            try { await invoke('set_pip_always_on_top', { peerId: appWindowPeerId(instanceId), alwaysOnTop: !alwaysOnTop });
              setAlwaysOnTop(!alwaysOnTop); } catch (reason) { setError(localizeError(reason)); }
          }}><Pin size={15} /></TooltipButton>
        <TooltipButton tooltip={t("message.5899ac52fbbf")} aria-label={t("message.5899ac52fbbf")}
          className="pip-header-btn pip-close-btn" onClick={close}><X size={16} /></TooltipButton>
      </div>
    </div>
    <div className="room-app-card-body">
      {error ? <div className="room-app-player-placeholder">{localizeText(error)}</div> :
        <Suspense fallback={<div className="room-app-player-placeholder">{t("message.e9be847e98aa")}</div>}>
          {View && <View instanceId={instanceId} compact={false} />}
        </Suspense>}
    </div>
  </div><ToastContainer /></>;
};
