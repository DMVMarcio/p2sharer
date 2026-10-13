/** Native capture accepts executable names with or without their extension. */
export const DEFAULT_AUDIO_EXCLUSIONS = ['discord', 'discord.exe', 'p2sharer', 'p2sharer.exe'] as const;
export type AudioCaptureChoice = 'full' | 'exclude' | 'include' | 'none';
export function audioProcessKey(name: string): string { return name.toLowerCase().trim().replace(/\.exe$/, ''); }

/** Presentation labels never change the executable identity used for filtering. */
export function audioProcessLabels(name: string, windowTitle?: string) {
  const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
  const executable = name.trim();
  return {
    title: capitalize(windowTitle?.trim() || executable.replace(/\.exe$/i, '')),
    executable: capitalize(executable),
  };
}
