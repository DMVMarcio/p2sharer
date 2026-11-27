export type BoardPlayerColor = 'w' | 'b';

export interface BoardClockState {
  /** Per-player time budget in milliseconds. */
  limitMs: number;
  /** Remaining milliseconds per side at the start of the active turn or latest sync. */
  remainingMs: { w: number; b: number };
  /** Wall-clock timestamp (ms) when the active turn started counting, or null when paused. */
  turnStartedAt: number | null;
  /** Monotonic sequence incremented on every move, undo, reset, config change, or periodic sync. */
  syncSeq: number;
}

export interface BoardUndoRequest {
  /** Color of the player who made the last move and asked to undo it. */
  requester: BoardPlayerColor;
  /** Move history length at request time so stale requests cannot undo another move. */
  moveCount: number;
}

export const TIME_LIMIT_OPTIONS_MINUTES = [0, 1, 3, 5, 10, 15, 20, 30, 60] as const;
export const MIN_BOARD_CLOCK_MS = 1000;
export const MAX_BOARD_CLOCK_MS = 7_200_000;

export function validBoardClockState(value: unknown): value is BoardClockState | null | undefined {
  if (value === undefined || value === null) return true;
  if (typeof value !== 'object') return false;
  const c = value as BoardClockState;
  if (!Number.isSafeInteger(c.limitMs) || c.limitMs < MIN_BOARD_CLOCK_MS || c.limitMs > MAX_BOARD_CLOCK_MS) {
    return false;
  }
  if (
    !c.remainingMs ||
    typeof c.remainingMs !== 'object' ||
    !Number.isSafeInteger(c.remainingMs.w) ||
    c.remainingMs.w < 0 ||
    c.remainingMs.w > c.limitMs ||
    !Number.isSafeInteger(c.remainingMs.b) ||
    c.remainingMs.b < 0 ||
    c.remainingMs.b > c.limitMs
  ) {
    return false;
  }
  if (c.turnStartedAt !== null && (!Number.isFinite(c.turnStartedAt) || c.turnStartedAt < 0)) {
    return false;
  }
  if (!Number.isSafeInteger(c.syncSeq) || c.syncSeq < 0) {
    return false;
  }
  return true;
}

export function validBoardUndoRequest(value: unknown): value is BoardUndoRequest | null | undefined {
  if (value === undefined || value === null) return true;
  if (typeof value !== 'object') return false;
  const req = value as BoardUndoRequest;
  if (req.requester !== 'w' && req.requester !== 'b') return false;
  if (!Number.isSafeInteger(req.moveCount) || req.moveCount < 1) return false;
  return true;
}

export function createBoardClock(limitMs: number, syncSeq = 0): BoardClockState {
  return {
    limitMs,
    remainingMs: { w: limitMs, b: limitMs },
    turnStartedAt: null,
    syncSeq,
  };
}

export function getElapsedTurnMs(clock: BoardClockState, now: number, elapsedMs?: number): number {
  if (elapsedMs !== undefined && Number.isFinite(elapsedMs)) {
    return Math.max(0, Math.round(elapsedMs));
  }
  if (clock.turnStartedAt === null) return 0;
  return Math.max(0, Math.round(now - clock.turnStartedAt));
}

export function advanceBoardClockOnMove(
  clock: BoardClockState | null | undefined,
  moverColor: BoardPlayerColor,
  moveCountBefore: number,
  nextStatus: string,
  now: number,
  elapsedMs?: number,
): BoardClockState | null {
  if (!clock) return null;
  const remaining = { ...clock.remainingMs };
  if (moveCountBefore > 0) {
    const spent = getElapsedTurnMs(clock, now, elapsedMs);
    remaining[moverColor] = Math.max(0, remaining[moverColor] - spent);
  }
  return {
    limitMs: clock.limitMs,
    remainingMs: remaining,
    turnStartedAt: nextStatus === 'playing' ? now : null,
    syncSeq: clock.syncSeq + 1,
  };
}

export function pauseBoardClock(
  clock: BoardClockState | null | undefined,
  activeTurn: BoardPlayerColor,
  moveCount: number,
  now: number,
  elapsedMs?: number,
): BoardClockState | null {
  if (!clock) return null;
  const remaining = { ...clock.remainingMs };
  if (moveCount > 0 && clock.turnStartedAt !== null) {
    const spent = getElapsedTurnMs(clock, now, elapsedMs);
    remaining[activeTurn] = Math.max(0, remaining[activeTurn] - spent);
  }
  return {
    limitMs: clock.limitMs,
    remainingMs: remaining,
    turnStartedAt: null,
    syncSeq: clock.syncSeq + 1,
  };
}

export function restoreBoardClockOnUndo(
  clock: BoardClockState | null | undefined,
  requester: BoardPlayerColor,
  nextMoveCount: number,
  now: number,
  prevRemainingMs?: { w: number; b: number },
): BoardClockState | null {
  if (!clock) return null;
  const opponent: BoardPlayerColor = requester === 'w' ? 'b' : 'w';
  const remaining = {
    w: clock.remainingMs.w,
    b: clock.remainingMs.b,
  };
  // Restore opponent's pre-turn time so accepting an undo never costs them clock time.
  if (prevRemainingMs && Number.isSafeInteger(prevRemainingMs[opponent])) {
    remaining[opponent] = Math.max(0, Math.min(clock.limitMs, prevRemainingMs[opponent]));
  }
  return {
    limitMs: clock.limitMs,
    remainingMs: remaining,
    turnStartedAt: nextMoveCount === 0 ? null : now,
    syncSeq: clock.syncSeq + 1,
  };
}

export function timeoutBoardClock(
  clock: BoardClockState | null | undefined,
  losingColor: BoardPlayerColor,
): BoardClockState | null {
  if (!clock) return null;
  return {
    limitMs: clock.limitMs,
    remainingMs: {
      ...clock.remainingMs,
      [losingColor]: 0,
    },
    turnStartedAt: null,
    syncSeq: clock.syncSeq + 1,
  };
}

export function formatBoardClockTime(ms: number): string {
  const clamped = Math.max(0, ms);
  if (clamped === 0) return '00:00';
  const totalSeconds = Math.ceil(clamped / 1000);
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(totalMinutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
