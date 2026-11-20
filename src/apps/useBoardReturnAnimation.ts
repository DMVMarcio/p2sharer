import { useLayoutEffect, useRef, useState } from 'react';
import { isReducedMotion } from '../core/appearance_preferences.ts';

export interface PieceReturnTransform {
  dxPercent: number;
  dyPercent: number;
  delayMs: number;
  durationMs: number;
  fromOutside: boolean;
}

interface BoardReturnPlan {
  animKey: number;
  entries: Map<number, PieceReturnTransform>;
}

interface UseBoardReturnAnimationParams<T> {
  roomId: string | undefined;
  board: readonly (T | null)[] | undefined;
  moveCount: number;
  status: string;
  flipped: boolean;
  getPieceSignature: (piece: T) => string;
  isPreferentialMatch?: (candidate: T, target: T) => boolean;
  onPieceSettle: (stepIndex: number) => void;
}

function visualCoords(sq: number, flipped: boolean): { row: number; col: number } {
  const rawRow = Math.floor(sq / 8);
  const rawCol = sq % 8;
  return {
    row: flipped ? 7 - rawRow : rawRow,
    col: flipped ? 7 - rawCol : rawCol,
  };
}

/**
 * Computes per-square procedural return/entrance animations on 8x8 boards.
 * - Surviving pieces travel smoothly from their actual pre-reset square to their starting home square.
 * - Missing/captured pieces and first-match setups enter from the middle-right edge of the board.
 * - Schedules an individual wooden settle sound as each animated piece lands on its square.
 */
