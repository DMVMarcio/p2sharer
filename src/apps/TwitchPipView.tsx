import { localizeError, localizeText, t } from '../i18n';
import { useLocale } from '../hooks/useLocale';
import { useElementFullscreen } from '../hooks/useElementFullscreen';
import React, { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event';
import { Pin, X, PictureInPicture2, Play, Pause, Volume2, VolumeX, Maximize, Minimize } from 'lucide-react';
import { useContextMenu } from '../components/common/ContextMenu';
import { TooltipButton } from '../components/common/TooltipButton';
import { PipWindowControls } from '../components/common/PipWindowControls';
import { initFrontendLogger } from '../core/logger';
import {
  buildTwitchPlayerUrl,
  createTwitchPlayer,
  loadTwitchPlayerScript,
  type TwitchPlayerInstance,
} from './twitch_player';
import { validTwitchState } from './models.ts';
import {
  twitchPipEvent,
  twitchPipPeerId,
  validTwitchPipSettings,
  type TwitchPipCommand,
  type TwitchPipLocalSettings,
  type TwitchPipMessage,
} from './twitch_pip';
import type { TwitchState } from './types.ts';

const VOLUME_STORAGE = 'p2sharer_twitch_volume';

export const TwitchPipView: React.FC<{ instanceId: string }> = ({ instanceId }) => {
  useLocale();
  const { ref: fullscreenRef, fullscreen, toggleFullscreen } = useElementFullscreen<HTMLDivElement>();
  const openContextMenu = useContextMenu();
  const [state, setState] = useState<TwitchState | null>(null);
  const [playerReady, setPlayerReady] = useState(false);
  const [playerLoadFailed, setPlayerLoadFailed] = useState(false);
  const [error, setError] = useState('');
  const [alwaysOnTop, setAlwaysOnTop] = useState(true);
  const [volume, setVolume] = useState(() => {
    const stored = localStorage.getItem(VOLUME_STORAGE);
    const saved = stored === null ? NaN : Number(stored);
    return Number.isFinite(saved) && saved >= 0 && saved <= 100 ? saved : 80;
  });
  const [muted, setMuted] = useState(false);

  const mountRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<TwitchPlayerInstance | null>(null);
  const stateRef = useRef(state);
  const volumeRef = useRef(volume);
  const mutedRef = useRef(muted);
  const suppressBroadcastRef = useRef(false);

  stateRef.current = state;
  volumeRef.current = volume;
  mutedRef.current = muted;

  const send = (message: TwitchPipMessage) => {
    void emit(twitchPipEvent(instanceId), message);
  };

  const command = (value: TwitchPipCommand) => send({ source: 'pip', type: 'command', command: value });

  const applySettings = (settings: TwitchPipLocalSettings) => {
    volumeRef.current = settings.volume;
    mutedRef.current = settings.muted;
    setVolume(settings.volume);
    setMuted(settings.muted);
    playerRef.current?.setVolume(settings.muted ? 0 : settings.volume / 100);
    playerRef.current?.setMuted(settings.muted);
  };

  useEffect(() => {
    initFrontendLogger();
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | null = null;
    let readyTimer: ReturnType<typeof setTimeout> | null = null;

    void listen<TwitchPipMessage>(twitchPipEvent(instanceId), (event) => {
      const message = event.payload;
      if (message?.source !== 'main') return;
      if (message.type === 'settings') {
        if (!validTwitchPipSettings(message.settings)) return;
        applySettings(message.settings);
        return;
      }
      if (message.type === 'state') {
        if (!validTwitchState(message.state)) return;
        if (validTwitchPipSettings(message.settings)) applySettings(message.settings);
        stateRef.current = message.state;
        setState(message.state);
      }
    }).then((remove) => {
      if (disposed) {
        remove();
        return;
      }
      unlisten = remove;
      readyTimer = setTimeout(() => send({ source: 'pip', type: 'ready' }), 0);
    }).catch((reason) => setError(localizeError(reason)));

    return () => {
      disposed = true;
      if (readyTimer) clearTimeout(readyTimer);
      unlisten?.();
    };
  }, [instanceId]);

  // Sync player playback with state
  useEffect(() => {
    const player = playerRef.current;
    if (!player || !playerReady || !state) return;

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
  }, [state?.channel, state?.playing, playerReady]);

  // Mount player
  useEffect(() => {
    if (!state?.channel || !mountRef.current) return;

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
        });

        playerRef.current = player;
      })
      .catch((err: unknown) => {
        console.warn('Twitch SDK load failed in PiP, falling back to direct iframe:', err);
        if (!disposed) setPlayerLoadFailed(true);
      });

    return () => {
      disposed = true;
      if (mountRef.current) mountRef.current.innerHTML = '';
      playerRef.current = null;
      setPlayerReady(false);
    };
  }, [state?.channel]);

  const setLocalVolume = (nextVolume: number) => {
    volumeRef.current = nextVolume;
    setVolume(nextVolume);
    localStorage.setItem(VOLUME_STORAGE, String(nextVolume));
    playerRef.current?.setVolume(muted ? 0 : nextVolume / 100);
    send({ source: 'pip', type: 'settings', settings: { volume: nextVolume, muted } });
  };

  const toggleMute = () => {
    const nextMuted = !muted;
    mutedRef.current = nextMuted;
    setMuted(nextMuted);
    playerRef.current?.setMuted(nextMuted);
    playerRef.current?.setVolume(nextMuted ? 0 : volume / 100);
    send({ source: 'pip', type: 'settings', settings: { volume, muted: nextMuted } });
  };

  const toggleTop = async () => {
    const next = !alwaysOnTop;
    try {
      await invoke('set_pip_always_on_top', { peerId: twitchPipPeerId(instanceId), alwaysOnTop: next });
      setAlwaysOnTop(next);
    } catch (reason) {
      setError(localizeError(reason));
    }
  };

  const close = async () => {
    try {
      await invoke('close_pip_window', { peerId: twitchPipPeerId(instanceId) });
    } catch (reason) {
      setError(t("message.f97d9af8dc31", { v0: localizeError(String(reason)) }));
    }
  };

  const currentChannel = state?.channel;

  return (
    <div
      ref={fullscreenRef}
      className="pip-window-root youtube-pip-root"
      onContextMenu={(event) =>
        openContextMenu(event, [
          { id: 'restore', get label() { return t("message.5899ac52fbbf"); }, icon: <PictureInPicture2 size={15} />, onSelect: close },
          {
            id: 'playback',
            get label() { return state?.playing ? t("message.c1301275ce3f") : t("message.ca0709c34209"); },
            icon: state?.playing ? <Pause size={15} /> : <Play size={15} />,
            disabled: !currentChannel,
            onSelect: () => command({ action: 'toggle' }),
          },
          {
            id: 'mute',
            get label() { return muted ? t("message.5cfebda5d336") : t("message.70f507f2963f"); },
            icon: muted ? <Volume2 size={15} /> : <VolumeX size={15} />,
            onSelect: toggleMute,
          },
          {
            id: 'top',
            get label() { return alwaysOnTop ? t("message.ceda40d1828b") : t("message.22da96afd9d8"); },
            icon: <Pin size={15} />,
            onSelect: toggleTop,
          },
        ])
      }
    >
      <div ref={mountRef} className="room-app-player-mount" />

      {playerLoadFailed && currentChannel && (
        <iframe
          src={buildTwitchPlayerUrl(currentChannel)}
          title={`Twitch - ${currentChannel}`}
          className="twitch-iframe-player"
          allow="autoplay; fullscreen"
          allowFullScreen
        />
      )}

      {currentChannel && (
        <button
          className="youtube-pip-hit-area"
          onClick={() => command({ action: 'toggle' })}
          aria-label={state?.playing ? t("message.c1301275ce3f") : t("message.ca0709c34209")}
        />
      )}

      {(!currentChannel || error) && (
        <div className="pip-loading-placeholder">
          {localizeText(error) || t("twitch.emptyTitle")}
        </div>
      )}

      <div className="pip-overlay">
        <div className="pip-top-bar" data-tauri-drag-region={!fullscreen || undefined}>
          <div className="pip-top-left" data-tauri-drag-region={!fullscreen || undefined}>
            <span className="pip-status-dot" aria-hidden="true" />
            <span className="pip-title" data-tauri-drag-region={!fullscreen || undefined}>
              {currentChannel ? `Twitch - ${currentChannel}` : 'Twitch'}
            </span>
          </div>
          <div className="pip-top-right">
            <PipWindowControls fullscreen={fullscreen} />
            <TooltipButton
              tooltip={alwaysOnTop ? t("message.9edf08040405") : t("message.5c73f9df033a")}
              className={`pip-header-btn ${alwaysOnTop ? 'active' : ''}`}
              onClick={() => void toggleTop()}
            >
              <Pin size={15} />
            </TooltipButton>
            <TooltipButton
              tooltip={t("message.99f8f48f4223")}
              className="pip-header-btn pip-close-btn"
              onClick={() => void close()}
            >
              <X size={16} />
            </TooltipButton>
          </div>
        </div>

        <div className="youtube-control-deck" style={{ justifyContent: 'space-between', padding: '8px 12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <TooltipButton
              tooltip={state?.playing ? t("twitch.pause") : t("twitch.play")}
              className="youtube-control-button"
              onClick={() => command({ action: 'toggle' })}
              disabled={!currentChannel}
            >
              {state?.playing ? <Pause size={17} /> : <Play size={17} />}
            </TooltipButton>

            <TooltipButton
              tooltip={muted ? t("twitch.unmute") : t("twitch.mute")}
              className="youtube-control-button"
              onClick={toggleMute}
            >
              {muted ? <VolumeX size={17} /> : <Volume2 size={17} />}
            </TooltipButton>

            <input
              autoComplete="off"
              type="range"
              min={0}
              max={100}
              value={muted ? 0 : volume}
              onChange={(e) => setLocalVolume(Number(e.target.value))}
              aria-label={t("twitch.volume")}
              className="youtube-volume-slider"
              style={{ width: '60px' }}
            />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <TooltipButton
              tooltip={t("message.5899ac52fbbf")}
              className="youtube-control-button"
              onClick={() => void close()}
            >
              <PictureInPicture2 size={17} />
            </TooltipButton>

            <TooltipButton
              tooltip={fullscreen ? t("browser.exitFullscreen") : t("browser.fullscreen")}
              className="youtube-control-button"
              onClick={() => void toggleFullscreen().catch((err) => setError(localizeError(err)))}
            >
              {fullscreen ? <Minimize size={17} /> : <Maximize size={17} />}
            </TooltipButton>
          </div>
        </div>
      </div>
    </div>
  );
};
