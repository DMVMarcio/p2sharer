import React, { useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowLeftRight,
  Check,
  Clock,
  Crown,
  Eraser,
  Eye,
  Flag,
  Grid3x3,
  LockKeyhole,
  Play,
  Plus,
  RotateCcw,
  ShieldAlert,
  Sparkles,
  Trash2,
  Trophy,
  Undo2,
  Users,
  UserCheck,
  X,
} from 'lucide-react';
import { t } from '../i18n/index.ts';
import { useLocale } from '../hooks/useLocale.ts';
import { useRoom } from '../hooks/useRoom.ts';
import { useDropdownPresence } from '../hooks/useDropdownPresence.ts';
import { ProfileAvatar } from '../components/common/ProfileAvatar.tsx';
import { Select, type SelectOption } from '../components/common/Select.tsx';
import { Tooltip } from '../components/common/Tooltip.tsx';
import { TooltipButton } from '../components/common/TooltipButton.tsx';
import { ModalDialog } from '../components/common/ModalDialog.tsx';
import { ContentTransition } from '../components/common/ContentTransition.tsx';
import { boardGameSounds } from './board_game_sounds.ts';
import {
  formatBoardClockTime,
  TIME_LIMIT_OPTIONS_MINUTES,
  type BoardUndoRequest,
} from './board_game_timing.ts';
import type { BoardGameKind, BoardGameLobbyModel, BoardGameRoomState } from './board_game_model.ts';
import type { ChessColor, ChessPieceType } from './chess_engine.ts';