export function useBoardReturnAnimation<T>({
  roomId,
  board,
  moveCount,
  status,
  flipped,
  getPieceSignature,
  isPreferentialMatch,
  onPieceSettle,
}: UseBoardReturnAnimationParams<T>): {
  animKey: number;
  activeTransforms: Map<number, PieceReturnTransform> | null;
} {
  const [plan, setPlan] = useState<BoardReturnPlan | null>(null);
  const snapshotRef = useRef<{
    roomId: string;
    moves: number;
    status: string;
    board: (T | null)[];
  } | null>(null);
  const onSettleRef = useRef(onPieceSettle);
  onSettleRef.current = onPieceSettle;

  useLayoutEffect(() => {
    if (!roomId || !board) {
      snapshotRef.current = null;
      setPlan(null);
      return;
    }

    const prev = snapshotRef.current;
    const isFreshRoomEnter = (!prev || prev.roomId !== roomId) && moveCount === 0 && status === 'playing';
    const isMatchReset =
      Boolean(prev && prev.roomId === roomId) &&
      ((prev!.moves > 0 && moveCount === 0) ||
        (prev!.status !== 'playing' && status === 'playing' && moveCount === 0));

    const prevBoard = prev && prev.roomId === roomId ? prev.board : null;
    snapshotRef.current = {
      roomId,
      moves: moveCount,
      status,
      board: [...board],
    };

    if (!isFreshRoomEnter && !isMatchReset) {
      if (moveCount > 0) {
        setPlan(null);
      }
      return;
    }

    if (isReducedMotion()) {
      setPlan(null);
      return;
    }

    // Build target squares that currently hold a piece in the reset/starting board
    const targets: { sq: number; piece: T; sig: string }[] = [];
    for (let sq = 0; sq < board.length; sq++) {
      const piece = board[sq];
      if (piece) {
        targets.push({ sq, piece, sig: getPieceSignature(piece) });
      }
    }

    const usedPrevSquares = new Set<number>();
    const matchedFrom = new Map<number, number>(); // targetSq -> prevSq

    if (prevBoard) {
      // Pass 1: Keep pieces already sitting on their exact origin square stationary
      for (const target of targets) {
        const prevPiece = prevBoard[target.sq];
        if (prevPiece && getPieceSignature(prevPiece) === target.sig) {
          usedPrevSquares.add(target.sq);
          matchedFrom.set(target.sq, target.sq);
        }
      }

      // Pass 2: Match remaining pieces by shortest Euclidean distance on the board
      const unmatchedTargets = targets.filter((t) => !matchedFrom.has(t.sq));
      const availableSources: { sq: number; piece: T; sig: string }[] = [];
      for (let sq = 0; sq < prevBoard.length; sq++) {
        if (usedPrevSquares.has(sq)) continue;
        const p = prevBoard[sq];
        if (p) availableSources.push({ sq, piece: p, sig: getPieceSignature(p) });
      }

      for (const target of unmatchedTargets) {
        const toCoord = visualCoords(target.sq, flipped);
        let bestIdx = -1;
        let bestScore = Number.POSITIVE_INFINITY;

        for (let i = 0; i < availableSources.length; i++) {
          const src = availableSources[i];
          if (src.sig !== target.sig) continue;
          const fromCoord = visualCoords(src.sq, flipped);
          const dist = Math.hypot(fromCoord.col - toCoord.col, fromCoord.row - toCoord.row);
          const preferencePenalty = isPreferentialMatch && !isPreferentialMatch(src.piece, target.piece) ? 0.25 : 0;
          const score = dist + preferencePenalty;
          if (score < bestScore) {
            bestScore = score;
            bestIdx = i;
          }
        }

        if (bestIdx >= 0) {
          const chosen = availableSources.splice(bestIdx, 1)[0];
          matchedFrom.set(target.sq, chosen.sq);
        }
      }
    }

    interface PendingAnim {
      targetSq: number;
      dxPercent: number;
      dyPercent: number;
      dist: number;
      fromOutside: boolean;
      toRow: number;
      toCol: number;
    }

    const pending: PendingAnim[] = [];
    for (const target of targets) {
      const fromSq = matchedFrom.get(target.sq);
      if (fromSq === target.sq) {
        continue; // Already resting on its home square
      }

      const toCoord = visualCoords(target.sq, flipped);
      const fromOutside = fromSq === undefined;
      const fromCoord = fromOutside
        ? { row: 3.5, col: 8.15 } // Middle-right side edge of the board
        : visualCoords(fromSq, flipped);

      const dxCols = fromCoord.col - toCoord.col;
      const dyRows = fromCoord.row - toCoord.row;
      const dist = Math.hypot(dxCols, dyRows);

      pending.push({
        targetSq: target.sq,
        dxPercent: dxCols * 100,
        dyPercent: dyRows * 100,
        dist,
        fromOutside,
        toRow: toCoord.row,
        toCol: toCoord.col,
      });
    }

    if (pending.length === 0) {
      setPlan(null);
      return;
    }

    // Order procedurally: on-board pieces return by shortest travel first; outside pieces fill far-to-near columns
    pending.sort((a, b) => {
      if (a.fromOutside !== b.fromOutside) return a.fromOutside ? 1 : -1;
      if (!a.fromOutside) {
        return a.dist - b.dist || a.toRow - b.toRow || a.toCol - b.toCol;
      }
      return a.toCol - b.toCol || Math.abs(b.toRow - 3.5) - Math.abs(a.toRow - 3.5);
    });

    const stepMs = pending.length > 20 ? 22 : pending.length > 10 ? 30 : 38;
    const entries = new Map<number, PieceReturnTransform>();
    const soundTimers: number[] = [];
    let maxEndMs = 0;

    pending.forEach((item, index) => {
      const delayMs = index * stepMs;
      const durationMs = Math.round(Math.min(340, 210 + item.dist * 16));
      entries.set(item.targetSq, {
        dxPercent: item.dxPercent,
        dyPercent: item.dyPercent,
        delayMs,
        durationMs,
        fromOutside: item.fromOutside,
      });

      const landMs = delayMs + durationMs - 15;
      maxEndMs = Math.max(maxEndMs, delayMs + durationMs + 40);
      soundTimers.push(
        window.setTimeout(() => {
          onSettleRef.current(index);
        }, Math.max(0, landMs)),
      );
    });

    setPlan((prevPlan) => ({
      animKey: (prevPlan?.animKey ?? 0) + 1,
      entries,
    }));

    const clearTimer = window.setTimeout(() => {
      setPlan(null);
    }, maxEndMs);

    return () => {
      window.clearTimeout(clearTimer);
      for (const timer of soundTimers) {
        window.clearTimeout(timer);
      }
    };
  }, [roomId, moveCount, status]);

  return {
    animKey: plan?.animKey ?? 0,
    activeTransforms: plan?.entries ?? null,
  };
}
