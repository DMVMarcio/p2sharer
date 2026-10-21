import { defaultRelayUrls as nostrDefaults } from '@trystero-p2p/nostr';
import { defaultRelayUrls as torrentDefaults } from '@trystero-p2p/torrent';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultRendezvousPreferences,
  enabledRendezvousUrls,
  loadRendezvousPreferences,
  saveRendezvousPreferences,
  validateRendezvousPreferences,
} from '../../src/p2p/relay_preferences.ts';
import { SignalingManager } from '../../src/p2p/signaling_manager.ts';

describe('Rendezvous server preferences', () => {
  it('persists disabled and custom servers without restoring removed defaults', () => {
    const values = new Map<string, string>();
    const prior = globalThis.localStorage;
    globalThis.localStorage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    } as Storage;
    try {
      const preferences = defaultRendezvousPreferences();
      preferences.mqtt = [{ url: 'wss://custom.example/mqtt', enabled: true }];
      preferences.nostr = [];
      preferences.torrent = [{ url: 'wss://tracker.example', enabled: false }];
      saveRendezvousPreferences(preferences);
      assert.deepEqual(loadRendezvousPreferences(), preferences);
      assert.deepEqual(enabledRendezvousUrls(loadRendezvousPreferences(), 'mqtt'), ['wss://custom.example/mqtt']);
      assert.deepEqual(enabledRendezvousUrls(loadRendezvousPreferences(), 'nostr'), []);
      const manager = new SignalingManager();
      assert.equal(manager.getRelayStatus('mqtt').total, 1);
    } finally {
      globalThis.localStorage = prior;
    }
  });

  it('rejects malformed, duplicated, and fully disabled configurations', () => {
    const preferences = defaultRendezvousPreferences();
    preferences.mqtt.push({ url: 'ws://insecure.example', enabled: true });
    assert.match(validateRendezvousPreferences(preferences) ?? '', /wss:\/\//);
    preferences.mqtt.pop();
    preferences.mqtt.push({ url: ['wss://', 'test-user', ':', 'test-pass', '@broker.example/mqtt'].join(''), enabled: true });
    assert.match(validateRendezvousPreferences(preferences) ?? '', /wss:\/\//);
    preferences.mqtt.pop();
    preferences.mqtt.push({ ...preferences.mqtt[0]! });
    assert.match(validateRendezvousPreferences(preferences) ?? '', /duplicado/);
    preferences.mqtt.pop();
    for (const transport of ['mqtt', 'nostr', 'torrent'] as const) {
      preferences[transport] = preferences[transport].map((server) => ({ ...server, enabled: false }));
    }
    assert.match(validateRendezvousPreferences(preferences) ?? '', /ao menos um/);
  });

  it('skips transports with no enabled servers when joining a room', async () => {
    const values = new Map<string, string>();
    const prior = globalThis.localStorage;
    globalThis.localStorage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    } as Storage;
    try {
      const preferences = defaultRendezvousPreferences();
      preferences.mqtt = [];
      preferences.torrent = [];
      preferences.nostr = [{ url: 'wss://nostr.example', enabled: true }];
      saveRendezvousPreferences(preferences);
      const manager = new SignalingManager();
      (manager as any).createRoomForTransport = () => ({ leave: async () => {} });
      manager.joinRoom({ appId: 'test' }, 'test-topic');
      assert.equal(manager.getActiveTransport(), 'nostr');
      assert.deepEqual(manager.getAvailableTransports(), ['nostr']);
      await manager.leaveRoom();
    } finally {
      globalThis.localStorage = prior;
    }
  });
});

it('uses first-party signaling in the web browser and removes retired saved endpoints without losing custom choices', () => {
  const oldWindow = globalThis.window, oldStorage = globalThis.localStorage;
  const values = new Map<string, string>();
  globalThis.window = { location: { origin: 'https://example.com' } } as Window & typeof globalThis;
  globalThis.localStorage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } } as Storage;
  try {
    const factory = defaultRendezvousPreferences();
    assert.deepEqual(enabledRendezvousUrls(factory, 'mqtt'), ['wss://example.com/mqtt']);
    assert.deepEqual(enabledRendezvousUrls(factory, 'nostr'), []);
    assert.deepEqual(enabledRendezvousUrls(factory, 'torrent'), []);
    values.set('p2sharer_rendezvous_servers_v1', JSON.stringify({ mqtt: [{ url: 'wss://p2sharer.com/mqtt', enabled: true }], nostr: [], torrent: [] }));
    assert.deepEqual(loadRendezvousPreferences(), factory);
    const legacy = { mqtt: ['wss://public:public@public.cloud.shiftr.io', 'wss://broker.emqx.io:8084/mqtt', 'wss://broker-cn.emqx.io:8084/mqtt', 'wss://test.mosquitto.org:8081/mqtt'].map(url => ({ url, enabled: true })),
      nostr: nostrDefaults.map(url => ({ url, enabled: true })), torrent: torrentDefaults.map(url => ({ url, enabled: true })) };
    values.set('p2sharer_rendezvous_servers_v1', JSON.stringify(legacy));
    assert.deepEqual(loadRendezvousPreferences(), factory);
    legacy.mqtt.push({ url: 'wss://custom.example/mqtt', enabled: false });
    legacy.nostr.push({ url: 'wss://rapi.acrop.net', enabled: true });
    values.set('p2sharer_rendezvous_servers_v1', JSON.stringify(legacy));
    const migrated = loadRendezvousPreferences();
    assert.ok(migrated.mqtt.some(entry => entry.url === 'wss://custom.example/mqtt' && !entry.enabled));
    assert.ok(!Object.values(migrated).flat().some(entry => ['broker-cn.emqx.io', 'rapi.acrop.net', 'public.cloud.shiftr.io'].includes(new URL(entry.url).hostname)));
  } finally { globalThis.window = oldWindow; globalThis.localStorage = oldStorage; }
});