export function ChessPieceSvg({
  type,
  color,
  size = 36,
}: {
  type: ChessPieceType;
  color: ChessColor;
  size?: number;
}) {
  const isWhite = color === 'w';
  const fill = isWhite ? 'url(#wood-piece-light)' : 'url(#wood-piece-dark)';
  const stroke = isWhite ? '#744b23' : '#1b0f06';
  const highlight = isWhite ? 'rgba(255,255,255,0.75)' : 'rgba(255,222,179,0.26)';

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 45 45"
      className={`board-svg-piece is-${color}`}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="wood-piece-light" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#fffaf0" />
          <stop offset="50%" stopColor="#f5e1bc" />
          <stop offset="100%" stopColor="#d8af72" />
        </linearGradient>
        <linearGradient id="wood-piece-dark" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#72482c" />
          <stop offset="52%" stopColor="#492a15" />
          <stop offset="100%" stopColor="#261408" />
        </linearGradient>
      </defs>
      {type === 'p' && (
        <g fill={fill} stroke={stroke} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M 22.5,9 C 19.5,9 17,11.5 17,14.5 C 17,16.8 18.4,18.7 20.4,19.5 C 17.5,21.2 15.5,24.5 15.5,29 L 29.5,29 C 29.5,24.5 27.5,21.2 24.6,19.5 C 26.6,18.7 28,16.8 28,14.5 C 28,11.5 25.5,9 22.5,9 z" />
          <path d="M 12.5,37 L 32.5,37 C 32.5,33.5 30,31 27,31 L 18,31 C 15,31 12.5,33.5 12.5,37 z" />
          <circle cx="21" cy="13" r="1.5" fill={highlight} stroke="none" />
        </g>
      )}
      {type === 'r' && (
        <g fill={fill} stroke={stroke} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M 9,39 L 36,39 L 36,36 L 9,36 L 9,39 z" />
          <path d="M 12,36 L 12,32 L 33,32 L 33,36 L 12,36 z" />
          <path d="M 14,29.5 L 14,16.5 L 31,16.5 L 31,29.5 L 14,29.5 z" />
          <path d="M 14,16.5 L 11,14 L 34,14 L 31,16.5 L 14,16.5 z" />
          <path d="M 11,14 L 11,9 L 15,9 L 15,11 L 20,11 L 20,9 L 25,9 L 25,11 L 30,11 L 30,9 L 34,9 L 34,14" />
          <path d="M 12,32 L 14,29.5 L 31,29.5 L 33,32 L 12,32 z" />
        </g>
      )}
      {type === 'n' && (
        <g fill={fill} stroke={stroke} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M 22,10 C 32.5,11 38.5,18 38,39 L 15,39 C 15,30 25,32.5 23,18" />
          <path d="M 24,18 C 24.38,20.91 18.45,25.37 16,27 C 13,29 13.18,31.34 11,31 C 9.958,30.06 12.41,27.96 11,28 C 10,28 11.19,29.23 10,30 C 9,30 5.997,31 6,26 C 6,24 12,14 12,14 C 12,14 13.89,12.1 14,10.5 C 13.27,9.506 13.5,8.5 13.5,7.5 C 14.5,6.5 16.5,10 16.5,10 L 18.5,10 C 18.5,10 19.28,8.008 21,7 C 22,7 22,10 22,10" />
          <circle cx="15.5" cy="14.5" r="1.2" fill={stroke} />
        </g>
      )}
      {type === 'b' && (
        <g fill={fill} stroke={stroke} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M 9,36 C 12.39,35.03 19.11,36.43 22.5,34 C 25.89,36.43 32.61,35.03 36,36 C 36,36 37.65,36.54 39,38 C 38.32,38.97 37.35,38.99 36,38.5 C 32.61,37.53 25.89,38.96 22.5,37.5 C 19.11,38.96 12.39,37.53 9,38.5 C 7.646,38.99 6.677,38.97 6,38 C 7.354,36.06 9,36 9,36 z" />
          <path d="M 15,32 C 17.5,34.5 27.5,34.5 30,32 C 30.5,30.5 30,30 30,30 C 30,27.5 27.5,26 27.5,26 C 33,24.5 33.5,14.5 22.5,10.5 C 11.5,14.5 12,24.5 17.5,26 C 17.5,26 15,27.5 15,30 C 15,30 14.5,30.5 15,32 z" />
          <circle cx="22.5" cy="8" r="2.2" />
          <path d="M 17.5,26 L 27.5,26 M 15,30 L 30,30 M 22.5,15.5 L 22.5,20.5 M 20,18 L 25,18" />
        </g>
      )}
      {type === 'q' && (
        <g fill={fill} stroke={stroke} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M 9,26 C 17.5,24.5 30,24.5 36,26 L 38.5,13.5 L 31,25 L 30.7,10.9 L 25.5,24.5 L 22.5,10 L 19.5,24.5 L 14.3,10.9 L 14,25 L 6.5,13.5 L 9,26 z" />
          <path d="M 9,26 C 9,28 10.5,28 11.5,30 C 12.5,31.5 12.5,31 12,33.5 C 10.5,34.5 11,36 11,36 C 9.5,37.5 11,38.5 11,38.5 C 17.5,39.5 27.5,39.5 34,38.5 C 34,38.5 35.5,37.5 34,36 C 34,36 34.5,34.5 33,33.5 C 32.5,31 32.5,31.5 33.5,30 C 34.5,28 36,28 36,26 C 27.5,24.5 17.5,24.5 9,26 z" />
          <circle cx="6" cy="12" r="1.8" />
          <circle cx="14" cy="9" r="1.8" />
          <circle cx="22.5" cy="8" r="1.8" />
          <circle cx="31" cy="9" r="1.8" />
          <circle cx="39" cy="12" r="1.8" />
        </g>
      )}
      {type === 'k' && (
        <g fill={fill} stroke={stroke} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M 22.5,11.63 L 22.5,6" />
          <path d="M 20,8 L 25,8" />
          <path d="M 22.5,25 C 22.5,25 27,17.5 25.5,14.5 C 25.5,14.5 24.5,12 22.5,12 C 20.5,12 19.5,14.5 19.5,14.5 C 18,17.5 22.5,25 22.5,25" />
          <path d="M 11.5,37 C 17,40.5 27,40.5 32.5,37 L 32.5,30 C 32.5,30 41.5,25.5 38.5,19.5 C 34.5,13 25,16 22.5,23.5 L 22.5,27 L 22.5,23.5 C 19,16 9.5,13 6.5,19.5 C 3.5,25.5 11.5,29.5 11.5,29.5 L 11.5,37 z" />
          <path d="M 11.5,30 C 17,27 27,27 32.5,30" />
          <path d="M 11.5,33.5 C 17,30.5 27,30.5 32.5,33.5" />
          <path d="M 11.5,37 C 17,34 27,34 32.5,37" />
        </g>
      )}
    </svg>
  );
}

export function CheckersPieceSvg({
  color,
  king,
  size = 38,
}: {
  color: 'w' | 'b';
  king: boolean;
  size?: number;
}) {
  const isWhite = color === 'w';
  return (
    <div className={`checkers-wood-token is-${color} ${king ? 'is-king' : ''}`} style={{ width: size, height: size }}>
      <div className="checkers-wood-token-ring">
        {king && <Crown size={Math.round(size * 0.45)} strokeWidth={2.2} className="checkers-king-crown" aria-hidden="true" />}
        {!king && <span className={`checkers-wood-token-inner ${isWhite ? 'light' : 'dark'}`} />}
      </div>
    </div>
  );
}

