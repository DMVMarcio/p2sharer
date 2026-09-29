export const MEDIA_SYNC_INTERVAL_MS = 10_000;
export const MEDIA_SYNC_DRIFT_SECONDS = 4;
export const MEDIA_SYNC_EVENT_DRIFT_SECONDS = 0.75;
export const MEDIA_SYNC_SEEK_COOLDOWN_MS = 8_000;
export const MEDIA_SYNC_MAX_SAMPLE_AGE_MS = 30_000;

export function projectMediaPosition(position: number, playing: boolean,
  receivedAt: number, now: number): number {
  const elapsed = Number.isFinite(receivedAt) && Number.isFinite(now)
    ? Math.max(0, now - receivedAt) / 1000 : 0;
  return Math.max(0, Math.min(86_400, position + (playing ? elapsed : 0)));
}

export function shouldCorrectMediaPosition(actual: number, expected: number,
  urgent: boolean, lastCorrectionAt: number, now: number): boolean {
  if (!Number.isFinite(actual) || !Number.isFinite(expected) || expected < 0) return false;
  const tolerance = urgent ? MEDIA_SYNC_EVENT_DRIFT_SECONDS : MEDIA_SYNC_DRIFT_SECONDS;
  if (Math.abs(actual - expected) <= tolerance) return false;
  return urgent || now - lastCorrectionAt >= MEDIA_SYNC_SEEK_COOLDOWN_MS;
}
