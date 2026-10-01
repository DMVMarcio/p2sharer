import { projectMediaPosition } from '../core/media_sync.ts';
import type { YouTubeState } from './types.ts';

export const YOUTUBE_MAX_POSITION_SECONDS = 10 * 365 * 24 * 60 * 60;
export const projectYouTubePosition = (position: number, playing: boolean, receivedAt: number, now: number) =>
  projectMediaPosition(position, playing, receivedAt, now, YOUTUBE_MAX_POSITION_SECONDS);

export function markCurrentYouTubeLive(state: YouTubeState, live: boolean): YouTubeState {
  const entry = state.queue[state.index];
  if (!live || !entry || entry.isLive) return state;
  return { ...state, queue: state.queue.map((item, index) => index === state.index ? { ...item, isLive: true } : item) };
}

export function preserveYouTubeTimeline(previous: YouTubeState, next: YouTubeState,
  receivedAt: number, now: number): YouTubeState {
  if ((next.syncReason ?? 'update') !== 'update' ||
    !previous.queue[previous.index] || previous.queue[previous.index].videoId !== next.queue[next.index]?.videoId ||
    previous.playing !== next.playing || previous.position !== next.position) return next;
  // Queue metadata does not create a new playback sample. Carry elapsed time
  // forward before the model starts the clock for this publication.
  return { ...next, position: projectYouTubePosition(previous.position, previous.playing, receivedAt, now) };
}
