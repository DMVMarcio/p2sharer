import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CircleDot } from 'lucide-react';
import { t } from '../../../i18n/index.ts';
import { useLocale } from '../../../hooks/useLocale.ts';
import { roomAppsService } from '../../room_apps_service.ts';
import type { RoomAppViewProps } from '../../registry.ts';
import type { CheckersModel, CheckersRoomState } from '../board_game_model.ts';
import {
  getAllLegalCheckersMoves,
  getLegalCheckersMovesForSquare,
  type CheckersCandidateMove,
  type CheckersColor,
  type CheckersPiece,
} from './checkers_engine.ts';
import {
  BoardUndoConsentNotification,
  CheckersPieceSvg,
  CozyBoardGameShell,
  CozyRoomSidePanel,
  useBoardGamePlayers,
  type CozyStatusTone,
} from '../BoardGameLobbyView.tsx';
import { BoardPlanningOverlay, useBoardPlanning } from '../BoardPlanningOverlay.tsx';
import { boardGameSounds } from '../board_game_sounds.ts';
import { useBoardReturnAnimation } from '../useBoardReturnAnimation.ts';
import { useTimedBoardMatch } from '../useTimedBoardMatch.ts';

interface DraggingCheckersState {
  from: number;
  piece: CheckersPiece;
  clientX: number;
  clientY: number;
  offsetX: number;
  offsetY: number;
  pieceSize: number;
  hoverSquare: number | null;
}

