import React, { useState } from 'react';
import {
  ArrowLeft,
  Crown,
  Eye,
  Plus,
  RotateCcw,
  Sparkles,
  Trash2,
  Trees,
  Users,
  UserCheck,
  UserPlus,
} from 'lucide-react';
import { t } from '../i18n/index.ts';
import { useLocale } from '../hooks/useLocale.ts';
import { useRoom } from '../hooks/useRoom.ts';
import { ProfileAvatar } from '../components/common/ProfileAvatar.tsx';
import { Tooltip } from '../components/common/Tooltip.tsx';
import { TooltipButton } from '../components/common/TooltipButton.tsx';
import { ModalDialog } from '../components/common/ModalDialog.tsx';
import { Select } from '../components/common/Select.tsx';
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
  const stroke = isWhite ? '#7c5329' : '#1c1108';
  const highlight = isWhite ? 'rgba(255,255,255,0.65)' : 'rgba(255,220,175,0.22)';

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
          <stop offset="0%" stopColor="#fff8eb" />
          <stop offset="55%" stopColor="#f3dfb9" />
          <stop offset="100%" stopColor="#d9b47c" />
        </linearGradient>
        <linearGradient id="wood-piece-dark" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#6b442a" />
          <stop offset="55%" stopColor="#462916" />
          <stop offset="100%" stopColor="#29160a" />
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
  children,
}: LobbyViewProps<TGame>) {
  useLocale();
  const resolveActor = useBoardGamePlayers();
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [roomNameDraft, setRoomNameDraft] = useState('');
  const [initialRoleDraft, setInitialRoleDraft] = useState<'seat1' | 'seat2' | 'spectator'>('seat1');

  const rooms = model.rooms;
  const activeRoom = activeRoomId ? model.getRoom(activeRoomId) : undefined;

  const openCreateModal = () => {
    const nextNumber = rooms.length + 1;
    setRoomNameDraft(t('games.defaultRoomName', { number: nextNumber }));
    setInitialRoleDraft('seat1');
    setCreateDialogOpen(true);
  };

  const handleCreateRoom = (event: React.FormEvent) => {
    event.preventDefault();
    const fallbackName = t('games.defaultRoomName', { number: rooms.length + 1 });
    const createdId = model.createRoom(roomNameDraft.trim() || fallbackName, initialRoleDraft);
    if (createdId) {
      setCreateDialogOpen(false);
      onSelectRoom(createdId);
    }
  };

  const quickJoinRoom = (room: BoardGameRoomState<TGame>, preferred?: 'seat1' | 'seat2' | 'spectator') => {
    const actor = model.localActor;
    if (preferred) {
      model.joinRole(room.id, preferred);
    } else if (room.players.seat1 === actor || room.players.seat2 === actor || room.spectators.includes(actor)) {
      // Already in room, keep role
    } else if (!room.players.seat1) {
      model.joinRole(room.id, 'seat1');
    } else if (!room.players.seat2) {
      model.joinRole(room.id, 'seat2');
    } else {
      model.joinRole(room.id, 'spectator');
    }
    onSelectRoom(room.id);
  };

  if (activeRoom && children) {
    const p1 = resolveActor(activeRoom.players.seat1, model.localActor);
    const p2 = resolveActor(activeRoom.players.seat2, model.localActor);
    const myRole =
      activeRoom.players.seat1 === model.localActor
        ? 'seat1'
        : activeRoom.players.seat2 === model.localActor
          ? 'seat2'
          : 'spectator';

    return (
      <div className={`cozy-game-root kind-${kind}`}>
        <div className="cozy-garden-backdrop" aria-hidden="true">
          <span className="cozy-leaf leaf-1" />
          <span className="cozy-leaf leaf-2" />
          <span className="cozy-leaf leaf-3" />
        </div>

        <header className="cozy-room-topbar">
          <div className="cozy-room-topbar-left">
            <button
              type="button"
              className="btn btn-sm btn-secondary cozy-back-lobby-btn"
              onClick={() => onSelectRoom(null)}
            >
              <ArrowLeft size={14} />
              <span>{t('games.backToLobbies')}</span>
            </button>
            <div className="cozy-room-title-pill">
              <Trees size={15} className="cozy-garden-icon" aria-hidden="true" />
              <strong>{activeRoom.name}</strong>
              <span className="cozy-room-status-tag">{describeRoomStatus(activeRoom)}</span>
            </div>
          </div>

          <div className="cozy-role-switcher" role="group" aria-label={t('games.switchRole')}>
            <button
              type="button"
              className={`cozy-role-pill ${myRole === 'seat1' ? 'active' : ''}`}
              disabled={Boolean(activeRoom.players.seat1 && activeRoom.players.seat1 !== model.localActor)}
              onClick={() => model.joinRole(activeRoom.id, 'seat1')}
            >
              <span className="cozy-role-dot seat-1" />
              <span>{seat1Label}:</span>
              <strong>{p1 ? p1.name : t('games.openSeat')}</strong>
            </button>

            <button
              type="button"
              className={`cozy-role-pill ${myRole === 'seat2' ? 'active' : ''}`}
              disabled={Boolean(activeRoom.players.seat2 && activeRoom.players.seat2 !== model.localActor)}
              onClick={() => model.joinRole(activeRoom.id, 'seat2')}
            >
              <span className="cozy-role-dot seat-2" />
              <span>{seat2Label}:</span>
              <strong>{p2 ? p2.name : t('games.openSeat')}</strong>
            </button>

            <button
              type="button"
              className={`cozy-role-pill spectator ${myRole === 'spectator' ? 'active' : ''}`}
              onClick={() => model.joinRole(activeRoom.id, 'spectator')}
            >
              <Eye size={13} />
              <span>{t('games.spectator')}</span>
              <span className="cozy-spectator-count">{activeRoom.spectators.length}</span>
            </button>
          </div>
        </header>

        <div className="cozy-room-stage">{children(activeRoom)}</div>
      </div>
    );
  }

  return (
    <div className={`cozy-game-root is-lobby kind-${kind}`}>
      <div className="cozy-garden-backdrop" aria-hidden="true">
        <span className="cozy-leaf leaf-1" />
        <span className="cozy-leaf leaf-2" />
        <span className="cozy-leaf leaf-3" />
      </div>

      <div className="cozy-lobby-container">
        <header className="cozy-lobby-header">
          <div className="cozy-lobby-heading">
            <div className="cozy-lobby-badge">
              <Trees size={18} aria-hidden="true" />
              <span>{t('games.gardenLounge')}</span>
            </div>
            <h2>{title}</h2>
            <p>{subtitle}</p>
          </div>
          <button type="button" className="btn btn-primary cozy-create-room-btn" onClick={openCreateModal}>
            <Plus size={16} />
            <span>{t('games.createRoom')}</span>
          </button>
        </header>

        {rooms.length === 0 ? (
          <div className="cozy-lobby-empty">
            <div className="cozy-lobby-empty-emblem">
              <Sparkles size={26} />
            </div>
            <h3>{t('games.noRoomsTitle')}</h3>
            <p>{t('games.noRoomsDescription')}</p>
            <button type="button" className="btn btn-primary" onClick={openCreateModal}>
              <Plus size={16} />
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
                <article key={room.id} className="cozy-lobby-card">
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
                        onClick={() => model.deleteRoom(room.id)}
                      >
                        <Trash2 size={14} />
                      </TooltipButton>
                    )}
                  </div>

                  <div className="cozy-lobby-seats">
                    <div className={`cozy-seat-slot ${p1 ? 'occupied' : 'empty'}`}>
                      <span className="cozy-seat-badge seat-1">{seat1Label}</span>
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
                          className="cozy-seat-join-link"
                          onClick={() => quickJoinRoom(room, 'seat1')}
                        >
                          <UserPlus size={13} />
                          <span>{t('games.sitHere')}</span>
                        </button>
                      )}
                    </div>

                    <div className={`cozy-seat-slot ${p2 ? 'occupied' : 'empty'}`}>
                      <span className="cozy-seat-badge seat-2">{seat2Label}</span>
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
                          className="cozy-seat-join-link"
                          onClick={() => quickJoinRoom(room, 'seat2')}
                        >
                          <UserPlus size={13} />
                          <span>{t('games.sitHere')}</span>
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="cozy-lobby-card-footer">
                    <div className="cozy-lobby-spectators">
                      <Eye size={13} />
                      <span>
                        {t('games.spectatorsCount', { count: spectators.length })}
                      </span>
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
                        className="btn btn-sm btn-secondary"
                        onClick={() => quickJoinRoom(room, 'spectator')}
                      >
                        <Eye size={14} />
                        <span>{t('games.watch')}</span>
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
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

      {createDialogOpen && (
        <ModalDialog
          title={t('games.createRoom')}
          subtitle={t('games.createRoomSubtitle')}
          icon={<Trees size={20} />}
          onClose={() => setCreateDialogOpen(false)}
          footer={(close) => (
            <>
              <button type="button" className="btn btn-secondary" onClick={close}>
                {t('tunnels.cancel')}
              </button>
              <button type="submit" form="cozy-create-room-form" className="btn btn-primary">
                {t('games.createRoom')}
              </button>
            </>
          )}
        >
          <form id="cozy-create-room-form" className="tunnel-form" autoComplete="off" onSubmit={handleCreateRoom}>
            <label>
              {t('games.roomName')}
              <input
                type="text"
                className="text-input"
                autoComplete="off"
                autoFocus
                maxLength={48}
                value={roomNameDraft}
                onChange={(e) => setRoomNameDraft(e.target.value)}
                placeholder={t('games.roomNamePlaceholder')}
              />
            </label>
            <label>
              {t('games.initialSeat')}
              <Select
                value={initialRoleDraft}
                onValueChange={(val) => setInitialRoleDraft(val as 'seat1' | 'seat2' | 'spectator')}
                options={[
                  { value: 'seat1', label: `${t('games.player1')} (${seat1Label})` },
                  { value: 'seat2', label: `${t('games.player2')} (${seat2Label})` },
                  { value: 'spectator', label: t('games.spectator') },
                ]}
              />
            </label>
          </form>
        </ModalDialog>
      )}
    </div>
  );
}

