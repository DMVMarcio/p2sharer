import type { RoomSlotInfo } from '../types.ts';

export const STREAM_VOLUME_STORAGE_KEY = 'p2sharer_stream_volumes_v1';
const MAX_SAVED_VOLUMES = 200;

export interface SavedVolumePreference {
  volume: number;
  isMuted: boolean;
  updatedAt?: number;
}

const sessionAppVolumes = new Map<string, { volume: number; isMuted: boolean }>();

function clampVolume(volume: number): number {
  if (!Number.isFinite(volume)) return 100;
  return Math.max(0, Math.min(100, Math.round(volume)));
}

/** Builds a stable cross-session preference key from the broadcaster identity and shared screen/camera label. */
export function getStreamVolumePreferenceKey(slot: Pick<RoomSlotInfo, 'isLocal' | 'ownerPublicKey' | 'senderName' | 'mediaKind' | 'mediaLabel'>): string | undefined {
  if (slot.isLocal) return undefined;
  const ownerKey = slot.ownerPublicKey
    ? `pk:${slot.ownerPublicKey}`
    : `name:${(slot.senderName || '').trim().toLowerCase()}`;
  const kind = slot.mediaKind || 'screen';
  const label = (slot.mediaLabel || 'default').trim().toLowerCase();
  if (!ownerKey || ownerKey === 'name:') return undefined;
  return `${ownerKey}|${kind}:${label}`;
}

function readAllSavedVolumes(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): Record<string, SavedVolumePreference> {
  if (!storage) return {};
  try {
    const raw = storage.getItem(STREAM_VOLUME_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const clean: Record<string, SavedVolumePreference> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!value || typeof value !== 'object') continue;
      const entry = value as Record<string, unknown>;
      if (typeof entry.volume === 'number' && typeof entry.isMuted === 'boolean') {
        clean[key] = {
          volume: clampVolume(entry.volume),
          isMuted: entry.isMuted,
          updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : 0,
        };
      }
    }
    return clean;
  } catch {
    return {};
  }
}

export function getSavedStreamVolume(
  key: string | undefined,
  storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage,
): { volume: number; isMuted: boolean } | null {
  if (!key) return null;
  const map = readAllSavedVolumes(storage);
  const found = map[key];
  return found ? { volume: found.volume, isMuted: found.isMuted } : null;
}

export function saveStreamVolume(
  key: string | undefined,
  volume: number,
  isMuted: boolean,
  storage: Pick<Storage, 'getItem' | 'setItem'> | undefined = globalThis.localStorage,
): void {
  if (!key || !storage) return;
  try {
    const current = readAllSavedVolumes(storage);
    current[key] = {
      volume: clampVolume(volume),
      isMuted: Boolean(isMuted),
      updatedAt: Date.now(),
    };
    const entries = Object.entries(current);
    if (entries.length > MAX_SAVED_VOLUMES) {
      entries.sort((a, b) => (b[1].updatedAt ?? 0) - (a[1].updatedAt ?? 0));
      const trimmed = Object.fromEntries(entries.slice(0, MAX_SAVED_VOLUMES));
      storage.setItem(STREAM_VOLUME_STORAGE_KEY, JSON.stringify(trimmed));
      return;
    }
    storage.setItem(STREAM_VOLUME_STORAGE_KEY, JSON.stringify(current));
  } catch {
    // Ignore storage quota or private browsing errors cleanly.
  }
}

export function getSessionAppVolume(appKey: string | undefined): { volume: number; isMuted: boolean } | null {
  if (!appKey) return null;
  const entry = sessionAppVolumes.get(appKey);
  return entry ? { ...entry } : null;
}

export function saveSessionAppVolume(appKey: string | undefined, volume: number, isMuted: boolean): void {
  if (!appKey) return;
  sessionAppVolumes.set(appKey, {
    volume: clampVolume(volume),
    isMuted: Boolean(isMuted),
  });
}

export function clearSessionAppVolumes(): void {
  sessionAppVolumes.clear();
}
