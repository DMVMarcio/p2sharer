import {
  advanceBoardClockOnMove,
  createBoardClock,
  getElapsedTurnMs,
  pauseBoardClock,
  restoreBoardClockOnUndo,
  timeoutBoardClock,
  validBoardClockState,
  validBoardUndoRequest,
  type BoardClockState,
  type BoardUndoRequest,
} from './board_game_timing.ts';

export type CheckersColor = 'w' | 'b';

export interface CheckersPiece {
  color: CheckersColor;
  king: boolean;
}

export interface CheckersMoveUndoMeta {
  capturedKing?: boolean;
  mustContinueFrom: number | null;
  lastMove: { from: number; to: number } | null;
  remainingMs?: { w: number; b: number };
}

export interface CheckersMoveRecord {
  from: number;
  to: number;
  color: CheckersColor;
  captured?: number;
  promoted?: boolean;
  notation: string;
  prev?: CheckersMoveUndoMeta;
}

export interface CheckersGameState {
  board: (CheckersPiece | null)[];
  turn: CheckersColor;
  mustContinueFrom: number | null;
  status: 'playing' | 'finished' | 'draw' | 'resigned' | 'timeout';
  winner: CheckersColor | 'draw' | null;
  lastMove: { from: number; to: number } | null;
  capturedByWhite: number;
  capturedByBlack: number;
  moveHistory: CheckersMoveRecord[];
  scores: { w: number; b: number; draws: number };
  clock?: BoardClockState | null;
  undoRequest?: BoardUndoRequest | null;
}

export interface CheckersCandidateMove {
  from: number;
  to: number;
  captured?: number;
  continuesChain?: boolean;
}

function rowOf(index: number): number {
  return Math.floor(index / 8);
}

function colOf(index: number): number {
  return index % 8;
}

function indexOf(row: number, col: number): number {
  return row * 8 + col;
}

function squareNotation(index: number): string {
  const file = String.fromCharCode(97 + colOf(index));
  const rank = 8 - rowOf(index);
  return `${file}${rank}`;
}

export function isDarkCheckersSquare(index: number): boolean {
  return (rowOf(index) + colOf(index)) % 2 === 1;
}

export function createInitialCheckersBoard(): (CheckersPiece | null)[] {
  const board = Array<CheckersPiece | null>(64).fill(null);
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if ((r + c) % 2 === 1) {
        const idx = indexOf(r, c);
        if (r < 3) {
          board[idx] = { color: 'b', king: false };
        } else if (r > 4) {
          board[idx] = { color: 'w', king: false };
        }
      }
    }
  }
  return board;
}

export function createInitialCheckersState(
  scores = { w: 0, b: 0, draws: 0 },
  limitMs: number | null = null,
  syncSeq = 0,
): CheckersGameState {
  return {
    board: createInitialCheckersBoard(),
    turn: 'w',
    mustContinueFrom: null,
    status: 'playing',
    winner: null,
    lastMove: null,
    capturedByWhite: 0,
    capturedByBlack: 0,
    moveHistory: [],
    scores: { ...scores },
    clock: limitMs && limitMs > 0 ? createBoardClock(limitMs, syncSeq) : null,
    undoRequest: null,
  };
}

function validSquarePair(pair: unknown): pair is { from: number; to: number } | null {
  if (pair === null) return true;
  if (!pair || typeof pair !== 'object') return false;
  const p = pair as { from: number; to: number };
  return (
    Number.isInteger(p.from) &&
    p.from >= 0 &&
    p.from < 64 &&
    Number.isInteger(p.to) &&
    p.to >= 0 &&
    p.to < 64
  );
}

