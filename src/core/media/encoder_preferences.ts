export type EncoderPreference = 'auto' | 'generic' | 'nvenc';
export interface NativeEncoderSupport { driver_api_available: boolean; experimental_enabled: boolean; reason: string | null }
const STORAGE_KEY = 'p2sharer_video_encoder';
export function normalizeEncoderPreference(value: string | null, nvencAvailable?: boolean): EncoderPreference {
  if (value === 'generic') return 'generic';
  if (value === 'nvenc' && nvencAvailable !== false) return 'nvenc';
  return 'auto';
}
export function getEncoderPreference(nvencAvailable?: boolean): EncoderPreference {
  if (typeof localStorage === 'undefined') return 'auto';
  const saved = localStorage.getItem(STORAGE_KEY);
  const value = normalizeEncoderPreference(saved, nvencAvailable);
  if (saved !== null && saved !== value) localStorage.setItem(STORAGE_KEY, value);
  return value;
}
export function saveEncoderPreference(value: EncoderPreference): void {
  localStorage.setItem(STORAGE_KEY, normalizeEncoderPreference(value));
}
