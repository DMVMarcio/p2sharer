import * as Y from 'yjs';
import { decodeUpdate, encodeUpdate, type RoomAppModel, type RoomAppModelContext } from './models.ts';
import {
  applyTicTacToeMove,
  createInitialTicTacToeState,
  resetTicTacToeRound,
  validTicTacToeState,
  type TicTacToeGameState,
} from './tictactoe_engine.ts';
import {
  applyChessMove,
  createInitialChessState,
  resignChessGame,
  timeoutChessGame,
  undoLastChessMove,
  validChessState,
  type ChessGameState,
  type ChessPromotionPiece,
} from './chess_engine.ts';
import {
  applyCheckersMove,
  createInitialCheckersState,
  resignCheckersGame,
  timeoutCheckersGame,
  undoLastCheckersMove,
  validCheckersState,
  type CheckersGameState,
} from './checkers_engine.ts';
import {
  createBoardClock,
  MAX_BOARD_CLOCK_MS,
  MIN_BOARD_CLOCK_MS,
  type BoardClockState,
  type BoardPlayerColor,
  type BoardUndoRequest,
} from './board_game_timing.ts';

export type BoardGameKind = 'tictactoe' | 'chess' | 'checkers';

export interface BoardGameRoomState<TGame> {
  id: string;
  name: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  players: {
    seat1: string | null;
    seat2: string | null;
  };
  spectators: string[];
  game: TGame;
}

export type TicTacToeRoomState = BoardGameRoomState<TicTacToeGameState>;
export type ChessRoomState = BoardGameRoomState<ChessGameState>;
export type CheckersRoomState = BoardGameRoomState<CheckersGameState>;

const MAX_ROOMS = 24;
const MAX_ROOM_NAME = 48;
const MAX_UPDATE = 700_000;
const LOCAL = 'board-game-local';

function validActorId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 100;
}

function validRoomId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9-]{4,48}$/i.test(value);
}

function validBoardGameRoom<TGame>(
  value: unknown,
  validGame: (game: unknown) => game is TGame,
): value is BoardGameRoomState<TGame> {
  if (!value || typeof value !== 'object') return false;
  const r = value as BoardGameRoomState<TGame>;
  if (!validRoomId(r.id)) return false;
  if (typeof r.name !== 'string' || !r.name.trim() || r.name.length > MAX_ROOM_NAME) return false;
  if (!validActorId(r.createdBy)) return false;
  if (!Number.isFinite(r.createdAt) || !Number.isFinite(r.updatedAt)) return false;
  if (!r.players || typeof r.players !== 'object') return false;
  if (r.players.seat1 !== null && !validActorId(r.players.seat1)) return false;
  if (r.players.seat2 !== null && !validActorId(r.players.seat2)) return false;
  if (r.players.seat1 && r.players.seat1 === r.players.seat2) return false;
  if (!Array.isArray(r.spectators) || r.spectators.length > 64 || !r.spectators.every(validActorId)) return false;
  return validGame(r.game);
}

export class BoardGameLobbyModel<TGame> implements RoomAppModel {
  readonly kind: BoardGameKind;
  readonly document = new Y.Doc();
  private roomsMap = this.document.getMap<string>('rooms');
  private participants = new Set<string>();
  private context: RoomAppModelContext;
  private createInitialGame: () => TGame;
  private validGame: (game: unknown) => game is TGame;

