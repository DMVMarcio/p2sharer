export type ChessColor = 'w' | 'b';
export type ChessPieceType = 'p' | 'n' | 'b' | 'r' | 'q' | 'k';
export type ChessPromotionPiece = 'q' | 'r' | 'b' | 'n';

export interface ChessPiece {
  color: ChessColor;
  type: ChessPieceType;
}

export interface ChessCastlingRights {
  wK: boolean;
  wQ: boolean;
  bK: boolean;
  bQ: boolean;
}

export interface ChessMoveRecord {
  from: number;
  to: number;
  piece: ChessPieceType;
  color: ChessColor;
  captured?: ChessPieceType;
  promotion?: ChessPromotionPiece;
  castling?: 'K' | 'Q';
  enPassant?: boolean;
  san: string;
}

export interface ChessGameState {
  board: (ChessPiece | null)[];
  turn: ChessColor;
  castling: ChessCastlingRights;
  enPassantTarget: number | null;
  halfMoveClock: number;
  fullMoveNumber: number;
  inCheck: boolean;
  status: 'playing' | 'checkmate' | 'stalemate' | 'draw_fifty' | 'resigned';
  winner: ChessColor | 'draw' | null;
  lastMove: { from: number; to: number } | null;
  capturedByWhite: ChessPieceType[];
  capturedByBlack: ChessPieceType[];
  moveHistory: ChessMoveRecord[];
  scores: { w: number; b: number; draws: number };
}

export interface ChessCandidateMove {
  from: number;
  to: number;
  promotion?: ChessPromotionPiece;
  castling?: 'K' | 'Q';
  enPassant?: boolean;
  captured?: ChessPieceType;
}

const VALID_PIECE_TYPES: readonly ChessPieceType[] = ['p', 'n', 'b', 'r', 'q', 'k'];
const VALID_PROMOTION_TYPES: readonly ChessPromotionPiece[] = ['q', 'r', 'b', 'n'];

export function rowOf(index: number): number {
  return Math.floor(index / 8);
}

export function colOf(index: number): number {
  return index % 8;
}

export function indexOf(row: number, col: number): number {
  return row * 8 + col;
}

export function squareName(index: number): string {
  const file = String.fromCharCode(97 + colOf(index));
  const rank = 8 - rowOf(index);
  return `${file}${rank}`;
}

export function createInitialChessBoard(): (ChessPiece | null)[] {
  const backRank: ChessPieceType[] = ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'];
  const board = Array<ChessPiece | null>(64).fill(null);
  for (let c = 0; c < 8; c++) {
    board[indexOf(0, c)] = { color: 'b', type: backRank[c] };
    board[indexOf(1, c)] = { color: 'b', type: 'p' };
    board[indexOf(6, c)] = { color: 'w', type: 'p' };
    board[indexOf(7, c)] = { color: 'w', type: backRank[c] };
  }
  return board;
}

export function createInitialChessState(scores = { w: 0, b: 0, draws: 0 }): ChessGameState {
  return {
    board: createInitialChessBoard(),
    turn: 'w',
    castling: { wK: true, wQ: true, bK: true, bQ: true },
    enPassantTarget: null,
    halfMoveClock: 0,
    fullMoveNumber: 1,
    inCheck: false,
    status: 'playing',
    winner: null,
    lastMove: null,
    capturedByWhite: [],
    capturedByBlack: [],
    moveHistory: [],
    scores: { ...scores },
  };
}

