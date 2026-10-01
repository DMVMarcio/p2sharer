import { MEDIA_SYNC_MAX_SAMPLE_AGE_MS, shouldCorrectMediaPosition } from '../core/media_sync.ts';
import { projectYouTubePosition } from './youtube_timeline.ts';
import type { YouTubeState } from './types.ts';

type PlayerEvent = { data: number };
export interface YouTubePlayer {
  loadVideoById(id: string, startSeconds?: number): void;
  cueVideoById(id: string, startSeconds?: number): void;
  playVideo(): void;
  pauseVideo(): void;
  stopVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  getVideoLoadedFraction(): number;
  getPlayerState(): number;
  getVideoData(): { video_id?: string; title?: string };
  setVolume(volume: number): void;
  getVolume(): number;
  mute(): void;
  unMute(): void;
  isMuted(): boolean;
  getOptions?(module?: string): string[];
  getOption?(module: string, option: string): unknown;
  setOption?(module: string, option: string, value: unknown): void;
  loadModule?(module: string): void;
  unloadModule?(module: string): void;
  destroy(): void;
}

export interface YouTubePlaybackTracker {
  videoId: string;
  lastLoadAt: number;
  lastPlayAttemptAt: number;
  lastCorrectionAt: number;
  live?: boolean;
  durationSample?: number;
  durationSampleAt?: number;
  initialPlaybackKey?: string;
  lastLiveSeekKey?: string;
}

export function sampleYouTubeLive(player: YouTubePlayer, tracker: YouTubePlaybackTracker, now: number): boolean {
  if (player.getVideoData().video_id !== tracker.videoId) return false;
  const duration = player.getDuration?.();
  if (!Number.isFinite(duration) || duration <= 0) return Boolean(tracker.live);
  const elapsed = (now - (tracker.durationSampleAt ?? now)) / 1000;
  const growth = duration - (tracker.durationSample ?? duration);
  // The documented live duration grows with the broadcast clock. Ignore the
  // initial metadata load and small rounding changes of fixed-duration videos.
  if (elapsed >= 1 && growth >= 0.5 && growth <= elapsed * 1.5 + 2) tracker.live = true;
  if (tracker.durationSampleAt === undefined || elapsed >= 1) {
    tracker.durationSample = duration;
    tracker.durationSampleAt = now;
  }
  return Boolean(tracker.live);
}

