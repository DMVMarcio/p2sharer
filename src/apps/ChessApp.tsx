import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Clipboard, ClipboardCheck, Crown, Download } from 'lucide-react';
import { t } from '../i18n/index.ts';
import { useLocale } from '../hooks/useLocale.ts';
import { roomAppsService } from './room_apps_service.ts';
import type { RoomAppViewProps } from './registry.ts';
import type { ChessModel, ChessRoomState } from './board_game_model.ts';
import {
  colOf,
  findKingSquare,
  getLegalChessMovesForSquare,
  rowOf,
  squareName,
  type ChessCandidateMove,
  type ChessColor,
  type ChessPieceType,
  type ChessPromotionPiece,
} from './chess_engine.ts';
import {
  BoardUndoConsentNotification,
  ChessPieceSvg,
  CozyBoardGameShell,
  CozyRoomSidePanel,
  useBoardGamePlayers,
  type CozyStatusTone,
} from './BoardGameLobbyView.tsx';
import { BoardPlanningOverlay, useBoardPlanning } from './BoardPlanningOverlay.tsx';
import { boardGameSounds } from './board_game_sounds.ts';
import { useBoardReturnAnimation } from './useBoardReturnAnimation.ts';
import { useTimedBoardMatch } from './useTimedBoardMatch.ts';
import { buildChessPgn } from './chess_pgn.ts';
import { ModalDialog } from '../components/common/ModalDialog.tsx';

interface DraggingPieceState {
  from: number;
  piece: { color: ChessColor; type: ChessPieceType };
  clientX: number;
  clientY: number;
  offsetX: number;
  offsetY: number;
  pieceSize: number;
  hoverSquare: number | null;
}

const CHESS_CAPTURE_ORDER: Record<ChessPieceType, number> = {
  q: 0,
  r: 1,
  b: 2,
  n: 3,
  p: 4,
  k: 5,
};

