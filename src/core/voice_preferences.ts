export type NoiseSuppressionMode = 'off' | 'standard' | 'high';

export interface VoicePreferences {
  inputDeviceId: string;
  outputDeviceId: string;
  inputVolume: number;
  outputVolume: number;
  noiseSuppressionMode: NoiseSuppressionMode;
  echoCancellation: boolean;
  autoGainControl: boolean;
  autoSensitivity: boolean;
  sensitivityDb: number;
}

export interface UserVoiceVolumePreference {
  volume: number;
  muted: boolean;
}

export interface VoicePeerState {
  peerId: string;
  inVoice: boolean;
  muted: boolean;
  deafened: boolean;
  speaking: boolean;
}

export interface VoiceMuteDeafenState {
  micMuted: boolean;
  deafened: boolean;
  micMutedBeforeDeafen: boolean;
}

export const VOICE_PREFERENCES_STORAGE_KEY = 'p2sharer_voice_preferences_v1';
export const USER_VOICE_VOLUMES_STORAGE_KEY = 'p2sharer_voice_user_volumes_v1';

export const DEFAULT_VOICE_PREFERENCES: VoicePreferences = {
  inputDeviceId: 'default',
  outputDeviceId: 'default',
  inputVolume: 100,
  outputVolume: 100,
  noiseSuppressionMode: 'standard',
  echoCancellation: false,
  autoGainControl: false,
  autoSensitivity: true,
  sensitivityDb: -50,
};

export function clampVoiceVolume(value: number): number {
  if (!Number.isFinite(value)) return 100;
  return Math.max(0, Math.min(200, Math.round(value)));
}

export function clampSensitivityDb(value: number): number {
  if (!Number.isFinite(value)) return -50;
  return Math.max(-100, Math.min(0, Math.round(value)));
}

export function normalizeVoicePreferences(raw: unknown): VoicePreferences {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_VOICE_PREFERENCES };
  }
  const record = raw as Record<string, unknown>;
  const inputDeviceId = typeof record.inputDeviceId === 'string' && record.inputDeviceId.trim()
    ? record.inputDeviceId.trim()
    : DEFAULT_VOICE_PREFERENCES.inputDeviceId;
  const outputDeviceId = typeof record.outputDeviceId === 'string' && record.outputDeviceId.trim()
    ? record.outputDeviceId.trim()
    : DEFAULT_VOICE_PREFERENCES.outputDeviceId;
  const noiseSuppressionMode: NoiseSuppressionMode =
    record.noiseSuppressionMode === 'off' ||
    record.noiseSuppressionMode === 'standard' ||
    record.noiseSuppressionMode === 'high'
      ? record.noiseSuppressionMode
      : DEFAULT_VOICE_PREFERENCES.noiseSuppressionMode;

  return {
    inputDeviceId,
    outputDeviceId,
    inputVolume: typeof record.inputVolume === 'number'
      ? clampVoiceVolume(record.inputVolume)
      : DEFAULT_VOICE_PREFERENCES.inputVolume,
    outputVolume: typeof record.outputVolume === 'number'
      ? clampVoiceVolume(record.outputVolume)
      : DEFAULT_VOICE_PREFERENCES.outputVolume,
    noiseSuppressionMode,
    echoCancellation: typeof record.echoCancellation === 'boolean'
      ? record.echoCancellation
      : DEFAULT_VOICE_PREFERENCES.echoCancellation,
    autoGainControl: typeof record.autoGainControl === 'boolean'
      ? record.autoGainControl
      : DEFAULT_VOICE_PREFERENCES.autoGainControl,
    autoSensitivity: typeof record.autoSensitivity === 'boolean'
      ? record.autoSensitivity
      : DEFAULT_VOICE_PREFERENCES.autoSensitivity,
    sensitivityDb: typeof record.sensitivityDb === 'number'
      ? clampSensitivityDb(record.sensitivityDb)
      : DEFAULT_VOICE_PREFERENCES.sensitivityDb,
  };
}

export function loadVoicePreferences(
  storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage,
): VoicePreferences {
  if (!storage) return { ...DEFAULT_VOICE_PREFERENCES };
  try {
    const raw = storage.getItem(VOICE_PREFERENCES_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_VOICE_PREFERENCES };
    return normalizeVoicePreferences(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_VOICE_PREFERENCES };
  }
}