  constructor(
    kind: BoardGameKind,
    context: RoomAppModelContext,
    createInitialGame: () => TGame,
    validGame: (game: unknown) => game is TGame,
  ) {
    this.kind = kind;
    this.context = context;
    this.createInitialGame = createInitialGame;
    this.validGame = validGame;

    this.document.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== 'remote' && update.byteLength <= MAX_UPDATE) {
        this.context.emit({ update: encodeUpdate(update) });
      }
      this.context.changed();
    });
  }

  get localActor(): string {
    return this.context.localActor;
  }

  get rooms(): BoardGameRoomState<TGame>[] {
    const list: BoardGameRoomState<TGame>[] = [];
    for (const [id, raw] of this.roomsMap.entries()) {
      try {
        const parsed = JSON.parse(raw);
        if (validBoardGameRoom(parsed, this.validGame) && parsed.id === id) {
          list.push(parsed);
        }
      } catch {
        // Ignore malformed room record
      }
    }
    return list.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  getRoom(roomId: string): BoardGameRoomState<TGame> | undefined {
    const raw = this.roomsMap.get(roomId);
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw);
      return validBoardGameRoom(parsed, this.validGame) && parsed.id === roomId ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  protected writeRoom(room: BoardGameRoomState<TGame>): void {
    if (!validBoardGameRoom(room, this.validGame)) return;
    this.document.transact(() => {
      this.roomsMap.set(room.id, JSON.stringify(room));
    }, LOCAL);
  }

  createRoom(name: string, joinSeat: 'seat1' | 'seat2' | 'spectator' = 'seat1'): string | null {
    const trimmed = name.trim().slice(0, MAX_ROOM_NAME);
    if (!trimmed || this.rooms.length >= MAX_ROOMS || !this.localActor) return null;
    const id = crypto.randomUUID();
    const now = Date.now();
    const room: BoardGameRoomState<TGame> = {
      id,
      name: trimmed,
      createdBy: this.localActor,
      createdAt: now,
      updatedAt: now,
      players: {
        seat1: joinSeat === 'seat1' ? this.localActor : null,
        seat2: joinSeat === 'seat2' ? this.localActor : null,
      },
      spectators: joinSeat === 'spectator' ? [this.localActor] : [],
      game: this.createInitialGame(),
    };
    this.writeRoom(room);
    return id;
  }

  deleteRoom(roomId: string): boolean {
    const room = this.getRoom(roomId);
    if (!room) return false;
    this.document.transact(() => {
      this.roomsMap.delete(roomId);
    }, LOCAL);
    return true;
  }

  renameRoom(roomId: string, nextName: string): boolean {
    const room = this.getRoom(roomId);
    const trimmed = nextName.trim().slice(0, MAX_ROOM_NAME);
    if (!room || !trimmed) return false;
    this.writeRoom({
      ...room,
      name: trimmed,
      updatedAt: Date.now(),
    });
    return true;
  }

  joinRole(roomId: string, role: 'seat1' | 'seat2' | 'spectator'): boolean {
    const room = this.getRoom(roomId);
    const actor = this.localActor;
    if (!room || !actor) return false;

    const nextPlayers = { ...room.players };
    const nextSpectators = room.spectators.filter((id) => id !== actor);

    if (role === 'seat1') {
      if (nextPlayers.seat1 && nextPlayers.seat1 !== actor) return false;
      if (nextPlayers.seat2 === actor) nextPlayers.seat2 = null;
      nextPlayers.seat1 = actor;
    } else if (role === 'seat2') {
      if (nextPlayers.seat2 && nextPlayers.seat2 !== actor) return false;
      if (nextPlayers.seat1 === actor) nextPlayers.seat1 = null;
      nextPlayers.seat2 = actor;
    } else {
      if (nextPlayers.seat1 === actor) nextPlayers.seat1 = null;
      if (nextPlayers.seat2 === actor) nextPlayers.seat2 = null;
      if (!nextSpectators.includes(actor)) nextSpectators.push(actor);
    }

    this.writeRoom({
      ...room,
      players: nextPlayers,
      spectators: nextSpectators,
      updatedAt: Date.now(),
    });
    return true;
  }

  leaveRoom(roomId: string): void {
    const room = this.getRoom(roomId);
    const actor = this.localActor;
    if (!room || !actor) return;

    const nextPlayers = {
      seat1: room.players.seat1 === actor ? null : room.players.seat1,
      seat2: room.players.seat2 === actor ? null : room.players.seat2,
    };
    const nextSpectators = room.spectators.filter((id) => id !== actor);

    if (
      nextPlayers.seat1 === room.players.seat1 &&
      nextPlayers.seat2 === room.players.seat2 &&
      nextSpectators.length === room.spectators.length
    ) {
      return;
    }

    this.writeRoom({
      ...room,
      players: nextPlayers,
      spectators: nextSpectators,
      updatedAt: Date.now(),
    });
  }

  updateGame(roomId: string, updater: (room: BoardGameRoomState<TGame>) => TGame | null): boolean {
    const room = this.getRoom(roomId);
    if (!room) return false;
    const nextGame = updater(room);
    if (!nextGame || !this.validGame(nextGame)) return false;
    this.writeRoom({
      ...room,
      game: nextGame,
      updatedAt: Date.now(),
    });
    return true;
  }

  setParticipants(participants: string[]): void {
    const active = new Set(participants);
    const previous = this.participants;
    this.participants = active;

    // Only clean up seats of departed participants if they were previously known in participants
    // and are now gone, to avoid racing initial presence sync.
    const departed = [...previous].filter((p) => !active.has(p));
    if (departed.length === 0) return;

    const departedSet = new Set(departed);
    this.document.transact(() => {
      for (const room of this.rooms) {
        const seat1 = room.players.seat1 && departedSet.has(room.players.seat1) ? null : room.players.seat1;
        const seat2 = room.players.seat2 && departedSet.has(room.players.seat2) ? null : room.players.seat2;
        const spectators = room.spectators.filter((id) => !departedSet.has(id));
        if (
          seat1 !== room.players.seat1 ||
          seat2 !== room.players.seat2 ||
          spectators.length !== room.spectators.length
        ) {
          const updated: BoardGameRoomState<TGame> = {
            ...room,
            players: { seat1, seat2 },
            spectators,
            updatedAt: Date.now(),
          };
          this.roomsMap.set(room.id, JSON.stringify(updated));
        }
      }
    }, LOCAL);
  }

  snapshot(): unknown {
    return { update: encodeUpdate(Y.encodeStateAsUpdate(this.document)) };
  }

  apply(payload: unknown): void {
    if (!payload || typeof payload !== 'object') return;
    const data = payload as { update?: unknown };
    const update = decodeUpdate(data.update, MAX_UPDATE);
    if (!update) return;
    try {
      Y.applyUpdate(this.document, update, 'remote');
    } catch {
      // Ignore malformed Yjs update
    }
  }

  destroy(): void {
    this.document.destroy();
  }
}

