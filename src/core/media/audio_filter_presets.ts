/** Native capture accepts executable names with or without their extension. */
export const DEFAULT_AUDIO_EXCLUSIONS = ['p2sharer', 'p2sharer.exe'] as const;
export const DEFAULT_AUDIO_SUB_EXCLUSIONS = ['discord:voice_audio'] as const;
export type AudioCaptureChoice = 'full' | 'exclude' | 'include' | 'none';
export function audioProcessKey(name: string): string { return name.toLowerCase().trim().replace(/\.exe$/, ''); }

export function audioSubProcessKey(appName: string, sub: { stable_id?: string; window_title?: string; is_root?: boolean; pid: number }): string {
  const appKey = audioProcessKey(appName);
  if (sub.stable_id) {
    return `${appKey}:${sub.stable_id}`;
  }
  if (sub.is_root) {
    return `${appKey}:main`;
  }
  if (sub.window_title && sub.window_title.trim()) {
    return `${appKey}:title:${sub.window_title.trim().toLowerCase()}`;
  }
  return `${appKey}:pid:${sub.pid}`;
}

/** Presentation labels never change the executable identity used for filtering. */
export function audioProcessLabels(name: string, windowTitle?: string) {
  const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
  const executable = name.trim();
  return {
    title: capitalize(windowTitle?.trim() || executable.replace(/\.exe$/i, '')),
    executable: capitalize(executable),
  };
}
