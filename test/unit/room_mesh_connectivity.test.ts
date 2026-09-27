import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GroupRoomManager } from '../../src/p2p/group_room.ts';
import { PeerTracker } from '../../src/p2p/peer_tracker.ts';
import { signalingManager } from '../../src/p2p/signaling_manager.ts';

type MockAction = {
  onMessage?: (data: any, context: { peerId: string }) => void;
  send: (data: unknown, options?: unknown) => Promise<void>;
};

function mockRoom() {
  const actions = new Map<string, MockAction>();
  return {
    actions,
    room: {
      makeAction(name: string): MockAction {
        const action = { send: async () => {} };
        actions.set(name, action);
        return action;
      },
      getPeers: () => ({}),
      leave: async () => {},
      onPeerJoin: (_peerId: string) => {},
      onPeerLeave: (_peerId: string) => {},
      onPeerStream: (_stream: MediaStream, _peerId: string) => {},
    },
  };
}

function callbacks() {
  return {
    onStreamsUpdate: () => {},
    onSlotsUpdate: () => {},
    onChat: () => {},
    onChatHistory: () => {},
    onPeersUpdate: () => {},
    onStatusChange: () => {},
  };
}

test('a direct handshake does not erase the known creator role', () => {
  const tracker = new PeerTracker();
  tracker.receivePeerExchange('creator-peer', false, 'Creator', true, 1);
  tracker.receivePeerExchange('creator-peer', true);
  tracker.addPeer('creator-peer', 'Creator', true, 1);
  tracker.receivePeerExchange('creator-peer', true);
  assert.equal(tracker.isPeerCreator('creator-peer'), true);
});

test('join and leave notices wait for the direct presence username', async () => {
  const originalJoin = signalingManager.joinRoom;
  const originalLeave = signalingManager.leaveRoom;
  const originalReannounce = signalingManager.reannounce;
  const mock = mockRoom();
  (signalingManager as any).joinRoom = () => mock.room;
  (signalingManager as any).leaveRoom = async () => {};
  (signalingManager as any).reannounce = async () => {};
  const events: string[] = [];
  const manager = new GroupRoomManager('Alice', 'notice-test', '', true);
  try {
    await manager.join({
      ...callbacks(),
      onPeerJoined: (peer) => events.push(`join:${peer.username}`),
      onPeerLeft: (_peerId, username) => events.push(`leave:${username}`),
    });
    mock.room.onPeerJoin('peer-b');
    assert.deepEqual(events, [], 'the WebRTC handshake alone has no real username');

    const presence = mock.actions.get('presence')!.onMessage!;
    presence({ username: '  Bob  ', isCreator: false }, { peerId: 'peer-b' });
    presence({ username: 'Bob', isCreator: false }, { peerId: 'peer-b' });
    assert.deepEqual(events, ['join:Bob'], 'repeated presence must not duplicate the notice');

    mock.room.onPeerLeave('peer-b');
    mock.room.onPeerJoin('peer-c');
    mock.room.onPeerLeave('peer-c');
    assert.deepEqual(events, ['join:Bob', 'leave:Bob'], 'unnamed transient peers produce no synthetic notice');
  } finally {
    await manager.leave();
    (signalingManager as any).joinRoom = originalJoin;
    (signalingManager as any).leaveRoom = originalLeave;
    (signalingManager as any).reannounce = originalReannounce;
  }
});

test('a joiner treats the first peer roster as existing room membership', async () => {
  const originalJoin = signalingManager.joinRoom;
  const originalLeave = signalingManager.leaveRoom;
  const originalReannounce = signalingManager.reannounce;
  const mock = mockRoom();
  (signalingManager as any).joinRoom = () => mock.room;
  (signalingManager as any).leaveRoom = async () => {};
  (signalingManager as any).reannounce = async () => {};
  const notices: Array<{ name: string; initial: boolean }> = [];
  const manager = new GroupRoomManager('Alice', 'roster-test', '', false);
  try {
    await manager.join({
      ...callbacks(),
      onPeerJoined: (peer, initial) => notices.push({ name: peer.username, initial }),
    });
    const presence = mock.actions.get('presence')!.onMessage!;
    const pex = mock.actions.get('peer_exchange')!.onMessage!;

    mock.room.onPeerJoin('host');
    presence({ username: 'Robert', isCreator: true }, { peerId: 'host' });
    assert.deepEqual(notices, [], 'host presence can precede the initial roster');
    pex({ peers: [
      { peerId: 'host', username: 'Robert', isCreator: true, joinedAt: 1 },
      { peerId: 'other', username: 'NormadM', isCreator: false, joinedAt: 2 },
    ] }, { peerId: 'host' });
    assert.deepEqual(notices, [{ name: 'Robert', initial: true }]);
    assert.equal(manager.getConnectedPeers().find((peer) => peer.id === 'host')?.isCreator, true);

    mock.room.onPeerJoin('other');
    presence({ username: 'NormadM', isCreator: false }, { peerId: 'other' });
    mock.room.onPeerJoin('late');
    presence({ username: 'NewUser', isCreator: false }, { peerId: 'late' });
    assert.deepEqual(notices, [
      { name: 'Robert', initial: true },
      { name: 'NormadM', initial: true },
      { name: 'NewUser', initial: false },
    ]);
  } finally {
    await manager.leave();
    (signalingManager as any).joinRoom = originalJoin;
    (signalingManager as any).leaveRoom = originalLeave;
    (signalingManager as any).reannounce = originalReannounce;
  }
});