export class TicTacToeModel extends BoardGameLobbyModel<TicTacToeGameState> {
  constructor(context: RoomAppModelContext) {
    super('tictactoe', context, () => createInitialTicTacToeState('X'), validTicTacToeState);
  }

  makeMove(roomId: string, cellIndex: number): boolean {
    const actor = this.localActor;
    return this.updateGame(roomId, (room) => {
      const expectedActor = room.game.turn === 'X' ? room.players.seat1 : room.players.seat2;
      if (!actor || expectedActor !== actor) return null;
      return applyTicTacToeMove(room.game, cellIndex);
    });
  }

  newRound(roomId: string, resetScores = false): boolean {
    const actor = this.localActor;
    return this.updateGame(roomId, (room) => {
      if (!actor) return null;
      const isPlayer = room.players.seat1 === actor || room.players.seat2 === actor || room.createdBy === actor;
      if (!isPlayer && room.players.seat1 && room.players.seat2) return null;
      return resetTicTacToeRound(room.game, resetScores);
    });
  }
}

export interface TimedBoardGameState {
  turn: BoardPlayerColor;
  status: string;
  moveHistory: { color: BoardPlayerColor }[];
  scores: { w: number; b: number; draws: number };
  clock?: BoardClockState | null;
  undoRequest?: BoardUndoRequest | null;
}

interface TimedGameHooks<TGame extends TimedBoardGameState> {
  createInitial: (scores: { w: number; b: number; draws: number }, limitMs: number | null, syncSeq: number) => TGame;
  resign: (game: TGame, color: BoardPlayerColor, now: number, elapsedMs?: number) => TGame;
  undo: (game: TGame, now: number) => TGame | null;
  timeout: (game: TGame, losingColor: BoardPlayerColor) => TGame;
}

export class TimedBoardGameModel<TGame extends TimedBoardGameState> extends BoardGameLobbyModel<TGame> {
  private hooks: TimedGameHooks<TGame>;
  private clockAnchors = new Map<string, { syncSeq: number; turn: BoardPlayerColor; anchoredAt: number }>();
  private seenRoomSyncs = new Map<string, number>();

