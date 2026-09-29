import React, { useEffect, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { ArrowDown, ArrowLeft, ArrowUp, ExternalLink, Expand, ListMinus, ListVideo,
  LoaderCircle, Minimize2, Play, Plus, Repeat, Repeat1, Search, Shuffle, SquarePlay, Trash2 } from 'lucide-react';
import { roomAppsService } from './room_apps_service';
import { YouTubeModel } from './models.ts';
import { loadYouTubePlaylist, loadYouTubePlaylistPreview, parseYouTubeInput, resolveYouTubeTitle, searchYouTube,
  type YouTubeSearchItem } from './youtube_api';
import { createYouTubePlayer, loadYouTubePlayerApi, reconcileYouTubePlayer, setYouTubeCaptions,
  type YouTubePlaybackTracker, type YouTubePlayer } from './youtube_player';
import { advanceYouTubeQueue, canAdvanceYouTubeQueue, moveYouTubeQueueEntry } from './youtube_queue';
import { YouTubeControls } from './YouTubeControls';
import { Tooltip } from '../components/common/Tooltip';
import { TooltipButton } from '../components/common/TooltipButton';
import { ActivityAvatar, type ActivityParticipant } from '../components/common/ActivityParticipants';
import { ActivityToast } from '../components/common/ActivityToast';
import { useRoom } from '../hooks/useRoom';
import { describeYouTubeActivity } from './youtube_activity';
import { MEDIA_SYNC_INTERVAL_MS } from '../core/media_sync';
import type { YouTubeEntry, YouTubeState } from './types';

interface Props { instanceId: string; compact?: boolean }
const VOLUME_STORAGE = 'p2sharer_youtube_volume';
const CAPTIONS_STORAGE = 'p2sharer_youtube_captions';

export const YouTubeApp: React.FC<Props> = ({ instanceId, compact = false }) => {
  const { username, peers, roomSlots } = useRoom();
  const [state, setState] = useState<YouTubeState>(() => roomAppsService.getModel<YouTubeModel>(instanceId)?.state ||
    { queue: [], index: 0, playing: false, position: 0, repeat: 'off', shuffle: false,
      removePlayed: false, updatedAt: 0 });
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<YouTubeSearchItem[]>([]);
  const [hasSearched, setHasSearched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [activity, setActivity] = useState<{ id: number; actor: string; message: string } | null>(null);
  const [playerReady, setPlayerReady] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [theater, setTheater] = useState(false);
  const [mobilePanel, setMobilePanel] = useState<'watch' | 'discover'>('watch');
  const [resolvedTitles, setResolvedTitles] = useState<Record<string, string>>({});
  const [volume, setVolume] = useState(() => {
    const stored = localStorage.getItem(VOLUME_STORAGE);
    const saved = stored === null ? NaN : Number(stored);
    return Number.isFinite(saved) && saved >= 0 && saved <= 100 ? saved : 80;
  });
  const [muted, setMuted] = useState(false);
  const [captions, setCaptions] = useState(() => localStorage.getItem(CAPTIONS_STORAGE) === 'true');
  const mountRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YouTubePlayer | null>(null);
  const playbackTrackerRef = useRef<YouTubePlaybackTracker>({ videoId: '', lastLoadAt: 0,
    lastPlayAttemptAt: 0, lastCorrectionAt: 0 });
  const appliedRef = useRef('');
  const requestedTitlesRef = useRef(new Set<string>());
  const stateRef = useRef(state);
  const previousStateRef = useRef(state);
  const previousReceivedAtRef = useRef(roomAppsService.getModel<YouTubeModel>(instanceId)?.receivedAt || Date.now());
  const activityIdRef = useRef(0);
  stateRef.current = state;
  const captionsRef = useRef(captions);
  captionsRef.current = captions;

  useEffect(() => roomAppsService.subscribe(() => {
    const model = roomAppsService.getModel<YouTubeModel>(instanceId);
    const next = model?.state;
    if (!next || next === previousStateRef.current) return;
    const message = describeYouTubeActivity(previousStateRef.current, next, previousReceivedAtRef.current);
    previousStateRef.current = next;
    previousReceivedAtRef.current = model.receivedAt;
    if (message && model?.actor && !model.lastChangeWasSnapshot)
      setActivity({ id: ++activityIdRef.current, actor: model.actor, message });
    setState(next);
  }), [instanceId]);

  useEffect(() => {
    if (!activity) return;
    const timer = window.setTimeout(() => setActivity((current) => current?.id === activity.id ? null : current), 3800);
    return () => window.clearTimeout(timer);
  }, [activity]);

  useEffect(() => {
    if (!mountRef.current) return;
    let canceled = false;
    loadYouTubePlayerApi().then(() => {
      if (!canceled && mountRef.current) playerRef.current = createYouTubePlayer(mountRef.current, (event) => {
        if (event.data === 1 && playerRef.current)
          setYouTubeCaptions(playerRef.current, captionsRef.current);
        if (event.data === 1 || event.data === 2 || event.data === 5) {
          const current = stateRef.current;
          const expected = current.queue[current.index];
          if (expected) reconcilePlayback(current, event.data === 1 || event.data === 5 ? 'resume' : 'update');
        }
        if (event.data === 0 && roomAppsService.getParticipants(instanceId).sort()[0] === roomAppsService.getLocalActor()) {
          const current = stateRef.current;
          const expected = current.queue[current.index];
          if (expected && playerRef.current?.getVideoData().video_id === expected.videoId && current.playing)
            publish(advanceYouTubeQueue(current), 'seek');
        }
      }, () => {
        const player = playerRef.current;
        if (player) {
          player.setVolume(volume);
          setYouTubeCaptions(player, captionsRef.current);
        }
        setPlayerReady(true);
      }, () => {
        if (playerRef.current) setYouTubeCaptions(playerRef.current, captionsRef.current);
      });
    }).catch((reason) => setError(String(reason)));
    return () => { canceled = true; playerRef.current?.destroy(); playerRef.current = null; };
  }, [instanceId]);

  useEffect(() => {
    const timer = setInterval(() => {
      const current = stateRef.current;
      const player = playerRef.current;
      if (!player) return;
      const position = player.getCurrentTime();
      const length = player.getDuration();
      const loaded = player.getVideoLoadedFraction();
      if (Number.isFinite(position) && position >= 0) setPlayhead(position);
      if (Number.isFinite(length) && length >= 0) setDuration(length);
      if (Number.isFinite(loaded) && loaded >= 0) setBuffered(loaded);
      const entry = current.queue[current.index];
      const metadata = player.getVideoData();
      if (entry && metadata.video_id === entry.videoId && metadata.title &&
        entry.title === `Vídeo ${entry.videoId}`) {
        setResolvedTitles((titles) => titles[entry.videoId] === metadata.title ? titles :
          { ...titles, [entry.videoId]: metadata.title! });
      }
      if (entry && current.playing && ![0, 1, 3].includes(player.getPlayerState()))
        reconcilePlayback(current, 'update');
    }, 1000);
    return () => clearInterval(timer);
  }, [instanceId]);

  useEffect(() => {
    if (!playerReady) return;
    const timer = setInterval(() => {
      const current = stateRef.current;
      const player = playerRef.current;
      const entry = current.queue[current.index];
      if (!player || !entry) return;
      const corrected = reconcilePlayback(current, 'periodic');
      if (corrected) return;
      if (roomAppsService.getParticipants(instanceId).sort()[0] === roomAppsService.getLocalActor() &&
        current.playing && player.getPlayerState() === 1 &&
        player.getVideoData().video_id === entry.videoId) {
        const position = player.getCurrentTime();
        if (Number.isFinite(position) && position >= 0) publish({ ...current, position }, 'heartbeat');
      }
    }, MEDIA_SYNC_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [instanceId, playerReady]);

  const current = state.queue[state.index];
  useEffect(() => {
    if (!playerReady || !current) return;
    const signature = `${current.videoId}:${state.index}:${state.playing}:${state.position}:${state.updatedAt}`;
    if (appliedRef.current === signature) return;
    appliedRef.current = signature;
    reconcilePlayback(state, state.syncReason === 'playback' || state.syncReason === 'seek'
      ? 'urgent' : 'update');
  }, [state, current, playerReady]);

  useEffect(() => {
    let canceled = false;
    const resolveMissing = async () => {
      for (const entry of state.queue) {
        if (canceled) return;
        if (entry.title !== `Vídeo ${entry.videoId}` || requestedTitlesRef.current.has(entry.videoId)) continue;
        requestedTitlesRef.current.add(entry.videoId);
        const title = await resolveYouTubeTitle(entry.videoId);
        if (title && !canceled) setResolvedTitles((titles) => ({ ...titles, [entry.videoId]: title }));
        if (canceled || !title) requestedTitlesRef.current.delete(entry.videoId);
      }
    };
    void resolveMissing();
    return () => { canceled = true; };
  }, [state.queue]);

  useEffect(() => {
    if (!theater) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setTheater(false); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [theater]);

  function reconcilePlayback(currentState: YouTubeState,
    mode: 'urgent' | 'update' | 'periodic' | 'resume'): boolean {
    const player = playerRef.current;
    if (!player) return false;
    const now = Date.now();
    const receivedAt = roomAppsService.getModel<YouTubeModel>(instanceId)?.receivedAt || now;
    const result = reconcileYouTubePlayer(player, currentState, playbackTrackerRef.current, receivedAt, now, mode);
    if (result.loaded) { setPlayhead(result.position); setDuration(0); }
    return result.corrected;
  }

  function publish(next: Omit<YouTubeState, 'updatedAt'>,
    syncReason: NonNullable<YouTubeState['syncReason']> = 'update') {
    const fullState: YouTubeState = { ...next, updatedAt: Date.now(), syncReason };
    stateRef.current = fullState;
    roomAppsService.getModel<YouTubeModel>(instanceId)?.update(fullState);
  }

  const displayTitle = (entry: YouTubeEntry) => resolvedTitles[entry.videoId] || entry.title;
  const personFor = (actor: string, savedName?: string): ActivityParticipant => {
    const local = actor === roomAppsService.getLocalActor();
    const peer = peers.find((entry) => entry.id === actor);
    const slot = roomSlots.find((entry) => local ? entry.isLocal : entry.peerId === actor);
    return { id: actor, name: (local ? username || 'Você' : peer?.username || savedName || 'Participante'),
      color: slot?.color || 'var(--accent-color)' };
  };

  const setLocalVolume = (next: number) => {
    setVolume(next);
    localStorage.setItem(VOLUME_STORAGE, String(next));
    playerRef.current?.setVolume(next);
    if (next > 0 && muted) { playerRef.current?.unMute(); setMuted(false); }
  };

  const toggleMute = () => {
    const next = !muted;
    if (next) playerRef.current?.mute();
    else playerRef.current?.unMute();
    setMuted(next);
  };

  const toggleCaptions = () => {
    const next = !captionsRef.current;
    captionsRef.current = next;
    setCaptions(next);
    localStorage.setItem(CAPTIONS_STORAGE, String(next));
    if (playerRef.current) setYouTubeCaptions(playerRef.current, next);
  };

  const togglePlayback = () => {
    const latest = stateRef.current;
    if (!latest.queue[latest.index]) return;
    const position = playerRef.current?.getCurrentTime();
    publish({ ...latest, position: Number.isFinite(position) && position! >= 0 ? position! : latest.position,
      playing: !latest.playing }, 'playback');
  };

  const seek = (position: number) => {
    if (!stateRef.current.queue[stateRef.current.index]) return;
    const next = Math.max(0, Math.min(duration || position, position));
    setPlayhead(next);
    playbackTrackerRef.current.lastCorrectionAt = Date.now();
    publish({ ...stateRef.current, position: next }, 'seek');
  };

  const add = (entries: YouTubeEntry[]) => {
    if (!entries.length) return;
    const latest = stateRef.current;
    const queue = [...latest.queue, ...entries.map((entry) => ({ ...entry,
      addedBy: roomAppsService.getLocalActor(), addedByName: (username || 'Você').slice(0, 80) }))].slice(0, 200);
    publish({ ...latest, queue, playing: latest.queue.length === 0 ? true : latest.playing });
  };

  const openExternalSearch = async (terms: string) => {
    const url = new URL(terms.trim() ? 'https://www.youtube.com/results' : 'https://www.youtube.com/');
    if (terms.trim()) url.searchParams.set('search_query', terms.trim());
    try {
      if (isTauri()) await openUrl(url.toString());
      else window.open(url.toString(), '_blank', 'noopener,noreferrer');
    } catch { setError('Não foi possível abrir a busca no YouTube.'); }
  };

  const search = async () => {
    const terms = query.trim();
    if (!terms || busy) return;
    setError('');
    setHasSearched(false);
    const parsed = parseYouTubeInput(terms);
    if (parsed.playlistId || parsed.videoId) {
      setBusy(true);
      try {
        const previews: YouTubeSearchItem[] = [];
        if (parsed.videoId) {
          const title = await resolveYouTubeTitle(parsed.videoId);
          previews.push({ kind: 'video', id: parsed.videoId, title: title || `Vídeo ${parsed.videoId}` });
        }
        if (parsed.playlistId) {
          const preview = await loadYouTubePlaylistPreview(parsed.playlistId).catch(() => null);
          previews.push({ kind: 'playlist', id: parsed.playlistId,
            title: preview?.title || `Playlist ${parsed.playlistId}`,
            count: preview?.count, thumbnailVideoId: preview?.thumbnailVideoId });
        }
        setResults(previews);
        setHasSearched(true);
      } catch (reason) { setError(String(reason)); } finally { setBusy(false); }
      return;
    }
    setBusy(true);
    try {
      const found = await searchYouTube(terms);
      setResults(found);
      setHasSearched(true);
    }
    catch (reason) { setError(String(reason)); } finally { setBusy(false); }
  };

  const chooseResult = async (result: YouTubeSearchItem) => {
    if (result.kind === 'video') { add([{ videoId: result.id, title: result.title }]); return; }
    setBusy(true);
    setError('');
    try { add(await loadYouTubePlaylist(result.id)); }
    catch (reason) { setError(String(reason)); } finally { setBusy(false); }
  };

  const move = (from: number, to: number) => {
    const next = moveYouTubeQueueEntry(stateRef.current, from, to);
    if (next !== stateRef.current) publish(next);
  };
  const remove = (index: number) => {
    const latest = stateRef.current;
    const queue = latest.queue.filter((_, position) => position !== index);
    const nextIndex = index < latest.index ? latest.index - 1 :
      Math.min(latest.index, Math.max(0, queue.length - 1));
    publish({ ...latest, queue, index: nextIndex, playing: queue.length > 0 && latest.playing,
      position: index === latest.index ? 0 : latest.position });
  };
  const select = (index: number) => publish({ ...stateRef.current, index, position: 0, playing: true }, 'seek');
  const next = () => publish(advanceYouTubeQueue(stateRef.current, true), 'seek');
  const cycleRepeat = () => {
    const latest = stateRef.current;
    publish({ ...latest, repeat: latest.repeat === 'off' ? 'all' : latest.repeat === 'all' ? 'one' : 'off' });
  };
  const toggleShuffle = () => publish({ ...stateRef.current, shuffle: !stateRef.current.shuffle });
  const toggleRemovePlayed = () => publish({ ...stateRef.current,
    removePlayed: !stateRef.current.removePlayed });

  return <div className={`room-app-youtube ${compact ? 'compact' : ''} ${theater ? 'is-theater' : ''} ${mobilePanel === 'discover' ? 'show-discover' : ''}`}
    onClick={(event) => event.stopPropagation()}>
    {activity && <ActivityToast key={activity.id} className="youtube-activity-toast"
      person={personFor(activity.actor)} message={activity.message} />}
    <section className="youtube-watch-pane" aria-label="Player e fila de reprodução">
      <div className="youtube-player-frame">
        <div ref={mountRef} className="room-app-player-mount" />
        {current && !compact && <button className="youtube-player-hit-area"
          aria-label={state.playing ? 'Pausar vídeo para todos' : 'Reproduzir vídeo para todos'}
          onClick={togglePlayback} />}
        {!current && <div className="youtube-player-empty">
          <SquarePlay size={30} strokeWidth={1.5} />
          <span>Adicione um vídeo para começar</span>
        </div>}
        <TooltipButton tooltip={theater ? 'Sair do modo teatro' : 'Modo teatro'} className="youtube-theater-toggle"
          onClick={() => setTheater(!theater)}>
          {theater ? <Minimize2 size={16} /> : <Expand size={16} />}
          <span>{theater ? 'Sair do teatro' : 'Teatro'}</span>
        </TooltipButton>
      </div>
      <div className="youtube-watch-meta">
        <div className="youtube-watch-title"><span>Reproduzindo na sala</span>
          <Tooltip content={current ? displayTitle(current) : ''}>
            <h3 tabIndex={current ? 0 : undefined}>{current ? displayTitle(current) : 'Nenhum vídeo selecionado'}</h3>
          </Tooltip>
        </div>
        {state.queue.length > 0 && <span className="youtube-watch-position">{state.index + 1} / {state.queue.length}</span>}
      </div>
      <YouTubeControls hasVideo={Boolean(current)} playing={state.playing} hasPrevious={state.index > 0}
        hasNext={canAdvanceYouTubeQueue(state)} position={playhead} duration={duration}
        buffered={buffered} volume={volume} muted={muted} captions={captions}
        onTogglePlayback={togglePlayback}
        onPrevious={() => state.index > 0 ? select(state.index - 1) : seek(0)}
        onNext={next} onSeek={seek} onVolume={setLocalVolume}
        onToggleMute={toggleMute} onToggleCaptions={toggleCaptions} />
      <div className="youtube-queue-header">
        <div><ListVideo size={16} /><strong>Fila de reprodução</strong><span>{state.queue.length}</span></div>
        <div className="youtube-queue-modes" aria-label="Opções da fila">
          <TooltipButton tooltip={state.repeat === 'off' ? 'Repetição desativada' : state.repeat === 'all'
            ? 'Repetir fila' : 'Repetir um vídeo'}
            className={state.repeat !== 'off' ? 'active' : ''} onClick={cycleRepeat}
            aria-label={state.repeat === 'off' ? 'Repetição desativada. Ativar repetição da fila'
              : state.repeat === 'all' ? 'Repetir fila. Ativar repetição de um vídeo'
                : 'Repetir vídeo. Desativar repetição'}>
            {state.repeat === 'one' ? <Repeat1 size={15} /> : <Repeat size={15} />}
          </TooltipButton>
          <TooltipButton tooltip="Ordem aleatória" className={state.shuffle ? 'active' : ''}
            onClick={toggleShuffle} aria-pressed={state.shuffle} aria-label="Reproduzir em ordem aleatória">
            <Shuffle size={15} /></TooltipButton>
          <TooltipButton tooltip="Remover após reproduzir" className={state.removePlayed ? 'active' : ''}
            onClick={toggleRemovePlayed} aria-pressed={state.removePlayed}>
            <ListMinus size={15} /></TooltipButton>
        </div>
        <button className="youtube-mobile-switch" onClick={() => setMobilePanel('discover')}>
          <Plus size={15} /> Adicionar
        </button>
      </div>
      <div className="youtube-queue-list" aria-label="Fila de reprodução">
        {state.queue.length === 0 && <p className="youtube-list-empty">A fila está vazia. Cole um link ou pesquise para adicionar um vídeo.</p>}
        {state.queue.map((entry, index) => <div className={`youtube-queue-item ${index === state.index ? 'active' : ''}`}
          key={`${entry.videoId}-${index}`}>
          <button className="youtube-queue-select" aria-label={`Reproduzir ${displayTitle(entry)}`} onClick={() => select(index)}>
            <span className="youtube-queue-thumb">
              <img src={`https://i.ytimg.com/vi/${entry.videoId}/mqdefault.jpg`} alt="" loading="lazy" />
              <Play size={18} fill="currentColor" className="youtube-queue-play" aria-hidden="true" />
            </span>
            <span className="youtube-queue-copy"><Tooltip content={displayTitle(entry)}><strong tabIndex={0}>{displayTitle(entry)}</strong></Tooltip>
              <small>{index === state.index ? 'Reproduzindo' : `Na fila · ${index + 1}`}</small></span>
          </button>
          <ActivityAvatar person={personFor(entry.addedBy || '', entry.addedByName)} className="youtube-queue-avatar" />
          <div className="youtube-queue-actions">
            <TooltipButton tooltip="Subir na fila" aria-label={`Subir ${displayTitle(entry)} na fila`} disabled={index === 0}
              onClick={() => move(index, index - 1)}><ArrowUp size={13} /></TooltipButton>
            <TooltipButton tooltip="Descer na fila" aria-label={`Descer ${displayTitle(entry)} na fila`}
              disabled={index === state.queue.length - 1} onClick={() => move(index, index + 1)}>
              <ArrowDown size={13} /></TooltipButton>
            <TooltipButton tooltip="Remover da fila" aria-label={`Remover ${displayTitle(entry)}`}
              onClick={() => remove(index)}><Trash2 size={13} /></TooltipButton>
          </div>
        </div>)}
      </div>
    </section>
    <aside className="youtube-discover-pane" aria-label="Pesquisar e adicionar vídeos">
      <div className="youtube-discover-heading">
        <div><h3>Adicionar vídeos</h3></div>
        <button className="youtube-mobile-switch" onClick={() => setMobilePanel('watch')} aria-label="Voltar ao player">
          <ArrowLeft size={16} /> Voltar
        </button>
      </div>
      <p className="youtube-discover-hint">Cole um link para visualizar antes de adicionar, ou pesquise algo para assistir juntos.</p>
      <div className="youtube-search-field">
        <Search size={17} aria-hidden="true" />
        <input aria-label="Pesquisar ou colar URL do YouTube" placeholder="Link ou nome do vídeo" value={query}
          onChange={(event) => { setQuery(event.target.value); setHasSearched(false); }}
          onKeyDown={(event) => { if (event.key === 'Enter') void search(); }} />
        <button aria-label="Pesquisar ou visualizar link" disabled={busy || !query.trim()} onClick={() => void search()}>
          {busy ? <LoaderCircle size={16} className="youtube-loading" /> : <Search size={16} />}
        </button>
      </div>
      <p className="youtube-search-help">Busca via Invidious</p>
      {error && <p className="youtube-search-error" role="alert">{error}</p>}
      {error && <button className="youtube-external-search" onClick={() => void openExternalSearch(query)}>
        <span>Abrir busca no YouTube</span><ExternalLink size={15} />
      </button>}
      <div className="youtube-results-header"><span>Resultados</span>{results.length > 0 && <span>{results.length}</span>}</div>
      <div className="youtube-results-list" aria-label="Resultados da busca">
        {results.length === 0 && <p className="youtube-list-empty">{hasSearched
          ? 'Nenhum resultado encontrado. Tente outros termos ou cole um link.'
          : 'Pesquise vídeos e playlists ou cole um link acima.'}</p>}
        {results.map((entry) => <button className="youtube-result-item" key={`${entry.kind}-${entry.id}`}
          disabled={busy} onClick={() => void chooseResult(entry)}>
          {entry.kind === 'video' || entry.thumbnailVideoId ? <img src={`https://i.ytimg.com/vi/${entry.kind === 'video' ? entry.id : entry.thumbnailVideoId}/mqdefault.jpg`} alt="" loading="lazy" /> :
            <span className="youtube-result-playlist"><ListVideo size={18} /></span>}
          <span><strong>{entry.title}</strong><small>{entry.kind === 'playlist' ? `Playlist${entry.count ? ` · ${entry.count} vídeos` : ''}` : 'Vídeo'}</small></span>
          <Plus size={15} />
        </button>)}
      </div>
    </aside>
  </div>;
};
