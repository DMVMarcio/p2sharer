export type TicTacToeSide = 'X' | 'O';
export type TicTacToeCell = TicTacToeSide | null;

export interface TicTacToeGameState {
  board: TicTacToeCell[];
  turn: TicTacToeSide;
  winner: TicTacToeSide | 'draw' | null;
  winningLine: number[] | null;
  lastMove: number | null;
  moveCount: number;
  scores: { X: number; O: number; draws: number };
  startingSide: TicTacToeSide;
}

export const TICTACTOE_WIN_LINES: readonly [number, number, number][] = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

export function createInitialTicTacToeState(
  startingSide: TicTacToeSide = 'X',
  scores = { X: 0, O: 0, draws: 0 },
): TicTacToeGameState {
  return {
    board: Array<TicTacToeCell>(9).fill(null),
    turn: startingSide,
    winner: null,
    winningLine: null,
    lastMove: null,
    moveCount: 0,
    scores: { ...scores },
    startingSide,
  };
}

export function validTicTacToeState(value: unknown): value is TicTacToeGameState {
  if (!value || typeof value !== 'object') return false;
  const state = value as TicTacToeGameState;
  if (!Array.isArray(state.board) || state.board.length !== 9) return false;
  if (!state.board.every((cell) => cell === null || cell === 'X' || cell === 'O')) return false;
  if (state.turn !== 'X' && state.turn !== 'O') return false;
  if (state.startingSide !== 'X' && state.startingSide !== 'O') return false;
  if (state.winner !== null && state.winner !== 'X' && state.winner !== 'O' && state.winner !== 'draw') return false;
  if (
    state.winningLine !== null &&
    (!Array.isArray(state.winningLine) ||
      state.winningLine.length !== 3 ||
      !state.winningLine.every((idx) => Number.isInteger(idx) && idx >= 0 && idx < 9))
  ) {
    return false;
  }
  if (state.lastMove !== null && (!Number.isInteger(state.lastMove) || state.lastMove < 0 || state.lastMove >= 9)) {
    return false;
  }
  if (!Number.isInteger(state.moveCount) || state.moveCount < 0 || state.moveCount > 9) return false;
  if (
    !state.scores ||
    typeof state.scores !== 'object' ||
    !Number.isSafeInteger(state.scores.X) ||
    state.scores.X < 0 ||
    !Number.isSafeInteger(state.scores.O) ||
    state.scores.O < 0 ||
    !Number.isSafeInteger(state.scores.draws) ||
    state.scores.draws < 0
  ) {
    return false;
  }
  return true;
}

export function applyTicTacToeMove(state: TicTacToeGameState, cellIndex: number): TicTacToeGameState | null {
  if (state.winner !== null) return null;
  if (!Number.isInteger(cellIndex) || cellIndex < 0 || cellIndex >= 9) return null;
  if (state.board[cellIndex] !== null) return null;

  const nextBoard = [...state.board];
  const side = state.turn;
  nextBoard[cellIndex] = side;

  let winner: TicTacToeSide | 'draw' | null = null;
  let winningLine: number[] | null = null;

  for (const line of TICTACTOE_WIN_LINES) {
    const [a, b, c] = line;
    if (nextBoard[a] === side && nextBoard[b] === side && nextBoard[c] === side) {
      winner = side;
      winningLine = [...line];
      break;
    }
  }

  const moveCount = state.moveCount + 1;
  if (!winner && moveCount >= 9) {
    winner = 'draw';
  }

  const nextScores = { ...state.scores };
  if (winner === 'X') nextScores.X += 1;
  else if (winner === 'O') nextScores.O += 1;
  else if (winner === 'draw') nextScores.draws += 1;

  return {
    board: nextBoard,
    turn: side === 'X' ? 'O' : 'X',
    winner,
    winningLine,
    lastMove: cellIndex,
    moveCount,
    scores: nextScores,
    startingSide: state.startingSide,
  };
}

export function resetTicTacToeRound(state: TicTacToeGameState, resetScores = false): TicTacToeGameState {
  const nextStart: TicTacToeSide = resetScores ? 'X' : state.startingSide === 'X' ? 'O' : 'X';
  const scores = resetScores ? { X: 0, O: 0, draws: 0 } : state.scores;
  return createInitialTicTacToeState(nextStart, scores);
}