export function CozyRoomSidePanel<TGame>({
  room,
  model,
  seat1Label,
  seat2Label,
  seat1Score,
  seat2Score,
  drawsScore,
  turnSide,
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
  onNewMatch: () => void;
  onResetScores?: () => void;
  onSwapSeats?: () => void;
  onResign?: () => void;
  canResign?: boolean;
  extraContent?: React.ReactNode;
}) {
  useLocale();
  const resolveActor = useBoardGamePlayers();
  const p1 = resolveActor(room.players.seat1, model.localActor);
  const p2 = resolveActor(room.players.seat2, model.localActor);
  const spectators = room.spectators
    .map((id) => resolveActor(id, model.localActor))
    .filter((item): item is NonNullable<typeof item> => Boolean(item));

  const isPlayerOrOwner =
    room.players.seat1 === model.localActor ||
    room.players.seat2 === model.localActor ||
    room.createdBy === model.localActor ||
    (!room.players.seat1 && !room.players.seat2);

  return (
    <aside className="cozy-side-panel">
      <div className="cozy-players-card">
        <div className={`cozy-player-row ${turnSide === 'seat1' ? 'is-turn' : ''}`}>
          <div className="cozy-player-identity">
            <span className="cozy-seat-chip seat-1">{seat1Label}</span>
            {p1 ? (
              <>
                <ProfileAvatar peerId={p1.id} name={p1.name} color={p1.color} isLocal={p1.isLocal} className="cozy-seat-avatar" />
                <div className="cozy-player-meta">
                  <strong>{p1.name}</strong>
                  {turnSide === 'seat1' && <span className="cozy-turn-indicator">{t('games.currentTurn')}</span>}
                </div>
              </>
            ) : (
              <button
                type="button"
                className="btn btn-sm btn-secondary cozy-take-seat-btn"
                onClick={() => model.joinRole(room.id, 'seat1')}
              >
                <UserPlus size={13} />
                <span>{t('games.sitHere')}</span>
              </button>
            )}
          </div>
          <span className="cozy-score-pill">{seat1Score}</span>
        </div>

        <div className={`cozy-player-row ${turnSide === 'seat2' ? 'is-turn' : ''}`}>
          <div className="cozy-player-identity">
            <span className="cozy-seat-chip seat-2">{seat2Label}</span>
            {p2 ? (
              <>
                <ProfileAvatar peerId={p2.id} name={p2.name} color={p2.color} isLocal={p2.isLocal} className="cozy-seat-avatar" />
                <div className="cozy-player-meta">
                  <strong>{p2.name}</strong>
                  {turnSide === 'seat2' && <span className="cozy-turn-indicator">{t('games.currentTurn')}</span>}
                </div>
              </>
            ) : (
              <button
                type="button"
                className="btn btn-sm btn-secondary cozy-take-seat-btn"
                onClick={() => model.joinRole(room.id, 'seat2')}
              >
                <UserPlus size={13} />
                <span>{t('games.sitHere')}</span>
              </button>
            )}
          </div>
          <span className="cozy-score-pill">{seat2Score}</span>
        </div>

        <div className="cozy-scoreboard-summary">
          <span>{t('games.draws')}: <strong>{drawsScore}</strong></span>
        </div>
      </div>

      {extraContent}

      <div className="cozy-spectators-card">
        <div className="cozy-card-subtitle">
          <Eye size={14} />
          <span>{t('games.spectatorsCount', { count: spectators.length })}</span>
        </div>
        {spectators.length === 0 ? (
          <p className="cozy-muted-note">{t('games.noSpectators')}</p>
        ) : (
          <div className="cozy-spectator-chips">
            {spectators.map((spec) => (
              <span key={spec.id} className="cozy-spectator-chip">
                <ProfileAvatar peerId={spec.id} name={spec.name} color={spec.color} isLocal={spec.isLocal} className="cozy-mini-avatar" />
                <span>{spec.name}</span>
              </span>
            ))}
          </div>
        )}
      </div>

      {isPlayerOrOwner && (
        <div className="cozy-room-controls">
          <button type="button" className="btn btn-sm btn-primary" onClick={onNewMatch}>
            <RotateCcw size={14} />
            <span>{t('games.newMatch')}</span>
          </button>
          {onSwapSeats && (
            <button type="button" className="btn btn-sm btn-secondary" onClick={onSwapSeats}>
              <Users size={14} />
              <span>{t('games.swapSides')}</span>
            </button>
          )}
          {canResign && onResign && (
            <button type="button" className="btn btn-sm btn-danger" onClick={onResign}>
              <span>{t('games.resign')}</span>
            </button>
          )}
          {onResetScores && (
            <button type="button" className="btn btn-sm btn-secondary" onClick={onResetScores}>
              <span>{t('games.resetScores')}</span>
            </button>
          )}
        </div>
      )}
    </aside>
  );
}
