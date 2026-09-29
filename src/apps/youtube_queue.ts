import type { YouTubeState } from './types';

export function moveYouTubeQueueEntry(state: YouTubeState, from: number, to: number): YouTubeState {
  if (from < 0 || from >= state.queue.length || to < 0 || to >= state.queue.length || from === to)
    return state;
  const queue = [...state.queue];
  const [entry] = queue.splice(from, 1);
  queue.splice(to, 0, entry);
  let index = state.index;
  if (index === from) index = to;
  else if (from < index && to >= index) index--;
  else if (from > index && to <= index) index++;
  return { ...state, queue, index };
}

export function advanceYouTubeQueue(state: YouTubeState, manual = false,
  random: () => number = Math.random): YouTubeState {
  if (!state.queue.length) return state;
  if (!manual && state.repeat === 'one') return { ...state, position: 0, playing: true };
  const queue = state.removePlayed ? state.queue.filter((_, index) => index !== state.index) : [...state.queue];
  if (!queue.length) return { ...state, queue, index: 0, position: 0, playing: false };
  let index = state.removePlayed ? state.index : state.index + 1;
  if (index >= queue.length) {
    if (state.repeat !== 'all' || state.removePlayed)
      return { ...state, queue, index: Math.max(0, queue.length - 1), position: 0, playing: false };
    index = 0;
  }
  if (state.shuffle && queue.length > 1) {
    const next = index + Math.floor(Math.min(0.999999, Math.max(0, random())) * (queue.length - index));
    [queue[index], queue[next]] = [queue[next], queue[index]];
  }
  return { ...state, queue, index, position: 0, playing: true };
}

export function canAdvanceYouTubeQueue(state: YouTubeState): boolean {
  return state.queue.length > 1 && (state.index < state.queue.length - 1 ||
    (state.repeat === 'all' && !state.removePlayed));
}