export const ChessApp: React.FC<RoomAppViewProps> = ({ instanceId, compact = false }) => {
  useLocale();
  const resolveActor = useBoardGamePlayers();
  const [, setTick] = useState(0);
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
  const [selectedSquare, setSelectedSquare] = useState<number | null>(null);
  const [pendingPromotion, setPendingPromotion] = useState<{ from: number; to: number; color: ChessColor } | null>(null);
  const [dragging, setDragging] = useState<DraggingPieceState | null>(null);
  const [pgnDialogOpen, setPgnDialogOpen] = useState(false);
  const [pgnCopied, setPgnCopied] = useState(false);
  const suppressClickRef = useRef(false);
  const lastSoundSnapshotRef = useRef<{
    roomId: string;
    moves: number;
    status: string;
    inCheck: boolean;
  } | null>(null);

  const { arrows, highlights, draftArrow, clearPlanning, startRightPlanning } = useBoardPlanning(8);

  useEffect(() => {
    return roomAppsService.subscribe(() => setTick((n) => n + 1));
  }, []);

  const model = roomAppsService.getModel<ChessModel>(instanceId);
  if (!model) return null;

  useEffect(() => {
    if (activeRoomId && !model.getRoom(activeRoomId)) {
      setActiveRoomId(null);
      setSelectedSquare(null);
      setPendingPromotion(null);
      setDragging(null);
      clearPlanning();
    }
  }, [activeRoomId, model, clearPlanning]);

  const currentRoom = activeRoomId ? model.getRoom(activeRoomId) : undefined;
  const { seat1ClockMs, seat2ClockMs, isClockRunning } = useTimedBoardMatch(model, currentRoom);

  useEffect(() => {
    if (currentRoom && currentRoom.game.status !== 'playing') {
      setPendingPromotion(null);
      setSelectedSquare(null);
      setDragging(null);
    }
  }, [currentRoom?.id, currentRoom?.game.status]);

  useEffect(() => {
    if (!currentRoom) {
      lastSoundSnapshotRef.current = null;
      return;
    }
    const { game } = currentRoom;
    const prev = lastSoundSnapshotRef.current;
    if (!prev || prev.roomId !== currentRoom.id) {
      lastSoundSnapshotRef.current = {
        roomId: currentRoom.id,
        moves: game.moveHistory.length,
        status: game.status,
        inCheck: game.inCheck,
      };
      return;
    }

    const movesIncreased = game.moveHistory.length > prev.moves;
    const movesDecreased = game.moveHistory.length < prev.moves;
    const statusChanged = game.status !== prev.status;

    if (movesIncreased || movesDecreased || statusChanged) {
      const lastRecord = game.moveHistory[game.moveHistory.length - 1];
      if (game.status === 'checkmate' || game.status === 'resigned' || game.status === 'timeout') {
        boardGameSounds.playVictory();
      } else if (game.status === 'stalemate' || game.status === 'draw_fifty') {
        boardGameSounds.playDraw();
      } else if (movesDecreased) {
        if (game.moveHistory.length > 0) {
          boardGameSounds.playMove();
        }
      } else if (movesIncreased) {
        if (game.inCheck) {
          boardGameSounds.playCheck();
        } else if (lastRecord?.promotion) {
          boardGameSounds.playPromote();
        } else if (lastRecord?.captured) {
          boardGameSounds.playCapture();
        } else {
          boardGameSounds.playMove();
        }
      }
    }

    lastSoundSnapshotRef.current = {
      roomId: currentRoom.id,
      moves: game.moveHistory.length,
      status: game.status,
      inCheck: game.inCheck,
    };
  }, [
    currentRoom?.id,
    currentRoom?.game.moveHistory.length,
    currentRoom?.game.status,
    currentRoom?.game.inCheck,
  ]);

  const { animKey: boardAnimKey, activeTransforms } = useBoardReturnAnimation({
    roomId: currentRoom?.id,
    board: currentRoom?.game.board,
    moveCount: currentRoom?.game.moveHistory.length ?? 0,
    status: currentRoom?.game.status ?? 'playing',
    flipped: currentRoom?.players.seat2 === model.localActor,
    getPieceSignature: (p) => `${p.color}:${p.type}`,
    onPieceSettle: (idx) => boardGameSounds.playSettle(idx),
  });

  const handleSelectRoom = (nextId: string | null) => {
    if (activeRoomId && nextId === null) {
      model.leaveRoom(activeRoomId);
    }
    setActiveRoomId(nextId);
    setSelectedSquare(null);
    setPendingPromotion(null);
    setDragging(null);
    clearPlanning();
  };

  const describeRoomStatus = (room: ChessRoomState): string => {
    const { game } = room;
    if (game.status === 'playing' && room.lockedBy === model.localActor) {
      return game.inCheck
        ? `${t('chess.soloModeStatus')} · ${t('chess.check')}`
        : t('chess.soloModeStatus');
    }
    if (game.status === 'checkmate' && (game.winner === 'w' || game.winner === 'b')) {
      const winnerId = game.winner === 'w' ? room.players.seat1 : room.players.seat2;
      const person = resolveActor(winnerId, model.localActor);
      return person
        ? t('chess.statusCheckmateWinner', { name: person.name })
        : t('chess.statusCheckmateSide', { side: game.winner === 'w' ? t('games.white') : t('games.black') });
    }
    if (game.status === 'stalemate' || game.status === 'draw_fifty' || game.winner === 'draw') {
      return t('games.statusDraw');
    }
    if (game.status === 'resigned' && (game.winner === 'w' || game.winner === 'b')) {
      const winnerId = game.winner === 'w' ? room.players.seat1 : room.players.seat2;
      const person = resolveActor(winnerId, model.localActor);
      return person
        ? t('games.statusResignedWinner', { name: person.name })
        : t('games.statusWinnerSide', { side: game.winner === 'w' ? t('games.white') : t('games.black') });
    }
    if (game.status === 'timeout' && (game.winner === 'w' || game.winner === 'b')) {
      const winnerId = game.winner === 'w' ? room.players.seat1 : room.players.seat2;
      const person = resolveActor(winnerId, model.localActor);
      return person
        ? t('games.statusTimeoutWinner', { name: person.name })
        : t('games.statusTimeoutSide', { side: game.winner === 'w' ? t('games.white') : t('games.black') });
    }
    if (!room.players.seat1 || !room.players.seat2) {
      return t('games.statusWaitingPlayers');
    }
    const turnId = game.turn === 'w' ? room.players.seat1 : room.players.seat2;
    const person = resolveActor(turnId, model.localActor);
    const base = person
      ? t('games.statusTurnNamed', { name: person.name })
      : t('games.statusTurnSide', { side: game.turn === 'w' ? t('games.white') : t('games.black') });
    return game.inCheck ? `${base} · ${t('chess.check')}` : base;
  };

  const getPgn = (room: ChessRoomState): string => {
    const playerName = (actorId: string | null, fallback: string) =>
      (actorId ? resolveActor(actorId, model.localActor)?.name : undefined) || fallback;
    return buildChessPgn(room.game, {
      event: room.name,
      white: playerName(room.players.seat1, 'White'),
      black: playerName(room.players.seat2, 'Black'),
    });
  };

  const copyPgn = async (pgn: string) => {
    await navigator.clipboard.writeText(pgn);
    setPgnCopied(true);
  };

  const downloadPgn = (room: ChessRoomState) => {
    const blob = new Blob([getPgn(room)], { type: 'application/x-chess-pgn;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${(room.name || 'p2sharer-chess').replace(/[^\p{L}\p{N}-]+/gu, '-').replace(/^-|-$/g, '') || 'p2sharer-chess'}.pgn`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  if (compact) {
    return (
      <div className="cozy-compact-preview kind-chess">
        <Crown size={28} strokeWidth={1.6} aria-hidden="true" />
        <strong>{t('chess.title')}</strong>
        <span>{t('games.roomsActiveCount', { count: model.rooms.length })}</span>
      </div>
    );
  }

  return (
    <CozyBoardGameShell
      kind="chess"
      title={t('chess.title')}
      subtitle={t('chess.description')}
      seat1Label={t('games.white')}
      seat2Label={t('games.black')}
      model={model}
      activeRoomId={activeRoomId}
      onSelectRoom={handleSelectRoom}
      describeRoomStatus={describeRoomStatus}
      renderRoomMiniPreview={(room) => (
        <div className="cozy-mini-board-badge">
          <ChessPieceSvg type="n" color={room.game.turn} size={24} />
          <span>{room.game.moveHistory.length}</span>
        </div>
      )}
      renderRoomOverlay={(room) => (
        <BoardUndoConsentNotification
          room={room}
          model={model}
          undoRequest={room.game.undoRequest}
          isPlaying={room.game.status === 'playing'}
          onRespond={(accept) => {
            model.respondUndo(room.id, accept);
            setSelectedSquare(null);
            clearPlanning();
          }}
        />
      )}
    >
      {(room) => {
        const { game } = room;
        const myColor: ChessColor | null =
          room.players.seat1 === model.localActor
            ? 'w'
            : room.players.seat2 === model.localActor
              ? 'b'
              : null;
        const isSoloMode = room.lockedBy === model.localActor;
        const isMyTurn = game.status === 'playing' && myColor !== null && (isSoloMode || game.turn === myColor);
        const flipped = isSoloMode ? game.moveHistory.length % 2 === 1 : myColor === 'b';

        const activeOrigin = dragging ? dragging.from : selectedSquare;
        const legalMoves: ChessCandidateMove[] =
          isMyTurn && activeOrigin !== null ? getLegalChessMovesForSquare(game, activeOrigin) : [];
        const legalTargets = new Map<number, ChessCandidateMove[]>();
        for (const m of legalMoves) {
          const existing = legalTargets.get(m.to) ?? [];
          existing.push(m);
          legalTargets.set(m.to, existing);
        }

        const checkedKingSquare = game.inCheck ? findKingSquare(game.board, game.turn) : -1;

        const commitMoveOrPromotion = (from: number, to: number) => {
          if (!isMyTurn || !myColor) return false;
          const movesFromOrigin = getLegalChessMovesForSquare(game, from);
          const matches = movesFromOrigin.filter((m) => m.to === to);
          if (matches.length === 0) return false;

          if (matches.some((m) => m.promotion)) {
            setPendingPromotion({ from, to, color: myColor });
          } else {
            model.makeMove(room.id, from, to);
            setSelectedSquare(null);
            clearPlanning();
          }
          return true;
        };

        const resolveSquareAtClientPoint = (clientX: number, clientY: number): number | null => {
          const el = document.elementFromPoint(clientX, clientY);
          const sqButton = el?.closest<HTMLElement>('[data-board-square]');
          if (!sqButton) return null;
          const raw = Number(sqButton.dataset.boardSquare);
          return Number.isInteger(raw) && raw >= 0 && raw < 64 ? raw : null;
        };

        const handleSquarePointerDown = (event: React.PointerEvent<HTMLButtonElement>, sqIndex: number) => {
          if (event.button === 2) {
            startRightPlanning(event, sqIndex);
            return;
          }
          if (event.button !== 0) return;

          // Left click clears local planning arrows
          clearPlanning();

          if (!isMyTurn || !myColor) return;
          const clickedPiece = game.board[sqIndex];

          if (selectedSquare !== null && legalTargets.has(sqIndex)) {
            event.preventDefault();
            suppressClickRef.current = true;
            commitMoveOrPromotion(selectedSquare, sqIndex);
            return;
          }

          if (!clickedPiece || clickedPiece.color !== myColor) {
            setSelectedSquare(null);
            return;
          }

          event.preventDefault();
          const pieceEl = event.currentTarget.querySelector<HTMLElement>('.board-svg-piece');
          const pieceRect = pieceEl?.getBoundingClientRect() ?? event.currentTarget.getBoundingClientRect();
          const centerX = pieceRect.left + pieceRect.width / 2;
          const centerY = pieceRect.top + pieceRect.height / 2;
          const offsetX = event.clientX - centerX;
          const offsetY = event.clientY - centerY;
          const pieceSize = Math.max(28, Math.round(pieceRect.width));

          setSelectedSquare(sqIndex);
          const startX = event.clientX;
          const startY = event.clientY;
          let dragStarted = false;

          const onPointerMove = (moveEvent: PointerEvent) => {
            const dx = moveEvent.clientX - startX;
            const dy = moveEvent.clientY - startY;
            if (!dragStarted && Math.hypot(dx, dy) > 4) {
              dragStarted = true;
            }
            if (dragStarted) {
              const hovered = resolveSquareAtClientPoint(moveEvent.clientX, moveEvent.clientY);
              setDragging({
                from: sqIndex,
                piece: clickedPiece,
                clientX: moveEvent.clientX,
                clientY: moveEvent.clientY,
                offsetX,
                offsetY,
                pieceSize,
                hoverSquare: hovered,
              });
            }
          };

          const onPointerUp = (upEvent: PointerEvent) => {
            window.removeEventListener('pointermove', onPointerMove);
            window.removeEventListener('pointerup', onPointerUp);
            window.removeEventListener('pointercancel', onPointerUp);
            if (dragStarted) {
              suppressClickRef.current = true;
              const targetSq = resolveSquareAtClientPoint(upEvent.clientX, upEvent.clientY);
              setDragging(null);
              if (targetSq !== null && targetSq !== sqIndex) {
                commitMoveOrPromotion(sqIndex, targetSq);
              }
            }
          };

          window.addEventListener('pointermove', onPointerMove);
          window.addEventListener('pointerup', onPointerUp);
          window.addEventListener('pointercancel', onPointerUp);
        };

        const displaySquares: number[] = [];
        for (let r = 0; r < 8; r++) {
          for (let c = 0; c < 8; c++) {
            const actualRow = flipped ? 7 - r : r;
            const actualCol = flipped ? 7 - c : c;
            displaySquares.push(actualRow * 8 + actualCol);
          }
        }

        const statusTone: CozyStatusTone =
          game.status !== 'playing'
            ? 'victory'
            : game.inCheck
              ? 'warning'
              : isMyTurn
                ? 'turn'
                : 'waiting';

        const statusText =
          game.status === 'playing' && game.inCheck
            ? `${t('chess.checkAlert')} · ${describeRoomStatus(room)}`
            : describeRoomStatus(room);

        const lastMoveRecord = game.moveHistory[game.moveHistory.length - 1];
        const canRequestUndo = Boolean(
          game.status === 'playing' &&
            myColor !== null &&
            room.players.seat1 &&
            room.players.seat2 &&
            lastMoveRecord?.color === myColor &&
            !game.undoRequest,
        );
        const isUndoPending = Boolean(
          game.status === 'playing' && myColor !== null && game.undoRequest?.requester === myColor,
        );

        return (
          <div className="cozy-match-layout">
            <div className="cozy-board-stage">
              <div className="wood-board-frame chess-wood-frame">
                <span className="wood-frame-stud stud-tl" aria-hidden="true" />
                <span className="wood-frame-stud stud-tr" aria-hidden="true" />
                <span className="wood-frame-stud stud-bl" aria-hidden="true" />
                <span className="wood-frame-stud stud-br" aria-hidden="true" />

                <div
                  className="wood-board-8x8"
                  role="grid"
                  aria-label={t('chess.title')}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                  }}
                >
                  {displaySquares.map((sqIndex, visualIdx) => {
                    const r = rowOf(sqIndex);
                    const c = colOf(sqIndex);
                    const isDark = (r + c) % 2 === 1;
                    const piece = game.board[sqIndex];
                    const isSelected = activeOrigin === sqIndex;
                    const isLegalDest = legalTargets.has(sqIndex);
                    const isDragHover = dragging?.hoverSquare === sqIndex && isLegalDest;
                    const isBeingDragged = dragging?.from === sqIndex;
                    const isLastMove =
                      game.lastMove?.from === sqIndex || game.lastMove?.to === sqIndex;
                    const isKingCheck = checkedKingSquare === sqIndex;
                    const showRank = visualIdx % 8 === 0;
                    const showFile = visualIdx >= 56;
                    const isDraggablePiece = Boolean(isMyTurn && piece && piece.color === myColor);

                    return (
                      <button
                        key={sqIndex}
                        type="button"
                        role="gridcell"
                        data-board-square={sqIndex}
                        aria-label={`${squareName(sqIndex)}${piece ? ` ${piece.color} ${piece.type}` : ''}`}
                        className={`wood-square ${isDark ? 'dark' : 'light'} ${
                          isSelected ? 'is-selected' : ''
                        } ${isLegalDest ? 'is-legal' : ''} ${
                          isDragHover ? 'is-drag-hover' : ''
                        } ${isLastMove ? 'is-last-move' : ''} ${
                          isKingCheck ? 'is-king-check' : ''
                        } ${isDraggablePiece ? 'is-draggable' : ''} ${
                          isBeingDragged ? 'is-dragging-source' : ''
                        }`}
                        onPointerDown={(e) => handleSquarePointerDown(e, sqIndex)}
                        onClick={() => {
                          if (suppressClickRef.current) {
                            suppressClickRef.current = false;
                            return;
                          }
                          if (isMyTurn) {
                            if (selectedSquare !== null && legalTargets.has(sqIndex)) {
                              commitMoveOrPromotion(selectedSquare, sqIndex);
                            } else if (piece && piece.color === myColor) {
                              setSelectedSquare(selectedSquare === sqIndex ? null : sqIndex);
                            }
                          }
                        }}
                      >
                        {showRank && <span className="wood-coord-rank">{8 - r}</span>}
                        {showFile && <span className="wood-coord-file">{String.fromCharCode(97 + c)}</span>}
                        {piece && (() => {
                          const returnTransform = activeTransforms?.get(sqIndex);
                          return (
                            <span
                              key={returnTransform ? `return-${boardAnimKey}-${sqIndex}` : `piece-${sqIndex}`}
                              className={
                                returnTransform
                                  ? `cozy-piece-slot is-returning ${returnTransform.fromOutside ? 'is-from-outside' : ''}`
                                  : 'cozy-piece-slot'
                              }
                              style={
                                returnTransform
                                  ? ({
                                      '--piece-from-x': `${returnTransform.dxPercent}%`,
                                      '--piece-from-y': `${returnTransform.dyPercent}%`,
                                      '--piece-delay': `${returnTransform.delayMs}ms`,
                                      '--piece-duration': `${returnTransform.durationMs}ms`,
                                    } as React.CSSProperties)
                                  : undefined
                              }
                            >
                              <ChessPieceSvg type={piece.type} color={piece.color} size={48} />
                            </span>
                          );
                        })()}
                        {isLegalDest && (
                          <span className={`wood-move-dot ${piece ? 'is-capture' : ''}`} aria-hidden="true" />
                        )}
                      </button>
                    );
                  })}

                  <BoardPlanningOverlay
                    gridSize={8}
                    flipped={flipped}
                    arrows={arrows}
                    highlights={highlights}
                    draftArrow={draftArrow}
                  />
                </div>
              </div>
            </div>

            {dragging &&
              createPortal(
                <div
                  className="board-drag-ghost"
                  style={{
                    left: `${dragging.clientX - dragging.offsetX}px`,
                    top: `${dragging.clientY - dragging.offsetY}px`,
                    width: `${dragging.pieceSize}px`,
                    height: `${dragging.pieceSize}px`,
                  }}
                  aria-hidden="true"
                >
                  <ChessPieceSvg
                    type={dragging.piece.type}
                    color={dragging.piece.color}
                    size={dragging.pieceSize}
                  />
                </div>,
                document.body,
              )}

            <CozyRoomSidePanel
              room={room}
              model={model}
              seat1Label={t('games.white')}
              seat2Label={t('games.black')}
              seat1Score={game.scores.w}
              seat2Score={game.scores.b}
              drawsScore={game.scores.draws}
              turnSide={game.status !== 'playing' ? null : game.turn === 'w' ? 'seat1' : 'seat2'}
              statusText={statusText}
              statusTone={statusTone}
              seat1ClockMs={seat1ClockMs}
              seat2ClockMs={seat2ClockMs}
              isClockRunning={isClockRunning}
              timeLimitMs={game.clock?.limitMs ?? null}
              canConfigureTimeLimit={game.status === 'playing' && game.moveHistory.length === 0}
              onChangeTimeLimit={(limitMs) => model.setTimeLimit(room.id, limitMs)}
              undoState={
                myColor !== null
                  ? {
                      canRequest: canRequestUndo,
                      isPending: isUndoPending,
                      onRequest: () => model.requestUndo(room.id),
                    }
                  : undefined
              }
              onNewMatch={() => {
                model.newGame(room.id, false);
                setSelectedSquare(null);
                clearPlanning();
              }}
              onResetScores={() => {
                model.newGame(room.id, true);
                setSelectedSquare(null);
                clearPlanning();
              }}
              onSwapSeats={!isSoloMode ? () => {
                model.swapSides(room.id);
                clearPlanning();
              } : undefined}
              canResign={game.status === 'playing' && myColor !== null}
              onResign={() => model.resign(room.id)}
              extraContent={
                <div className="cozy-panel-card cozy-history-card">
                  <div className="cozy-captured-strip">
                    <div className="cozy-captured-row">
                      <span className="cozy-captured-label">
                        <span className="cozy-seat-orb tone-light" aria-hidden="true" />
                        <span>{t('games.white')}</span>
                      </span>
                      <div className="cozy-captured-tray">
                        {game.capturedByWhite.length === 0 ? (
                          <span className="cozy-captured-empty">—</span>
                        ) : (
                          [...game.capturedByWhite]
                            .sort((a, b) => CHESS_CAPTURE_ORDER[a] - CHESS_CAPTURE_ORDER[b])
                            .map((type, idx) => (
                              <span key={idx} className="cozy-captured-piece">
                                <ChessPieceSvg type={type} color="b" size={26} />
                              </span>
                            ))
                        )}
                      </div>
                    </div>
                    <div className="cozy-captured-row">
                      <span className="cozy-captured-label">
                        <span className="cozy-seat-orb tone-dark" aria-hidden="true" />
                        <span>{t('games.black')}</span>
                      </span>
                      <div className="cozy-captured-tray">
                        {game.capturedByBlack.length === 0 ? (
                          <span className="cozy-captured-empty">—</span>
                        ) : (
                          [...game.capturedByBlack]
                            .sort((a, b) => CHESS_CAPTURE_ORDER[a] - CHESS_CAPTURE_ORDER[b])
                            .map((type, idx) => (
                              <span key={idx} className="cozy-captured-piece">
                                <ChessPieceSvg type={type} color="w" size={26} />
                              </span>
                            ))
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="cozy-moves-log">
                    <span className="cozy-card-subtitle">{t('games.moveHistory')}</span>
                    {game.moveHistory.length === 0 ? (
                      <p className="cozy-muted-note">{t('games.noMovesYet')}</p>
                    ) : (
                      <div className="cozy-moves-list">
                        {game.moveHistory.slice(-28).map((m, idx) => (
                          <span key={idx} className={`cozy-move-pill is-${m.color}`}>
                            {m.san}
                          </span>
                        ))}
                      </div>
                    )}
                    {game.status !== 'playing' && (
                      <button type="button" className="cozy-wood-btn is-secondary cozy-pgn-export" onClick={() => { setPgnCopied(false); setPgnDialogOpen(true); }}>
                        <Download size={15} aria-hidden="true" />{t('chess.exportPgn')}
                      </button>
                    )}
                  </div>
                </div>
              }
            />

            {pendingPromotion && (
              <ModalDialog
                title={t('chess.promoteTitle')}
                subtitle={t('chess.promoteSubtitle')}
                onClose={() => setPendingPromotion(null)}
              >
                <div className="cozy-promotion-choices">
                  {([
                    { piece: 'q' as ChessPromotionPiece, label: t('chess.piece.q') },
                    { piece: 'r' as ChessPromotionPiece, label: t('chess.piece.r') },
                    { piece: 'b' as ChessPromotionPiece, label: t('chess.piece.b') },
                    { piece: 'n' as ChessPromotionPiece, label: t('chess.piece.n') },
                  ]).map(({ piece: promo, label }) => (
                    <button
                      key={promo}
                      type="button"
                      className="cozy-promotion-btn"
                      onClick={() => {
                        model.makeMove(room.id, pendingPromotion.from, pendingPromotion.to, promo);
                        setPendingPromotion(null);
                        setSelectedSquare(null);
                        clearPlanning();
                      }}
                    >
                      <ChessPieceSvg type={promo} color={pendingPromotion.color} size={48} />
                      <span>{label}</span>
                    </button>
                  ))}
                </div>
              </ModalDialog>
            )}
            {pgnDialogOpen && game.status !== 'playing' && (
              <ModalDialog
                title={t('chess.exportPgnTitle')}
                subtitle={t('chess.exportPgnSubtitle')}
                onClose={() => setPgnDialogOpen(false)}
                footer={(close) => (
                  <>
                    <button type="button" className="btn btn-secondary" onClick={() => void copyPgn(getPgn(room))}>
                      {pgnCopied ? <ClipboardCheck size={16} aria-hidden="true" /> : <Clipboard size={16} aria-hidden="true" />}
                      {pgnCopied ? t('chess.pgnCopied') : t('chess.copyPgn')}
                    </button>
                    <button type="button" className="btn btn-primary" onClick={() => { downloadPgn(room); close(); }}>
                      <Download size={16} aria-hidden="true" />{t('chess.downloadPgn')}
                    </button>
                  </>
                )}
              >
                <textarea className="text-input chess-pgn-preview" value={getPgn(room)} readOnly aria-label={t('chess.exportPgnTitle')} />
              </ModalDialog>
            )}
          </div>
        );
      }}
    </CozyBoardGameShell>
  );
};