export function validChessState(value: unknown): value is ChessGameState {
  if (!value || typeof value !== 'object') return false;
  const s = value as ChessGameState;
  if (!Array.isArray(s.board) || s.board.length !== 64) return false;
  for (const cell of s.board) {
    if (cell !== null) {
      if (
        !cell ||
        typeof cell !== 'object' ||
        (cell.color !== 'w' && cell.color !== 'b') ||
        !VALID_PIECE_TYPES.includes(cell.type)
      ) {
        return false;
      }
    }
  }
  if (s.turn !== 'w' && s.turn !== 'b') return false;
  if (
    !s.castling ||
    typeof s.castling !== 'object' ||
    typeof s.castling.wK !== 'boolean' ||
    typeof s.castling.wQ !== 'boolean' ||
    typeof s.castling.bK !== 'boolean' ||
    typeof s.castling.bQ !== 'boolean'
  ) {
    return false;
  }
  if (s.enPassantTarget !== null && (!Number.isInteger(s.enPassantTarget) || s.enPassantTarget < 0 || s.enPassantTarget >= 64)) {
    return false;
  }
  if (!Number.isSafeInteger(s.halfMoveClock) || s.halfMoveClock < 0) return false;
  if (!Number.isSafeInteger(s.fullMoveNumber) || s.fullMoveNumber < 1) return false;
  if (typeof s.inCheck !== 'boolean') return false;
  if (!['playing', 'checkmate', 'stalemate', 'draw_fifty', 'resigned'].includes(s.status)) return false;
  if (s.winner !== null && s.winner !== 'w' && s.winner !== 'b' && s.winner !== 'draw') return false;
  if (
    s.lastMove !== null &&
    (!s.lastMove ||
      typeof s.lastMove !== 'object' ||
      !Number.isInteger(s.lastMove.from) ||
      s.lastMove.from < 0 ||
      s.lastMove.from >= 64 ||
      !Number.isInteger(s.lastMove.to) ||
      s.lastMove.to < 0 ||
      s.lastMove.to >= 64)
  ) {
    return false;
  }
  if (
    !Array.isArray(s.capturedByWhite) ||
    s.capturedByWhite.length > 32 ||
    !s.capturedByWhite.every((t) => VALID_PIECE_TYPES.includes(t))
  ) {
    return false;
  }
  if (
    !Array.isArray(s.capturedByBlack) ||
    s.capturedByBlack.length > 32 ||
    !s.capturedByBlack.every((t) => VALID_PIECE_TYPES.includes(t))
  ) {
    return false;
  }
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
      !VALID_PIECE_TYPES.includes(m.piece) ||
      (m.color !== 'w' && m.color !== 'b') ||
      typeof m.san !== 'string' ||
      m.san.length > 16
    ) {
      return false;
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
  return true;
}

export function findKingSquare(board: (ChessPiece | null)[], color: ChessColor): number {
  for (let i = 0; i < 64; i++) {
    const p = board[i];
    if (p && p.color === color && p.type === 'k') return i;
  }
  return -1;
}

export function isSquareAttacked(
  board: (ChessPiece | null)[],
  square: number,
  byColor: ChessColor,
): boolean {
  const r = rowOf(square);
  const c = colOf(square);

  // Pawn attacks
  const pawnRow = byColor === 'w' ? r + 1 : r - 1;
  if (pawnRow >= 0 && pawnRow < 8) {
    for (const dc of [-1, 1]) {
      const pc = c + dc;
      if (pc >= 0 && pc < 8) {
        const piece = board[indexOf(pawnRow, pc)];
        if (piece && piece.color === byColor && piece.type === 'p') return true;
      }
    }
  }

  // Knight attacks
  const knightSteps = [
    [-2, -1], [-2, 1], [-1, -2], [-1, 2],
    [1, -2], [1, 2], [2, -1], [2, 1],
  ];
  for (const [dr, dc] of knightSteps) {
    const nr = r + dr;
    const nc = c + dc;
    if (nr >= 0 && nr < 8 && nc >= 0 && nc < 8) {
      const piece = board[indexOf(nr, nc)];
      if (piece && piece.color === byColor && piece.type === 'n') return true;
    }
  }

  // King attacks
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = r + dr;
      const nc = c + dc;
      if (nr >= 0 && nr < 8 && nc >= 0 && nc < 8) {
        const piece = board[indexOf(nr, nc)];
        if (piece && piece.color === byColor && piece.type === 'k') return true;
      }
    }
  }

  // Orthogonal (Rook / Queen)
  const orthoDirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  for (const [dr, dc] of orthoDirs) {
    let nr = r + dr;
    let nc = c + dc;
    while (nr >= 0 && nr < 8 && nc >= 0 && nc < 8) {
      const piece = board[indexOf(nr, nc)];
      if (piece) {
        if (piece.color === byColor && (piece.type === 'r' || piece.type === 'q')) return true;
        break;
      }
      nr += dr;
      nc += dc;
    }
  }

  // Diagonal (Bishop / Queen)
  const diagDirs = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
  for (const [dr, dc] of diagDirs) {
    let nr = r + dr;
    let nc = c + dc;
    while (nr >= 0 && nr < 8 && nc >= 0 && nc < 8) {
      const piece = board[indexOf(nr, nc)];
      if (piece) {
        if (piece.color === byColor && (piece.type === 'b' || piece.type === 'q')) return true;
        break;
      }
      nr += dr;
      nc += dc;
    }
  }

  return false;
}

