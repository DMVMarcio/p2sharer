import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GroupRoomManager } from '../../src/p2p/group_room.ts';
import { signalingManager } from '../../src/p2p/signaling_manager.ts';
import { createLanConnection } from '../../src/core/lan_room.ts';
import { createAuthenticatedInvite, parseRoomInvite } from '../../src/core/room_invite.ts';
import { savedRooms } from '../../src/core/saved_rooms.ts';

test('LAN room lifecycle keeps canonical actions, host-only ICE, signed renames and isolated teardown', async () => {
  const connection = createLanConnection('192.0.2.1');
  const created = await createAuthenticatedInvite('LAN lifecycle', connection);
  const invite = parseRoomInvite(created.invite)!;
  await savedRooms.put({ roomId: invite.roomId, invite: created.invite, name: 'LAN lifecycle',
    saved: true, owned: true, identity: created.identity });
  const actions: string[] = [];
  const room = {
    makeAction(name: string) { actions.push(name); return { send: async () => {} }; },
    getPeers: () => ({}), onPeerJoin: () => {}, onPeerLeave: () => {}, onPeerStream: () => {},
  };
  const original = { prepareLan: signalingManager.prepareLan, joinRoom: signalingManager.joinRoom,
    leaveRoom: signalingManager.leaveRoom, reannounce: signalingManager.reannounce };
  let rtc: RTCConfiguration | undefined;
  let preparation: unknown[] | undefined;
  let leaveTarget: unknown;
  signalingManager.prepareLan = async (...args) => { preparation = args; };
  signalingManager.joinRoom = (config) => { rtc = config.rtcConfig; return room; };
  signalingManager.leaveRoom = async target => { leaveTarget = target; };
  signalingManager.reannounce = async () => {};
  const manager = new GroupRoomManager('LAN owner', created.invite, '', true,
    { enabled: true, forceRelay: true, url: 'turn:relay.example.com:3478', username: 'fixture', credential: 'fixture' });
  const statuses: string[] = [];
  try {
    await manager.join({ onStreamsUpdate: () => {}, onSlotsUpdate: () => {}, onChat: () => {},
      onChatHistory: () => {}, onPeersUpdate: () => {}, onStatusChange: status => statuses.push(status) });
    assert.deepEqual(preparation?.slice(0, 3), [connection, invite.roomId, true]);
    assert.deepEqual(rtc, { iceServers: [], iceTransportPolicy: 'all', iceCandidatePoolSize: 0 });
    assert.ok(actions.includes('peer_identity'));
    assert.ok(actions.includes('room_admission'));
    assert.ok(actions.includes('chat'));
    assert.ok(actions.includes('stream_req'));
    const count = actions.length;
    const report = preparation![3] as (connected: boolean) => void;
    report(false);
    report(true);
    assert.equal(actions.length, count, 'rendezvous recovery must not recreate room actions');
    assert.equal(await manager.updateRoomName('Renamed LAN'), true);
    const renamed = parseRoomInvite(manager.getInvite()!);
    assert.ok(renamed && renamed.version === 5);
    assert.deepEqual(renamed.connection, connection);
    assert.equal(renamed.name, 'Renamed LAN');
  } finally {
    await manager.leave();
    await savedRooms.remove(invite.roomId);
    Object.assign(signalingManager, original);
  }
  assert.equal(leaveTarget, room);
});
