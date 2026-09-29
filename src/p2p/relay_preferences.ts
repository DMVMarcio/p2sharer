import { defaultRelayUrls as defaultNostrUrls } from '@trystero-p2p/nostr';
import { defaultRelayUrls as defaultTorrentUrls } from '@trystero-p2p/torrent';
import type { SignalingTransport } from '../core/types.ts';

export interface RendezvousServer {
  url: string;
  enabled: boolean;
}

export type RendezvousPreferences = Record<SignalingTransport, RendezvousServer[]>;

const STORAGE_KEY = 'p2sharer_rendezvous_servers_v1';

export const DEFAULT_MQTT_RELAY_URLS = [
  'wss://public:public@public.cloud.shiftr.io',
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker-cn.emqx.io:8084/mqtt',
  'wss://test.mosquitto.org:8081/mqtt',
];

const defaults: Record<SignalingTransport, string[]> = {
  mqtt: DEFAULT_MQTT_RELAY_URLS,
  nostr: defaultNostrUrls,
  torrent: defaultTorrentUrls,
};

export function defaultRendezvousPreferences(): RendezvousPreferences {
  return {
    mqtt: defaults.mqtt.map((url) => ({ url, enabled: true })),
    nostr: defaults.nostr.map((url) => ({ url, enabled: true })),
    torrent: defaults.torrent.map((url) => ({ url, enabled: true })),
  };
}

export function normalizeRendezvousUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'wss:' || !url.hostname || url.hash) return null;
    return url.href.replace(/\/$/, value.trim().endsWith('/') ? '/' : '');
  } catch {
    return null;
  }
}

export function validateRendezvousPreferences(value: RendezvousPreferences): string | null {
  let enabled = 0;
  for (const transport of ['mqtt', 'nostr', 'torrent'] as const) {
    const seen = new Set<string>();
    for (const server of value[transport]) {
      const url = normalizeRendezvousUrl(server.url);
      if (!url) return `URL inválida em ${transport.toUpperCase()}. Use wss://.`;
      if (seen.has(url)) return `Servidor duplicado em ${transport.toUpperCase()}.`;
      seen.add(url);
      if (server.enabled) enabled++;
    }
  }
  return enabled ? null : 'Habilite ao menos um servidor de encontro.';
}

export function loadRendezvousPreferences(): RendezvousPreferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultRendezvousPreferences();
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return defaultRendezvousPreferences();
    const result = {} as RendezvousPreferences;
    for (const transport of ['mqtt', 'nostr', 'torrent'] as const) {
      const entries = (parsed as Record<string, unknown>)[transport];
      if (!Array.isArray(entries)) return defaultRendezvousPreferences();
      result[transport] = entries.filter((entry): entry is RendezvousServer =>
        entry && typeof entry.url === 'string' && typeof entry.enabled === 'boolean' &&
        normalizeRendezvousUrl(entry.url) !== null
      );
    }
    return validateRendezvousPreferences(result) ? defaultRendezvousPreferences() : result;
  } catch {
    return defaultRendezvousPreferences();
  }
}

export function saveRendezvousPreferences(value: RendezvousPreferences): void {
  const error = validateRendezvousPreferences(value);
  if (error) throw new Error(error);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
}

export function enabledRendezvousUrls(value: RendezvousPreferences, transport: SignalingTransport): string[] {
  return value[transport].filter((server) => server.enabled).map((server) => server.url);
}