test('creator and joiner both advertise so joiners can pair directly', async () => {
  const originalJoin = signalingManager.joinRoom;
  const originalLeave = signalingManager.leaveRoom;
  const originalReannounce = signalingManager.reannounce;
  const configs: any[] = [];
  const rooms = [mockRoom(), mockRoom()];
  let announcements = 0;
  (signalingManager as any).joinRoom = (config: any) => {
    configs.push(config);
    return rooms[configs.length - 1]!.room;
  };
  (signalingManager as any).leaveRoom = async () => {};
  (signalingManager as any).reannounce = async () => { announcements++; };
  const creator = new GroupRoomManager('Creator', 'room-test', '', true);
  const joiner = new GroupRoomManager('Joiner', 'room-test', '', false);
  try {
    await creator.join(callbacks());
    await joiner.join(callbacks());
    assert.equal(configs[0].passive, false);
    assert.equal(configs[1].passive, false);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.ok(announcements >= 2, 'both participants must announce the shared rendezvous');
    const before = announcements;
    await creator.leave();
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.ok(announcements > before, 'a joiner must remain discoverable by other joiners');
  } finally {
    await joiner.leave();
    (signalingManager as any).joinRoom = originalJoin;
    (signalingManager as any).leaveRoom = originalLeave;
    (signalingManager as any).reannounce = originalReannounce;
  }
});

test('PEX reveals a missing third peer and direct handshake promotes it', async () => {
  const originalJoin = signalingManager.joinRoom;
  const originalLeave = signalingManager.leaveRoom;
  const originalReannounce = signalingManager.reannounce;
  const mock = mockRoom();
  const replacement = mockRoom();
  let joins = 0;
  (signalingManager as any).joinRoom = () => (joins++ === 0 ? mock.room : replacement.room);
  (signalingManager as any).leaveRoom = async () => {};
  (signalingManager as any).reannounce = async () => {};
  const manager = new GroupRoomManager('Alice', 'mesh-test', '', true);
  const slotUpdates: string[][] = [];
  try {
    await manager.join({
      ...callbacks(),
      onSlotsUpdate: (slots) => slotUpdates.push(slots.map((slot) => slot.peerId)),
    });
    mock.room.onPeerJoin('peer-b');
    mock.actions.get('peer_exchange')!.onMessage!({
      peers: [{ peerId: 'peer-c', username: 'Carol', isCreator: false, joinedAt: 10 }],
    }, { peerId: 'peer-b' });
    assert.equal(manager.getConnectedPeers().find((peer) => peer.id === 'peer-c')?.connectionState, 'connecting');
    assert.ok(slotUpdates.some((ids) => ids.includes('peer-c')), 'rumor must appear in the central view immediately');
    const pendingSlot = manager.getAllRoomSlots().find((slot) => slot.peerId === 'peer-c');
    assert.equal(pendingSlot?.connectionState, 'connecting');
    assert.equal(pendingSlot?.stream, null);
    assert.equal(pendingSlot?.isStreaming, false);
    let mediaDispatches = 0;
    (mock.room as any).addStream = () => { mediaDispatches++; };
    (manager as any).localStream = { id: 'local-test-stream' };
    manager.sendStreamToPeer('peer-c');
    assert.equal(mediaDispatches, 0, 'PEX rumors must never receive media before direct verification');
    (manager as any).localStream = null;
    mock.room.onPeerJoin('peer-c');
    assert.equal(manager.getConnectedPeers().find((peer) => peer.id === 'peer-c')?.connectionState, 'connected');
    assert.equal(manager.getAllRoomSlots().find((slot) => slot.peerId === 'peer-c')?.connectionState, 'connected');

    const oldLeave = mock.room.onPeerLeave;
    const oldPex = mock.actions.get('peer_exchange')!.onMessage!;
    await (manager as any).reconnectOnNewTransport();
    replacement.room.onPeerJoin('peer-c');
    oldLeave('peer-c');
    oldPex({ peers: [{ peerId: 'stale-peer', username: 'Stale', joinedAt: 20 }] }, { peerId: 'peer-b' });
    assert.equal(manager.getConnectedPeers().find((peer) => peer.id === 'peer-c')?.connectionState, 'connected');
    assert.equal(manager.getConnectedPeers().find((peer) => peer.id === 'stale-peer'), undefined);
  } finally {
    await manager.leave();
    (signalingManager as any).joinRoom = originalJoin;
    (signalingManager as any).leaveRoom = originalLeave;
    (signalingManager as any).reannounce = originalReannounce;
  }
});