export function isKingInCheck(board: (ChessPiece | null)[], color: ChessColor): boolean {
  const kingSq = findKingSquare(board, color);
  if (kingSq < 0) return false;
  const enemy: ChessColor = color === 'w' ? 'b' : 'w';
  return isSquareAttacked(board, kingSq, enemy);
}

function simulateBoardMove(
  board: (ChessPiece | null)[],
  move: ChessCandidateMove,
): (ChessPiece | null)[] {
  const next = board.map((cell) => (cell ? { ...cell } : null));
  const piece = next[move.from];
  if (!piece) return next;
  next[move.from] = null;

  if (move.enPassant) {
    const capRow = piece.color === 'w' ? rowOf(move.to) + 1 : rowOf(move.to) - 1;
    next[indexOf(capRow, colOf(move.to))] = null;
  }

  if (move.castling === 'K') {
    const row = rowOf(move.from);
    next[indexOf(row, 5)] = next[indexOf(row, 7)];
    next[indexOf(row, 7)] = null;
  } else if (move.castling === 'Q') {
    const row = rowOf(move.from);
    next[indexOf(row, 3)] = next[indexOf(row, 0)];
    next[indexOf(row, 0)] = null;
  }

  next[move.to] = {
    color: piece.color,
    type: move.promotion ?? piece.type,
  };
  return next;
}