export function saveVoicePreferences(
  prefs: VoicePreferences,
  storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage,
): VoicePreferences {
  const normalized = normalizeVoicePreferences(prefs);
  if (!storage) return normalized;
  try {
    storage.setItem(VOICE_PREFERENCES_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // Ignore storage quota or restricted browsing errors cleanly.
  }
  return normalized;
}

export function getUserVoicePreferenceKey(publicKey?: string, username?: string): string | undefined {
  const cleanKey = typeof publicKey === 'string' ? publicKey.trim() : '';
  if (cleanKey) return `pk:${cleanKey}`;
  const cleanName = typeof username === 'string' ? username.trim().toLowerCase() : '';
  if (cleanName) return `name:${cleanName}`;
  return undefined;
}

function readAllUserVoiceVolumes(
  storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage,
): Record<string, UserVoiceVolumePreference> {
  if (!storage) return {};
  try {
    const raw = storage.getItem(USER_VOICE_VOLUMES_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const clean: Record<string, UserVoiceVolumePreference> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const entry = value as Record<string, unknown>;
      if (typeof entry.volume === 'number' && typeof entry.muted === 'boolean') {
        clean[key] = {
          volume: clampVoiceVolume(entry.volume),
          muted: entry.muted,
        };
      }
    }
    return clean;
  } catch {
    return {};
  }
}

export function getSavedUserVoiceVolume(
  publicKey?: string,
  username?: string,
  storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage,
): UserVoiceVolumePreference {
  const map = readAllUserVoiceVolumes(storage);
  const pkKey = getUserVoicePreferenceKey(publicKey, undefined);
  if (pkKey && map[pkKey]) {
    return { ...map[pkKey] };
  }
  const nameKey = getUserVoicePreferenceKey(undefined, username);
  if (nameKey && map[nameKey]) {
    return { ...map[nameKey] };
  }
  return { volume: 100, muted: false };
}

export function saveUserVoiceVolume(
  publicKey: string | undefined,
  username: string | undefined,
  volume: number,
  muted: boolean,
  storage: Pick<Storage, 'getItem' | 'setItem'> | undefined = globalThis.localStorage,
): UserVoiceVolumePreference {
  const normalized: UserVoiceVolumePreference = {
    volume: clampVoiceVolume(volume),
    muted: Boolean(muted),
  };
  const primaryKey = getUserVoicePreferenceKey(publicKey, username);
  if (!primaryKey || !storage) return normalized;
  try {
    const current = readAllUserVoiceVolumes(storage);
    current[primaryKey] = normalized;
    if (primaryKey.startsWith('pk:')) {
      const nameKey = getUserVoicePreferenceKey(undefined, username);
      if (nameKey && nameKey in current) {
        delete current[nameKey];
      }
    }
    storage.setItem(USER_VOICE_VOLUMES_STORAGE_KEY, JSON.stringify(current));
  } catch {
    // Ignore storage quota or restricted browsing errors cleanly.
  }
  return normalized;
}

export function computeNextVoiceMuteDeafen(
  current: VoiceMuteDeafenState,
  action: 'toggleMute' | 'toggleDeafen' | 'setMuted' | 'setDeafened',
  value?: boolean,
): VoiceMuteDeafenState {
  if (action === 'toggleDeafen' || action === 'setDeafened') {
    const targetDeafened = action === 'toggleDeafen' ? !current.deafened : Boolean(value);
    if (targetDeafened === current.deafened) {
      return {
        micMuted: current.deafened ? true : current.micMuted,
        deafened: current.deafened,
        micMutedBeforeDeafen: current.micMutedBeforeDeafen,
      };
    }
    if (targetDeafened) {
      return {
        micMuted: true,
        deafened: true,
        micMutedBeforeDeafen: current.micMuted,
      };
    }
    return {
      micMuted: current.micMutedBeforeDeafen,
      deafened: false,
      micMutedBeforeDeafen: current.micMutedBeforeDeafen,
    };
  }

  const targetMuted = action === 'toggleMute' ? !current.micMuted : Boolean(value);
  if (!targetMuted && current.deafened) {
    return {
      micMuted: false,
      deafened: false,
      micMutedBeforeDeafen: false,
    };
  }
  return {
    micMuted: targetMuted,
    deafened: current.deafened,
    micMutedBeforeDeafen: current.deafened ? current.micMutedBeforeDeafen : targetMuted,
  };
}
