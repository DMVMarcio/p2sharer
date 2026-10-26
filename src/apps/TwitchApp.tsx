import { t } from '../i18n/index.ts';
import { useLocale } from '../hooks/useLocale';
import { useElementFullscreen } from '../hooks/useElementFullscreen';
import React, { useEffect, useRef, useState } from 'react';
import { SiTwitch } from 'react-icons/si';
import {
  Expand,
  Maximize,
  MessageSquare,
  MessageSquareOff,
  Minimize,
  Minimize2,
  Pause,
  Play,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { roomAppsService } from './room_apps_service';
import { TwitchModel } from './models.ts';
import type { TwitchState } from './types.ts';
import {
  buildTwitchChatUrl,
  buildTwitchPlayerUrl,
  createTwitchPlayer,
  loadTwitchPlayerScript,
  parseTwitchChannel,
  type TwitchPlayerInstance,
} from './twitch_player';
import { describeTwitchActivity } from './twitch_activity';
import { TooltipButton } from '../components/common/TooltipButton';
import { ActivityToast } from '../components/common/ActivityToast';
import { useRoom } from '../hooks/useRoom';
import { type ActivityParticipant } from '../components/common/ActivityParticipants';

interface Props {
  instanceId: string;
  compact?: boolean;
}

const VOLUME_STORAGE = 'p2sharer_twitch_volume';
const CHAT_STORAGE = 'p2sharer_twitch_chat';

export const TwitchApp: React.FC<Props> = ({ instanceId, compact = false }) => {
  useLocale();
  const { ref: fullscreenRef, fullscreen, toggleFullscreen } = useElementFullscreen<HTMLDivElement>();
  const { username, peers, roomSlots } = useRoom();

  const [state, setState] = useState<TwitchState>(() => {
    return roomAppsService.getModel<TwitchModel>(instanceId)?.state || {
      channel: '',
      playing: true,
      updatedAt: 0,
    };
  });

  const [channelInput, setChannelInput] = useState('');
  const [theater, setTheater] = useState(false);
  const [chatOpen, setChatOpen] = useState(() => {
    const saved = localStorage.getItem(CHAT_STORAGE);
    return saved === null ? true : saved === 'true';
  });
  const [volume, setVolume] = useState(() => {
    const stored = localStorage.getItem(VOLUME_STORAGE);
    const saved = stored === null ? NaN : Number(stored);
    return Number.isFinite(saved) && saved >= 0 && saved <= 100 ? saved : 80;
  });
  const [muted, setMuted] = useState(false);
  const [isLive, setIsLive] = useState(false);
  const [playerReady, setPlayerReady] = useState(false);
  const [playerLoadFailed, setPlayerLoadFailed] = useState(false);
  const [activity, setActivity] = useState<{ id: number; actor: string; message: string } | null>(null);

  const mountRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<TwitchPlayerInstance | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const previousStateRef = useRef(state);
  const activityIdRef = useRef(0);
  const suppressBroadcastRef = useRef(false);

  // Subscribe to room model changes
  useEffect(() => {
    return roomAppsService.subscribe(() => {
      const model = roomAppsService.getModel<TwitchModel>(instanceId);
      const next = model?.state;
      if (!next || next === previousStateRef.current) return;

      const message = describeTwitchActivity(previousStateRef.current, next);
      previousStateRef.current = next;

      if (!model.lastChangeWasSnapshot && message && model.actor) {
        setActivity({
          id: ++activityIdRef.current,
          actor: model.actor,
          message,
        });
      }

      setState(next);
    });
  }, [instanceId]);

  // Sync player playback with state
  useEffect(() => {
    const player = playerRef.current;
    if (!player || !playerReady) return;

    if (state.channel && player.getChannel() !== state.channel) {
      player.setChannel(state.channel);
    }

    if (state.playing && player.isPaused()) {
      suppressBroadcastRef.current = true;
      player.play();
      setTimeout(() => { suppressBroadcastRef.current = false; }, 300);
    } else if (!state.playing && !player.isPaused()) {
      suppressBroadcastRef.current = true;
      player.pause();
      setTimeout(() => { suppressBroadcastRef.current = false; }, 300);
    }
  }, [state.channel, state.playing, playerReady]);

  // Mount Twitch Player when channel exists
  useEffect(() => {
    if (!state.channel || !mountRef.current) {
      if (playerRef.current) {
        playerRef.current = null;
        setPlayerReady(false);
      }
      setPlayerLoadFailed(false);
      return;
    }

    let disposed = false;
    setPlayerLoadFailed(false);

    loadTwitchPlayerScript()
      .then(() => {
        if (disposed || !mountRef.current) return;

        mountRef.current.innerHTML = '';

        const player = createTwitchPlayer(mountRef.current, {
          channel: state.channel,
          autoplay: state.playing,
          muted,
          onReady: () => {
            if (disposed) return;
            setPlayerReady(true);
            player.setVolume(muted ? 0 : volume / 100);
            if (state.playing) player.play();
            else player.pause();
          },
          onOnline: () => {
            if (!disposed) setIsLive(true);
          },
          onOffline: () => {
            if (!disposed) setIsLive(false);
          },
          onPlay: () => {
            if (disposed || suppressBroadcastRef.current) return;
            if (!stateRef.current.playing) {
              publish({ ...stateRef.current, playing: true }, 'playback');
            }
          },
          onPause: () => {
            if (disposed || suppressBroadcastRef.current) return;
            if (stateRef.current.playing) {
              publish({ ...stateRef.current, playing: false }, 'playback');
            }
          },
        });

        playerRef.current = player;
      })
      .catch((err: unknown) => {
        console.warn('Twitch SDK load failed, falling back to direct iframe:', err);
        if (!disposed) {
          setPlayerLoadFailed(true);
        }
      });

    return () => {
      disposed = true;
      if (mountRef.current) mountRef.current.innerHTML = '';
      playerRef.current = null;
      setPlayerReady(false);
    };
  }, [state.channel]);

  // Handle theater mode Escape key
  useEffect(() => {
    if (!theater) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setTheater(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [theater]);

  function publish(next: Omit<TwitchState, 'updatedAt'>, syncReason: NonNullable<TwitchState['syncReason']> = 'channel') {
    const fullState: TwitchState = { ...next, updatedAt: Date.now(), syncReason };
    stateRef.current = fullState;
    const model = roomAppsService.getModel<TwitchModel>(instanceId);
    model?.update(fullState);
    if (model) {
      stateRef.current = model.state;
      setState(model.state);
    } else {
      setState(fullState);
    }
  }

  function handleSelectChannel(target: string) {
    const parsed = parseTwitchChannel(target);
    if (!parsed) return;
    setChannelInput('');
    publish({ channel: parsed, playing: true }, 'channel');
  }

  function handleSubmitChannel(event: React.FormEvent) {
    event.preventDefault();
    if (!channelInput.trim()) return;
    handleSelectChannel(channelInput);
  }

  function handleTogglePlay() {
    publish({ ...state, playing: !state.playing }, 'playback');
  }

  function handleVolumeChange(nextVolume: number) {
    setVolume(nextVolume);
    setMuted(false);
    localStorage.setItem(VOLUME_STORAGE, String(nextVolume));
    if (playerRef.current) {
      playerRef.current.setMuted(false);
      playerRef.current.setVolume(nextVolume / 100);
    }
  }

  function handleToggleMute() {
    const nextMuted = !muted;
    setMuted(nextMuted);
    if (playerRef.current) {
      playerRef.current.setMuted(nextMuted);
      if (!nextMuted) playerRef.current.setVolume(volume / 100);
    }
  }

  function handleToggleChat() {
    const nextChat = !chatOpen;
    setChatOpen(nextChat);
    localStorage.setItem(CHAT_STORAGE, String(nextChat));
  }

  const personFor = (actor: string): ActivityParticipant => {
    const local = actor === roomAppsService.getLocalActor();
    const peer = peers.find((entry) => entry.id === actor);
    const slot = roomSlots.find((entry) => (local ? entry.isLocal : entry.peerId === actor));
    return {
      id: actor,
      name: local ? username || t('message.b21e91730d18') : peer?.username || t('message.1e97ddf60a0f'),
      color: slot?.color || 'var(--accent-color)',
    };
  };

  const showChatPane = Boolean(state.channel) && chatOpen && !theater && !compact;

  return (
    <div
      ref={fullscreenRef}
      className={`room-app-twitch ${theater ? 'is-theater' : ''} ${compact ? 'compact' : ''}`}
      tabIndex={0}
    >
      {/* Header bar */}
      <div className="twitch-header">
        <div className="twitch-channel-info">
          <SiTwitch size={20} className="twitch-brand-icon" aria-hidden="true" />
          <div className="twitch-channel-heading">
            <h3 className="twitch-channel-name" title={state.channel || 'Twitch'}>
              {state.channel ? state.channel : t('twitch.title')}
            </h3>
            {state.channel && (
              isLive ? (
                <span className="twitch-badge-live">
                  <span className="twitch-live-dot" aria-hidden="true" />
                  {t('twitch.live')}
                </span>
              ) : (
                <span className="twitch-badge-offline">{t('twitch.offline')}</span>
              )
            )}
          </div>
        </div>

        {/* Tune to channel form */}
        <form className="twitch-form" onSubmit={handleSubmitChannel} autoComplete="off">
          <input
            autoComplete="off"
            type="text"
            className="twitch-input"
            value={channelInput}
            onChange={(e) => setChannelInput(e.target.value)}
            placeholder={t('twitch.placeholder')}
            aria-label={t('twitch.placeholder')}
          />
          <button
            type="submit"
            className="twitch-tune-btn"
            disabled={!channelInput.trim()}
          >
            {t('twitch.tune')}
          </button>
        </form>

        {/* Action buttons */}
        <div className="twitch-header-actions">
          {state.channel && (
            <TooltipButton
              tooltip={state.playing ? t('twitch.pause') : t('twitch.play')}
              className="twitch-btn"
              onClick={handleTogglePlay}
            >
              {state.playing ? <Pause size={17} strokeWidth={2.2} /> : <Play size={17} strokeWidth={2.2} />}
            </TooltipButton>
          )}

          {/* Volume */}
          <div className="twitch-volume-wrapper">
            <TooltipButton
              tooltip={muted || volume === 0 ? t('twitch.unmute') : t('twitch.mute')}
              className="twitch-btn"
              onClick={handleToggleMute}
            >
              {muted || volume === 0 ? <VolumeX size={17} /> : <Volume2 size={17} />}
            </TooltipButton>
            <input
              autoComplete="off"
              type="range"
              min="0"
              max="100"
              value={muted ? 0 : volume}
              onChange={(e) => handleVolumeChange(Number(e.target.value))}
              className="twitch-volume-slider"
              aria-label="Volume"
            />
          </div>

          {/* Chat toggle */}
          {state.channel && (
            <TooltipButton
              tooltip={chatOpen ? t('twitch.hideChat') : t('twitch.showChat')}
              className={`twitch-btn ${chatOpen ? 'active' : ''}`}
              onClick={handleToggleChat}
            >
              {chatOpen ? <MessageSquare size={17} /> : <MessageSquareOff size={17} />}
            </TooltipButton>
          )}

          {/* Theater mode */}
          {state.channel && (
            <TooltipButton
              tooltip={theater ? t('twitch.exitTheater') : t('twitch.theater')}
              className={`twitch-btn ${theater ? 'active' : ''}`}
              onClick={() => setTheater((prev) => !prev)}
            >
              {theater ? <Minimize2 size={17} /> : <Expand size={17} />}
            </TooltipButton>
          )}

          {/* Fullscreen */}
          <TooltipButton
            tooltip={fullscreen ? t('browser.exitFullscreen') : t('browser.fullscreen')}
            className="twitch-btn"
            onClick={toggleFullscreen}
          >
            {fullscreen ? <Minimize size={17} /> : <Maximize size={17} />}
          </TooltipButton>
        </div>
      </div>

      {/* Main content pane */}
      <div className="twitch-content">
        <div className="twitch-player-pane">
          {state.channel ? (
            <div className="twitch-player-wrapper">
              {playerLoadFailed ? (
                <iframe
                  key={state.channel}
                  title={`Twitch - ${state.channel}`}
                  src={buildTwitchPlayerUrl(state.channel, state.playing, muted)}
                  className="twitch-player-iframe"
                  allowFullScreen
                />
              ) : (
                <div ref={mountRef} className="twitch-player-mount" style={{ width: '100%', height: '100%' }} />
              )}

              {/* Pause overlay for room synchronization */}
              {!state.playing && (
                <div className="twitch-pause-overlay">
                  <div className="twitch-pause-card">
                    <Pause size={32} className="twitch-pause-icon" />
                    <p className="twitch-pause-text">{t('twitch.pausedNotice')}</p>
                    <button
                      type="button"
                      className="twitch-resume-btn"
                      onClick={handleTogglePlay}
                    >
                      <Play size={14} />
                      {t('twitch.play')}
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="twitch-empty-state">
              <SiTwitch className="twitch-empty-icon" aria-hidden="true" />
              <div className="twitch-empty-text">
                <h4 className="twitch-empty-title">{t('twitch.emptyTitle')}</h4>
                <p className="twitch-empty-desc">{t('twitch.emptyDesc')}</p>
              </div>
            </div>
          )}
        </div>

        {/* Chat sidebar */}
        {showChatPane && (
          <aside className="twitch-chat-pane">
            <div className="twitch-chat-header">
              <span>{t('twitch.chat')}</span>
              <TooltipButton
                tooltip={t('twitch.hideChat')}
                className="twitch-btn"
                onClick={handleToggleChat}
              >
                <MessageSquareOff size={15} />
              </TooltipButton>
            </div>
            <iframe
              title={`Twitch Chat - ${state.channel}`}
              src={buildTwitchChatUrl(state.channel)}
              className="twitch-chat-iframe"
            />
          </aside>
        )}
      </div>

      {/* Activity toast */}
      {activity && (
        <ActivityToast
          key={activity.id}
          className="twitch-activity-toast"
          person={activity.actor ? personFor(activity.actor) : undefined}
          icon={<SiTwitch size={16} />}
          message={activity.message}
        />
      )}
    </div>
  );
};
