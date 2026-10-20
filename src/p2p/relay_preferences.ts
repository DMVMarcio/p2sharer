import { isBrowserRuntime, signalingBrokerUrl, websiteUrl } from '../platform/website.ts';
import { defaultRelayUrls as defaultNostrUrls } from '@trystero-p2p/nostr';
import { defaultRelayUrls as defaultTorrentUrls } from '@trystero-p2p/torrent';
import type { RendezvousTransport, SignalingTransport } from '../core/types.ts';

export interface RendezvousServer {
  url: string;
  enabled: boolean;
}

export type RendezvousPreferences = Record<RendezvousTransport, RendezvousServer[]>;

const STORAGE_KEY = 'p2sharer_rendezvous_servers_v1';

const ownedBrokerUrl = signalingBrokerUrl;
const retiredHosts = new Set(['broker-cn.emqx.io', 'rapi.acrop.net']);
function retired(url: string): boolean {
  try { return retiredHosts.has(new URL(url).hostname); } catch { return true; }
}
const publicMqttUrls = [
  'wss://public:public@public.cloud.shiftr.io',
  'wss://broker.emqx.io:8084/mqtt',
  'wss://test.mosquitto.org:8081/mqtt',
];

export const DEFAULT_MQTT_RELAY_URLS = [ownedBrokerUrl(), ...publicMqttUrls];
const legacyMqttUrls = [...publicMqttUrls, 'wss://broker-cn.emqx.io:8084/mqtt'];

export function defaultRendezvousPreferences(): RendezvousPreferences {
  const web = isBrowserRuntime();
  return {
    mqtt: [ownedBrokerUrl(), ...(web ? [] : publicMqttUrls)].map(url => ({ url, enabled: true })),
    nostr: web ? [] : defaultNostrUrls.filter(url => !retired(url)).map(url => ({ url, enabled: true })),
    torrent: web ? [] : defaultTorrentUrls.filter(url => !retired(url)).map(url => ({ url, enabled: true })),
  };
}

export function normalizeRendezvousUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    const localWebSocket = url.protocol === 'ws:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'wss:' && !localWebSocket) || !url.hostname || url.hash) return null;
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
      if (!url || retired(server.url)) return `URL inválida em ${transport.toUpperCase()}. Use wss://.`;
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
    const sameDefaults = (entries: RendezvousServer[], urls: string[]) => entries.length === urls.length && entries.every(entry => entry.enabled && urls.includes(entry.url));
    const previousOwned = [websiteUrl('/mqtt').replace(/^http/, 'ws'), 'wss://p2sharer.com/mqtt'];
    const factoryFallbacks = sameDefaults(result.nostr, defaultNostrUrls) && sameDefaults(result.torrent, defaultTorrentUrls);
    if (factoryFallbacks && (sameDefaults(result.mqtt, legacyMqttUrls) || previousOwned.some(url => sameDefaults(result.mqtt, [url, ...publicMqttUrls])))) return defaultRendezvousPreferences();
    if (isBrowserRuntime() && !result.nostr.length && !result.torrent.length && previousOwned.some(url => sameDefaults(result.mqtt, [url]))) return defaultRendezvousPreferences();
    for (const transport of ['mqtt', 'nostr', 'torrent'] as const) result[transport] = result[transport].filter(entry => !retired(entry.url));
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
  if (transport === 'lan') return [];
  return value[transport].filter((server) => server.enabled).map((server) => server.url);
}