export function validCheckersState(value: unknown): value is CheckersGameState {
  if (!value || typeof value !== 'object') return false;
  const s = value as CheckersGameState;
  if (!Array.isArray(s.board) || s.board.length !== 64) return false;
  for (const cell of s.board) {
    if (cell !== null) {
      if (
        !cell ||
        typeof cell !== 'object' ||
        (cell.color !== 'w' && cell.color !== 'b') ||
        typeof cell.king !== 'boolean'
      ) {
        return false;
      }
    }
  }
  if (s.turn !== 'w' && s.turn !== 'b') return false;
  if (
    s.mustContinueFrom !== null &&
    (!Number.isInteger(s.mustContinueFrom) || s.mustContinueFrom < 0 || s.mustContinueFrom >= 64)
  ) {
    return false;
  }
  if (!['playing', 'finished', 'draw', 'resigned', 'timeout'].includes(s.status)) return false;
  if (s.winner !== null && s.winner !== 'w' && s.winner !== 'b' && s.winner !== 'draw') return false;
  if (!validSquarePair(s.lastMove)) return false;
  if (!Number.isSafeInteger(s.capturedByWhite) || s.capturedByWhite < 0 || s.capturedByWhite > 12) return false;
  if (!Number.isSafeInteger(s.capturedByBlack) || s.capturedByBlack < 0 || s.capturedByBlack > 12) return false;
  if (!Array.isArray(s.moveHistory) || s.moveHistory.length > 600) return false;
  for (const m of s.moveHistory) {
    if (
      !m ||
      typeof m !== 'object' ||
      !Number.isInteger(m.from) ||
      m.from < 0 ||
      m.from >= 64 ||
      !Number.isInteger(m.to) ||
      m.to < 0 ||
      m.to >= 64 ||
      (m.color !== 'w' && m.color !== 'b') ||
      typeof m.notation !== 'string' ||
      m.notation.length > 16
    ) {
      return false;
    }
    if (m.prev !== undefined) {
      if (
        !m.prev ||
        typeof m.prev !== 'object' ||
        (m.prev.mustContinueFrom !== null &&
          (!Number.isInteger(m.prev.mustContinueFrom) || m.prev.mustContinueFrom < 0 || m.prev.mustContinueFrom >= 64)) ||
        !validSquarePair(m.prev.lastMove)
      ) {
        return false;
      }
    }
  }
  if (
    !s.scores ||
    typeof s.scores !== 'object' ||
    !Number.isSafeInteger(s.scores.w) ||
    s.scores.w < 0 ||
    !Number.isSafeInteger(s.scores.b) ||
    s.scores.b < 0 ||
    !Number.isSafeInteger(s.scores.draws) ||
    s.scores.draws < 0
  ) {
    return false;
  }
  if (!validBoardClockState(s.clock)) return false;
  if (!validBoardUndoRequest(s.undoRequest)) return false;
  return true;
}

function getPieceCaptures(
  board: (CheckersPiece | null)[],
  from: number,
): CheckersCandidateMove[] {
  const piece = board[from];
  if (!piece) return [];
  const r = rowOf(from);
  const c = colOf(from);
  const enemy: CheckersColor = piece.color === 'w' ? 'b' : 'w';
  const captures: CheckersCandidateMove[] = [];

  if (!piece.king) {
    // Men capture in all 4 diagonal directions (Brazilian/International checkers rule, standard & fun)
    const dirs: [number, number][] = [
      [-1, -1], [-1, 1],
      [1, -1], [1, 1],
    ];
    for (const [dr, dc] of dirs) {
      const midR = r + dr;
      const midC = c + dc;
      const landR = r + dr * 2;
      const landC = c + dc * 2;
      if (landR >= 0 && landR < 8 && landC >= 0 && landC < 8) {
        const midIdx = indexOf(midR, midC);
        const landIdx = indexOf(landR, landC);
        const midPiece = board[midIdx];
        if (midPiece && midPiece.color === enemy && !board[landIdx]) {
          captures.push({ from, to: landIdx, captured: midIdx });
        }
      }
    }
  } else {
    // Kings can capture along diagonals (flying kings or adjacent jumps)
    const dirs: [number, number][] = [
      [-1, -1], [-1, 1],
      [1, -1], [1, 1],
    ];
    for (const [dr, dc] of dirs) {
      let nr = r + dr;
      let nc = c + dc;
      let enemySquare: number | null = null;
      while (nr >= 0 && nr < 8 && nc >= 0 && nc < 8) {
        const sq = indexOf(nr, nc);
        const target = board[sq];
        if (enemySquare === null) {
          if (target) {
            if (target.color === enemy) {
              enemySquare = sq;
            } else {
              break;
            }
          }
        } else {
          if (!target) {
            captures.push({ from, to: sq, captured: enemySquare });
          } else {
            break;
          }
        }
        nr += dr;
        nc += dc;
      }
    }
  }

  return captures;
}

