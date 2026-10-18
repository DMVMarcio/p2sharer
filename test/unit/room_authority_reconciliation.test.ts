import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PeerAuthenticator } from '../../src/core/peer_auth.ts';
import { RoomAuthority } from '../../src/core/room_authority.ts';
import { createAuthenticatedInvite, formatRoomInvite, parseRoomInvite,
  signRoomInvite } from '../../src/core/room_invite.ts';
import { roomStateFingerprint } from '../../src/core/room_state_sync.ts';
import { savedRooms } from '../../src/core/saved_rooms.ts';
import { GroupRoomManager } from '../../src/p2p/group_room.ts';
import { signalingManager } from '../../src/p2p/signaling_manager.ts';

type Action = {
  onMessage?: (data: any, meta: { peerId: string }) => Promise<void> | void;
  send: (data: any, options?: { target: string }) => Promise<void>;
};

test('admitted peers reconcile signed commands; unauthenticated peers cannot request history', async () => {
  const created = await createAuthenticatedInvite();
  const invite = parseRoomInvite(created.invite)!;
  await savedRooms.put({
    roomId: invite.roomId, invite: created.invite, name: 'Reconciliation test',
    saved: true, owned: true, identity: created.identity,
  });
  const actions = new Map<string, Action>();
  const sent: Array<{ action: string; data: any; target?: string }> = [];
  let mediaSends = 0;
  const inviteUpdates: string[] = [];
  const room = {
    makeAction(name: string): Action {
      const action: Action = {
        send: async (data, options) => { sent.push({ action: name, data, target: options?.target }); },
      };
      actions.set(name, action);
      return action;
    },
    getPeers: () => ({}),
    addStream: () => { mediaSends += 1; return []; },
    onPeerJoin: (_peerId: string) => {},
    onPeerLeave: (_peerId: string) => {},
    onPeerStream: (_stream: MediaStream, _peerId: string) => {},
  };
  const originalJoin = signalingManager.joinRoom;
  const originalLeave = signalingManager.leaveRoom;
  const originalReannounce = signalingManager.reannounce;
  (signalingManager as any).joinRoom = () => room;
  (signalingManager as any).leaveRoom = async () => {};
  (signalingManager as any).reannounce = async () => {};
  const manager = new GroupRoomManager('Host', created.invite, '', true);

  try {
    await manager.join({
      onStreamsUpdate: () => {}, onSlotsUpdate: () => {}, onChat: () => {},
      onChatHistory: () => {}, onPeersUpdate: () => {}, onStatusChange: () => {},
      onInviteChange: (_invite, name) => { inviteUpdates.push(name); },
    });
    room.onPeerJoin('unproved');
    assert.equal(manager.getConnectedPeers().some((peer) => peer.id === 'unproved'), false);
    assert.equal(manager.getAllRoomSlots().some(slot => slot.peerId === 'unproved'), false,
      'a discovery connection must not create a participant card');
    (manager as any).sendRoomAction(actions.get('presence'), { username: 'Host' });
    assert.equal(sent.some((item) => item.action === 'presence' && item.target === 'unproved'), false);
    (manager as any).localStream = { getTracks: () => [] };
    manager.sendStreamToPeer('unproved');
    room.onPeerStream({ getTracks: () => [] } as unknown as MediaStream, 'unproved');
    assert.equal(mediaSends, 0, 'a direct WebRTC edge alone must not receive media');
    assert.equal((manager as any).remoteStreams.has('unproved'), false);
    (manager as any).localStream = null;
    await actions.get('room_admission')!.onMessage!({ kind: 'sync-request' }, { peerId: 'unproved' });
    assert.equal(sent.some((item) => item.action === 'room_admission' &&
      item.data.kind === 'sync' && item.target === 'unproved'), false);

    const member = await PeerAuthenticator.create(invite.roomId, 'member');
    room.onPeerJoin('member');
    const nonce = sent.findLast((item) => item.action === 'peer_identity' &&
      item.data.kind === 'challenge' && item.target === 'member')!.data.nonce;
    const signature = await member.signControl('identity', [invite.roomId, 'member', nonce]);
    await actions.get('peer_identity')!.onMessage!(
      { kind: 'proof', nonce, key: member.publicKey, signature }, { peerId: 'member' });
    assert.equal(manager.getConnectedPeers().some((peer) => peer.id === 'member'), false);
    assert.equal(manager.getAllRoomSlots().some(slot => slot.peerId === 'member'), false);
    (manager as any).localStream = { getTracks: () => [] };
    manager.sendStreamToPeer('member');
    assert.equal(mediaSends, 0, 'a verified identity still requires room admission');
    (manager as any).localStream = null;
    await actions.get('room_admission')!.onMessage!(
      { kind: 'request', password: '' }, { peerId: 'member' });

    const firstAdmission = sent.findLast(item => item.action === 'room_admission' &&
      item.data.kind === 'command' && item.data.command.kind === 'admit')!.data.command;
    const memberAuthority = new RoomAuthority(invite.roomId, invite.rootKey, member);
    assert.equal(await memberAuthority.verifyCommand(firstAdmission), true);
    assert.equal(manager.getAllRoomSlots().some(slot => slot.peerId === 'member'), false,
      'admission alone must not publish a card before presence');
    await actions.get('presence')!.onMessage!({ username: 'Member' }, { peerId: 'member' });
    assert.equal(manager.getAllRoomSlots().find(slot => slot.peerId === 'member')?.senderName, 'Member');
    room.onPeerLeave('member');
    room.onPeerJoin('member');
    const reconnectNonce = sent.findLast(item => item.action === 'peer_identity' &&
      item.data.kind === 'challenge' && item.target === 'member')!.data.nonce;
    await actions.get('peer_identity')!.onMessage!({ kind: 'proof', nonce: reconnectNonce,
      key: member.publicKey, signature: await member.signControl('identity',
        [invite.roomId, 'member', reconnectNonce]) }, { peerId: 'member' });
    assert.equal(manager.getConnectedPeers().some(peer => peer.id === 'member'), false,
      'a previous admission cannot make a returning preview visible');
    assert.equal(manager.getAllRoomSlots().some(slot => slot.peerId === 'member'), false);
    await actions.get('room_admission')!.onMessage!(
      { kind: 'request', password: '' }, { peerId: 'member' });
    const renewed = sent.findLast(item => item.action === 'room_admission' &&
      item.data.kind === 'command' && item.data.command.kind === 'admit')!.data.command;
    assert.ok(renewed.sequence > firstAdmission.sequence, 're-entry needs a fresh signed admission');
    assert.equal(await memberAuthority.verifyCommand(firstAdmission), false, 'old commands remain replay protected');
    assert.equal(await memberAuthority.verifyCommand(renewed), true);
    await actions.get('presence')!.onMessage!({ username: 'Member' }, { peerId: 'member' });
    assert.equal(manager.getConnectedPeers().some(peer => peer.id === 'member'), true);
    assert.equal(manager.getAllRoomSlots().filter(slot => slot.peerId === 'member').length, 1);

    const emptyFingerprint = await roomStateFingerprint(0, []);
    await actions.get('room_admission')!.onMessage!(
      { kind: 'summary', epoch: 0, fingerprint: emptyFingerprint }, { peerId: 'unproved' });
    assert.equal(sent.some((item) => item.action === 'room_admission' &&
      item.data.kind === 'sync' && item.target === 'unproved'), false);

    sent.length = 0;
    await actions.get('room_admission')!.onMessage!(
      { kind: 'summary', epoch: 0, fingerprint: emptyFingerprint }, { peerId: 'member' });
    assert.ok(sent.some((item) => item.action === 'room_admission' &&
      item.data.kind === 'sync' && item.target === 'member' &&
      item.data.commands.some((command: { kind: string }) => command.kind === 'admit')));

    assert.equal(await manager.setAdministrator('member', true), true);
    assert.equal(manager.canManageRoomApps('member'), true);
    assert.equal(manager.canManageRoomApps(manager.getLocalPeerId()), true);
    assert.equal(manager.canManageRoomApps('unproved'), false);
    const updatedInvite = parseRoomInvite(manager.getInvite()!);
    assert.ok(updatedInvite && updatedInvite.version === 4);
    assert.equal(updatedInvite.adminKeys.length, 1);
    assert.equal(updatedInvite.adminKeys[0], member.publicKey);
    assert.equal((await savedRooms.get(invite.roomId))?.invite, manager.getInvite());
    const authority = (manager as any).authority;
    const signer = await PeerAuthenticator.create(invite.roomId, 'snapshot-signer', created.identity);
    const renamed = await signRoomInvite({ ...updatedInvite,
      name: 'Sala Renomeada', revision: authority.nextSnapshotRevision() }, signer);
    const renamedCode = formatRoomInvite(renamed);
    await actions.get('room_invite_sync')!.onMessage!(
      { invite: renamedCode }, { peerId: 'member' });
    assert.equal(manager.getRoomName(), 'Sala Renomeada');
    assert.equal((await savedRooms.get(invite.roomId))?.invite, renamedCode);
    assert.ok(inviteUpdates.includes('Sala Renomeada'));
    await actions.get('room_invite_sync')!.onMessage!(
      { invite: created.invite }, { peerId: 'member' });
    assert.equal(manager.getInvite(), renamedCode,
      'an older signed invitation must not replace the saved snapshot');
    const revoke = await authority.makeCommand('revoke-admin',
      { targetPeerId: 'member', targetKey: member.publicKey });
    await actions.get('room_admission')!.onMessage!(
      { kind: 'sync', commands: [revoke] }, { peerId: 'member' });
    assert.equal(manager.isPeerAdmin('member'), false);
    assert.equal(manager.canManageRoomApps('member'), false);
    await actions.get('room_admission')!.onMessage!(
      { kind: 'sync', commands: [revoke] }, { peerId: 'member' });
    assert.equal(manager.isPeerAdmin('member'), false);
  } finally {
    await manager.leave();
    await savedRooms.remove(invite.roomId);
    (signalingManager as any).joinRoom = originalJoin;
    (signalingManager as any).leaveRoom = originalLeave;
    (signalingManager as any).reannounce = originalReannounce;
  }
});
