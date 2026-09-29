export interface PipAudioSettings {
  volume: number;
  muted: boolean;
}

export function validPipAudioSettings(value: unknown): value is PipAudioSettings {
  if (!value || typeof value !== 'object') return false;
  const settings = value as Partial<PipAudioSettings>;
  return typeof settings.volume === 'number' && Number.isFinite(settings.volume) &&
    settings.volume >= 0 && settings.volume <= 100 && typeof settings.muted === 'boolean';
}
