import { isTauri } from '@tauri-apps/api/core';
import { roomCodeFromPath, webRoomPath } from '../core/web_room_links.ts';
import { parseRoomInvite } from '../core/room_invite.ts';
import { stateStore } from '../core/state_store.ts';
import { modalManager } from '../hooks/useModal.ts';
import { roomService } from './room_service.ts';

/** URLs carry only public short codes. Joining still requires the canonical preview and admission flow. */
export interface WebRoomNavigation {
  replace: (path: string) => void;
  subscribe: (listener: () => void) => () => void;
  registerExit: (confirmExit: () => Promise<boolean>) => () => void;
}

export function startWebRoomNavigation(confirmExit: () => Promise<boolean>, router?: WebRoomNavigation): () => void {
  if (isTauri()) return () => {};
  let pending = roomCodeFromPath(window.location.pathname);
  let preview: string | null = null;
  if (pending && modalManager.getActive() === 'joinRoom' && (roomService.pendingJoinInvite === pending ||
      parseRoomInvite(roomService.pendingJoinInvite)?.roomId === pending)) { preview = pending; pending = null; }
  let previous: string | null = null;
  let disposed = false;
  let navigating = false;
  const current = () => stateStore.roomSlots.length ? parseRoomInvite(stateStore.currentRoomInvite)?.roomId ?? null : null;
  const replace = (code: string | null) => {
    const path = webRoomPath(code);
    if (window.location.pathname !== path || window.location.search || window.location.hash) {
      if (router) router.replace(path);
      else history.replaceState(history.state, '', path);
    }
  };
  const sync = () => {
    if (disposed || navigating) return;
    const active = current();
    if (preview && modalManager.getActive() !== 'joinRoom' && (active || !roomService.connectingOverlay.visible)) {
      preview = null;
      if (!active && !pending && !roomService.connectingOverlay.visible) replace(null);
    }
    if (active !== previous) {
      if (active) { pending = null; replace(active); }
      else if (previous) replace(pending);
      previous = active;
    }
    if (pending && !active && stateStore.username && !modalManager.getActive() && !roomService.connectingOverlay.visible) {
      const code = pending; pending = null;
      preview = code;
      roomService.pendingJoinInvite = code;
      roomService.pendingJoinPassword = '';
      roomService.pendingJoinAsOwner = false;
      roomService.pendingJoinError = '';
      modalManager.open('joinRoom');
    }
  };
  const pop = async () => {
    if (navigating) return;
    const code = roomCodeFromPath(window.location.pathname);
    const active = current();
    if (active === code) return;
    navigating = true;
    try {
      if (active && !await confirmExit()) { if (!disposed) replace(active); return; }
      if (disposed) return;
      pending = code;
      if (active) await roomService.leaveRoom();
    } finally { navigating = false; sync(); }
  };
  const onPop = () => { void pop().catch(() => { if (!disposed) replace(current()); }); };
  const subscriptions = [stateStore.subscribe(sync), modalManager.subscribe(sync), roomService.subscribe(sync)];
  const stopNavigation = router ? router.subscribe(onPop) : (() => {
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  })();
  const stopExit = router?.registerExit(confirmExit);
  sync();
  return () => { disposed = true; stopNavigation(); stopExit?.(); subscriptions.forEach(stop => stop()); };
}
