import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PeerAuthenticator } from '../../src/core/peer_auth.ts';
import { createAuthenticatedInvite, parseRoomInvite } from '../../src/core/room_invite.ts';
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
  const room = {
    makeAction(name: string): Action {
      const action: Action = {
        send: async (data, options) => { sent.push({ action: name, data, target: options?.target }); },
      };
      actions.set(name, action);
      return action;
    },
    getPeers: () => ({}),
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
    });
    room.onPeerJoin('unproved');
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
    await actions.get('room_admission')!.onMessage!(
      { kind: 'request', password: '' }, { peerId: 'member' });

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
    const authority = (manager as any).authority;
    const revoke = await authority.makeCommand('revoke-admin',
      { targetPeerId: 'member', targetKey: member.publicKey });
    await actions.get('room_admission')!.onMessage!(
      { kind: 'sync', commands: [revoke] }, { peerId: 'member' });
    assert.equal(manager.isPeerAdmin('member'), false);
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
