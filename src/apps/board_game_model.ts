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
  validChessState,
  type ChessGameState,
  type ChessPromotionPiece,
} from './chess_engine.ts';
import {
  applyCheckersMove,
  createInitialCheckersState,
  resignCheckersGame,
  validCheckersState,
  type CheckersGameState,
} from './checkers_engine.ts';

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

export class ChessModel extends BoardGameLobbyModel<ChessGameState> {
  constructor(context: RoomAppModelContext) {
    super('chess', context, () => createInitialChessState(), validChessState);
  }

  makeMove(roomId: string, from: number, to: number, promotion?: ChessPromotionPiece): boolean {
    const actor = this.localActor;
    return this.updateGame(roomId, (room) => {
      const expectedActor = room.game.turn === 'w' ? room.players.seat1 : room.players.seat2;
      if (!actor || expectedActor !== actor) return null;
      return applyChessMove(room.game, from, to, promotion);
    });
  }

  resign(roomId: string): boolean {
    const actor = this.localActor;
    return this.updateGame(roomId, (room) => {
      if (!actor || room.game.status !== 'playing') return null;
      if (room.players.seat1 === actor) return resignChessGame(room.game, 'w');
      if (room.players.seat2 === actor) return resignChessGame(room.game, 'b');
      return null;
    });
  }

  newGame(roomId: string, resetScores = false): boolean {
    const actor = this.localActor;
    return this.updateGame(roomId, (room) => {
      if (!actor) return null;
      const isPlayer = room.players.seat1 === actor || room.players.seat2 === actor || room.createdBy === actor;
      if (!isPlayer && room.players.seat1 && room.players.seat2) return null;
      return createInitialChessState(resetScores ? { w: 0, b: 0, draws: 0 } : room.game.scores);
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
      updatedAt: Date.now(),
    });
    return true;
  }
}

export class CheckersModel extends BoardGameLobbyModel<CheckersGameState> {
  constructor(context: RoomAppModelContext) {
    super('checkers', context, () => createInitialCheckersState(), validCheckersState);
  }

  makeMove(roomId: string, from: number, to: number): boolean {
    const actor = this.localActor;
    return this.updateGame(roomId, (room) => {
      const expectedActor = room.game.turn === 'w' ? room.players.seat1 : room.players.seat2;
      if (!actor || expectedActor !== actor) return null;
      return applyCheckersMove(room.game, from, to);
    });
  }

  resign(roomId: string): boolean {
    const actor = this.localActor;
    return this.updateGame(roomId, (room) => {
      if (!actor || room.game.status !== 'playing') return null;
      if (room.players.seat1 === actor) return resignCheckersGame(room.game, 'w');
      if (room.players.seat2 === actor) return resignCheckersGame(room.game, 'b');
      return null;
    });
  }

  newGame(roomId: string, resetScores = false): boolean {
    const actor = this.localActor;
    return this.updateGame(roomId, (room) => {
      if (!actor) return null;
      const isPlayer = room.players.seat1 === actor || room.players.seat2 === actor || room.createdBy === actor;
      if (!isPlayer && room.players.seat1 && room.players.seat2) return null;
      return createInitialCheckersState(resetScores ? { w: 0, b: 0, draws: 0 } : room.game.scores);
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
      updatedAt: Date.now(),
    });
    return true;
  }
}
