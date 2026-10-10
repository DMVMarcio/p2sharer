import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAuthenticatedInvite, parseRoomInvite } from '../../src/core/room_invite.ts';
import { PeerAuthenticator } from '../../src/core/peer_auth.ts';
import { RoomAuthority } from '../../src/core/room_authority.ts';
import { savedRooms } from '../../src/core/saved_rooms.ts';
import { validRoomPreview } from '../../src/core/room_preview.ts';
import { GroupRoomManager } from '../../src/p2p/group_room.ts';
import { signalingManager } from '../../src/p2p/signaling_manager.ts';

test('discovery authenticates identities without requesting admission or sending room content', async () => {
  const created = await createAuthenticatedInvite();
  const invite = parseRoomInvite(created.invite)!;
  const record = { roomId: invite.roomId, invite: created.invite, name: 'Preview fixture', saved: true,
    owned: true, identity: created.identity };
  await savedRooms.put(record);
  const before = await savedRooms.get(invite.roomId);
  const actions = new Map<string, any>();
  const sent: Array<{ action: string; data: any; target?: string }> = [];
  const room = { makeAction(name: string) {
    const action = { send: async (data: any, options?: { target: string }) => {
      sent.push({ action: name, data, target: options?.target });
    } }; actions.set(name, action); return action;
  }, getPeers: () => ({}), onPeerJoin: (_id: string) => {}, onPeerLeave: (_id: string) => {} };
  const original = { join: signalingManager.joinRoom, leave: signalingManager.leaveRoom, announce: signalingManager.reannounce };
  let transportJoins = 0;
  signalingManager.joinRoom = () => { transportJoins++; return room; };
  signalingManager.leaveRoom = async () => {};
  signalingManager.reannounce = async () => {};
  const manager = new GroupRoomManager('Owner', created.invite, '', true);
  const previews: unknown[] = [];
  try {
    await manager.join({ onStreamsUpdate: () => {}, onSlotsUpdate: () => {}, onChat: () => {},
      onChatHistory: () => {}, onPeersUpdate: () => {}, onStatusChange: () => {},
      onPreview: preview => previews.push(preview) }, true);
    assert.equal(manager.hasAdmission(), false);
    room.onPeerJoin('member');
    const member = await PeerAuthenticator.create(invite.roomId, 'member');
    const nonce = sent.findLast(packet => packet.action === 'peer_identity' && packet.data.kind === 'challenge')!.data.nonce;
    await actions.get('peer_identity').onMessage({ kind: 'proof', nonce, key: member.publicKey,
      signature: await member.signControl('identity', [invite.roomId, 'member', nonce]) }, { peerId: 'member' });
    await actions.get('room_admission').onMessage({ kind: 'prompt' }, { peerId: 'member' });
    assert.ok(sent.some(packet => packet.action === 'room_preview_v1' && packet.data.kind === 'request'));
    assert.equal(sent.some(packet => packet.action === 'room_admission' && packet.data.kind === 'request'), false);
    assert.equal(sent.some(packet => ['presence', 'chat', 'chat_history', 'profile_image_v1'].includes(packet.action)), false);
    assert.deepEqual(await savedRooms.get(invite.roomId), before, 'discovery must not rewrite saved room credentials');

    // Exercise the same production responder on an admitted host.
    (manager as any).previewOnly = false;
    sent.length = 0;
    const requestNonce = crypto.randomUUID();
    await actions.get('room_preview_v1').onMessage({ kind: 'request', nonce: requestNonce }, { peerId: 'member' });
    const response = sent.find(packet => packet.action === 'room_preview_v1')!;
    assert.ok(validRoomPreview(response.data.preview));
    assert.equal(response.target, 'member');
    assert.deepEqual(response.data.preview.participants.map((person: any) => person.name), ['Owner']);
    assert.equal(response.data.preview.protected, false);
    assert.equal('password' in response.data, false);
    const hostKey = (manager as any).chatAuth.publicKey;
    assert.equal(await member.verifyControl('room-preview', [requestNonce, response.data.preview], response.data.signature, hostKey), true);
    assert.equal(await member.verifyControl('room-preview', [crypto.randomUUID(), response.data.preview], response.data.signature, hostKey), false);
    await actions.get('room_preview_v1').onMessage({ kind: 'request', nonce: requestNonce }, { peerId: 'member' });
    assert.equal(sent.filter(packet => packet.action === 'room_preview_v1').length, 1, 'preview requests are rate limited');
    (manager as any).previewOnly = true;
    const previewNonce = (manager as any).previewNonce;
    const preview = { name: 'Room', protected: false, participants: [{ id: 'member', name: 'Member', color: '#06b6d4' }] };
    const incoming = { kind: 'response', nonce: previewNonce, preview,
      signature: await member.signControl('room-preview', [previewNonce, preview]) };
    await actions.get('room_preview_v1').onMessage(incoming, { peerId: 'member' });
    assert.equal(previews.length, 0, 'an authenticated stranger cannot claim room membership');
    const membership = await (manager as any).authority.makeCommand('admit', { targetPeerId: 'member', targetKey: member.publicKey });
    await actions.get('room_preview_v1').onMessage({ ...incoming, membership }, { peerId: 'member' });
    assert.deepEqual(previews, [preview]);
    (room as any).onPeerStream({ getTracks: () => [] }, 'member');
    assert.equal((manager as any).remoteStreams.size, 0, 'discovery must reject media even with saved host credentials');
    sent.length = 0;
    await manager.join({ onStreamsUpdate: () => {}, onSlotsUpdate: () => {}, onChat: () => {},
      onChatHistory: () => {}, onPeersUpdate: () => {}, onStatusChange: () => {} }, false, 'fixture-password');
    assert.equal(transportJoins, 1, 'promotion must preserve the existing transport and authenticated identity');
    assert.equal(manager.hasAdmission(), true, 'the saved host can activate its own room');
    assert.equal((await savedRooms.get(invite.roomId))?.identity?.publicKey,
      (manager as any).chatAuth.exportIdentity().publicKey);
    assert.ok(sent.some(packet => packet.action === 'room_admission' && packet.data.kind === 'prompt'));
  } finally {
    (manager as any).previewOnly = true;
    await manager.leave();
    signalingManager.joinRoom = original.join;
    signalingManager.leaveRoom = original.leave;
    signalingManager.reannounce = original.announce;
  }
});

