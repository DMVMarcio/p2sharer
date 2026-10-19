import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withLocalInterfaceStun } from '../../src/p2p/interface_stun.ts';

test('local interface discovery supplements Internet and LAN ICE without mutating configuration', async () => {
  const local = ['stun:192.0.2.1:45678'];
  for (const servers of [[], [{ urls: 'stun:stun.cloudflare.com:3478' }]]) {
    const configuration: RTCConfiguration = { iceServers: servers, iceTransportPolicy: 'all', iceCandidatePoolSize: 0 };
    const result = await withLocalInterfaceStun(configuration, async () => local);
    assert.deepEqual(result.iceServers, [...servers, { urls: local }]);
    assert.deepEqual(configuration.iceServers, servers);
    assert.equal(result.iceTransportPolicy, 'all');
  }
});

test('forced relay never invokes local discovery or adds direct candidates', async () => {
  const configuration: RTCConfiguration = { iceTransportPolicy: 'relay', iceServers: [{ urls: 'turn:relay.example:3478' }] };
  assert.equal(await withLocalInterfaceStun(configuration, async () => { assert.fail('Relay-only discovery'); }), configuration);
});

test('unavailable local discovery does not prevent the existing ICE configuration from working', async () => {
  const configuration: RTCConfiguration = { iceServers: [] };
  assert.equal(await withLocalInterfaceStun(configuration, async () => []), configuration);
  assert.equal(await withLocalInterfaceStun(configuration, async () => { throw new Error('Unavailable'); }), configuration);
});