export function TicTacToePieceSvg({
  side,
  size = 44,
}: {
  side: 'X' | 'O';
  size?: number;
}) {
  if (side === 'X') {
    return (
      <svg width={size} height={size} viewBox="0 0 48 48" className="ttt-svg-piece is-x" aria-hidden="true">
        <path
          d="M12 12 L36 36 M36 12 L12 36"
          stroke="currentColor"
          strokeWidth="6.5"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" className="ttt-svg-piece is-o" aria-hidden="true">
      <circle
        cx="24"
        cy="24"
        r="13.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="6.5"
      />
    </svg>
  );
}

export function useBoardGamePlayers() {
  const { username, peers, roomSlots } = useRoom();
  return (actorId: string | null | undefined, localActor: string) => {
    if (!actorId) return null;
    const isLocal = actorId === localActor;
    const peer = peers.find((entry) => entry.id === actorId);
    const slot = roomSlots.find((entry) => (isLocal ? entry.isLocal : entry.peerId === actorId));
    return {
      id: actorId,
      name: isLocal ? username || t('message.b21e91730d18') : peer?.username || t('message.1e97ddf60a0f'),
      color: slot?.color || 'var(--accent-color)',
      isLocal,
    };
  };
}

function GameKindCrest({ kind }: { kind: BoardGameKind }) {
  if (kind === 'chess') return <ChessPieceSvg type="n" color="w" size={32} />;
  if (kind === 'checkers') return <CheckersPieceSvg color="w" king size={30} />;
  return <Grid3x3 size={26} strokeWidth={2} />;
}

interface LobbyViewProps<TGame> {
  kind: BoardGameKind;
  title: string;
  subtitle: string;
  seat1Label: string;
  seat2Label: string;
  model: BoardGameLobbyModel<TGame>;
  activeRoomId: string | null;
  onSelectRoom: (roomId: string | null) => void;
  describeRoomStatus: (room: BoardGameRoomState<TGame>) => string;
  renderRoomMiniPreview?: (room: BoardGameRoomState<TGame>) => React.ReactNode;
  renderRoomOverlay?: (room: BoardGameRoomState<TGame>) => React.ReactNode;
  children?: (room: BoardGameRoomState<TGame>) => React.ReactNode;
}

export function CozyBoardGameShell<TGame>({
  kind,
  title,
  subtitle,
  seat1Label,
  seat2Label,
  model,
  activeRoomId,
  onSelectRoom,
  describeRoomStatus,
  renderRoomMiniPreview,
  renderRoomOverlay,
  children,
}: LobbyViewProps<TGame>) {
  useLocale();
  const resolveActor = useBoardGamePlayers();
  const [deletingRoom, setDeletingRoom] = useState<BoardGameRoomState<TGame> | null>(null);

  const rooms = model.rooms;
  const activeRoom = activeRoomId ? model.getRoom(activeRoomId) : undefined;
  const screenKey = activeRoom && children ? `room:${activeRoom.id}` : 'lobby';

  const navigateToRoom = (roomId: string | null) => {
    if (roomId && roomId !== activeRoomId) {
      boardGameSounds.playRoomEnter();
    } else if (!roomId && activeRoomId) {
      boardGameSounds.playRoomLeave();
    }
    onSelectRoom(roomId);
  };

  const createTableImmediately = () => {
    const usedNumbers = new Set<number>();
    for (const r of rooms) {
      const match = r.name.match(/(\d+)/);
      if (match) usedNumbers.add(Number(match[1]));
    }
    let nextNumber = 1;
    while (usedNumbers.has(nextNumber)) nextNumber++;

    const tableName = t('games.defaultRoomName', { number: nextNumber });
    const createdId = model.createRoom(tableName, 'seat1');
    if (createdId) {
      navigateToRoom(createdId);
    }
  };

  const quickJoinRoom = (room: BoardGameRoomState<TGame>, preferred?: 'seat1' | 'seat2' | 'spectator') => {
    const actor = model.localActor;
    if (preferred) {
      model.joinRole(room.id, preferred);
    } else if (room.players.seat1 === actor || room.players.seat2 === actor || room.spectators.includes(actor)) {
      // Keep current seat or spectator role
    } else if (!room.players.seat1) {
      model.joinRole(room.id, 'seat1');
    } else if (!room.players.seat2) {
      model.joinRole(room.id, 'seat2');
    } else {
      model.joinRole(room.id, 'spectator');
    }
    navigateToRoom(room.id);
  };

  return (
    <div className={`cozy-game-root ${activeRoom ? 'is-match' : 'is-lobby'} kind-${kind}`}>
      <div className="cozy-garden-scenery" aria-hidden="true">
        <span className="cozy-grass-vignette" />
        <span className="cozy-sunbeam beam-1" />
        <span className="cozy-sunbeam beam-2" />
      </div>

      <ContentTransition value={screenKey} className="content-transition-fill cozy-screen-transition">
        {(currentScreen) => {
          const isRoomView = currentScreen.startsWith('room:');
          const roomObj = isRoomView ? model.getRoom(currentScreen.slice(5)) : undefined;

          if (isRoomView && roomObj && children) {
            const roomSpectators = roomObj.spectators
              .map((id) => resolveActor(id, model.localActor))
              .filter((item): item is NonNullable<typeof item> => Boolean(item));

            return (
              <div className="cozy-screen-inner">
                <header className="cozy-room-topbar">
                  <div className="cozy-room-topbar-left">
                    <button
                      type="button"
                      className="cozy-wood-topbar-btn"
                      onClick={() => navigateToRoom(null)}
                    >
                      <ArrowLeft size={14} />
                      <span>{t('games.backToLobbies')}</span>
                    </button>
                    <div className="cozy-room-title-plaque">
                      <span className="cozy-plaque-rivet" aria-hidden="true" />
                      <strong>{roomObj.name}</strong>
                      <span className="cozy-plaque-rivet" aria-hidden="true" />
                    </div>
                  </div>

                  <div className="cozy-header-spectators" aria-label={t('games.spectators')}>
                    <span className="cozy-header-spectators-label">
                      <Eye size={13} aria-hidden="true" />
                      <span>{t('games.spectators')}</span>
                    </span>
                    <div className="cozy-header-spectators-list">
                      {roomSpectators.length === 0 ? (
                        <span className="cozy-header-spectators-empty">—</span>
                      ) : (
                        roomSpectators.map((spec) => (
                          <Tooltip key={spec.id} content={spec.name} placement="bottom">
                            <ProfileAvatar
                              peerId={spec.id}
                              name={spec.name}
                              color={spec.color}
                              isLocal={spec.isLocal}
                              tabIndex={0}
                              className="cozy-header-spectator-avatar"
                            />
                          </Tooltip>
                        ))
                      )}
                    </div>
                  </div>
                </header>

                <div className="cozy-room-stage">{children(roomObj)}</div>
                {renderRoomOverlay?.(roomObj)}
              </div>
            );
          }

          return (
            <div className="cozy-lobby-container">
              <header className="cozy-wood-signboard">
                <div className="cozy-signboard-nail nail-tl" aria-hidden="true" />
                <div className="cozy-signboard-nail nail-tr" aria-hidden="true" />
                <div className="cozy-signboard-nail nail-bl" aria-hidden="true" />
                <div className="cozy-signboard-nail nail-br" aria-hidden="true" />

                <div className="cozy-signboard-identity">
                  <div className="cozy-signboard-crest" aria-hidden="true">
                    <GameKindCrest kind={kind} />
                  </div>
                  <div className="cozy-lobby-heading">
                    <h2>{title}</h2>
                    <p>{subtitle}</p>
                  </div>
                </div>

                <button type="button" className="cozy-wood-cta-btn" onClick={createTableImmediately}>
                  <Plus size={16} strokeWidth={2.4} />
                  <span>{t('games.createRoom')}</span>
                </button>
              </header>

              {rooms.length === 0 ? (
                <div className="cozy-lobby-empty">
                  <div className="cozy-empty-board-illustration" aria-hidden="true">
                    <div className="cozy-mini-checkerboard">
                      {Array.from({ length: 16 }).map((_, idx) => (
                        <span key={idx} className={(Math.floor(idx / 4) + (idx % 4)) % 2 === 1 ? 'dark' : 'light'} />
                      ))}
                    </div>
                    <div className="cozy-empty-crest-overlay">
                      <GameKindCrest kind={kind} />
                    </div>
                  </div>
                  <h3>{t('games.noRoomsTitle')}</h3>
                  <p>{t('games.noRoomsDescription')}</p>
                  <button type="button" className="cozy-wood-cta-btn" onClick={createTableImmediately}>
                    <Plus size={16} strokeWidth={2.4} />
                    <span>{t('games.createFirstRoom')}</span>
                  </button>
                </div>
              ) : (
                <div className="cozy-lobby-grid">
                  {rooms.map((room) => {
                    const p1 = resolveActor(room.players.seat1, model.localActor);
                    const p2 = resolveActor(room.players.seat2, model.localActor);
                    const spectators = room.spectators
                      .map((id) => resolveActor(id, model.localActor))
                      .filter((item): item is NonNullable<typeof item> => Boolean(item));
                    const canDelete =
                      room.createdBy === model.localActor ||
                      (!room.players.seat1 && !room.players.seat2 && room.spectators.length === 0);

                    return (
                      <article key={room.id} className="cozy-table-card">
                        <div className="cozy-table-card-stud stud-l" aria-hidden="true" />
                        <div className="cozy-table-card-stud stud-r" aria-hidden="true" />

                        <div className="cozy-lobby-card-top">
                          <div className="cozy-lobby-card-titles">
                            <h3>{room.name}</h3>
                            <span className="cozy-lobby-card-status">{describeRoomStatus(room)}</span>
                          </div>
                          {renderRoomMiniPreview && (
                            <div className="cozy-lobby-mini-preview" aria-hidden="true">
                              {renderRoomMiniPreview(room)}
                            </div>
                          )}
                          {canDelete && (
                            <TooltipButton
                              tooltip={t('games.deleteRoom')}
                              aria-label={t('games.deleteRoom')}
                              className="cozy-icon-btn danger"
                              onClick={() => setDeletingRoom(room)}
                            >
                              <Trash2 size={14} />
                            </TooltipButton>
                          )}
                        </div>

                        <div className="cozy-lobby-seats">
                          <div className={`cozy-seat-slot is-seat-1 ${p1 ? 'occupied' : 'empty'}`}>
                            <span className="cozy-seat-badge seat-1">
                              <span className={`cozy-seat-orb ${kind === 'tictactoe' ? 'tone-x' : 'tone-light'}`} aria-hidden="true" />
                              <span>{seat1Label}</span>
                            </span>
                            {p1 ? (
                              <div className="cozy-seat-player">
                                <ProfileAvatar
                                  peerId={p1.id}
                                  name={p1.name}
                                  color={p1.color}
                                  isLocal={p1.isLocal}
                                  className="cozy-seat-avatar"
                                />
                                <strong>{p1.name}</strong>
                              </div>
                            ) : (
                              <button
                                type="button"
                                className="cozy-seat-play-btn"
                                onClick={() => quickJoinRoom(room, 'seat1')}
                              >
                                <Play size={12} />
                                <span>{t('games.play')}</span>
                              </button>
                            )}
                          </div>

                          <div className={`cozy-seat-slot is-seat-2 ${p2 ? 'occupied' : 'empty'}`}>
                            <span className="cozy-seat-badge seat-2">
                              <span className={`cozy-seat-orb ${kind === 'tictactoe' ? 'tone-o' : 'tone-dark'}`} aria-hidden="true" />
                              <span>{seat2Label}</span>
                            </span>
                            {p2 ? (
                              <div className="cozy-seat-player">
                                <ProfileAvatar
                                  peerId={p2.id}
                                  name={p2.name}
                                  color={p2.color}
                                  isLocal={p2.isLocal}
                                  className="cozy-seat-avatar"
                                />
                                <strong>{p2.name}</strong>
                              </div>
                            ) : (
                              <button
                                type="button"
                                className="cozy-seat-play-btn"
                                onClick={() => quickJoinRoom(room, 'seat2')}
                              >
                                <Play size={12} />
                                <span>{t('games.play')}</span>
                              </button>
                            )}
                          </div>
                        </div>

                        <div className="cozy-lobby-card-footer">
                          <div className="cozy-lobby-spectators">
                            <Eye size={13} />
                            <span>{t('games.spectatorsCount', { count: spectators.length })}</span>
                            {spectators.slice(0, 4).map((spec) => (
                              <Tooltip key={spec.id} content={spec.name}>
                                <ProfileAvatar
                                  peerId={spec.id}
                                  name={spec.name}
                                  color={spec.color}
                                  isLocal={spec.isLocal}
                                  className="cozy-mini-avatar"
                                />
                              </Tooltip>
                            ))}
                          </div>

                          <div className="cozy-lobby-actions">
                            <button
                              type="button"
                              className="cozy-wood-ghost-btn"
                              onClick={() => quickJoinRoom(room, 'spectator')}
                            >
                              <Eye size={14} />
                              <span>{t('games.watch')}</span>
                            </button>
                            <button
                              type="button"
                              className="cozy-wood-join-btn"
                              onClick={() => quickJoinRoom(room)}
                            >
                              {!p1 || !p2 || p1.isLocal || p2.isLocal ? <UserCheck size={14} /> : <Users size={14} />}
                              <span>{!p1 || !p2 || p1.isLocal || p2.isLocal ? t('games.play') : t('games.enterRoom')}</span>
                            </button>
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </div>
          );
        }}
      </ContentTransition>

      {deletingRoom && (
        <ModalDialog
          title={t('games.deleteRoom')}
          onClose={() => setDeletingRoom(null)}
          footer={(close) => (
            <>
              <button type="button" className="btn btn-secondary" onClick={close}>
                {t('tunnels.cancel')}
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => {
                  model.deleteRoom(deletingRoom.id);
                  setDeletingRoom(null);
                }}
              >
                {t('games.deleteRoom')}
              </button>
            </>
          )}
        >
          <p>{t('games.confirmDeleteRoom', { name: deletingRoom.name })}</p>
        </ModalDialog>
      )}
    </div>
  );
}

export function BoardUndoConsentNotification<TGame>({
  room,
  model,
  undoRequest,
  isPlaying,
  onRespond,
}: {
  room: BoardGameRoomState<TGame>;
  model: BoardGameLobbyModel<TGame>;
  undoRequest: BoardUndoRequest | null | undefined;
  isPlaying: boolean;
  onRespond: (accept: boolean) => void;
}) {
  useLocale();
  const resolveActor = useBoardGamePlayers();
  const myColor =
    room.players.seat1 === model.localActor
      ? 'w'
      : room.players.seat2 === model.localActor
        ? 'b'
        : null;
  const isForMe = Boolean(isPlaying && myColor && undoRequest && undoRequest.requester !== myColor);
  const requesterId =
    undoRequest?.requester === 'w'
      ? room.players.seat1
      : undoRequest?.requester === 'b'
        ? room.players.seat2
        : null;
  const requester = resolveActor(requesterId, model.localActor);
  const activeKey =
    isForMe && undoRequest
      ? `${room.id}:${undoRequest.moveCount}:${undoRequest.requester}`
      : null;
  const presence = useDropdownPresence(activeKey);
  const lastNameRef = useRef('');
  if (isForMe) {
    lastNameRef.current = requester?.name || t('games.opponent');
  }

  if (!presence.value) return null;

  const requesterName = lastNameRef.current || t('games.opponent');

  return (
    <div
      className={`cozy-undo-toast ${presence.closing ? 'is-closing' : ''}`}
      role="status"
      aria-live="polite"
      aria-label={t('games.undoRequestTitle')}
      inert={presence.closing}
      aria-hidden={presence.closing || undefined}
    >
      <div className="cozy-undo-toast-body">
        <span className="cozy-undo-toast-icon" aria-hidden="true">
          <Undo2 size={15} />
        </span>
        <div className="cozy-undo-toast-copy">
          <strong>{t('games.undoRequestTitle')}</strong>
          <span>{t('games.undoRequestPrompt', { name: requesterName })}</span>
        </div>
      </div>
      <div className="cozy-undo-toast-actions">
        <button
          type="button"
          disabled={presence.closing}
          className="cozy-wood-btn is-primary"
          onClick={() => onRespond(true)}
        >
          <Check size={13} aria-hidden="true" />
          <span>{t('games.accept')}</span>
        </button>
        <button
          type="button"
          disabled={presence.closing}
          className="cozy-wood-btn is-danger"
          onClick={() => onRespond(false)}
        >
          <X size={13} aria-hidden="true" />
          <span>{t('games.decline')}</span>
        </button>
      </div>
    </div>
  );
}

export type CozyStatusTone = 'victory' | 'warning' | 'highlight' | 'turn' | 'waiting';

export function CozyRoomSidePanel<TGame>({
  room,
  model,
  seat1Label,
  seat2Label,
  seat1Score,
  seat2Score,
  drawsScore,
  turnSide,
  statusText,
  statusTone = 'waiting',
  seat1OrbTone = 'light',
  seat2OrbTone = 'dark',
  seat1ClockMs,
  seat2ClockMs,
  isClockRunning = false,
  timeLimitMs,
  canConfigureTimeLimit = false,
  onChangeTimeLimit,
  undoState,
  onNewMatch,
  onResetScores,
  onSwapSeats,
  onResign,
  canResign,
  extraContent,
}: {
  room: BoardGameRoomState<TGame>;
  model: BoardGameLobbyModel<TGame>;
  seat1Label: string;
  seat2Label: string;
  seat1Score: number;
  seat2Score: number;
  drawsScore: number;
  turnSide: 'seat1' | 'seat2' | null;
  statusText: string;
  statusTone?: CozyStatusTone;
  seat1OrbTone?: 'light' | 'x';
  seat2OrbTone?: 'dark' | 'o';
  seat1ClockMs?: number | null;
  seat2ClockMs?: number | null;
  isClockRunning?: boolean;
  timeLimitMs?: number | null;
  canConfigureTimeLimit?: boolean;
  onChangeTimeLimit?: (limitMs: number | null) => void;
  undoState?: {
    canRequest: boolean;
    isPending: boolean;
    onRequest: () => void;
  };
  onNewMatch: () => void;
  onResetScores?: () => void;
  onSwapSeats?: () => void;
  onResign?: () => void;
  canResign?: boolean;
  extraContent?: React.ReactNode;
}) {
  useLocale();
  const resolveActor = useBoardGamePlayers();
  const [confirmAction, setConfirmAction] = useState<'newMatch' | 'resetScores' | 'resign' | null>(null);

  const p1 = resolveActor(room.players.seat1, model.localActor);
  const p2 = resolveActor(room.players.seat2, model.localActor);

  const isPlayerOrOwner =
    room.players.seat1 === model.localActor ||
    room.players.seat2 === model.localActor ||
    room.createdBy === model.localActor ||
    (!room.players.seat1 && !room.players.seat2);

  const isGameOngoing = turnSide !== null;

  const selectedMinutes =
    timeLimitMs && timeLimitMs > 0 ? Math.round(timeLimitMs / 60_000) : 0;
  const timeLimitOptions: SelectOption[] = TIME_LIMIT_OPTIONS_MINUTES.map((minutes) => ({
    value: String(minutes),
    label: minutes === 0 ? t('games.timeNoLimit') : t('games.timeMinutes', { count: minutes }),
  }));

  const StatusIcon =
    statusTone === 'victory'
      ? Trophy
      : statusTone === 'warning'
        ? ShieldAlert
        : statusTone === 'highlight'
          ? Sparkles
          : Clock;

  const renderSeatCard = (
    seat: 'seat1' | 'seat2',
    label: string,
    orbTone: 'light' | 'dark' | 'x' | 'o',
    player: ReturnType<typeof resolveActor>,
    score: number,
    clockMs: number | null | undefined,
  ) => {
    const isTurn = turnSide === seat;
    const clockActive = isTurn && isClockRunning;
    const clockExpired = clockMs !== null && clockMs !== undefined && clockMs <= 0;
    const clockCritical = clockMs !== null && clockMs !== undefined && clockMs > 0 && clockMs <= 10_000;
    const clockLow = clockMs !== null && clockMs !== undefined && clockMs > 10_000 && clockMs <= 30_000;

    const seatSublabel = isTurn
      ? player?.isLocal
        ? t('games.currentTurn')
        : t('games.turnActive')
      : player
        ? t('games.waitingTurn')
        : t('games.openSeat');

    return (
      <div className={`cozy-seat-card is-${seat} ${isTurn ? 'is-turn' : ''} ${player ? 'is-occupied' : 'is-open'}`}>
        <div className="cozy-seat-card-header">
          <div className="cozy-seat-card-side">
            <span className={`cozy-seat-orb tone-${orbTone}`} aria-hidden="true" />
            <span className="cozy-seat-side-name">{label}</span>
          </div>
          <div className="cozy-seat-header-badges">
            {clockMs !== null && clockMs !== undefined && (
              <span
                className={`cozy-clock-pill ${clockActive ? 'is-running' : ''} ${
                  clockExpired ? 'is-expired' : clockCritical ? 'is-critical' : clockLow ? 'is-low' : ''
                }`}
                aria-label={`${label}: ${formatBoardClockTime(clockMs)}`}
              >
                <Clock size={11} aria-hidden="true" />
                <span>{formatBoardClockTime(clockMs)}</span>
              </span>
            )}
            <span className="cozy-score-pill">{score}</span>
          </div>
        </div>

        <div className="cozy-seat-card-body">
          {player ? (
            <div className="cozy-seat-occupied-row">
              <div className="cozy-seat-player">
                <ProfileAvatar
                  peerId={player.id}
                  name={player.name}
                  color={player.color}
                  isLocal={player.isLocal}
                  className="cozy-seat-avatar"
                />
                <strong>{player.name}</strong>
              </div>
              <span className={`cozy-seat-status-tag ${isTurn ? 'is-active' : ''}`}>{seatSublabel}</span>
            </div>
          ) : (
            <div className="cozy-seat-open-row">
              {room.lockedBy && room.lockedBy !== model.localActor ? (
                <span className="cozy-seat-open-label is-locked">
                  <LockKeyhole size={11} aria-hidden="true" />
                  {t('games.roomLocked')}
                </span>
              ) : (
                <>
                  <span className="cozy-seat-open-label">{t('games.openSeat')}</span>
                  <button
                    type="button"
                    className="cozy-wood-seat-btn"
                    onClick={() => model.joinRole(room.id, seat)}
                  >
                    <Play size={11} />
                    <span>{t('games.play')}</span>
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <aside className="cozy-side-panel">
      {/* Unified Fixed-Height Match Status Plaque */}
      <div className={`cozy-status-plaque tone-${statusTone}`} role="status">
        <span className="cozy-status-plaque-icon" aria-hidden="true">
          <StatusIcon size={16} />
        </span>
        <span className="cozy-status-plaque-text">{statusText}</span>
      </div>

      {/* Distinct Highlighted Seat Cards */}
      <div className="cozy-seats-stack">
        {renderSeatCard('seat1', seat1Label, seat1OrbTone, p1, seat1Score, seat1ClockMs)}
        {renderSeatCard('seat2', seat2Label, seat2OrbTone, p2, seat2Score, seat2ClockMs)}
        <div className="cozy-draws-bar">
          <span>{t('games.draws')}</span>
          <strong>{drawsScore}</strong>
        </div>
      </div>

      {onChangeTimeLimit && (
        <div className="cozy-panel-card cozy-time-control-card">
          <div className="cozy-time-control-row">
            <span className="cozy-card-subtitle">
              <Clock size={12} aria-hidden="true" />
              <span>{t('games.timePerPlayer')}</span>
            </span>
            <Select
              value={String(selectedMinutes)}
              options={timeLimitOptions}
              disabled={!isPlayerOrOwner || !canConfigureTimeLimit}
              aria-label={t('games.timePerPlayer')}
              className="cozy-time-select"
              onValueChange={(value) => {
                const minutes = Number(value);
                onChangeTimeLimit(minutes > 0 ? minutes * 60_000 : null);
              }}
            />
          </div>
        </div>
      )}

      {extraContent}

      {/* Handcrafted Wooden Control Deck */}
      {isPlayerOrOwner && (
        <div className="cozy-panel-card cozy-control-deck">
          <button
            type="button"
            className="cozy-wood-btn is-primary is-full"
            onClick={() => (isGameOngoing ? setConfirmAction('newMatch') : onNewMatch())}
          >
            <RotateCcw size={14} />
            <span>{t('games.newMatch')}</span>
          </button>

          {undoState && (
            <button
              type="button"
              className="cozy-wood-btn is-secondary is-full"
              disabled={!undoState.canRequest}
              onClick={undoState.onRequest}
            >
              <Undo2 size={14} />
              <span>{undoState.isPending ? t('games.undoPending') : t('games.undoMove')}</span>
            </button>
          )}

          <div className="cozy-control-deck-row">
            {onSwapSeats && (
              <TooltipButton
                tooltip={t('games.swapSides')}
                aria-label={t('games.swapSides')}
                className="cozy-wood-btn is-secondary"
                onClick={onSwapSeats}
              >
                <ArrowLeftRight size={14} />
                <span>{t('games.swapSides')}</span>
              </TooltipButton>
            )}
            {onResetScores && (
              <TooltipButton
                tooltip={t('games.resetScores')}
                aria-label={t('games.resetScores')}
                className="cozy-wood-btn is-secondary"
                onClick={() => setConfirmAction('resetScores')}
              >
                <Eraser size={14} />
                <span>{t('games.resetScores')}</span>
              </TooltipButton>
            )}
          </div>

          {canResign && onResign && (
            <button
              type="button"
              className="cozy-wood-btn is-danger is-full"
              onClick={() => setConfirmAction('resign')}
            >
              <Flag size={13} />
              <span>{t('games.resign')}</span>
            </button>
          )}
        </div>
      )}

      {confirmAction && (
        <ModalDialog
          title={
            confirmAction === 'resign'
              ? t('games.resign')
              : confirmAction === 'resetScores'
                ? t('games.resetScores')
                : t('games.newMatch')
          }
          onClose={() => setConfirmAction(null)}
          footer={(close) => (
            <>
              <button type="button" className="btn btn-secondary" onClick={close}>
                {t('tunnels.cancel')}
              </button>
              <button
                type="button"
                className={confirmAction === 'resign' ? 'btn btn-danger' : 'btn btn-primary'}
                onClick={() => {
                  const action = confirmAction;
                  setConfirmAction(null);
                  if (action === 'resign') onResign?.();
                  else if (action === 'resetScores') onResetScores?.();
                  else onNewMatch();
                }}
              >
                {confirmAction === 'resign'
                  ? t('games.resign')
                  : confirmAction === 'resetScores'
                    ? t('games.resetScores')
                    : t('games.newMatch')}
              </button>
            </>
          )}
        >
          <p>
            {confirmAction === 'resign'
              ? t('games.confirmResign')
              : confirmAction === 'resetScores'
                ? t('games.confirmResetScores')
                : t('games.confirmNewMatch')}
          </p>
        </ModalDialog>
      )}
    </aside>
  );
}
