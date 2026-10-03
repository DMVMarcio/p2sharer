import React, { Suspense, lazy, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { ExternalLink, Pin, X } from 'lucide-react';
import { TooltipButton } from '../components/common/TooltipButton';
import { ToastContainer } from '../components/common/ToastContainer';
import { getRoomApp, type RoomAppViewProps } from './registry';
import { roomAppsService } from './room_apps_service';
import { appWindowEvent, appWindowPeerId, sendAppWindow, type AppWindowMessage } from './app_window';
import { stateStore } from '../core/state_store';

export const RoomAppWindow: React.FC<{ instanceId: string }> = ({ instanceId }) => {
  const [View, setView] = useState<React.LazyExoticComponent<React.ComponentType<RoomAppViewProps>> | null>(null);
  const [label, setLabel] = useState('App');
  const [error, setError] = useState('');
  const [alwaysOnTop, setAlwaysOnTop] = useState(true);
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
        roomAppsService.receive({ kind: 'sync', instances: [message.instance],
          snapshots: {}, closed: [] }, message.actor);
        stateStore.set((state) => { state.username = message.username; });
        setLabel(definition.label);
        setView(() => lazy(definition.loadView));
      }
      roomAppsService.applyLocalView(instanceId, message.snapshot, message.participants, message.receivedAt);
    }).then((unlisten) => {
      if (disposed) { unlisten(); return; }
      remove = unlisten;
      void sendAppWindow(instanceId, 'main', { type: 'ready' }).catch((reason) => setError(String(reason)));
    }).catch((reason) => setError(String(reason)));
    return () => { disposed = true; remove?.(); roomAppsService.reset(); };
  }, [instanceId]);
  const close = () => void sendAppWindow(instanceId, 'main', { type: 'restore' }).catch(console.warn);
  return <><div className="room-app-window">
    <div className="pip-top-bar" data-tauri-drag-region>
      <div className="pip-top-left" data-tauri-drag-region><ExternalLink size={16} />
        <span className="pip-title" data-tauri-drag-region>{label}</span></div>
      <div className="pip-top-right">
        <TooltipButton tooltip="Sempre no topo" aria-label="Sempre no topo" aria-pressed={alwaysOnTop}
          className={`pip-header-btn ${alwaysOnTop ? 'active' : ''}`} onClick={async () => {
            try { await invoke('set_pip_always_on_top', { peerId: appWindowPeerId(instanceId), alwaysOnTop: !alwaysOnTop });
              setAlwaysOnTop(!alwaysOnTop); } catch (reason) { setError(String(reason)); }
          }}><Pin size={15} /></TooltipButton>
        <TooltipButton tooltip="Restaurar para o app" aria-label="Restaurar para o app"
          className="pip-header-btn pip-close-btn" onClick={close}><X size={16} /></TooltipButton>
      </div>
    </div>
    <div className="room-app-card-body">
      {error ? <div className="room-app-player-placeholder">{error}</div> :
        <Suspense fallback={<div className="room-app-player-placeholder">Carregando App...</div>}>
          {View && <View instanceId={instanceId} compact={false} />}
        </Suspense>}
    </div>
  </div><ToastContainer /></>;
};
