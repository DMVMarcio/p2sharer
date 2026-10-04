import { localizeError, t } from '../i18n/index.ts';
import { useEffect, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { roomAppsService } from './room_apps_service';
import { appWindowEvent, appWindowPeerId, sendAppWindow, type AppWindowMessage } from './app_window';
import { youtubePipPeerId } from './youtube_pip';
import { stateStore } from '../core/state_store';
import { showToast } from '../hooks/useToast';
import type { RoomAppInstance } from './types';
import { YouTubeModel } from './models';
import { getRoomApp } from './registry';

export function useAppWindow(instance: RoomAppInstance) {
  const [detached, setDetached] = useState(false);
  const active = useRef(false);
  const opening = useRef(false);
  const ready = useRef<Promise<unknown>>(Promise.resolve());
  const restore = async () => {
    if (instance.kind === 'youtube') await invoke('close_pip_window', { peerId: youtubePipPeerId(instance.id) });
    await invoke('close_pip_window', { peerId: appWindowPeerId(instance.id) });
    active.current = false;
    setDetached(false);
  };
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    const removers: (() => void)[] = [];
    const sendState = () => {
      if (!active.current) return;
      const model = roomAppsService.getModel(instance.id);
      if (!model || !roomAppsService.isJoined(instance.id)) {
        void restore().catch(console.warn);
        return;
      }
      void sendAppWindow(instance.id, 'external', { type: 'state', instance,
        actor: roomAppsService.getLocalActor(), participants: roomAppsService.getParticipants(instance.id),
        snapshot: model.snapshot(), username: stateStore.username,
        receivedAt: model instanceof YouTubeModel ? model.receivedAt : undefined }).catch(console.warn);
    };
    removers.push(roomAppsService.subscribe(sendState));
    ready.current = Promise.all([
      listen<AppWindowMessage>(appWindowEvent(instance.id), ({ payload: message }) => {
        if (!active.current) return;
        if (message.type === 'ready') sendState();
        else if (message.type === 'update') roomAppsService.publishLocalView(instance.id, message.payload);
        else if (message.type === 'restore') void restore().catch(console.warn);
      }),
      listen<string>('pip-window-closed', ({ payload }) => {
        if (payload === appWindowPeerId(instance.id)) {
          if (instance.kind === 'youtube') void invoke('close_pip_window', { peerId: youtubePipPeerId(instance.id) }).catch(console.warn);
          active.current = false;
          setDetached(false);
        }
      }),
    ]).then((listeners) => {
      if (disposed) listeners.forEach((remove) => remove());
      else removers.push(...listeners);
    });
    return () => {
      disposed = true;
      removers.forEach((remove) => remove());
      if (active.current) {
        if (instance.kind === 'youtube') void invoke('close_pip_window', { peerId: youtubePipPeerId(instance.id) }).catch(console.warn);
        void invoke('close_pip_window', { peerId: appWindowPeerId(instance.id) }).catch(console.warn);
      }
      active.current = false;
    };
  }, [instance.id]);
  const detach = async () => {
    if (!isTauri() || active.current || opening.current || !roomAppsService.isJoined(instance.id)) return;
    opening.current = true;
    try {
      await ready.current;
      // The full app takes ownership after the existing player-only window closes.
      if (instance.kind === 'youtube') await invoke('close_pip_window', { peerId: youtubePipPeerId(instance.id) });
      active.current = true;
      setDetached(true);
      await invoke('open_pip_window', { peerId: appWindowPeerId(instance.id), title: getRoomApp(instance.kind)?.label || instance.kind });
      if (!roomAppsService.isJoined(instance.id)) await restore();
    } catch (error) {
      active.current = false;
      setDetached(false);
      showToast(t("message.cd3c7e1436f8", { v0: localizeError(error) }));
    } finally { opening.current = false; }
  };
  return { detached, detach, restore };
}