export function getLegalChessMovesForSquare(
  state: ChessGameState,
  from: number,
): ChessCandidateMove[] {
  if (state.status !== 'playing') return [];
  const piece = state.board[from];
  if (!piece || piece.color !== state.turn) return [];

  const pseudo: ChessCandidateMove[] = [];
  const r = rowOf(from);
  const c = colOf(from);
  const enemy: ChessColor = piece.color === 'w' ? 'b' : 'w';

  if (piece.type === 'p') {
    const dir = piece.color === 'w' ? -1 : 1;
    const startRow = piece.color === 'w' ? 6 : 1;
    const promoRow = piece.color === 'w' ? 0 : 7;

    const addPawnMove = (to: number, captured?: ChessPieceType, enPassant?: boolean) => {
      if (rowOf(to) === promoRow) {
        for (const promo of VALID_PROMOTION_TYPES) {
          pseudo.push({ from, to, promotion: promo, captured });
        }
      } else {
        pseudo.push({ from, to, captured, enPassant });
      }
    };

    const oneStepR = r + dir;
    if (oneStepR >= 0 && oneStepR < 8) {
      const oneStepIdx = indexOf(oneStepR, c);
      if (!state.board[oneStepIdx]) {
        addPawnMove(oneStepIdx);
        const twoStepR = r + dir * 2;
        if (r === startRow) {
          const twoStepIdx = indexOf(twoStepR, c);
          if (!state.board[twoStepIdx]) {
            pseudo.push({ from, to: twoStepIdx });
          }
        }
      }

      for (const dc of [-1, 1]) {
        const nc = c + dc;
        if (nc >= 0 && nc < 8) {
          const diagIdx = indexOf(oneStepR, nc);
          const target = state.board[diagIdx];
          if (target && target.color === enemy) {
            addPawnMove(diagIdx, target.type);
          } else if (state.enPassantTarget === diagIdx) {
            addPawnMove(diagIdx, 'p', true);
          }
        }
      }
    }
  } else if (piece.type === 'n') {
    const steps = [
      [-2, -1], [-2, 1], [-1, -2], [-1, 2],
      [1, -2], [1, 2], [2, -1], [2, 1],
    ];
    for (const [dr, dc] of steps) {
      const nr = r + dr;
      const nc = c + dc;
      if (nr >= 0 && nr < 8 && nc >= 0 && nc < 8) {
        const to = indexOf(nr, nc);
        const target = state.board[to];
        if (!target || target.color === enemy) {
          pseudo.push({ from, to, captured: target?.type });
        }
      }
    }
  } else if (piece.type === 'b' || piece.type === 'r' || piece.type === 'q') {
    const dirs: [number, number][] = [];
    if (piece.type === 'b' || piece.type === 'q') {
      dirs.push([-1, -1], [-1, 1], [1, -1], [1, 1]);
    }
    if (piece.type === 'r' || piece.type === 'q') {
      dirs.push([-1, 0], [1, 0], [0, -1], [0, 1]);
    }
    for (const [dr, dc] of dirs) {
      let nr = r + dr;
      let nc = c + dc;
      while (nr >= 0 && nr < 8 && nc >= 0 && nc < 8) {
        const to = indexOf(nr, nc);
        const target = state.board[to];
        if (!target) {
          pseudo.push({ from, to });
        } else {
          if (target.color === enemy) {
            pseudo.push({ from, to, captured: target.type });
          }
          break;
        }
        nr += dr;
        nc += dc;
      }
    }
  } else if (piece.type === 'k') {
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const nr = r + dr;
        const nc = c + dc;
        if (nr >= 0 && nr < 8 && nc >= 0 && nc < 8) {
          const to = indexOf(nr, nc);
          const target = state.board[to];
          if (!target || target.color === enemy) {
            pseudo.push({ from, to, captured: target?.type });
          }
        }
      }
    }

    // Castling
    if (!state.inCheck) {
      const homeRow = piece.color === 'w' ? 7 : 0;
      if (r === homeRow && c === 4) {
        const canK = piece.color === 'w' ? state.castling.wK : state.castling.bK;
        const canQ = piece.color === 'w' ? state.castling.wQ : state.castling.bQ;
        const kRook = state.board[indexOf(homeRow, 7)];
        if (
          canK &&
          kRook &&
          kRook.color === piece.color &&
          kRook.type === 'r' &&
          !state.board[indexOf(homeRow, 5)] &&
          !state.board[indexOf(homeRow, 6)] &&
          !isSquareAttacked(state.board, indexOf(homeRow, 5), enemy) &&
          !isSquareAttacked(state.board, indexOf(homeRow, 6), enemy)
        ) {
          pseudo.push({ from, to: indexOf(homeRow, 6), castling: 'K' });
        }
        const qRook = state.board[indexOf(homeRow, 0)];
        if (
          canQ &&
          qRook &&
          qRook.color === piece.color &&
          qRook.type === 'r' &&
          !state.board[indexOf(homeRow, 1)] &&
          !state.board[indexOf(homeRow, 2)] &&
          !state.board[indexOf(homeRow, 3)] &&
          !isSquareAttacked(state.board, indexOf(homeRow, 3), enemy) &&
          !isSquareAttacked(state.board, indexOf(homeRow, 2), enemy)
        ) {
          pseudo.push({ from, to: indexOf(homeRow, 2), castling: 'Q' });
        }
      }
    }
  }

  return pseudo.filter((move) => {
    const nextBoard = simulateBoardMove(state.board, move);
    return !isKingInCheck(nextBoard, piece.color);
  });
}

export function getAllLegalChessMoves(state: ChessGameState): ChessCandidateMove[] {
  if (state.status !== 'playing') return [];
  const all: ChessCandidateMove[] = [];
  for (let i = 0; i < 64; i++) {
    const p = state.board[i];
    if (p && p.color === state.turn) {
      all.push(...getLegalChessMovesForSquare(state, i));
    }
  }
  return all;
}

function buildSan(
  piece: ChessPiece,
  move: ChessCandidateMove,
  inCheckAfter: boolean,
  isCheckmateAfter: boolean,
): string {
  const suffix = isCheckmateAfter ? '#' : inCheckAfter ? '+' : '';
  if (move.castling === 'K') return `O-O${suffix}`;
  if (move.castling === 'Q') return `O-O-O${suffix}`;

  const dest = squareName(move.to);
  if (piece.type === 'p') {
    const fromFile = String.fromCharCode(97 + colOf(move.from));
    const cap = move.captured ? `${fromFile}x` : '';
    const promo = move.promotion ? `=${move.promotion.toUpperCase()}` : '';
    return `${cap}${dest}${promo}${suffix}`;
  }

  const letter = piece.type.toUpperCase();
  const cap = move.captured ? 'x' : '';
  return `${letter}${cap}${dest}${suffix}`;
}