  constructor(
    kind: BoardGameKind,
    context: RoomAppModelContext,
    createInitialGame: () => TGame,
    validGame: (game: unknown) => game is TGame,
    hooks: TimedGameHooks<TGame>,
  ) {
    super(kind, context, createInitialGame, validGame);
    this.hooks = hooks;
  }

  protected override writeRoom(room: BoardGameRoomState<TGame>): void {
    super.writeRoom(room);
    this.refreshClockAnchors();
  }

  override apply(payload: unknown): void {
    super.apply(payload);
    this.refreshClockAnchors();
  }

  override joinRole(roomId: string, role: 'seat1' | 'seat2' | 'spectator'): boolean {
    const before = this.getRoom(roomId);
    const changed = super.joinRole(roomId, role);
    if (changed && before?.game.undoRequest) {
      const after = this.getRoom(roomId);
      if (
        after &&
        (after.players.seat1 !== before.players.seat1 || after.players.seat2 !== before.players.seat2)
      ) {
        this.clearUndoRequest(roomId);
      }
    }
    return changed;
  }

  override leaveRoom(roomId: string): void {
    const before = this.getRoom(roomId);
    super.leaveRoom(roomId);
    if (before?.game.undoRequest) {
      const after = this.getRoom(roomId);
      if (
        after &&
        (after.players.seat1 !== before.players.seat1 || after.players.seat2 !== before.players.seat2)
      ) {
        this.clearUndoRequest(roomId);
      }
    }
  }

  override setParticipants(participants: string[]): void {
    super.setParticipants(participants);
    for (const room of this.rooms) {
      if (room.game.undoRequest && (!room.players.seat1 || !room.players.seat2)) {
        this.clearUndoRequest(room.id);
      }
    }
    this.refreshClockAnchors();
  }

  private clearUndoRequest(roomId: string): void {
    this.updateGame(roomId, (room) => {
      if (!room.game.undoRequest) return null;
      return { ...room.game, undoRequest: null };
    });
  }

  private refreshClockAnchors(now = Date.now()): void {
    const activeIds = new Set<string>();
    for (const room of this.rooms) {
      activeIds.add(room.id);
      const { clock } = room.game;
      if (
        !clock ||
        room.game.status !== 'playing' ||
        room.game.moveHistory.length === 0 ||
        clock.turnStartedAt === null
      ) {
        this.clockAnchors.delete(room.id);
        this.seenRoomSyncs.set(room.id, clock?.syncSeq ?? -1);
        continue;
      }

      const prevAnchor = this.clockAnchors.get(room.id);
      if (prevAnchor && prevAnchor.syncSeq === clock.syncSeq && prevAnchor.turn === room.game.turn) {
        continue;
      }

      const prevSeenSync = this.seenRoomSyncs.get(room.id);
      const anchoredAt =
        prevSeenSync !== undefined && prevSeenSync !== clock.syncSeq
          ? now
          : Math.min(now, clock.turnStartedAt);

      this.clockAnchors.set(room.id, {
        syncSeq: clock.syncSeq,
        turn: room.game.turn,
        anchoredAt,
      });
      this.seenRoomSyncs.set(room.id, clock.syncSeq);
    }

    for (const roomId of [...this.clockAnchors.keys()]) {
      if (!activeIds.has(roomId)) {
        this.clockAnchors.delete(roomId);
        this.seenRoomSyncs.delete(roomId);
      }
    }
  }

  protected getElapsedMsForTurn(room: BoardGameRoomState<TGame>, now = Date.now()): number | undefined {
    const { clock } = room.game;
    if (!clock || room.game.status !== 'playing' || room.game.moveHistory.length === 0 || clock.turnStartedAt === null) {
      return undefined;
    }
    const anchor = this.clockAnchors.get(room.id);
    if (anchor && anchor.syncSeq === clock.syncSeq && anchor.turn === room.game.turn) {
      return Math.max(0, Math.round(now - anchor.anchoredAt));
    }
    return Math.max(0, Math.round(now - Math.min(now, clock.turnStartedAt)));
  }

  getRemainingTimeMs(roomId: string, color: BoardPlayerColor, now = Date.now()): number | null {
    const room = this.getRoom(roomId);
    if (!room) return null;
    return this.getRemainingTimeMsForRoom(room, color, now);
  }