export function reconcileYouTubePlayer(player: YouTubePlayer, state: YouTubeState,
  tracker: YouTubePlaybackTracker, receivedAt: number, now: number,
  mode: 'urgent' | 'update' | 'periodic' | 'resume'): { corrected: boolean; loaded: boolean; position: number } {
  const entry = state.queue[state.index];
  if (!entry) {
    if (tracker.videoId) player.stopVideo();
    tracker.videoId = '';
    tracker.live = false;
    tracker.durationSample = undefined;
    tracker.durationSampleAt = undefined;
    return { corrected: false, loaded: false, position: 0 };
  }
  if (mode === 'periodic' && now - receivedAt > MEDIA_SYNC_MAX_SAMPLE_AGE_MS)
    return { corrected: false, loaded: false, position: state.position };

  const position = projectYouTubePosition(state.position, state.playing, receivedAt, now);
  const actualId = player.getVideoData().video_id;
  const playbackKey = `${state.updatedAt}:${state.index}:${state.syncReason}:${state.position}`;
  if (tracker.videoId !== entry.videoId ||
    (actualId !== entry.videoId && now - tracker.lastLoadAt >= 2500)) {
    if (tracker.videoId !== entry.videoId) {
      tracker.live = Boolean(entry.isLive);
      tracker.durationSample = undefined;
      tracker.durationSampleAt = undefined;
      tracker.lastLiveSeekKey = undefined;
    }
    tracker.videoId = entry.videoId;
    tracker.lastLoadAt = now;
    tracker.lastPlayAttemptAt = now;
    tracker.lastCorrectionAt = now;
    tracker.initialPlaybackKey = playbackKey;
    tracker.lastLiveSeekKey = playbackKey;
    // Let YouTube select its default live edge instead of asking for second 0.
    const start = (position > 0 && !tracker.live) || (tracker.live && state.syncReason === 'seek') ? position : undefined;
    if (state.playing) player.loadVideoById(entry.videoId, start);
    else player.cueVideoById(entry.videoId, start);
    return { corrected: true, loaded: true, position };
  }

  if (actualId !== entry.videoId) return { corrected: false, loaded: false, position };
  const live = Boolean(entry.isLive || sampleYouTubeLive(player, tracker, now));
  if (live) tracker.live = true;
  const playerState = player.getPlayerState();
  let corrected = false;
  const metadataOnly = mode === 'update' && (state.syncReason === undefined || state.syncReason === 'update');
  const explicitLiveSeek = live && (mode === 'urgent' || mode === 'resume') && state.syncReason === 'seek' && tracker.lastLiveSeekKey !== playbackKey;
  const awaitingFirstSample = tracker.initialPlaybackKey === playbackKey && state.position === 0;
  const allowCorrection = live ? explicitLiveSeek : !awaitingFirstSample;
  if (allowCorrection && !metadataOnly && !state.ended && playerState !== 3 && shouldCorrectMediaPosition(player.getCurrentTime(), position,
    mode === 'urgent' || explicitLiveSeek, mode === 'resume' ? 0 : tracker.lastCorrectionAt, now)) {
    player.seekTo(position, true);
    tracker.lastCorrectionAt = now;
    if (live) tracker.lastLiveSeekKey = playbackKey;
    corrected = true;
  }
  if (explicitLiveSeek && playerState !== 3) tracker.lastLiveSeekKey = playbackKey;
  if (state.playing && playerState !== 1 && playerState !== 3 &&
    (mode === 'urgent' || playerState === 5 || now - tracker.lastPlayAttemptAt >= 1500)) {
    tracker.lastPlayAttemptAt = now;
    player.playVideo();
  }
  if (!state.playing && playerState !== 2 && playerState !== 5 && playerState !== -1)
    player.pauseVideo();
  return { corrected, loaded: false, position };
}

export function setYouTubeCaptions(player: YouTubePlayer, enabled: boolean): void {
  try {
    const available = player.getOptions?.().includes('captions') || false;
    if (!enabled) {
      if (available) {
        player.setOption?.('captions', 'track', {});
        player.unloadModule?.('captions');
      }
      return;
    }
    if (!available) {
      player.loadModule?.('captions');
      return;
    }
    const tracks = player.getOption?.('captions', 'tracklist');
    if (Array.isArray(tracks)) {
      const preferred = navigator.language.split('-')[0];
      const track = tracks.find((entry) => entry?.languageCode === preferred) || tracks[0];
      if (track?.languageCode) player.setOption?.('captions', 'track', { languageCode: track.languageCode });
    }
  } catch { /* YouTube may not expose caption controls for every video. */ }
}

declare global {
  interface Window {
    YT?: { Player: new (element: HTMLElement, options: Record<string, unknown>) => YouTubePlayer };
    onYouTubeIframeAPIReady?: () => void;
  }
}

let loading: Promise<void> | null = null;
export function loadYouTubePlayerApi(): Promise<void> {
  if (window.YT?.Player) return Promise.resolve();
  if (!loading) loading = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.onerror = () => reject(new Error('Não foi possível carregar o player do YouTube'));
    window.onYouTubeIframeAPIReady = () => resolve();
    document.head.appendChild(script);
  });
  return loading;
}

export function createYouTubePlayer(element: HTMLElement, onStateChange: (event: PlayerEvent) => void,
  onReady: () => void, onApiChange?: () => void): YouTubePlayer {
  if (!window.YT) throw new Error('Player indisponível');
  return new window.YT.Player(element, {
    width: '100%', height: '100%',
    playerVars: { playsinline: 1, origin: window.location.origin, rel: 0, controls: 0,
      disablekb: 1, iv_load_policy: 3, cc_load_policy: 0 },
    events: { onStateChange, onReady, onApiChange },
  });
}
