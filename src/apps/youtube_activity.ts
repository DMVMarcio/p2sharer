import type { YouTubeState } from './types';
import { projectYouTubePosition } from './youtube_timeline.ts';

export function describeAutomaticYouTubeActivity(previous: YouTubeState, next: YouTubeState): string | null {
  if (next.syncReason !== 'auto-advance') return null;
  const entry = next.queue[next.index];
  if (!entry || next.ended || !next.playing) return 'Fila de reprodução concluída.';
  if (previous.repeat === 'one') return `Repetindo automaticamente “${entry.title}”.`;
  return `Reprodução automática: “${entry.title}”.`;
}

export function describeYouTubeActivity(previous: YouTubeState, next: YouTubeState,
  previousReceivedAt = Date.now(), now = Date.now()): string | null {
  if (next.syncReason === 'heartbeat') return null;
  if (next.syncReason === 'auto-advance') return null;
  if (next.syncReason === 'queue-replace') return `substituiu a fila por ${next.queue.length} vídeos`;

  const added = Math.max(0, next.queue.length - previous.queue.length);
  if (added === 1) return `adicionou “${next.queue[next.queue.length - 1].title}” à fila`;
  if (added > 1) return `adicionou ${added} vídeos à fila`;

  if (previous.repeat !== next.repeat) return next.repeat === 'all'
    ? 'ativou a repetição da fila' : next.repeat === 'one'
      ? 'ativou a repetição de um vídeo' : 'desativou a repetição';
  if (previous.shuffle !== next.shuffle) return next.shuffle
    ? 'ativou a ordem aleatória' : 'desativou a ordem aleatória';
  if (previous.removePlayed !== next.removePlayed) return next.removePlayed
    ? 'ativou a remoção automática' : 'desativou a remoção automática';

  if (next.syncReason === 'update' && next.queue.length < previous.queue.length) {
    const removedCount = previous.queue.length - next.queue.length;
    if (removedCount > 1) return `removeu ${removedCount} vídeos da fila`;
    const removedIndex = previous.queue.findIndex((entry, index) =>
      next.queue[index]?.videoId !== entry.videoId);
    const removed = previous.queue[removedIndex];
    if (removed) return `removeu “${removed.title}” da fila`;
  }

  const before = previous.queue[previous.index];
  const after = next.queue[next.index];
  if (before && after && before.videoId !== after.videoId)
    return `reproduziu “${after.title}”`;

  const previousPosition = projectYouTubePosition(previous.position, previous.playing, previousReceivedAt, now);
  if (before && after && next.syncReason === 'seek' && Math.abs(next.position - previousPosition) >= 1)
    return next.position > previousPosition ? 'avançou o vídeo' : 'voltou no vídeo';

  if (before && after && next.syncReason === 'playback' && previous.playing !== next.playing)
    return next.playing ? 'retomou o vídeo' : 'pausou o vídeo';

  return null;
}