  getRemainingTimeMsForRoom(
    room: BoardGameRoomState<TGame>,
    color: BoardPlayerColor,
    now = Date.now(),
  ): number | null {
    const { clock } = room.game;
    if (!clock) return null;
    if (
      room.game.status !== 'playing' ||
      room.game.moveHistory.length === 0 ||
      clock.turnStartedAt === null ||
      room.game.turn !== color
    ) {
      return clock.remainingMs[color];
    }
    const elapsed = this.getElapsedMsForTurn(room, now) ?? 0;
    return Math.max(0, clock.remainingMs[color] - elapsed);
  }

  setTimeLimit(roomId: string, limitMs: number | null): boolean {
    const actor = this.localActor;
    return this.updateGame(roomId, (room) => {
      if (!actor) return null;
      const isPlayerOrOwner =
        room.players.seat1 === actor ||
        room.players.seat2 === actor ||
        room.createdBy === actor ||
        (!room.players.seat1 && !room.players.seat2);
      if (!isPlayerOrOwner) return null;
      if (room.game.status !== 'playing' || room.game.moveHistory.length > 0) return null;

      if (limitMs === null || limitMs === 0) {
        if (!room.game.clock) return null;
        return { ...room.game, clock: null };
      }

      if (!Number.isSafeInteger(limitMs) || limitMs < MIN_BOARD_CLOCK_MS || limitMs > MAX_BOARD_CLOCK_MS) {
        return null;
      }

      const nextSeq = (room.game.clock?.syncSeq ?? 0) + 1;
      return {
        ...room.game,
        clock: createBoardClock(limitMs, nextSeq),
      };
    });
  }

  syncClock(roomId: string, now = Date.now()): boolean {
    const actor = this.localActor;
    return this.updateGame(roomId, (room) => {
      const expectedActor = room.game.turn === 'w' ? room.players.seat1 : room.players.seat2;
      if (!actor || expectedActor !== actor) return null;
      const { clock } = room.game;
      if (!clock || room.game.status !== 'playing' || room.game.moveHistory.length === 0) return null;

      const elapsed = this.getElapsedMsForTurn(room, now) ?? 0;
      const nextRemaining = Math.max(0, clock.remainingMs[room.game.turn] - elapsed);
      if (nextRemaining <= 0) {
        return this.hooks.timeout(room.game, room.game.turn);
      }

      return {
        ...room.game,
        clock: {
          limitMs: clock.limitMs,
          remainingMs: {
            ...clock.remainingMs,
            [room.game.turn]: nextRemaining,
          },
          turnStartedAt: now,
          syncSeq: clock.syncSeq + 1,
        },
      };
    });
  }

  claimTimeout(roomId: string, now = Date.now()): boolean {
    const actor = this.localActor;
    return this.updateGame(roomId, (room) => {
      if (!actor || room.game.status !== 'playing' || !room.game.clock || room.game.moveHistory.length === 0) {
        return null;
      }
      const isPlayer =
        room.players.seat1 === actor ||
        room.players.seat2 === actor ||
        (room.createdBy === actor && (!room.players.seat1 || !room.players.seat2));
      if (!isPlayer) return null;

      const remaining = this.getRemainingTimeMsForRoom(room, room.game.turn, now);
      if (remaining === null || remaining > 0) return null;

      return this.hooks.timeout(room.game, room.game.turn);
    });
  }

  requestUndo(roomId: string): boolean {
    const actor = this.localActor;
    return this.updateGame(roomId, (room) => {
      if (!actor || room.game.status !== 'playing' || room.game.moveHistory.length === 0) return null;
      if (!room.players.seat1 || !room.players.seat2) return null;
      const myColor: BoardPlayerColor | null =
        room.players.seat1 === actor ? 'w' : room.players.seat2 === actor ? 'b' : null;
      if (!myColor) return null;
      const lastMove = room.game.moveHistory[room.game.moveHistory.length - 1];
      if (!lastMove || lastMove.color !== myColor) return null;
      if (room.game.undoRequest) return null;

      return {
        ...room.game,
        undoRequest: {
          requester: myColor,
          moveCount: room.game.moveHistory.length,
        },
      };
    });
  }

