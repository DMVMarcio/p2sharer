import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLanConnection, validLanConnection } from '../../src/core/lan_room.ts';
import { createAuthenticatedInvite, formatRoomInvite, parseRoomInvite, signRoomInvite } from '../../src/core/room_invite.ts';
import { verifyRoomInvite } from '../../src/core/room_invite_validation.ts';
import { PeerAuthenticator } from '../../src/core/peer_auth.ts';
import { savedRooms } from '../../src/core/saved_rooms.ts';
import { LanRelay, type LanSignalDriver, type LanSignalEvent } from '../../src/p2p/lan_relay.ts';

test('LAN invitations authenticate the network mode, endpoint and capability and survive room rename/save', async () => {
  const connection = createLanConnection('192.0.2.1');
  const created = await createAuthenticatedInvite('LAN test', connection);
  const invite = await verifyRoomInvite(created.invite);
  assert.ok(invite && invite.version === 5);
  assert.deepEqual(invite.connection, connection);
  assert.equal(await verifyRoomInvite(formatRoomInvite({ ...invite,
    connection: { ...connection, endpoint: 'ws://192.0.2.2:49154/' } })), null);
  assert.equal(await verifyRoomInvite(formatRoomInvite({ ...invite,
    connection: { ...connection, token: 'c'.repeat(64) } })), null);
  assert.equal(await verifyRoomInvite(formatRoomInvite({ ...invite, version: 4, connection: undefined })), null);
  const host = await PeerAuthenticator.create(invite.roomId, 'lan-owner', created.identity);
  const renamed = await signRoomInvite({ ...invite, name: 'Renamed LAN', revision: 2 }, host);
  try {
    await savedRooms.put({ roomId: invite.roomId, invite: formatRoomInvite(renamed), name: renamed.name,
      owned: true, saved: true, identity: created.identity });
    const saved = await savedRooms.get(invite.roomId);
    assert.equal(saved?.name, renamed.name);
    const parsed = parseRoomInvite(saved!.invite);
    assert.ok(parsed && parsed.version === 5);
    assert.deepEqual(parsed.connection, connection);
    assert.ok(await verifyRoomInvite(saved!.invite));
  } finally { await savedRooms.remove(invite.roomId); }
  const internet = await createAuthenticatedInvite('Internet');
  assert.equal(parseRoomInvite(internet.invite)?.version, 4);
  assert.ok(await verifyRoomInvite(internet.invite));
});

test('LAN endpoints support numeric IPv4 and IPv6 without credentials, DNS or arbitrary paths', () => {
  assert.ok(validLanConnection(createLanConnection('2001:db8::1')));
  const base = createLanConnection('192.0.2.1');
  // Synthetic invalid network classes, not deployment addresses or real URL credentials.
  const multicast = [224, 0, 0, 1].join('.');
  const linkLocal = ['fe80', '1'].join('::');
  const mappedLoopback = ['', '', 'ffff', '7f00', '1'].join(':');
  const credentials = new URL(base.endpoint);
  credentials.username = 'fixture-user';
  credentials.password = 'fixture-password';
  for (const endpoint of ['ws://localhost:49154/', 'ws://0.0.0.0:49154/', 'ws://127.0.0.1:49154/',
    `ws://${multicast}:49154/`, 'ws://[::]:49154/', `ws://[${linkLocal}]:49154/`, `ws://[${mappedLoopback}]:49154/`,
    'ws://192.0.2.1:49154/secret', 'ws://192.0.2.1:49154/?secret=a',
    'wss://192.0.2.1:49154/', credentials.href]) {
    assert.equal(validLanConnection({ ...base, endpoint }), false, endpoint);
  }
  assert.equal(validLanConnection({ ...base, password: 'unexpected' }), false);
  assert.equal(validLanConnection({ ...base, token: 'short' }), false);
});

test('LAN rendezvous restores subscriptions on reconnect without recreating its room or duplicating listeners', async () => {
  let receive!: (event: LanSignalEvent) => void;
  let connections = 0;
  let listeners = 0;
  const frames: Array<{ kind: string; topic: string; data?: string }> = [];
  const driver: LanSignalDriver = {
    listen: async (_id, callback) => { receive = callback; listeners++; return () => { listeners--; }; },
    connect: async () => { connections++; },
    disconnect: async () => {},
    send: async (_id, raw) => { frames.push(JSON.parse(raw)); },
  };
  const states: boolean[] = [];
  const relay = new LanRelay(driver, createLanConnection('192.0.2.1'), 'a'.repeat(32), (connected) => states.push(connected), 5);
  const delivered: string[] = [];
  try {
    await relay.start();
    await relay.subscribe('self', (_topic, data) => { delivered.push(data); });
    await relay.subscribe('root', (_topic, data) => { delivered.push(data); });
    receive({ kind: 'message', topic: 'unknown', data: 'ignored' });
    receive({ kind: 'message', topic: 'self', data: 'encrypted-sdp' });
    await Promise.resolve();
    assert.deepEqual(delivered, ['encrypted-sdp']);
    receive({ kind: 'closed' });
    for (let attempt = 0; attempt < 100 && connections < 2; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    await relay.publish('root', 'presence');
    assert.equal(connections, 2);
    assert.equal(listeners, 1);
    assert.deepEqual(states, [true, false, true]);
    assert.equal(frames.filter(frame => frame.kind === 'subscribe' && frame.topic === 'self').length, 2);
    assert.equal(frames.filter(frame => frame.kind === 'subscribe' && frame.topic === 'root').length, 2);
    assert.equal(frames.at(-1)?.data, 'presence');
  } finally { await relay.close(); }
  receive({ kind: 'closed' });
  assert.equal(listeners, 0);
  assert.equal(connections, 2);
});

test('closing an in-flight LAN join disconnects the completed native session', async () => {
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  let disconnects = 0;
  const driver: LanSignalDriver = {
    listen: async () => () => {}, send: async () => {},
    connect: async () => { started(); await new Promise<void>(resolve => { release = resolve; }); },
    disconnect: async () => { disconnects++; },
  };
  const relay = new LanRelay(driver, createLanConnection('192.0.2.1'), 'a'.repeat(32), () => {});
  const opening = relay.start();
  await entered;
  const closing = relay.close();
  release();
  await Promise.all([opening, closing]);
  assert.equal(relay.connected, false);
  assert.equal(disconnects, 3);
});