function getPieceSimpleMoves(
  board: (CheckersPiece | null)[],
  from: number,
): CheckersCandidateMove[] {
  const piece = board[from];
  if (!piece) return [];
  const r = rowOf(from);
  const c = colOf(from);
  const moves: CheckersCandidateMove[] = [];

  if (!piece.king) {
    const forwardRow = piece.color === 'w' ? r - 1 : r + 1;
    if (forwardRow >= 0 && forwardRow < 8) {
      for (const dc of [-1, 1]) {
        const nc = c + dc;
        if (nc >= 0 && nc < 8) {
          const to = indexOf(forwardRow, nc);
          if (!board[to]) {
            moves.push({ from, to });
          }
        }
      }
    }
  } else {
    const dirs: [number, number][] = [
      [-1, -1], [-1, 1],
      [1, -1], [1, 1],
    ];
    for (const [dr, dc] of dirs) {
      let nr = r + dr;
      let nc = c + dc;
      while (nr >= 0 && nr < 8 && nc >= 0 && nc < 8) {
        const to = indexOf(nr, nc);
        if (!board[to]) {
          moves.push({ from, to });
        } else {
          break;
        }
        nr += dr;
        nc += dc;
      }
    }
  }

  return moves;
}

export function getAllLegalCheckersMoves(state: CheckersGameState): CheckersCandidateMove[] {
  if (state.status !== 'playing') return [];

  if (state.mustContinueFrom !== null) {
    return getPieceCaptures(state.board, state.mustContinueFrom);
  }

  const allCaptures: CheckersCandidateMove[] = [];
  for (let i = 0; i < 64; i++) {
    const p = state.board[i];
    if (p && p.color === state.turn) {
      allCaptures.push(...getPieceCaptures(state.board, i));
    }
  }

  // Mandatory capture rule: if any capture is available, player must capture
  if (allCaptures.length > 0) {
    return allCaptures;
  }

  const simpleMoves: CheckersCandidateMove[] = [];
  for (let i = 0; i < 64; i++) {
    const p = state.board[i];
    if (p && p.color === state.turn) {
      simpleMoves.push(...getPieceSimpleMoves(state.board, i));
    }
  }
  return simpleMoves;
}

export function getLegalCheckersMovesForSquare(
  state: CheckersGameState,
  from: number,
): CheckersCandidateMove[] {
  return getAllLegalCheckersMoves(state).filter((m) => m.from === from);
}

export function applyCheckersMove(
  state: CheckersGameState,
  from: number,
  to: number,
  timing?: { now?: number; elapsedMs?: number },
): CheckersGameState | null {
  if (state.status !== 'playing') return null;
  const now = timing?.now ?? Date.now();
  if (state.clock && state.moveHistory.length > 0) {
    const spent = getElapsedTurnMs(state.clock, now, timing?.elapsedMs);
    if (state.clock.remainingMs[state.turn] - spent <= 0) {
      return null;
    }
  }
  const legal = getLegalCheckersMovesForSquare(state, from);
  const matched = legal.find((m) => m.to === to);
  if (!matched) return null;

  const nextBoard = state.board.map((cell) => (cell ? { ...cell } : null));
  const piece = nextBoard[from]!;
  const capturedPiece = matched.captured !== undefined ? nextBoard[matched.captured] : null;
  nextBoard[from] = null;

  if (matched.captured !== undefined) {
    nextBoard[matched.captured] = null;
  }

  const destRow = rowOf(to);
  const promoRow = piece.color === 'w' ? 0 : 7;

  let promoted = false;
  let nextMustContinue: number | null = null;

  // Check if multi-jump continues
  if (matched.captured !== undefined) {
    nextBoard[to] = { ...piece };
    const furtherCaptures = getPieceCaptures(nextBoard, to);
    if (furtherCaptures.length > 0) {
      nextMustContinue = to;
    } else if (!piece.king && destRow === promoRow) {
      nextBoard[to] = { color: piece.color, king: true };
      promoted = true;
    }
  } else {
    const becomesKing = !piece.king && destRow === promoRow;
    if (becomesKing) promoted = true;
    nextBoard[to] = { color: piece.color, king: piece.king || becomesKing };
  }

  const capturedByWhite = state.capturedByWhite + (matched.captured !== undefined && piece.color === 'w' ? 1 : 0);
  const capturedByBlack = state.capturedByBlack + (matched.captured !== undefined && piece.color === 'b' ? 1 : 0);

  const nextTurn: CheckersColor = nextMustContinue !== null ? state.turn : state.turn === 'w' ? 'b' : 'w';
  const notation = `${squareNotation(from)}${matched.captured !== undefined ? 'x' : '-'}${squareNotation(to)}${promoted ? 'K' : ''}`;

  const draft: CheckersGameState = {
    board: nextBoard,
    turn: nextTurn,
    mustContinueFrom: nextMustContinue,
    status: 'playing',
    winner: null,
    lastMove: { from, to },
    capturedByWhite,
    capturedByBlack,
    moveHistory: state.moveHistory,
    scores: { ...state.scores },
  };

  if (nextMustContinue === null) {
    const nextLegal = getAllLegalCheckersMoves(draft);
    if (nextLegal.length === 0) {
      draft.status = 'finished';
      draft.winner = piece.color;
      draft.scores[piece.color] += 1;
    }
  }

  const nextClock = advanceBoardClockOnMove(
    state.clock,
    piece.color,
    state.moveHistory.length,
    draft.status,
    now,
    timing?.elapsedMs,
  );

  const record: CheckersMoveRecord = {
    from,
    to,
    color: piece.color,
    ...(matched.captured !== undefined ? { captured: matched.captured } : {}),
    ...(promoted ? { promoted: true } : {}),
    notation,
    prev: {
      ...(capturedPiece?.king ? { capturedKing: true } : {}),
      mustContinueFrom: state.mustContinueFrom,
      lastMove: state.lastMove ? { ...state.lastMove } : null,
      ...(nextClock ? { remainingMs: { ...nextClock.remainingMs } } : {}),
    },
  };

  return {
    ...draft,
    moveHistory: [...state.moveHistory.slice(-599), record],
    clock: nextClock,
    undoRequest: null,
  };
}

