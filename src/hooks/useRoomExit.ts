import { useCallback, useEffect, useRef, useState } from 'react';
import { stateStore } from '../core/state_store';
import { parseRoomInvite } from '../core/room_invite';
import { savedRooms } from '../core/saved_rooms';
import { showToast } from './useToast';
import { t } from '../i18n';

/** Shares one consent boundary between leaving a room and closing the main window. */
export function useRoomExit() {
  const [pending, setPending] = useState(false);
  const [busy, setBusy] = useState(false);
  const active = useRef(false);
  const decision = useRef<((save: boolean | null) => void) | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; decision.current?.(null); };
  }, []);

  const confirmExit = useCallback(async (): Promise<boolean> => {
    if (active.current) return false;
    active.current = true;
    const invite = stateStore.currentRoomInvite;
    try {
      const roomId = parseRoomInvite(invite)?.roomId;
      if (!roomId || !stateStore.currentRoomCode) return true;
      const record = await savedRooms.get(roomId);
      if (!mounted.current || stateStore.currentRoomInvite !== invite) return false;
      if (record?.saved) return true;
      setPending(true);
      const save = await new Promise<boolean | null>(resolve => { decision.current = resolve; });
      decision.current = null;
      if (save === null || stateStore.currentRoomInvite !== invite) return false;
      if (save) {
        setBusy(true);
        const latest = await savedRooms.get(roomId);
        if (!latest) throw new Error('Room record is missing');
        await savedRooms.put({ ...latest, saved: true });
      }
      return stateStore.currentRoomInvite === invite;
    } catch (error) {
      console.warn('[Rooms] Could not prepare room exit:', error);
      showToast(t('message.d94a6e24bf10'), 3500, 'error');
      return false;
    } finally {
      active.current = false;
      if (mounted.current) { setPending(false); setBusy(false); }
    }
  }, []);

  return { confirmExit, pending, busy, decide: (save: boolean | null) => decision.current?.(save) };
}
