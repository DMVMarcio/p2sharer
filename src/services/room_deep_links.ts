import { isTauri } from '@tauri-apps/api/core';
import { getCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link';
import { extractRoomInvite, RoomDeepLinkInbox } from '../core/room_deep_links.ts';
import { verifyRoomInvite } from '../core/room_invite_validation.ts';
import { isShortRoomCode, parseRoomInvite } from '../core/room_invite.ts';
import { stateStore } from '../core/state_store.ts';
import { modalManager } from '../hooks/useModal.ts';
import { showToast } from '../hooks/useToast.ts';
import { t } from '../i18n/index.ts';
import { roomService } from './room_service.ts';

/** Only MainApp subscribes: auxiliary WebViews must never handle invitations. */
export function startRoomDeepLinks(): () => void {
  if (!isTauri()) return () => {};
  let disposed = false;
  let checking = false;
  let inspectingInvite: string | null = null;
  let receivedEvent = false;
  let unlisten: (() => void) | undefined;
  const inbox = new RoomDeepLinkInbox(invite => {
    checking = true;
    inspectingInvite = invite;
    const short = isShortRoomCode(invite);
    void (short ? Promise.resolve(null) : verifyRoomInvite(invite)).then(parsed => {
      if (disposed) return;
      if (!short && !parsed) { showToast(t('message.5348364ca0b6'), 3500, 'error'); return; }
      if (stateStore.roomSlots.length && (invite === stateStore.currentRoomInvite ||
          short && parseRoomInvite(stateStore.currentRoomInvite)?.roomId === invite)) return;
      // Recheck after asynchronous signature verification; never replace an active dialog.
      if (modalManager.getActive() || !stateStore.username || roomService.connectingOverlay.visible) {
        inbox.receive([`p2sharer://invite/${invite}`]);
        return;
      }
      roomService.pendingJoinInvite = invite;
      roomService.pendingJoinPassword = '';
      roomService.pendingJoinAsOwner = false;
      roomService.pendingJoinError = '';
      modalManager.open('joinRoom');
    }).catch(() => {
      if (!disposed) showToast(t('message.5348364ca0b6'), 3500, 'error');
    }).finally(() => { checking = false; inspectingInvite = null; if (!disposed) inbox.flush(); });
  }, () => !disposed && !checking && Boolean(stateStore.username) &&
    !modalManager.getActive() && !roomService.connectingOverlay.visible);
  const receive = (urls: string[]) => {
    // The same startup URL can arrive through both APIs, or be clicked again during preview.
    inbox.receive(urls.filter(url => {
      const invite = extractRoomInvite(url);
      return invite !== inspectingInvite && (invite !== roomService.pendingJoinInvite ||
        modalManager.getActive() !== 'joinRoom');
    }));
  };
  const subscriptions = [modalManager.subscribe(() => inbox.flush()),
    stateStore.subscribe(() => inbox.flush()), roomService.subscribe(() => inbox.flush())];
  void (async () => {
    // Listen first so a link delivered during startup cannot fall between the two APIs.
    unlisten = await onOpenUrl(urls => { receivedEvent = true; if (!disposed) receive(urls); });
    if (disposed) { unlisten(); return; }
    const urls = await getCurrent();
    if (!disposed && !receivedEvent && urls) receive(urls);
  })().catch(() => {
    if (!disposed) console.warn('[Rooms] Could not subscribe to application invitations');
  });
  return () => { disposed = true; unlisten?.(); subscriptions.forEach(unsubscribe => unsubscribe()); };
}
