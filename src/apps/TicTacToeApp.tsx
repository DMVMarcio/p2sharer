import React, { useEffect, useState } from 'react';
import { Grid3x3, Trophy } from 'lucide-react';
import { t } from '../i18n/index.ts';
import { useLocale } from '../hooks/useLocale.ts';
import { roomAppsService } from './room_apps_service.ts';
import type { RoomAppViewProps } from './registry.ts';
import type { TicTacToeModel, TicTacToeRoomState } from './board_game_model.ts';
import {
  CozyBoardGameShell,
  CozyRoomSidePanel,
  TicTacToePieceSvg,
  useBoardGamePlayers,
} from './BoardGameLobbyView.tsx';

export const TicTacToeApp: React.FC<RoomAppViewProps> = ({ instanceId, compact = false }) => {
  useLocale();
  const resolveActor = useBoardGamePlayers();
  const [, setTick] = useState(0);
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);

  useEffect(() => {
    return roomAppsService.subscribe(() => setTick((n) => n + 1));
  }, []);

  const model = roomAppsService.getModel<TicTacToeModel>(instanceId);
  if (!model) return null;

  useEffect(() => {
    if (activeRoomId && !model.getRoom(activeRoomId)) {
      setActiveRoomId(null);
    }
  }, [activeRoomId, model]);

  const handleSelectRoom = (nextId: string | null) => {
    if (activeRoomId && nextId === null) {
      model.leaveRoom(activeRoomId);
    }
    setActiveRoomId(nextId);
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
        const myTurn =
          game.winner === null &&
          ((game.turn === 'X' && room.players.seat1 === model.localActor) ||
            (game.turn === 'O' && room.players.seat2 === model.localActor));
        const winSet = new Set(game.winningLine ?? []);

        return (
          <div className="cozy-match-layout">
            <div className="cozy-board-stage">
              {game.winner && (
                <div className="cozy-match-banner" role="status">
                  <Trophy size={16} aria-hidden="true" />
                  <span>{describeRoomStatus(room)}</span>
                </div>
              )}

              <div className="wood-board-frame ttt-wood-frame">
                <div className="ttt-wood-grid" role="grid" aria-label={t('tictactoe.title')}>
                  {game.board.map((cell, index) => {
                    const isWinning = winSet.has(index);
                    const isLast = game.lastMove === index;
                    const canClick = myTurn && cell === null;

                    return (
                      <button
                        key={index}
                        type="button"
                        role="gridcell"
                        aria-label={`${t('games.cell')} ${index + 1}${cell ? `: ${cell}` : ''}`}
                        disabled={!canClick}
                        className={`ttt-wood-cell ${cell ? 'occupied' : ''} ${canClick ? 'playable' : ''} ${
                          isWinning ? 'is-winning' : ''
                        } ${isLast ? 'is-last-move' : ''}`}
                        onClick={() => model.makeMove(room.id, index)}
                      >
                        {cell && <TicTacToePieceSvg side={cell} size={56} />}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            <CozyRoomSidePanel
              room={room}
              model={model}
              seat1Label="X"
              seat2Label="O"
              seat1Score={game.scores.X}
              seat2Score={game.scores.O}
              drawsScore={game.scores.draws}
              turnSide={game.winner ? null : game.turn === 'X' ? 'seat1' : 'seat2'}
              onNewMatch={() => model.newRound(room.id, false)}
              onResetScores={() => model.newRound(room.id, true)}
            />
          </div>
        );
      }}
    </CozyBoardGameShell>
  );
};
