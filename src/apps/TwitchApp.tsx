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
  createTwitchPlayer,
  getTwitchParentHost,
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
const RECENTS_STORAGE = 'p2sharer_twitch_recents';
const SUGGESTED_CHANNELS = ['gaules', 'alanzoka', 'cellbit', 'shroud', 'monstercat'];

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
  const [activity, setActivity] = useState<{ id: number; actor: string; message: string } | null>(null);
  const [recentChannels, setRecentChannels] = useState<string[]>(() => {
    try {
      const stored = localStorage.getItem(RECENTS_STORAGE);
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });

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
      return;
    }

    let disposed = false;

    loadTwitchPlayerScript()
      .then(() => {
        if (disposed || !mountRef.current) return;

        // Clear mount element first
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
      .catch((err) => {
        console.error('Failed to load Twitch Player:', err);
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
    if (model) stateRef.current = model.state;
  }

  function handleSelectChannel(target: string) {
    const parsed = parseTwitchChannel(target);
    if (!parsed) return;

    // Save to recents
    const nextRecents = [parsed, ...recentChannels.filter(c => c !== parsed)].slice(0, 8);
    setRecentChannels(nextRecents);
    try {
      localStorage.setItem(RECENTS_STORAGE, JSON.stringify(nextRecents));
    } catch {
      // Local storage full or blocked
    }

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
      name: local ? username || 'Você' : peer?.username || 'Alguém',
      color: slot?.color || 'var(--accent-color)',
    };
  };

  const parentHost = getTwitchParentHost();
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
        <form className="twitch-form" onSubmit={handleSubmitChannel}>
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
              tooltip={state.playing ? t('twitch.activity.pause') : t('twitch.activity.play')}
              className="twitch-btn"
              onClick={handleTogglePlay}
            >
              {state.playing ? <Pause size={17} strokeWidth={2.2} /> : <Play size={17} strokeWidth={2.2} />}
            </TooltipButton>
          )}

          {/* Volume */}
          <div className="twitch-volume-wrapper">
            <TooltipButton
              tooltip={muted || volume === 0 ? 'Desmutar' : 'Mutar'}
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
            <div ref={mountRef} className="twitch-player-mount" />
          ) : (
            <div className="twitch-empty-state">
              <SiTwitch className="twitch-empty-icon" aria-hidden="true" />
              <div className="twitch-empty-text">
                <h4 className="twitch-empty-title">{t('twitch.emptyTitle')}</h4>
                <p className="twitch-empty-desc">{t('twitch.emptyDesc')}</p>
              </div>

              <div className="twitch-suggested-wrapper">
                <span className="twitch-suggested-title">{t('twitch.suggested')}</span>
                <div className="twitch-suggested-pills">
                  {(recentChannels.length > 0 ? recentChannels : SUGGESTED_CHANNELS).map((chan) => (
                    <button
                      key={chan}
                      type="button"
                      className="twitch-pill"
                      onClick={() => handleSelectChannel(chan)}
                    >
                      <SiTwitch size={11} aria-hidden="true" />
                      {chan}
                    </button>
                  ))}
                </div>
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
              src={`https://www.twitch.tv/embed/${state.channel}/chat?parent=${parentHost}&darkpopout`}
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
