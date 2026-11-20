import { parseRoomInvite } from '../core/room_invite.ts';
import { stabilizeRoomPreview, type RoomPreview, type RoomPreviewParticipant } from '../core/room_preview.ts';
import { savedRooms, type SavedRoom } from '../core/saved_rooms.ts';
import { stateStore } from '../core/state_store.ts';
import { modalManager } from '../hooks/useModal.ts';
import { GroupRoomManager } from '../p2p/group_room.ts';
import { roomService } from './room_service.ts';

export const HOME_ROOM_PRESENCE_INTERVAL_MS = 5 * 60 * 1000;
const PROBE_MAX_MS = 7000;
const PROBE_RETRY_MS = 2200;
const PROBE_SETTLE_AFTER_RESPONSE_MS = 1200;

export type ProbeRoomFn = (room: SavedRoom, signal: AbortSignal,
  onUpdate: (participants: RoomPreviewParticipant[]) => void) => Promise<RoomPreviewParticipant[]>;

export function createHomeRoomPresenceService(probeFn?: ProbeRoomFn) {
  let participantsByRoom: Record<string, RoomPreviewParticipant[]> = {};
  const lastCheckedAt = new Map<string, number>();
  const listeners = new Set<() => void>();
  let version = 0;
  let intervalTimer: ReturnType<typeof setInterval> | null = null;
  let activeConsumers = 0;
  let currentAbort: AbortController | null = null;
  let activeCycle: Promise<void> | null = null;
  let storeUnsubscribe: (() => void) | null = null;
  let savedUnsubscribe: (() => void) | null = null;
  let modalUnsubscribe: (() => void) | null = null;

  const notify = () => {
    version++;
    listeners.forEach((listener) => listener());
  };

  const canPoll = (): boolean => {
    const activeModal = modalManager.getActive();
    return stateStore.homeRoomPresencePolling &&
      !stateStore.currentRoomCode &&
      !roomService.roomManager &&
      !roomService.hasActiveRoomPreview() &&
      activeModal !== 'joinRoom' &&
      activeModal !== 'createRoom';
  };

  const defaultProbeRoom: ProbeRoomFn = async (room, signal, onUpdate) => {
    const parsed = parseRoomInvite(room.invite);
    if (!parsed || (parsed.version === 4 && parsed.connection) || signal.aborted) {
      return [];
    }
    const manager = new GroupRoomManager(
      stateStore.username || 'Guest',
      room.invite,
      '',
      room.owned,
      stateStore.getTurnConfig(),
      false,
      true,
    );
    let preview: RoomPreview | null = null;
    let latestParticipants: RoomPreviewParticipant[] = [];
    let settled = false;
    let resolveDone: (() => void) | null = null;
    let maxTimer: ReturnType<typeof setTimeout> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = () => {
      if (settled) return;
      settled = true;
      if (maxTimer) clearTimeout(maxTimer);
      if (retryTimer) clearTimeout(retryTimer);
      if (settleTimer) clearTimeout(settleTimer);
      resolveDone?.();
    };

    const donePromise = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const onAbort = () => finish();
    signal.addEventListener('abort', onAbort, { once: true });

    try {
      maxTimer = setTimeout(finish, PROBE_MAX_MS);
      retryTimer = setTimeout(() => {
        if (!settled && !signal.aborted && !preview) {
          manager.requestPreview();
        }
      }, PROBE_RETRY_MS);

      await manager.join({
        onPreview: (summary) => {
          if (settled || signal.aborted) return;
          preview = stabilizeRoomPreview(preview, summary);
          latestParticipants = preview.participants;
          onUpdate(latestParticipants);
          if (!settleTimer) {
            settleTimer = setTimeout(finish, PROBE_SETTLE_AFTER_RESPONSE_MS);
          }
        },
        onStreamsUpdate: () => {},
        onSlotsUpdate: () => {},
        onChat: () => {},
        onChatHistory: () => {},
        onPeersUpdate: () => {},
        onStatusChange: () => {},
      }, true);

      if (!signal.aborted && !settled) {
        manager.requestPreview();
        await donePromise;
      }
      return latestParticipants;
    } catch {
      return latestParticipants;
    } finally {
      signal.removeEventListener('abort', onAbort);
      if (maxTimer) clearTimeout(maxTimer);
      if (retryTimer) clearTimeout(retryTimer);
      if (settleTimer) clearTimeout(settleTimer);
      await manager.leave().catch(() => {});
    }
  };

  const runProbe = probeFn ?? defaultProbeRoom;

  const abortCurrent = () => {
    currentAbort?.abort();
    currentAbort = null;
  };

  const clear = () => {
    abortCurrent();
    lastCheckedAt.clear();
    if (Object.keys(participantsByRoom).length > 0) {
      participantsByRoom = {};
      notify();
    }
  };

  const pruneDeletedRooms = (savedIds: Set<string>) => {
    let changed = false;
    const next: Record<string, RoomPreviewParticipant[]> = {};
    for (const [id, list] of Object.entries(participantsByRoom)) {
      if (savedIds.has(id)) {
        next[id] = list;
      } else {
        lastCheckedAt.delete(id);
        changed = true;
      }
    }
    if (changed) {
      participantsByRoom = next;
      notify();
    }
  };

  const refreshDueRooms = async (force = false): Promise<void> => {
    if (!canPoll() || activeConsumers === 0) return;
    if (activeCycle) {
      if (!force) return;
      abortCurrent();
      await activeCycle.catch(() => {});
    }
    const controller = new AbortController();
    currentAbort = controller;
    const run = (async () => {
      try {
        const records = (await savedRooms.list()).filter((room) => room.saved);
        const savedIds = new Set(records.map((room) => room.roomId));
        pruneDeletedRooms(savedIds);
        const now = Date.now();
        for (const room of records) {
          if (controller.signal.aborted || !canPoll() || activeConsumers === 0) break;
          const last = lastCheckedAt.get(room.roomId) ?? 0;
          if (!force && now - last < HOME_ROOM_PRESENCE_INTERVAL_MS) continue;
          lastCheckedAt.set(room.roomId, Date.now());
          const result = await runProbe(room, controller.signal, (liveList) => {
            if (controller.signal.aborted || !canPoll()) return;
            participantsByRoom = { ...participantsByRoom, [room.roomId]: liveList };
            notify();
          });
          if (!controller.signal.aborted && canPoll()) {
            participantsByRoom = { ...participantsByRoom, [room.roomId]: result };
            notify();
          }
        }
      } finally {
        if (currentAbort === controller) currentAbort = null;
      }
    })();
    activeCycle = run;
    try {
      await run;
    } finally {
      if (activeCycle === run) activeCycle = null;
    }
  };

  const handleStateChange = () => {
    if (!stateStore.homeRoomPresencePolling) {
      clear();
      return;
    }
    if (!canPoll()) {
      abortCurrent();
      return;
    }
    if (activeConsumers > 0) {
      void refreshDueRooms();
    }
  };

  const start = (): (() => void) => {
    activeConsumers++;
    if (activeConsumers === 1) {
      storeUnsubscribe = stateStore.subscribe(handleStateChange);
      modalUnsubscribe = modalManager.subscribe(handleStateChange);
      savedUnsubscribe = savedRooms.subscribe(() => {
        if (canPoll()) void refreshDueRooms();
      });
      intervalTimer = setInterval(() => {
        if (canPoll()) void refreshDueRooms(true);
      }, HOME_ROOM_PRESENCE_INTERVAL_MS);
      if (canPoll()) void refreshDueRooms();
    }
    return () => {
      activeConsumers = Math.max(0, activeConsumers - 1);
      if (activeConsumers === 0) {
        abortCurrent();
        if (intervalTimer) {
          clearInterval(intervalTimer);
          intervalTimer = null;
        }
        storeUnsubscribe?.();
        storeUnsubscribe = null;
        modalUnsubscribe?.();
        modalUnsubscribe = null;
        savedUnsubscribe?.();
        savedUnsubscribe = null;
      }
    };
  };

  return {
    start,
    clear,
    refreshNow: (force = true) => refreshDueRooms(force),
    getParticipants: (roomId: string): RoomPreviewParticipant[] => participantsByRoom[roomId] ?? [],
    snapshot: () => version,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

export const homeRoomPresence = createHomeRoomPresenceService();