test('preview bounds reject remote URLs, oversized avatars, and duplicate participants', () => {
  const person = { id: 'peer', name: 'Member', color: '#06b6d4' };
  assert.ok(validRoomPreview({ name: 'Room', protected: true, participants: [person] }));
  const png = Buffer.alloc(33);
  png.set([137, 80, 78, 71, 13, 10, 26, 10]);
  png.writeUInt32BE(13, 8); png.write('IHDR', 12); png.writeUInt32BE(32, 16); png.writeUInt32BE(32, 20);
  const previewWithPng = () => ({ name: 'Room', protected: true,
    participants: [{ ...person, avatar: 'data:image/png;base64,' + png.toString('base64') }] });
  assert.ok(validRoomPreview(previewWithPng()));
  png.writeUInt32BE(8192, 16);
  assert.equal(validRoomPreview(previewWithPng()), false, 'small encoded images must also have bounded decoded dimensions');
  for (const participants of [[person, person], [{ ...person, avatar: 'https://example.com/avatar.png' }],
    [{ ...person, avatar: 'data:image/png;base64,' + 'A'.repeat(8192) }]]) {
    assert.equal(validRoomPreview({ name: 'Room', protected: true, participants }), false);
  }
});

test('promoting a guest preserves the authenticated edge and still requires signed admission', async () => {
  const created = await createAuthenticatedInvite();
  const invite = parseRoomInvite(created.invite)!;
  const actions = new Map<string, any>();
  const sent: Array<{ action: string; data: any }> = [];
  const room = { makeAction(name: string) {
    const action = { send: async (data: any) => { sent.push({ action: name, data }); } };
    actions.set(name, action); return action;
  }, getPeers: () => ({ host: {} }), onPeerJoin: (_id: string) => {}, onPeerLeave: (_id: string) => {} };
  const original = { join: signalingManager.joinRoom, leave: signalingManager.leaveRoom, announce: signalingManager.reannounce };
  let connections = 0;
  signalingManager.joinRoom = () => { connections++; return room; };
  signalingManager.leaveRoom = async () => {};
  signalingManager.reannounce = async () => {};
  const manager = new GroupRoomManager('Guest', created.invite, '', false);
  const callbacks = { onStreamsUpdate: () => {}, onSlotsUpdate: () => {}, onChat: () => {},
    onChatHistory: () => {}, onPeersUpdate: () => {}, onStatusChange: () => {} };
  try {
    await manager.join(callbacks, true);
    room.onPeerJoin('host');
    const host = await PeerAuthenticator.create(invite.roomId, 'host', created.identity);
    const nonce = sent.findLast(packet => packet.action === 'peer_identity' && packet.data.kind === 'challenge')!.data.nonce;
    await actions.get('peer_identity').onMessage({ kind: 'proof', nonce, key: host.publicKey,
      signature: await host.signControl('identity', [invite.roomId, 'host', nonce]) }, { peerId: 'host' });
    const identity = (manager as any).chatAuth.publicKey;
    sent.length = 0;
    await manager.join(callbacks, false, 'fixture-password');
    assert.equal(connections, 1);
    assert.equal((manager as any).chatAuth.publicKey, identity);
    assert.equal(manager.hasAdmission(), false);
    assert.ok(sent.some(packet => packet.action === 'room_admission' && packet.data.kind === 'request' &&
      packet.data.password === 'fixture-password'));
    assert.equal(sent.some(packet => packet.action === 'presence'), false);
    await actions.get('room_admission').onMessage({ kind: 'denied' }, { peerId: 'host' });
    await manager.join(callbacks, false, 'corrected-fixture');
    assert.equal(connections, 1, 'password retries must preserve the same transport too');
    assert.equal(manager.hasAdmission(), false);
    const authority = new RoomAuthority(invite.roomId, invite.rootKey, host);
    const command = await authority.makeCommand('admit', { targetPeerId: manager.getLocalPeerId(), targetKey: identity });
    await actions.get('room_admission').onMessage({ kind: 'command', command }, { peerId: 'host' });
    assert.equal(manager.hasAdmission(), true);
  } finally {
    await manager.leave();
    signalingManager.joinRoom = original.join;
    signalingManager.leaveRoom = original.leave;
    signalingManager.reannounce = original.announce;
  }
});
