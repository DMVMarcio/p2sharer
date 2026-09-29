import type { YouTubeState } from './types';
import { projectMediaPosition } from '../core/media_sync.ts';

export function describeYouTubeActivity(previous: YouTubeState, next: YouTubeState,
  previousReceivedAt = Date.now(), now = Date.now()): string | null {
  if (next.syncReason === 'heartbeat') return null;

  const added = Math.max(0, next.queue.length - previous.queue.length);
  if (added === 1) return `adicionou “${next.queue[next.queue.length - 1].title}” à fila`;
  if (added > 1) return `adicionou ${added} vídeos à fila`;

  const before = previous.queue[previous.index];
  const after = next.queue[next.index];
  if (before && after && before.videoId !== after.videoId)
    return `reproduziu “${after.title}”`;

  const previousPosition = projectMediaPosition(previous.position, previous.playing, previousReceivedAt, now);
  if (before && after && next.syncReason === 'seek' && Math.abs(next.position - previousPosition) >= 1)
    return next.position > previousPosition ? 'avançou o vídeo' : 'voltou no vídeo';

  if (before && after && next.syncReason === 'playback' && previous.playing !== next.playing)
    return next.playing ? 'retomou o vídeo' : 'pausou o vídeo';

  return null;
}
