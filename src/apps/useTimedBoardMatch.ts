import { useEffect, useRef, useState } from 'react';
import type { BoardGameRoomState, TimedBoardGameModel, TimedBoardGameState } from './board_game_model.ts';

const CLOCK_SYNC_INTERVAL_MS = 10_000;
const OPPONENT_TIMEOUT_GRACE_MS = 350;

export interface TimedBoardMatchClockView {
  seat1ClockMs: number | null;
  seat2ClockMs: number | null;
  isClockRunning: boolean;
}

export function useTimedBoardMatch<TGame extends TimedBoardGameState>(
  model: TimedBoardGameModel<TGame>,
  room: BoardGameRoomState<TGame> | undefined,
): TimedBoardMatchClockView {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const zeroReachedRef = useRef<{ key: string; at: number } | null>(null);

  const clock = room?.game.clock ?? null;
  const moveCount = room?.game.moveHistory.length ?? 0;
  const status = room?.game.status ?? 'playing';
  const turn = room?.game.turn ?? 'w';
  const isClockRunning = Boolean(
    room && clock && status === 'playing' && moveCount > 0 && clock.turnStartedAt !== null,
  );

  // Tick local display and claim timeout when the active player's clock reaches zero.
  useEffect(() => {
    if (!room || !clock || !isClockRunning) {
      zeroReachedRef.current = null;
      return;
    }

    const syncKey = `${room.id}:${clock.syncSeq}:${turn}`;
    const checkClock = () => {
      const now = Date.now();
      setNowMs(now);

      const remaining = model.getRemainingTimeMsForRoom(room, turn, now);
      if (remaining === null || remaining > 0) {
        if (zeroReachedRef.current?.key === syncKey) {
          zeroReachedRef.current = null;
        }
        return;
      }

      const activeActor = turn === 'w' ? room.players.seat1 : room.players.seat2;
      const otherActor = turn === 'w' ? room.players.seat2 : room.players.seat1;

      if (activeActor === model.localActor) {
        model.claimTimeout(room.id, now);
        return;
      }

      if (otherActor === model.localActor) {
        if (!zeroReachedRef.current || zeroReachedRef.current.key !== syncKey) {
          zeroReachedRef.current = { key: syncKey, at: now };
          return;
        }
        if (now - zeroReachedRef.current.at >= OPPONENT_TIMEOUT_GRACE_MS) {
          model.claimTimeout(room.id, now);
        }
      }
    };

    checkClock();
    const currentRemaining = model.getRemainingTimeMsForRoom(room, turn, Date.now());
    const intervalMs = currentRemaining !== null && currentRemaining <= 15_000 ? 80 : 180;
    const timer = window.setInterval(checkClock, intervalMs);
    return () => window.clearInterval(timer);
  }, [model, room, clock?.syncSeq, clock?.turnStartedAt, isClockRunning, turn]);

  // Periodically publish a clock sync from the active player during long turns so all peers stay aligned.
  useEffect(() => {
    if (!room || !clock || !isClockRunning) return;
    const activeActor = turn === 'w' ? room.players.seat1 : room.players.seat2;
    if (activeActor !== model.localActor) return;

    const timer = window.setInterval(() => {
      model.syncClock(room.id);
    }, CLOCK_SYNC_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [model, room?.id, clock?.syncSeq, isClockRunning, turn, room?.players.seat1, room?.players.seat2]);

  if (!room || !clock) {
    return { seat1ClockMs: null, seat2ClockMs: null, isClockRunning: false };
  }

  return {
    seat1ClockMs: model.getRemainingTimeMsForRoom(room, 'w', nowMs),
    seat2ClockMs: model.getRemainingTimeMsForRoom(room, 'b', nowMs),
    isClockRunning,
  };
}