export const CheckersApp: React.FC<RoomAppViewProps> = ({ instanceId, compact = false }) => {
  useLocale();
  const resolveActor = useBoardGamePlayers();
  const [, setTick] = useState(0);
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
  const [selectedSquare, setSelectedSquare] = useState<number | null>(null);
  const [dragging, setDragging] = useState<DraggingCheckersState | null>(null);
  const suppressClickRef = useRef(false);
  const lastSoundSnapshotRef = useRef<{
    roomId: string;
    moves: number;
    status: string;
  } | null>(null);

  const { arrows, highlights, draftArrow, clearPlanning, startRightPlanning } = useBoardPlanning(8);

  useEffect(() => {
    return roomAppsService.subscribe(() => setTick((n) => n + 1));
  }, []);

  const model = roomAppsService.getModel<CheckersModel>(instanceId);
  if (!model) return null;

  useEffect(() => {
    if (activeRoomId && !model.getRoom(activeRoomId)) {
      setActiveRoomId(null);
      setSelectedSquare(null);
      setDragging(null);
      clearPlanning();
    }
  }, [activeRoomId, model, clearPlanning]);

  const currentRoom = activeRoomId ? model.getRoom(activeRoomId) : undefined;
  const { seat1ClockMs, seat2ClockMs, isClockRunning } = useTimedBoardMatch(model, currentRoom);

  useEffect(() => {
    if (currentRoom && currentRoom.game.status !== 'playing') {
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
      };
      return;
    }

    const movesIncreased = game.moveHistory.length > prev.moves;
    const movesDecreased = game.moveHistory.length < prev.moves;
    const statusChanged = game.status !== prev.status;

    if (movesIncreased || movesDecreased || statusChanged) {
      const lastRecord = game.moveHistory[game.moveHistory.length - 1];
      if (game.status === 'finished' || game.status === 'resigned' || game.status === 'timeout') {
        boardGameSounds.playVictory();
      } else if (game.status === 'draw') {
        boardGameSounds.playDraw();
      } else if (movesDecreased) {
        if (game.moveHistory.length > 0) {
          boardGameSounds.playMove();
        }
      } else if (movesIncreased) {
        if (lastRecord?.promoted) {
          boardGameSounds.playPromote();
        } else if (lastRecord?.captured !== undefined) {
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
    };
  }, [currentRoom?.id, currentRoom?.game.moveHistory.length, currentRoom?.game.status]);

  const { animKey: boardAnimKey, activeTransforms } = useBoardReturnAnimation({
    roomId: currentRoom?.id,
    board: currentRoom?.game.board,
    moveCount: currentRoom?.game.moveHistory.length ?? 0,
    status: currentRoom?.game.status ?? 'playing',
    flipped: currentRoom?.players.seat2 === model.localActor,
    getPieceSignature: (p) => p.color,
    isPreferentialMatch: (src, target) => src.king === target.king,
    onPieceSettle: (idx) => boardGameSounds.playSettle(idx),
  });

  const handleSelectRoom = (nextId: string | null) => {
    if (activeRoomId && nextId === null) {
      model.leaveRoom(activeRoomId);
    }
    setActiveRoomId(nextId);
    setSelectedSquare(null);
    setDragging(null);
    clearPlanning();
  };

  const describeRoomStatus = (room: CheckersRoomState): string => {
    const { game } = room;
    if (game.status === 'draw' || game.winner === 'draw') {
      return t('games.statusDraw');
    }
    if (game.status === 'timeout' && (game.winner === 'w' || game.winner === 'b')) {
      const winnerId = game.winner === 'w' ? room.players.seat1 : room.players.seat2;
      const person = resolveActor(winnerId, model.localActor);
      return person
        ? t('games.statusTimeoutWinner', { name: person.name })
        : t('games.statusTimeoutSide', { side: game.winner === 'w' ? t('games.lightPieces') : t('games.darkPieces') });
    }
    if ((game.status === 'finished' || game.status === 'resigned') && (game.winner === 'w' || game.winner === 'b')) {
      const winnerId = game.winner === 'w' ? room.players.seat1 : room.players.seat2;
      const person = resolveActor(winnerId, model.localActor);
      return person
        ? t('games.statusWinnerNamed', { name: person.name })
        : t('games.statusWinnerSide', { side: game.winner === 'w' ? t('games.lightPieces') : t('games.darkPieces') });
    }
    if (!room.players.seat1 || !room.players.seat2) {
      return t('games.statusWaitingPlayers');
    }
    const turnId = game.turn === 'w' ? room.players.seat1 : room.players.seat2;
    const person = resolveActor(turnId, model.localActor);
    return person
      ? t('games.statusTurnNamed', { name: person.name })
      : t('games.statusTurnSide', { side: game.turn === 'w' ? t('games.lightPieces') : t('games.darkPieces') });
  };

  if (compact) {
    return (
      <div className="cozy-compact-preview kind-checkers">
        <CircleDot size={28} strokeWidth={1.6} aria-hidden="true" />
        <strong>{t('checkers.title')}</strong>
        <span>{t('games.roomsActiveCount', { count: model.rooms.length })}</span>
      </div>
    );
  }

  return (
    <CozyBoardGameShell
      kind="checkers"
      title={t('checkers.title')}
      subtitle={t('checkers.description')}
      seat1Label={t('games.lightPieces')}
      seat2Label={t('games.darkPieces')}
      model={model}
      activeRoomId={activeRoomId}
      onSelectRoom={handleSelectRoom}
      describeRoomStatus={describeRoomStatus}
      renderRoomMiniPreview={(room) => (
        <div className="cozy-mini-board-badge">
          <CheckersPieceSvg color={room.game.turn} king={false} size={20} />
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
        const myColor: CheckersColor | null =
          room.players.seat1 === model.localActor
            ? 'w'
            : room.players.seat2 === model.localActor
              ? 'b'
              : null;
        const isMyTurn = game.status === 'playing' && myColor !== null && game.turn === myColor;
        const flipped = myColor === 'b';

        const effectiveSelected =
          game.mustContinueFrom !== null
            ? game.mustContinueFrom
            : dragging
              ? dragging.from
              : selectedSquare;

        const allLegal = isMyTurn ? getAllLegalCheckersMoves(game) : [];
        const selectableOrigins = new Set(allLegal.map((m) => m.from));

        const legalMoves: CheckersCandidateMove[] =
          isMyTurn && effectiveSelected !== null
            ? getLegalCheckersMovesForSquare(game, effectiveSelected)
            : [];
        const legalTargets = new Map<number, CheckersCandidateMove>();
        for (const m of legalMoves) {
          legalTargets.set(m.to, m);
        }

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

          clearPlanning();

          if (!isMyTurn || !myColor) return;

          if (effectiveSelected !== null && legalTargets.has(sqIndex)) {
            event.preventDefault();
            suppressClickRef.current = true;
            model.makeMove(room.id, effectiveSelected, sqIndex);
            setSelectedSquare(null);
            return;
          }

          if (game.mustContinueFrom !== null && game.mustContinueFrom !== sqIndex) return;

          const clickedPiece = game.board[sqIndex];
          if (!clickedPiece || clickedPiece.color !== myColor || !selectableOrigins.has(sqIndex)) {
            if (game.mustContinueFrom === null) setSelectedSquare(null);
            return;
          }

          event.preventDefault();
          const pieceEl = event.currentTarget.querySelector<HTMLElement>('.checkers-wood-token');
          const pieceRect = pieceEl?.getBoundingClientRect() ?? event.currentTarget.getBoundingClientRect();
          const centerX = pieceRect.left + pieceRect.width / 2;
          const centerY = pieceRect.top + pieceRect.height / 2;
          const offsetX = event.clientX - centerX;
          const offsetY = event.clientY - centerY;
          const pieceSize = Math.max(24, Math.round(pieceRect.width));

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
                const candidateMoves = getLegalCheckersMovesForSquare(game, sqIndex);
                if (candidateMoves.some((m) => m.to === targetSq)) {
                  model.makeMove(room.id, sqIndex, targetSq);
                  setSelectedSquare(null);
                }
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
            : game.mustContinueFrom !== null
              ? 'highlight'
              : isMyTurn
                ? 'turn'
                : 'waiting';

        const statusText =
          game.status === 'playing' && game.mustContinueFrom !== null
            ? t('checkers.continueCapture')
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
              <div className="wood-board-frame checkers-wood-frame">
                <span className="wood-frame-stud stud-tl" aria-hidden="true" />
                <span className="wood-frame-stud stud-tr" aria-hidden="true" />
                <span className="wood-frame-stud stud-bl" aria-hidden="true" />
                <span className="wood-frame-stud stud-br" aria-hidden="true" />

                <div
                  className="wood-board-8x8"
                  role="grid"
                  aria-label={t('checkers.title')}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                  }}
                >
                  {displaySquares.map((sqIndex, visualIdx) => {
                    const r = Math.floor(sqIndex / 8);
                    const c = sqIndex % 8;
                    const isDark = (r + c) % 2 === 1;
                    const piece = game.board[sqIndex];
                    const isSelected = effectiveSelected === sqIndex;
                    const legalMatch = legalTargets.get(sqIndex);
                    const isLegalDest = Boolean(legalMatch);
                    const isDragHover = dragging?.hoverSquare === sqIndex && isLegalDest;
                    const isBeingDragged = dragging?.from === sqIndex;
                    const isLastMove =
                      game.lastMove?.from === sqIndex || game.lastMove?.to === sqIndex;
                    const isForcedOrigin =
                      isMyTurn &&
                      selectableOrigins.has(sqIndex) &&
                      allLegal.some((m) => m.captured !== undefined);
                    const isDraggablePiece = Boolean(
                      isMyTurn && piece && piece.color === myColor && selectableOrigins.has(sqIndex),
                    );
                    const showRank = visualIdx % 8 === 0;
                    const showFile = visualIdx >= 56;
                    const sqLabel = `${String.fromCharCode(97 + c)}${8 - r}`;

                    return (
                      <button
                        key={sqIndex}
                        type="button"
                        role="gridcell"
                        data-board-square={sqIndex}
                        aria-label={`${sqLabel}${piece ? ` ${piece.color}${piece.king ? ' king' : ''}` : ''}`}
                        className={`wood-square ${isDark ? 'dark' : 'light'} ${
                          isSelected ? 'is-selected' : ''
                        } ${isLegalDest ? 'is-legal' : ''} ${
                          isDragHover ? 'is-drag-hover' : ''
                        } ${isLastMove ? 'is-last-move' : ''} ${
                          isForcedOrigin ? 'is-forced-capture' : ''
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
                            if (effectiveSelected !== null && legalTargets.has(sqIndex)) {
                              model.makeMove(room.id, effectiveSelected, sqIndex);
                              setSelectedSquare(null);
                            } else if (piece && piece.color === myColor && selectableOrigins.has(sqIndex)) {
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
                              <CheckersPieceSvg color={piece.color} king={piece.king} size={42} />
                            </span>
                          );
                        })()}
                        {isLegalDest && (
                          <span
                            className={`wood-move-dot ${legalMatch?.captured !== undefined ? 'is-capture' : ''}`}
                            aria-hidden="true"
                          />
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
                  <CheckersPieceSvg
                    color={dragging.piece.color}
                    king={dragging.piece.king}
                    size={dragging.pieceSize}
                  />
                </div>,
                document.body,
              )}

            <CozyRoomSidePanel
              room={room}
              model={model}
              seat1Label={t('games.lightPieces')}
              seat2Label={t('games.darkPieces')}
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
              onSwapSeats={() => {
                model.swapSides(room.id);
                clearPlanning();
              }}
              canResign={game.status === 'playing' && myColor !== null}
              onResign={() => model.resign(room.id)}
              extraContent={
                <div className="cozy-panel-card cozy-history-card">
                  <div className="cozy-captured-strip">
                    <div className="cozy-captured-row">
                      <span className="cozy-captured-label">
                        <span className="cozy-seat-orb tone-light" aria-hidden="true" />
                        <span>{t('games.lightPieces')}</span>
                        <span className="cozy-captured-count">{game.capturedByWhite}</span>
                      </span>
                      <div
                        className="cozy-captured-tray"
                        aria-label={t('checkers.capturedCount', { count: game.capturedByWhite })}
                      >
                        {game.capturedByWhite === 0 ? (
                          <span className="cozy-captured-empty">—</span>
                        ) : (
                          Array.from({ length: game.capturedByWhite }).map((_, idx) => (
                            <span key={idx} className="cozy-captured-piece is-checker">
                              <CheckersPieceSvg color="b" king={false} size={20} />
                            </span>
                          ))
                        )}
                      </div>
                    </div>
                    <div className="cozy-captured-row">
                      <span className="cozy-captured-label">
                        <span className="cozy-seat-orb tone-dark" aria-hidden="true" />
                        <span>{t('games.darkPieces')}</span>
                        <span className="cozy-captured-count">{game.capturedByBlack}</span>
                      </span>
                      <div
                        className="cozy-captured-tray"
                        aria-label={t('checkers.capturedCount', { count: game.capturedByBlack })}
                      >
                        {game.capturedByBlack === 0 ? (
                          <span className="cozy-captured-empty">—</span>
                        ) : (
                          Array.from({ length: game.capturedByBlack }).map((_, idx) => (
                            <span key={idx} className="cozy-captured-piece is-checker">
                              <CheckersPieceSvg color="w" king={false} size={20} />
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
                            {m.notation}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              }
            />
          </div>
        );
      }}
    </CozyBoardGameShell>
  );
};
