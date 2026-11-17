import React, { useEffect, useState } from 'react';
import { CircleDot, FlipVertical, Trophy } from 'lucide-react';
import { t } from '../i18n/index.ts';
import { useLocale } from '../hooks/useLocale.ts';
import { roomAppsService } from './room_apps_service.ts';
import type { RoomAppViewProps } from './registry.ts';
import type { CheckersModel, CheckersRoomState } from './board_game_model.ts';
import {
  getAllLegalCheckersMoves,
  getLegalCheckersMovesForSquare,
  type CheckersCandidateMove,
  type CheckersColor,
} from './checkers_engine.ts';
import {
  CheckersPieceSvg,
  CozyBoardGameShell,
  CozyRoomSidePanel,
  useBoardGamePlayers,
} from './BoardGameLobbyView.tsx';
import { TooltipButton } from '../components/common/TooltipButton.tsx';

export const CheckersApp: React.FC<RoomAppViewProps> = ({ instanceId, compact = false }) => {
  useLocale();
  const resolveActor = useBoardGamePlayers();
  const [, setTick] = useState(0);
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
  const [selectedSquare, setSelectedSquare] = useState<number | null>(null);
  const [flipOverride, setFlipOverride] = useState<boolean | null>(null);

  useEffect(() => {
    return roomAppsService.subscribe(() => setTick((n) => n + 1));
  }, []);

  const model = roomAppsService.getModel<CheckersModel>(instanceId);
  if (!model) return null;

  useEffect(() => {
    if (activeRoomId && !model.getRoom(activeRoomId)) {
      setActiveRoomId(null);
      setSelectedSquare(null);
    }
  }, [activeRoomId, model]);

  const handleSelectRoom = (nextId: string | null) => {
    if (activeRoomId && nextId === null) {
      model.leaveRoom(activeRoomId);
    }
    setActiveRoomId(nextId);
    setSelectedSquare(null);
    setFlipOverride(null);
  };

  const describeRoomStatus = (room: CheckersRoomState): string => {
    const { game } = room;
    if (game.status === 'draw' || game.winner === 'draw') {
      return t('games.statusDraw');
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
        const flipped = flipOverride !== null ? flipOverride : myColor === 'b';

        const effectiveSelected =
          game.mustContinueFrom !== null ? game.mustContinueFrom : selectedSquare;

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

        const handleSquareClick = (sqIndex: number) => {
          if (!isMyTurn) return;
          if (effectiveSelected !== null && legalTargets.has(sqIndex)) {
            model.makeMove(room.id, effectiveSelected, sqIndex);
            setSelectedSquare(null);
            return;
          }

          if (game.mustContinueFrom !== null) return;

          const clickedPiece = game.board[sqIndex];
          if (clickedPiece && clickedPiece.color === myColor && selectableOrigins.has(sqIndex)) {
            setSelectedSquare(selectedSquare === sqIndex ? null : sqIndex);
          } else {
            setSelectedSquare(null);
          }
        };

        const displaySquares: number[] = [];
        for (let r = 0; r < 8; r++) {
          for (let c = 0; c < 8; c++) {
            const actualRow = flipped ? 7 - r : r;
            const actualCol = flipped ? 7 - c : c;
            displaySquares.push(actualRow * 8 + actualCol);
          }
        }

        return (
          <div className="cozy-match-layout">
            <div className="cozy-board-stage">
              <div className="cozy-board-hud-row">
                {game.status !== 'playing' ? (
                  <div className="cozy-match-banner" role="status">
                    <Trophy size={16} aria-hidden="true" />
                    <span>{describeRoomStatus(room)}</span>
                  </div>
                ) : game.mustContinueFrom !== null ? (
                  <div className="cozy-match-banner is-highlight" role="status">
                    <span>{t('checkers.continueCapture')}</span>
                  </div>
                ) : (
                  <div />
                )}

                <TooltipButton
                  tooltip={t('games.flipBoard')}
                  aria-label={t('games.flipBoard')}
                  className="btn btn-sm btn-secondary cozy-flip-btn"
                  onClick={() => setFlipOverride(!flipped)}
                >
                  <FlipVertical size={14} />
                  <span>{t('games.flipBoard')}</span>
                </TooltipButton>
              </div>

              <div className="wood-board-frame checkers-wood-frame">
                <div className="wood-board-8x8" role="grid" aria-label={t('checkers.title')}>
                  {displaySquares.map((sqIndex, visualIdx) => {
                    const r = Math.floor(sqIndex / 8);
                    const c = sqIndex % 8;
                    const isDark = (r + c) % 2 === 1;
                    const piece = game.board[sqIndex];
                    const isSelected = effectiveSelected === sqIndex;
                    const legalMatch = legalTargets.get(sqIndex);
                    const isLegalDest = Boolean(legalMatch);
                    const isLastMove =
                      game.lastMove?.from === sqIndex || game.lastMove?.to === sqIndex;
                    const isForcedOrigin = isMyTurn && selectableOrigins.has(sqIndex) && allLegal.some((m) => m.captured !== undefined);
                    const showRank = visualIdx % 8 === 0;
                    const showFile = visualIdx >= 56;
                    const sqLabel = `${String.fromCharCode(97 + c)}${8 - r}`;

                    return (
                      <button
                        key={sqIndex}
                        type="button"
                        role="gridcell"
                        aria-label={`${sqLabel}${piece ? ` ${piece.color}${piece.king ? ' king' : ''}` : ''}`}
                        className={`wood-square ${isDark ? 'dark' : 'light'} ${
                          isSelected ? 'is-selected' : ''
                        } ${isLegalDest ? 'is-legal' : ''} ${
                          isLastMove ? 'is-last-move' : ''
                        } ${isForcedOrigin ? 'is-forced-capture' : ''}`}
                        onClick={() => handleSquareClick(sqIndex)}
                      >
                        {showRank && <span className="wood-coord-rank">{8 - r}</span>}
                        {showFile && <span className="wood-coord-file">{String.fromCharCode(97 + c)}</span>}
                        {piece && <CheckersPieceSvg color={piece.color} king={piece.king} size={38} />}
                        {isLegalDest && (
                          <span
                            className={`wood-move-dot ${legalMatch?.captured !== undefined ? 'is-capture' : ''}`}
                            aria-hidden="true"
                          />
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            <CozyRoomSidePanel
              room={room}
              model={model}
              seat1Label={t('games.lightPieces')}
              seat2Label={t('games.darkPieces')}
              seat1Score={game.scores.w}
              seat2Score={game.scores.b}
              drawsScore={game.scores.draws}
              turnSide={game.status !== 'playing' ? null : game.turn === 'w' ? 'seat1' : 'seat2'}
              onNewMatch={() => {
                model.newGame(room.id, false);
                setSelectedSquare(null);
              }}
              onResetScores={() => {
                model.newGame(room.id, true);
                setSelectedSquare(null);
              }}
              onSwapSeats={() => model.swapSides(room.id)}
              canResign={game.status === 'playing' && myColor !== null}
              onResign={() => model.resign(room.id)}
              extraContent={
                <div className="cozy-history-card">
                  <div className="cozy-captured-strip">
                    <div className="cozy-captured-row">
                      <span>{t('games.lightPieces')}:</span>
                      <strong>{t('checkers.capturedCount', { count: game.capturedByWhite })}</strong>
                    </div>
                    <div className="cozy-captured-row">
                      <span>{t('games.darkPieces')}:</span>
                      <strong>{t('checkers.capturedCount', { count: game.capturedByBlack })}</strong>
                    </div>
                  </div>

                  <div className="cozy-moves-log">
                    <span className="cozy-card-subtitle">{t('games.moveHistory')}</span>
                    {game.moveHistory.length === 0 ? (
                      <p className="cozy-muted-note">{t('games.noMovesYet')}</p>
                    ) : (
                      <div className="cozy-moves-list">
                        {game.moveHistory.slice(-24).map((m, idx) => (
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