  respondUndo(roomId: string, accept: boolean, now = Date.now()): boolean {
    const actor = this.localActor;
    return this.updateGame(roomId, (room) => {
      if (!actor || room.game.status !== 'playing') return null;
      const req = room.game.undoRequest;
      if (!req || req.moveCount !== room.game.moveHistory.length) return null;
      const myColor: BoardPlayerColor | null =
        room.players.seat1 === actor ? 'w' : room.players.seat2 === actor ? 'b' : null;
      if (!myColor || myColor === req.requester) return null;

      if (!accept) {
        return {
          ...room.game,
          undoRequest: null,
        };
      }
      return this.hooks.undo(room.game, now);
    });
  }

  resign(roomId: string, now = Date.now()): boolean {
    const actor = this.localActor;
    return this.updateGame(roomId, (room) => {
      if (!actor || room.game.status !== 'playing') return null;
      const elapsed = this.getElapsedMsForTurn(room, now);
      if (room.players.seat1 === actor) return this.hooks.resign(room.game, 'w', now, elapsed);
      if (room.players.seat2 === actor) return this.hooks.resign(room.game, 'b', now, elapsed);
      return null;
    });
  }

  newGame(roomId: string, resetScores = false): boolean {
    const actor = this.localActor;
    return this.updateGame(roomId, (room) => {
      if (!actor) return null;
      const isPlayer = room.players.seat1 === actor || room.players.seat2 === actor || room.createdBy === actor;
      if (!isPlayer && room.players.seat1 && room.players.seat2) return null;
      const limitMs = room.game.clock?.limitMs ?? null;
      const nextSeq = (room.game.clock?.syncSeq ?? 0) + 1;
      return this.hooks.createInitial(
        resetScores ? { w: 0, b: 0, draws: 0 } : room.game.scores,
        limitMs,
        nextSeq,
      );
    });
  }

  swapSides(roomId: string): boolean {
    const room = this.getRoom(roomId);
    const actor = this.localActor;
    if (!room || !actor) return false;
    const isPlayer = room.players.seat1 === actor || room.players.seat2 === actor || room.createdBy === actor;
    if (!isPlayer && room.players.seat1 && room.players.seat2) return false;
    this.writeRoom({
      ...room,
      players: {
        seat1: room.players.seat2,
        seat2: room.players.seat1,
      },
      game: room.game.undoRequest ? { ...room.game, undoRequest: null } : room.game,
      updatedAt: Date.now(),
    });
    return true;
  }
}

export class ChessModel extends TimedBoardGameModel<ChessGameState> {
  constructor(context: RoomAppModelContext) {
    super('chess', context, () => createInitialChessState(), validChessState, {
      createInitial: createInitialChessState,
      resign: resignChessGame,
      undo: undoLastChessMove,
      timeout: timeoutChessGame,
    });
  }

  makeMove(
    roomId: string,
    from: number,
    to: number,
    promotion?: ChessPromotionPiece,
    now = Date.now(),
  ): boolean {
    const actor = this.localActor;
    return this.updateGame(roomId, (room) => {
      const expectedActor = room.game.turn === 'w' ? room.players.seat1 : room.players.seat2;
      if (!actor || expectedActor !== actor) return null;
      const elapsedMs = this.getElapsedMsForTurn(room, now);
      return applyChessMove(room.game, from, to, promotion, { now, elapsedMs });
    });
  }
}

export class CheckersModel extends TimedBoardGameModel<CheckersGameState> {
  constructor(context: RoomAppModelContext) {
    super('checkers', context, () => createInitialCheckersState(), validCheckersState, {
      createInitial: createInitialCheckersState,
      resign: resignCheckersGame,
      undo: undoLastCheckersMove,
      timeout: timeoutCheckersGame,
    });
  }

  makeMove(roomId: string, from: number, to: number, now = Date.now()): boolean {
    const actor = this.localActor;
    return this.updateGame(roomId, (room) => {
      const expectedActor = room.game.turn === 'w' ? room.players.seat1 : room.players.seat2;
      if (!actor || expectedActor !== actor) return null;
      const elapsedMs = this.getElapsedMsForTurn(room, now);
      return applyCheckersMove(room.game, from, to, { now, elapsedMs });
    });
  }
}
