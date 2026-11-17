import React, { useEffect, useState } from 'react';
import { Crown, FlipVertical, ShieldAlert, Trophy } from 'lucide-react';
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
  type ChessPromotionPiece,
} from './chess_engine.ts';
import {
  ChessPieceSvg,
  CozyBoardGameShell,
  CozyRoomSidePanel,
  useBoardGamePlayers,
} from './BoardGameLobbyView.tsx';
import { ModalDialog } from '../components/common/ModalDialog.tsx';
import { TooltipButton } from '../components/common/TooltipButton.tsx';

export const ChessApp: React.FC<RoomAppViewProps> = ({ instanceId, compact = false }) => {
  useLocale();
  const resolveActor = useBoardGamePlayers();
  const [, setTick] = useState(0);
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
  const [selectedSquare, setSelectedSquare] = useState<number | null>(null);
  const [pendingPromotion, setPendingPromotion] = useState<{ from: number; to: number; color: ChessColor } | null>(null);
  const [flipOverride, setFlipOverride] = useState<boolean | null>(null);

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
    }
  }, [activeRoomId, model]);

  const handleSelectRoom = (nextId: string | null) => {
    if (activeRoomId && nextId === null) {
      model.leaveRoom(activeRoomId);
    }
    setActiveRoomId(nextId);
    setSelectedSquare(null);
    setPendingPromotion(null);
    setFlipOverride(null);
  };

  const describeRoomStatus = (room: ChessRoomState): string => {
    const { game } = room;
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
    >
      {(room) => {
        const { game } = room;
        const myColor: ChessColor | null =
          room.players.seat1 === model.localActor
            ? 'w'
            : room.players.seat2 === model.localActor
              ? 'b'
              : null;
        const isMyTurn = game.status === 'playing' && myColor !== null && game.turn === myColor;
        const flipped = flipOverride !== null ? flipOverride : myColor === 'b';

        const legalMoves: ChessCandidateMove[] =
          isMyTurn && selectedSquare !== null ? getLegalChessMovesForSquare(game, selectedSquare) : [];
        const legalTargets = new Map<number, ChessCandidateMove[]>();
        for (const m of legalMoves) {
          const existing = legalTargets.get(m.to) ?? [];
          existing.push(m);
          legalTargets.set(m.to, existing);
        }

        const checkedKingSquare = game.inCheck ? findKingSquare(game.board, game.turn) : -1;

        const handleSquareClick = (sqIndex: number) => {
          if (!isMyTurn) return;
          const matches = legalTargets.get(sqIndex);
          if (selectedSquare !== null && matches && matches.length > 0) {
            if (matches.some((m) => m.promotion)) {
              setPendingPromotion({ from: selectedSquare, to: sqIndex, color: myColor });
            } else {
              model.makeMove(room.id, selectedSquare, sqIndex);
              setSelectedSquare(null);
            }
            return;
          }

          const clickedPiece = game.board[sqIndex];
          if (clickedPiece && clickedPiece.color === myColor) {
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
                ) : game.inCheck ? (
                  <div className="cozy-match-banner is-warning" role="status">
                    <ShieldAlert size={16} aria-hidden="true" />
                    <span>{t('chess.checkAlert')}</span>
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

              <div className="wood-board-frame chess-wood-frame">
                <div className="wood-board-8x8" role="grid" aria-label={t('chess.title')}>
                  {displaySquares.map((sqIndex, visualIdx) => {
                    const r = rowOf(sqIndex);
                    const c = colOf(sqIndex);
                    const isDark = (r + c) % 2 === 1;
                    const piece = game.board[sqIndex];
                    const isSelected = selectedSquare === sqIndex;
                    const isLegalDest = legalTargets.has(sqIndex);
                    const isLastMove =
                      game.lastMove?.from === sqIndex || game.lastMove?.to === sqIndex;
                    const isKingCheck = checkedKingSquare === sqIndex;
                    const showRank = visualIdx % 8 === 0;
                    const showFile = visualIdx >= 56;

                    return (
                      <button
                        key={sqIndex}
                        type="button"
                        role="gridcell"
                        aria-label={`${squareName(sqIndex)}${piece ? ` ${piece.color} ${piece.type}` : ''}`}
                        className={`wood-square ${isDark ? 'dark' : 'light'} ${
                          isSelected ? 'is-selected' : ''
                        } ${isLegalDest ? 'is-legal' : ''} ${
                          isLastMove ? 'is-last-move' : ''
                        } ${isKingCheck ? 'is-king-check' : ''}`}
                        onClick={() => handleSquareClick(sqIndex)}
                      >
                        {showRank && <span className="wood-coord-rank">{8 - r}</span>}
                        {showFile && <span className="wood-coord-file">{String.fromCharCode(97 + c)}</span>}
                        {piece && <ChessPieceSvg type={piece.type} color={piece.color} size={42} />}
                        {isLegalDest && (
                          <span className={`wood-move-dot ${piece ? 'is-capture' : ''}`} aria-hidden="true" />
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
              seat1Label={t('games.white')}
              seat2Label={t('games.black')}
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
                      <span>{t('games.white')}:</span>
                      <div className="cozy-captured-icons">
                        {game.capturedByWhite.map((type, idx) => (
                          <ChessPieceSvg key={idx} type={type} color="b" size={18} />
                        ))}
                      </div>
                    </div>
                    <div className="cozy-captured-row">
                      <span>{t('games.black')}:</span>
                      <div className="cozy-captured-icons">
                        {game.capturedByBlack.map((type, idx) => (
                          <ChessPieceSvg key={idx} type={type} color="w" size={18} />
                        ))}
                      </div>
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
                            {m.san}
                          </span>
                        ))}
                      </div>
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
                      }}
                    >
                      <ChessPieceSvg type={promo} color={pendingPromotion.color} size={48} />
                      <span>{label}</span>
                    </button>
                  ))}
                </div>
              </ModalDialog>
            )}
          </div>
        );
      }}
    </CozyBoardGameShell>
  );
};
