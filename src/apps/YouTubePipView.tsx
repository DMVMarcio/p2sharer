import React, { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event';
import { Pin, X } from 'lucide-react';
import { TooltipButton } from '../components/common/TooltipButton';
import { initFrontendLogger } from '../core/logger';
import { YouTubeControls } from './YouTubeControls';
import { canAdvanceYouTubeQueue } from './youtube_queue';
import { createYouTubePlayer, loadYouTubePlayerApi, reconcileYouTubePlayer, setYouTubeCaptions,
  type YouTubePlaybackTracker, type YouTubePlayer } from './youtube_player';
import { validYouTubeState } from './models.ts';
import { validYouTubePipSettings, youtubePipEvent, youtubePipPeerId,
  type YouTubePipCommand, type YouTubePipLocalSettings, type YouTubePipMessage } from './youtube_pip';
import type { YouTubeState } from './types';

const VOLUME_STORAGE = 'p2sharer_youtube_volume';
const CAPTIONS_STORAGE = 'p2sharer_youtube_captions';

export const YouTubePipView: React.FC<{ instanceId: string }> = ({ instanceId }) => {
  const [state, setState] = useState<YouTubeState | null>(null);
  const [playerReady, setPlayerReady] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [error, setError] = useState('');
  const [alwaysOnTop, setAlwaysOnTop] = useState(true);
  const [volume, setVolume] = useState(() => {
    const stored = localStorage.getItem(VOLUME_STORAGE);
    const saved = stored === null ? NaN : Number(stored);
    return Number.isFinite(saved) && saved >= 0 && saved <= 100 ? saved : 80;
  });
  const [muted, setMuted] = useState(false);
  const [captions, setCaptions] = useState(() => localStorage.getItem(CAPTIONS_STORAGE) === 'true');
  const mountRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YouTubePlayer | null>(null);
  const stateRef = useRef(state);
  const captionsRef = useRef(captions);
  const volumeRef = useRef(volume);
  const mutedRef = useRef(muted);
  const receivedAtRef = useRef(Date.now());
  const sequenceRef = useRef(-1);
  const trackerRef = useRef<YouTubePlaybackTracker>({ videoId: '', lastLoadAt: 0,
    lastPlayAttemptAt: 0, lastCorrectionAt: 0 });
  stateRef.current = state;
  captionsRef.current = captions;
  volumeRef.current = volume;
  mutedRef.current = muted;

  const send = (message: YouTubePipMessage) => { void emit(youtubePipEvent(instanceId), message); };
  const command = (value: YouTubePipCommand) => send({ source: 'pip', type: 'command', command: value });
  const applySettings = (settings: YouTubePipLocalSettings) => {
    volumeRef.current = settings.volume;
    mutedRef.current = settings.muted;
    captionsRef.current = settings.captions;
    setVolume(settings.volume);
    setMuted(settings.muted);
    setCaptions(settings.captions);
    playerRef.current?.setVolume(settings.volume);
    if (settings.muted) playerRef.current?.mute();
    else playerRef.current?.unMute();
    if (playerRef.current) setYouTubeCaptions(playerRef.current, settings.captions);
  };

  useEffect(() => { initFrontendLogger(); }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | null = null;
    let readyTimer: ReturnType<typeof setTimeout> | null = null;
    void listen<YouTubePipMessage>(youtubePipEvent(instanceId), (event) => {
      const message = event.payload;
      if (message?.source !== 'main') return;
      if (message.type === 'settings') {
        if (!validYouTubePipSettings(message.settings)) return;
        applySettings(message.settings);
        return;
      }
      if (message.type !== 'state' ||
        !validYouTubeState(message.state) || !Number.isSafeInteger(message.sequence) ||
        message.sequence <= sequenceRef.current) return;
      if (sequenceRef.current < 0 && validYouTubePipSettings(message.settings)) applySettings(message.settings);
      sequenceRef.current = message.sequence;
      receivedAtRef.current = message.receivedAt;
      stateRef.current = message.state;
      setState(message.state);
    }).then((remove) => {
      if (disposed) { remove(); return; }
      unlisten = remove;
      readyTimer = setTimeout(() => send({ source: 'pip', type: 'ready' }), 0);
    }).catch((reason) => setError(String(reason)));
    return () => {
      disposed = true;
      if (readyTimer) clearTimeout(readyTimer);
      unlisten?.();
    };
  }, [instanceId]);

  function reconcile(mode: 'urgent' | 'update' | 'periodic' | 'resume') {
    const player = playerRef.current;
    const current = stateRef.current;
    if (!player || !current) return;
    const result = reconcileYouTubePlayer(player, current, trackerRef.current, receivedAtRef.current,
      Date.now(), mode);
    if (result.loaded) { setPosition(result.position); setDuration(0); }
  }

  useEffect(() => {
    let disposed = false;
    void loadYouTubePlayerApi().then(() => {
      if (disposed || !mountRef.current) return;
      playerRef.current = createYouTubePlayer(mountRef.current, (event) => {
        const current = stateRef.current;
        const entry = current?.queue[current.index];
        if (event.data === 1 && playerRef.current)
          setYouTubeCaptions(playerRef.current, captionsRef.current);
        if (event.data === 0 && entry && playerRef.current?.getVideoData().video_id === entry.videoId)
          send({ source: 'pip', type: 'ended', videoId: entry.videoId });
        if (event.data === 1 || event.data === 2 || event.data === 5)
          reconcile(event.data === 1 || event.data === 5 ? 'resume' : 'update');
      }, () => {
        playerRef.current?.setVolume(volumeRef.current);
        if (mutedRef.current) playerRef.current?.mute();
        if (playerRef.current) setYouTubeCaptions(playerRef.current, captionsRef.current);
        setPlayerReady(true);
      }, () => {
        if (playerRef.current) setYouTubeCaptions(playerRef.current, captionsRef.current);
      });
    }).catch((reason) => setError(String(reason)));
    return () => { disposed = true; playerRef.current?.destroy(); playerRef.current = null; };
  }, [instanceId]);

  useEffect(() => {
    if (!playerReady || !state) return;
    reconcile(state.syncReason === 'seek' || state.syncReason === 'playback' ? 'urgent' : 'update');
    if (!state.queue[state.index]) {
      setPosition(0);
      setDuration(0);
      setBuffered(0);
    }
  }, [state, playerReady]);

  useEffect(() => {
    if (!playerReady) return;
    const timer = setInterval(() => {
      const player = playerRef.current;
      const current = stateRef.current;
      if (!player || !current) return;
      if (!current.queue[current.index]) return;
      const time = player.getCurrentTime();
      const length = player.getDuration();
      const loaded = player.getVideoLoadedFraction();
      if (Number.isFinite(time) && time >= 0) setPosition(time);
      if (Number.isFinite(length) && length >= 0) setDuration(length);
      if (Number.isFinite(loaded) && loaded >= 0) setBuffered(loaded);
      const entry = current.queue[current.index];
      if (entry && player.getVideoData().video_id === entry.videoId && Number.isFinite(time) && time >= 0)
        send({ source: 'pip', type: 'progress', videoId: entry.videoId, position: time,
          duration: Number.isFinite(length) ? length : 0, playing: player.getPlayerState() === 1 });
      if (entry && current.playing && ![0, 1, 3].includes(player.getPlayerState())) reconcile('update');
    }, 1000);
    return () => clearInterval(timer);
  }, [instanceId, playerReady]);

  const current = state?.queue[state.index];
  const setLocalVolume = (next: number) => {
    volumeRef.current = next;
    setVolume(next);
    localStorage.setItem(VOLUME_STORAGE, String(next));
    playerRef.current?.setVolume(next);
    if (next > 0 && muted) { playerRef.current?.unMute(); setMuted(false); mutedRef.current = false; }
    send({ source: 'pip', type: 'settings', settings: { volume: next,
      muted: next > 0 ? false : muted, captions: captionsRef.current } });
  };
  const toggleMute = () => {
    mutedRef.current = !muted;
    if (muted) playerRef.current?.unMute();
    else playerRef.current?.mute();
    setMuted(!muted);
    send({ source: 'pip', type: 'settings', settings: { volume, muted: !muted, captions: captionsRef.current } });
  };
  const toggleCaptions = () => {
    const next = !captionsRef.current;
    captionsRef.current = next;
    setCaptions(next);
    localStorage.setItem(CAPTIONS_STORAGE, String(next));
    if (playerRef.current) setYouTubeCaptions(playerRef.current, next);
    send({ source: 'pip', type: 'settings', settings: { volume, muted, captions: next } });
  };
  const toggleTop = async () => {
    const next = !alwaysOnTop;
    try {
      await invoke('set_pip_always_on_top', { peerId: youtubePipPeerId(instanceId), alwaysOnTop: next });
      setAlwaysOnTop(next);
    } catch (reason) { setError(String(reason)); }
  };
  const close = async () => {
    try {
      await invoke('close_pip_window', { peerId: youtubePipPeerId(instanceId) });
    } catch (reason) { setError(`Não foi possível fechar o Picture-in-Picture: ${String(reason)}`); }
  };

  return <div className="pip-window-root youtube-pip-root">
    <div ref={mountRef} className="room-app-player-mount" />
    {current && <button className="youtube-pip-hit-area" onClick={() => command({ action: 'toggle' })}
      aria-label={state?.playing ? 'Pausar para todos' : 'Reproduzir para todos'} />}
    {(!current || error) && <div className="pip-loading-placeholder">{error || 'Adicione um vídeo para começar'}</div>}
    <div className="pip-overlay">
      <div className="pip-top-bar" data-tauri-drag-region>
        <div className="pip-top-left" data-tauri-drag-region>
          <span className="pip-status-dot" aria-hidden="true" />
          <span className="pip-title" data-tauri-drag-region>{current?.title || 'YouTube compartilhado'}</span>
        </div>
        <div className="pip-top-right">
          <TooltipButton tooltip={alwaysOnTop ? 'Desafixar do topo' : 'Fixar no topo'}
            className={`pip-header-btn ${alwaysOnTop ? 'active' : ''}`} onClick={() => void toggleTop()}>
            <Pin size={15} /></TooltipButton>
          <TooltipButton tooltip="Fechar Picture-in-Picture" className="pip-header-btn pip-close-btn"
            onClick={() => void close()}><X size={16} /></TooltipButton>
        </div>
      </div>
      <YouTubeControls hasVideo={Boolean(current)} playing={Boolean(state?.playing)}
        hasPrevious={Boolean(state && state.index > 0)} hasNext={Boolean(state && canAdvanceYouTubeQueue(state))}
        position={position} duration={duration} buffered={buffered} volume={volume} muted={muted} captions={captions}
        onTogglePlayback={() => command({ action: 'toggle' })}
        onPrevious={() => command({ action: 'previous' })} onNext={() => command({ action: 'next' })}
        onSeek={(next) => command({ action: 'seek', position: next })}
        onVolume={setLocalVolume} onToggleMute={toggleMute} onToggleCaptions={toggleCaptions} />
    </div>
  </div>;
};
