import { invoke, isTauri } from '@tauri-apps/api/core';

/** Discover interface-specific candidates without requesting microphone/camera access. */
export async function withLocalInterfaceStun(configuration: RTCConfiguration,
  discover: () => Promise<string[]> = () => isTauri() ? invoke('get_interface_stun_servers') : Promise.resolve([]),
): Promise<RTCConfiguration> {
  // A relay-only configuration must never acquire direct interface candidates.
  if (configuration.iceTransportPolicy === 'relay') return configuration;
  try {
    const urls = await discover();
    return urls.length ? { ...configuration,
      iceServers: [...(configuration.iceServers ?? []), { urls }],
    } : configuration;
  } catch {
    console.warn('[P2P/ICE Diagnostics] Local interface discovery unavailable');
    return configuration;
  }
}
