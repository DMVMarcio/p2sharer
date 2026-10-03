import { invoke } from '@tauri-apps/api/core';

export async function resolveCaptureSource(requested?: string): Promise<string> {
  const sources = await invoke<{ monitors: { id: string; is_primary?: boolean }[];
    windows: { id: string }[] }>('list_screen_sources');
  if (requested) {
    if (![...sources.monitors, ...sources.windows].some(source => source.id === requested)) {
      throw new Error('Requested capture source is unavailable; enumerate sources on this computer.');
    }
    return requested;
  }
  const monitor = sources.monitors.find(source => source.is_primary) ?? sources.monitors[0];
  if (!monitor) throw new Error('This manual benchmark requires an interactive Windows desktop.');
  return monitor.id;
}
