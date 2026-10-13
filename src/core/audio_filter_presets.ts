/** Native capture accepts executable names with or without their extension. */
export const DEFAULT_AUDIO_EXCLUSIONS = ['discord', 'discord.exe', 'p2sharer', 'p2sharer.exe'] as const;
export type AudioCaptureChoice = 'full' | 'exclude' | 'include' | 'none';
export function audioProcessKey(name: string): string { return name.toLowerCase().trim().replace(/\.exe$/, ''); }
