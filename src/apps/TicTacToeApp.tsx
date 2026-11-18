import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Grid3x3 } from 'lucide-react';
import { t } from '../i18n/index.ts';
import { useLocale } from '../hooks/useLocale.ts';
import { roomAppsService } from './room_apps_service.ts';
import type { RoomAppViewProps } from './registry.ts';
import type { TicTacToeModel, TicTacToeRoomState } from './board_game_model.ts';
import type { TicTacToeSide } from './tictactoe_engine.ts';
import {
  CozyBoardGameShell,
  CozyRoomSidePanel,
  TicTacToePieceSvg,
  useBoardGamePlayers,
  type CozyStatusTone,
} from './BoardGameLobbyView.tsx';
import { BoardPlanningOverlay, useBoardPlanning } from './BoardPlanningOverlay.tsx';
import { boardGameSounds } from './board_game_sounds.ts';

export const TicTacToeApp: React.FC<RoomAppViewProps> = ({ instanceId, compact = false }) => {
  useLocale();
  const resolveActor = useBoardGamePlayers();
  const [, setTick] = useState(0);
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
  const [draggingToken, setDraggingToken] = useState<{
    side: TicTacToeSide;
    clientX: number;
    clientY: number;
    offsetX: number;
    offsetY: number;
    pieceSize: number;
    hoverCell: number | null;
  } | null>(null);

  const lastSoundSnapshotRef = useRef<{
    roomId: string;
    moves: number;
    winner: string | null;
  } | null>(null);

  const { arrows, highlights, draftArrow, clearPlanning, startRightPlanning } = useBoardPlanning(3);

  useEffect(() => {
    return roomAppsService.subscribe(() => setTick((n) => n + 1));
  }, []);

  const model = roomAppsService.getModel<TicTacToeModel>(instanceId);
  if (!model) return null;

  useEffect(() => {
    if (activeRoomId && !model.getRoom(activeRoomId)) {
      setActiveRoomId(null);
      setDraggingToken(null);
      clearPlanning();
    }
  }, [activeRoomId, model, clearPlanning]);

  const currentRoom = activeRoomId ? model.getRoom(activeRoomId) : undefined;
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
        moves: game.moveCount,
        winner: game.winner,
      };
      return;
    }

    if (game.moveCount > prev.moves || game.winner !== prev.winner) {
      if (game.winner === 'X' || game.winner === 'O') {
        boardGameSounds.playVictory();
      } else if (game.winner === 'draw') {
        boardGameSounds.playDraw();
      } else if (game.moveCount > prev.moves) {
        boardGameSounds.playMove();
      }
    }

    lastSoundSnapshotRef.current = {
      roomId: currentRoom.id,
      moves: game.moveCount,
      winner: game.winner,
    };
  }, [currentRoom?.id, currentRoom?.game.moveCount, currentRoom?.game.winner]);

  const handleSelectRoom = (nextId: string | null) => {
    if (activeRoomId && nextId === null) {
      model.leaveRoom(activeRoomId);
    }
    setActiveRoomId(nextId);
    setDraggingToken(null);
    clearPlanning();
  };

  const describeRoomStatus = (room: TicTacToeRoomState): string => {
    const { game } = room;
    if (game.winner === 'draw') return t('games.statusDraw');
    if (game.winner === 'X' || game.winner === 'O') {
      const winnerId = game.winner === 'X' ? room.players.seat1 : room.players.seat2;
      const person = resolveActor(winnerId, model.localActor);
      return person ? t('games.statusWinnerNamed', { name: person.name }) : t('games.statusWinnerSide', { side: game.winner });
    }
    if (!room.players.seat1 || !room.players.seat2) {
      return t('games.statusWaitingPlayers');
    }
    const turnId = game.turn === 'X' ? room.players.seat1 : room.players.seat2;
    const person = resolveActor(turnId, model.localActor);
    return person ? t('games.statusTurnNamed', { name: person.name }) : t('games.statusTurnSide', { side: game.turn });
  };

  if (compact) {
    return (
      <div className="cozy-compact-preview kind-tictactoe">
        <Grid3x3 size={28} strokeWidth={1.6} aria-hidden="true" />
        <strong>{t('tictactoe.title')}</strong>
        <span>{t('games.roomsActiveCount', { count: model.rooms.length })}</span>
      </div>
    );
  }

  return (
    <CozyBoardGameShell
      kind="tictactoe"
      title={t('tictactoe.title')}
      subtitle={t('tictactoe.description')}
      seat1Label="X"
      seat2Label="O"
      model={model}
      activeRoomId={activeRoomId}
      onSelectRoom={handleSelectRoom}
      describeRoomStatus={describeRoomStatus}
      renderRoomMiniPreview={(room) => (
        <div className="cozy-mini-ttt-grid">
          {room.game.board.map((cell, idx) => (
            <span key={idx} className={`cozy-mini-ttt-cell ${cell ? `is-${cell.toLowerCase()}` : ''}`}>
              {cell}
            </span>
          ))}
        </div>
      )}
    >
      {(room) => {
        const { game } = room;
        const mySide: TicTacToeSide | null =
          room.players.seat1 === model.localActor
            ? 'X'
            : room.players.seat2 === model.localActor
              ? 'O'
              : null;
        const myTurn = game.winner === null && mySide !== null && game.turn === mySide;
        const winSet = new Set(game.winningLine ?? []);

        const resolveCellAtPoint = (clientX: number, clientY: number): number | null => {
          const el = document.elementFromPoint(clientX, clientY);
          const cellBtn = el?.closest<HTMLElement>('[data-ttt-cell]');
          if (!cellBtn) return null;
          const idx = Number(cellBtn.dataset.tttCell);
          return Number.isInteger(idx) && idx >= 0 && idx < 9 ? idx : null;
        };

        const startTokenDrag = (event: React.PointerEvent<HTMLElement>) => {
          if (event.button !== 0 || !myTurn || !mySide) return;
          event.preventDefault();
          const side = mySide;
          const pieceEl = event.currentTarget.querySelector<HTMLElement>('.ttt-svg-piece');
          const pieceRect = pieceEl?.getBoundingClientRect() ?? event.currentTarget.getBoundingClientRect();
          const centerX = pieceRect.left + pieceRect.width / 2;
          const centerY = pieceRect.top + pieceRect.height / 2;
          const offsetX = event.clientX - centerX;
          const offsetY = event.clientY - centerY;
          const pieceSize = Math.max(32, Math.round(pieceRect.width));

          setDraggingToken({
            side,
            clientX: event.clientX,
            clientY: event.clientY,
            offsetX,
            offsetY,
            pieceSize,
            hoverCell: resolveCellAtPoint(event.clientX, event.clientY),
          });

          const onPointerMove = (moveEvent: PointerEvent) => {
            setDraggingToken({
              side,
              clientX: moveEvent.clientX,
              clientY: moveEvent.clientY,
              offsetX,
              offsetY,
              pieceSize,
              hoverCell: resolveCellAtPoint(moveEvent.clientX, moveEvent.clientY),
            });
          };

          const onPointerUp = (upEvent: PointerEvent) => {
            window.removeEventListener('pointermove', onPointerMove);
            window.removeEventListener('pointerup', onPointerUp);
            window.removeEventListener('pointercancel', onPointerUp);
            const targetCell = resolveCellAtPoint(upEvent.clientX, upEvent.clientY);
            setDraggingToken(null);
            if (targetCell !== null && game.board[targetCell] === null) {
              model.makeMove(room.id, targetCell);
            }
          };

          window.addEventListener('pointermove', onPointerMove);
          window.addEventListener('pointerup', onPointerUp);
          window.addEventListener('pointercancel', onPointerUp);
        };

        const statusTone: CozyStatusTone =
          game.winner !== null ? 'victory' : myTurn ? 'turn' : 'waiting';

        return (
          <div className="cozy-match-layout">
            <div className="cozy-board-stage">
              <div className="wood-board-frame ttt-wood-frame">
                <span className="wood-frame-stud stud-tl" aria-hidden="true" />
                <span className="wood-frame-stud stud-tr" aria-hidden="true" />
                <span className="wood-frame-stud stud-bl" aria-hidden="true" />
                <span className="wood-frame-stud stud-br" aria-hidden="true" />

                <div
                  className="ttt-wood-grid"
                  role="grid"
                  aria-label={t('tictactoe.title')}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                  }}
                >
                  {game.board.map((cell, index) => {
                    const isWinning = winSet.has(index);
                    const isLast = game.lastMove === index;
                    const canClick = myTurn && cell === null;
                    const isDragHover = draggingToken?.hoverCell === index && canClick;

                    return (
                      <button
                        key={index}
                        type="button"
                        role="gridcell"
                        data-ttt-cell={index}
                        data-board-square={index}
                        aria-label={`${t('games.cell')} ${index + 1}${cell ? `: ${cell}` : ''}`}
                        aria-disabled={!canClick}
                        className={`ttt-wood-cell ${cell ? 'occupied' : ''} ${canClick ? 'playable' : ''} ${
                          isWinning ? 'is-winning' : ''
                        } ${isLast ? 'is-last-move' : ''} ${isDragHover ? 'is-drag-hover' : ''}`}
                        onPointerDown={(e) => {
                          if (e.button === 2) {
                            startRightPlanning(e, index);
                          } else if (e.button === 0) {
                            clearPlanning();
                          }
                        }}
                        onClick={() => {
                          if (canClick) {
                            model.makeMove(room.id, index);
                            clearPlanning();
                          }
                        }}
                      >
                        {cell && <TicTacToePieceSvg side={cell} size={64} />}
                      </button>
                    );
                  })}

                  <BoardPlanningOverlay
                    gridSize={3}
                    flipped={false}
                    arrows={arrows}
                    highlights={highlights}
                    draftArrow={draftArrow}
                  />
                </div>
              </div>
            </div>

            {draggingToken &&
              createPortal(
                <div
                  className="board-drag-ghost"
                  style={{
                    left: `${draggingToken.clientX - draggingToken.offsetX}px`,
                    top: `${draggingToken.clientY - draggingToken.offsetY}px`,
                    width: `${draggingToken.pieceSize}px`,
                    height: `${draggingToken.pieceSize}px`,
                  }}
                  aria-hidden="true"
                >
                  <TicTacToePieceSvg side={draggingToken.side} size={draggingToken.pieceSize} />
                </div>,
                document.body,
              )}

            <CozyRoomSidePanel
              room={room}
              model={model}
              seat1Label="X"
              seat2Label="O"
              seat1Score={game.scores.X}
              seat2Score={game.scores.O}
              drawsScore={game.scores.draws}
              turnSide={game.winner ? null : game.turn === 'X' ? 'seat1' : 'seat2'}
              statusText={describeRoomStatus(room)}
              statusTone={statusTone}
              onNewMatch={() => model.newRound(room.id, false)}
              onResetScores={() => model.newRound(room.id, true)}
              extraContent={
                mySide && (
                  <div className="cozy-panel-card ttt-token-tray-card">
                    <div
                      className={`ttt-draggable-token-well ${myTurn ? 'is-ready' : 'is-waiting'}`}
                      onPointerDown={startTokenDrag}
                    >
                      <TicTacToePieceSvg side={mySide} size={36} />
                      <span>{myTurn ? t('games.currentTurn') : describeRoomStatus(room)}</span>
                    </div>
                  </div>
                )
              }
            />
          </div>
        );
      }}
    </CozyBoardGameShell>
  );
};
