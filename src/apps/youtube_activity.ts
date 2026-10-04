import { t } from '../i18n/index.ts';
import type { YouTubeState } from './types';
import { projectYouTubePosition } from './youtube_timeline.ts';

export function describeAutomaticYouTubeActivity(previous: YouTubeState, next: YouTubeState): string | null {
  if (next.syncReason !== 'auto-advance') return null;
  const entry = next.queue[next.index];
  if (!entry || next.ended || !next.playing) return t("message.4bd1fc61bf0e");
  if (previous.repeat === 'one') return t("message.b0954ef45804", { v0: entry.title });
  return t("message.29069cb10afc", { v0: entry.title });
}

export function describeYouTubeActivity(previous: YouTubeState, next: YouTubeState,
  previousReceivedAt = Date.now(), now = Date.now()): string | null {
  if (next.syncReason === 'heartbeat') return null;
  if (next.syncReason === 'auto-advance') return null;
  if (next.syncReason === 'queue-replace') return t("message.e5b0c4a90937", { v0: next.queue.length });

  const added = Math.max(0, next.queue.length - previous.queue.length);
  if (added === 1) return t("message.3b6d5e5911dc", { v0: next.queue[next.queue.length - 1].title });
  if (added > 1) return t("message.32d47c37560c", { v0: added });

  if (previous.repeat !== next.repeat) return next.repeat === 'all'
    ? t("message.dbde753e45a4") : next.repeat === 'one'
      ? t("message.e9c27e03e673") : t("message.4db8f92d5395");
  if (previous.shuffle !== next.shuffle) return next.shuffle
    ? t("message.a61f099aee43") : t("message.17551e1b6b27");
  if (previous.removePlayed !== next.removePlayed) return next.removePlayed
    ? t("message.af5333d04f32") : t("message.a67a86d23850");

  if (next.syncReason === 'update' && next.queue.length < previous.queue.length) {
    const removedCount = previous.queue.length - next.queue.length;
    if (removedCount > 1) return t("message.109863ccfe7b", { v0: removedCount });
    const removedIndex = previous.queue.findIndex((entry, index) =>
      next.queue[index]?.videoId !== entry.videoId);
    const removed = previous.queue[removedIndex];
    if (removed) return t("message.6b62c35c51b7", { v0: removed.title });
  }

  const before = previous.queue[previous.index];
  const after = next.queue[next.index];
  if (before && after && before.videoId !== after.videoId)
    return t("message.536b48cecec6", { v0: after.title });

  const previousPosition = projectYouTubePosition(previous.position, previous.playing, previousReceivedAt, now);
  if (before && after && next.syncReason === 'seek' && Math.abs(next.position - previousPosition) >= 1)
    return next.position > previousPosition ? t("message.86f46ac2bbaa") : t("message.ca667c39fb52");

  if (before && after && next.syncReason === 'playback' && previous.playing !== next.playing)
    return next.playing ? t("message.0c935b7a8364") : t("message.81c26db279ff");

  return null;
}