export function undoLastCheckersMove(state: CheckersGameState, now = Date.now()): CheckersGameState | null {
  if (state.status !== 'playing' || state.moveHistory.length === 0) return null;
  const last = state.moveHistory[state.moveHistory.length - 1];
  const nextBoard = state.board.map((cell) => (cell ? { ...cell } : null));
  const movedPiece = nextBoard[last.to];
  const enemy: CheckersColor = last.color === 'w' ? 'b' : 'w';

  nextBoard[last.from] = {
    color: last.color,
    king: last.promoted ? false : Boolean(movedPiece?.king),
  };
  nextBoard[last.to] = null;

  if (last.captured !== undefined) {
    nextBoard[last.captured] = {
      color: enemy,
      king: Boolean(last.prev?.capturedKing),
    };
  }

  const capturedByWhite =
    last.captured !== undefined && last.color === 'w'
      ? Math.max(0, state.capturedByWhite - 1)
      : state.capturedByWhite;
  const capturedByBlack =
    last.captured !== undefined && last.color === 'b'
      ? Math.max(0, state.capturedByBlack - 1)
      : state.capturedByBlack;

  const nextHistory = state.moveHistory.slice(0, -1);
  const prevRecord = nextHistory[nextHistory.length - 1];
  const prevMeta = last.prev;

  return {
    board: nextBoard,
    turn: last.color,
    mustContinueFrom: prevMeta ? prevMeta.mustContinueFrom : null,
    status: 'playing',
    winner: null,
    lastMove: prevMeta ? prevMeta.lastMove : prevRecord ? { from: prevRecord.from, to: prevRecord.to } : null,
    capturedByWhite,
    capturedByBlack,
    moveHistory: nextHistory,
    scores: { ...state.scores },
    clock: restoreBoardClockOnUndo(state.clock, last.color, nextHistory.length, now, prevMeta?.remainingMs),
    undoRequest: null,
  };
}

export function resignCheckersGame(
  state: CheckersGameState,
  resigningColor: CheckersColor,
  now = Date.now(),
  elapsedMs?: number,
): CheckersGameState {
  if (state.status !== 'playing') return state;
  const winner: CheckersColor = resigningColor === 'w' ? 'b' : 'w';
  const nextScores = { ...state.scores };
  nextScores[winner] += 1;
  return {
    ...state,
    status: 'resigned',
    winner,
    mustContinueFrom: null,
    scores: nextScores,
    clock: pauseBoardClock(state.clock, state.turn, state.moveHistory.length, now, elapsedMs),
    undoRequest: null,
  };
}

export function timeoutCheckersGame(state: CheckersGameState, losingColor: CheckersColor): CheckersGameState {
  if (state.status !== 'playing') return state;
  const winner: CheckersColor = losingColor === 'w' ? 'b' : 'w';
  const nextScores = { ...state.scores };
  nextScores[winner] += 1;
  return {
    ...state,
    status: 'timeout',
    winner,
    mustContinueFrom: null,
    scores: nextScores,
    clock: timeoutBoardClock(state.clock, losingColor),
    undoRequest: null,
  };
}