export function applyChessMove(
  state: ChessGameState,
  from: number,
  to: number,
  promotion?: ChessPromotionPiece,
): ChessGameState | null {
  if (state.status !== 'playing') return null;
  const legalMoves = getLegalChessMovesForSquare(state, from);
  const matched = legalMoves.find(
    (m) => m.to === to && (m.promotion === undefined || m.promotion === (promotion ?? 'q')),
  );
  if (!matched) return null;

  const movingPiece = state.board[from]!;
  const nextBoard = simulateBoardMove(state.board, matched);
  const nextTurn: ChessColor = state.turn === 'w' ? 'b' : 'w';

  // Update castling rights
  const nextCastling: ChessCastlingRights = { ...state.castling };
  if (movingPiece.type === 'k') {
    if (movingPiece.color === 'w') {
      nextCastling.wK = false;
      nextCastling.wQ = false;
    } else {
      nextCastling.bK = false;
      nextCastling.bQ = false;
    }
  }
  if (from === 63 || to === 63) nextCastling.wK = false;
  if (from === 56 || to === 56) nextCastling.wQ = false;
  if (from === 7 || to === 7) nextCastling.bK = false;
  if (from === 0 || to === 0) nextCastling.bQ = false;

  // En passant target
  let nextEnPassant: number | null = null;
  if (movingPiece.type === 'p' && Math.abs(rowOf(to) - rowOf(from)) === 2) {
    nextEnPassant = indexOf((rowOf(from) + rowOf(to)) / 2, colOf(from));
  }

  // Captured pieces
  const capturedByWhite = [...state.capturedByWhite];
  const capturedByBlack = [...state.capturedByBlack];
  if (matched.captured) {
    if (movingPiece.color === 'w') capturedByWhite.push(matched.captured);
    else capturedByBlack.push(matched.captured);
  }

  const nextHalfMove = movingPiece.type === 'p' || matched.captured ? 0 : state.halfMoveClock + 1;
  const nextFullMove = state.turn === 'b' ? state.fullMoveNumber + 1 : state.fullMoveNumber;
  const nextInCheck = isKingInCheck(nextBoard, nextTurn);

  const draftState: ChessGameState = {
    board: nextBoard,
    turn: nextTurn,
    castling: nextCastling,
    enPassantTarget: nextEnPassant,
    halfMoveClock: nextHalfMove,
    fullMoveNumber: nextFullMove,
    inCheck: nextInCheck,
    status: 'playing',
    winner: null,
    lastMove: { from, to },
    capturedByWhite,
    capturedByBlack,
    moveHistory: state.moveHistory,
    scores: { ...state.scores },
  };

  const enemyLegal = getAllLegalChessMoves(draftState);
  let status: ChessGameState['status'] = 'playing';
  let winner: ChessGameState['winner'] = null;

  if (enemyLegal.length === 0) {
    if (nextInCheck) {
      status = 'checkmate';
      winner = movingPiece.color;
      draftState.scores[movingPiece.color] += 1;
    } else {
      status = 'stalemate';
      winner = 'draw';
      draftState.scores.draws += 1;
    }
  } else if (nextHalfMove >= 100) {
    status = 'draw_fifty';
    winner = 'draw';
    draftState.scores.draws += 1;
  }

  const san = buildSan(movingPiece, matched, nextInCheck, status === 'checkmate');
  const record: ChessMoveRecord = {
    from,
    to,
    piece: movingPiece.type,
    color: movingPiece.color,
    ...(matched.captured ? { captured: matched.captured } : {}),
    ...(matched.promotion ? { promotion: matched.promotion } : {}),
    ...(matched.castling ? { castling: matched.castling } : {}),
    ...(matched.enPassant ? { enPassant: true } : {}),
    san,
  };

  return {
    ...draftState,
    status,
    winner,
    moveHistory: [...state.moveHistory.slice(-599), record],
  };
}

export function resignChessGame(state: ChessGameState, resigningColor: ChessColor): ChessGameState {
  if (state.status !== 'playing') return state;
  const winner: ChessColor = resigningColor === 'w' ? 'b' : 'w';
  const nextScores = { ...state.scores };
  nextScores[winner] += 1;
  return {
    ...state,
    status: 'resigned',
    winner,
    scores: nextScores,
  };
}
