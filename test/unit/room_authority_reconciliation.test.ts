import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PeerAuthenticator } from '../../src/core/network/peer_auth.ts';
import { RoomAuthority } from '../../src/core/room/room_authority.ts';
import { createAuthenticatedInvite, formatRoomInvite, parseRoomInvite,
  signRoomInvite } from '../../src/core/room/room_invite.ts';
import { roomStateFingerprint } from '../../src/core/room/room_state_sync.ts';
import { savedRooms } from '../../src/core/room/saved_rooms.ts';
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
    getPeers: () => ({ member: {} }),
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

test('relayed admission admits indirect newcomers through an admitted peer while rejecting invalid proofs and banned keys', async () => {
  const created = await createAuthenticatedInvite('Relayed admission test');
  const invite = parseRoomInvite(created.invite)!;
  await savedRooms.put({
    roomId: invite.roomId, invite: created.invite, name: 'Relayed admission test',
    saved: true, owned: true, identity: created.identity,
  });

  const makeMockRoom = (peers: Record<string, object>) => {
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
      getPeers: () => peers,
      addStream: () => [],
      onPeerJoin: (_peerId: string) => {},
      onPeerLeave: (_peerId: string) => {},
      onPeerStream: (_stream: MediaStream, _peerId: string) => {},
    };
    return { actions, sent, room };
  };

  const originalJoin = signalingManager.joinRoom;
  const originalLeave = signalingManager.leaveRoom;
  const originalReannounce = signalingManager.reannounce;
  (signalingManager as any).leaveRoom = async () => {};
  (signalingManager as any).reannounce = async () => {};

  const callbacks = {
    onStreamsUpdate: () => {}, onSlotsUpdate: () => {}, onChat: () => {},
    onChatHistory: () => {}, onPeersUpdate: () => {}, onStatusChange: () => {},
  };

  const hostNet = makeMockRoom({ member: {} });
  const relayNet = makeMockRoom({ host: {}, newcomer: {} });
  const newcomerNet = makeMockRoom({ member: {} });

  let currentRoom: any = hostNet.room;
  (signalingManager as any).joinRoom = () => currentRoom;

  const hostManager = new GroupRoomManager('Host', created.invite, '', true);
  let relayManager: GroupRoomManager | undefined;
  let newcomerManager: GroupRoomManager | undefined;

  const verifyDirectPeer = async (
    actions: Map<string, Action>,
    sent: Array<{ action: string; data: any; target?: string }>,
    peerId: string,
    auth: PeerAuthenticator,
  ) => {
    const challenge = sent.findLast((item) => item.action === 'peer_identity' &&
      item.data.kind === 'challenge' && item.target === peerId)!.data.nonce;
    await actions.get('peer_identity')!.onMessage!({
      kind: 'proof',
      nonce: challenge,
      key: auth.publicKey,
      signature: await auth.signControl('identity', [invite.roomId, peerId, challenge]),
    }, { peerId });
  };

  try {
    currentRoom = hostNet.room;
    await hostManager.join(callbacks);

    // Isolate guest identity creation in shared process from host's savedRooms & localKeys cache.
    await savedRooms.remove(invite.roomId);
    const localAuthCache = (PeerAuthenticator as any).localKeys as Map<string, unknown>;
    localAuthCache.delete(JSON.stringify([invite.roomId.toLowerCase(), hostManager.getLocalPeerId()]));

    currentRoom = relayNet.room;
    relayManager = new GroupRoomManager('MemberRelay', created.invite, '', false);
    await relayManager.join(callbacks, false);

    localAuthCache.delete(JSON.stringify([invite.roomId.toLowerCase(), relayManager.getLocalPeerId()]));
    currentRoom = newcomerNet.room;
    newcomerManager = new GroupRoomManager('Newcomer', created.invite, '', false);
    await newcomerManager.join(callbacks, false);

    const hostAuth = await PeerAuthenticator.create(invite.roomId, 'host', created.identity);
    const memberAuth = await PeerAuthenticator.create(invite.roomId, 'member');
    const newcomerAuth = await PeerAuthenticator.create(invite.roomId, 'newcomer');

    // Host verifies and admits member directly
    hostNet.room.onPeerJoin('member');
    await verifyDirectPeer(hostNet.actions, hostNet.sent, 'member', memberAuth);
    hostNet.sent.length = 0;
    await hostNet.actions.get('room_admission')!.onMessage!({ kind: 'request', password: '' }, { peerId: 'member' });
    const hostAdmitIndex = hostNet.sent.findIndex((item) =>
      item.action === 'room_admission' && item.data.kind === 'command' && item.data.command.kind === 'admit');
    const hostSyncIndex = hostNet.sent.findIndex((item) =>
      item.action === 'room_admission' && item.data.kind === 'sync' && item.target === 'member');
    const hostPresenceIndex = hostNet.sent.findIndex((item) =>
      item.action === 'presence' && item.target === 'member');
    assert.ok(hostAdmitIndex >= 0 && hostSyncIndex > hostAdmitIndex && hostPresenceIndex > hostSyncIndex,
      'host must send admission command and sync before announcing presence to the newcomer');
    const hostAdmittedMember = hostNet.sent[hostAdmitIndex]!.data.command;

    // Relay member authenticates host and applies its own admission
    const relaySelfId = relayManager.getLocalPeerId();
    const relaySelfKey = (relayManager as any).chatAuth.publicKey as string;
    const hostAuthority = new RoomAuthority(invite.roomId, invite.rootKey, hostAuth);
    const relaySelfAdmit = await hostAuthority.makeCommand('admit', { targetPeerId: relaySelfId, targetKey: relaySelfKey });
    relayNet.room.onPeerJoin('host');
    await verifyDirectPeer(relayNet.actions, relayNet.sent, 'host', hostAuth);
    await relayNet.actions.get('room_admission')!.onMessage!({ kind: 'command', command: relaySelfAdmit }, { peerId: 'host' });
    assert.equal(relayManager.hasAdmission(), true);

    // Relay member connects directly to newcomer (which cannot reach host)
    relayNet.room.onPeerJoin('newcomer');
    await verifyDirectPeer(relayNet.actions, relayNet.sent, 'newcomer', newcomerAuth);
    assert.ok(relayNet.sent.some((item) =>
      item.action === 'room_admission' && item.target === 'newcomer' && item.data.kind === 'relay-ready'),
      'admitted peer connected to host should advertise relay-ready to newcomer');

    // Newcomer connects directly only to member and triggers relay-request
    const newcomerSelfId = newcomerManager.getLocalPeerId();
    const newcomerSelfKey = (newcomerManager as any).chatAuth.publicKey as string;
    newcomerNet.room.onPeerJoin('member');
    await verifyDirectPeer(newcomerNet.actions, newcomerNet.sent, 'member', memberAuth);
    await newcomerNet.actions.get('room_admission')!.onMessage!({ kind: 'relay-ready' }, { peerId: 'member' });
    const newcomerReq = newcomerNet.sent.findLast((item) =>
      item.action === 'room_admission' && item.target === 'member' && item.data.kind === 'relay-request')!.data;
    assert.equal(newcomerReq.password, '', 'relayed admission must not send a room password through third parties');
    assert.equal(newcomerReq.targetPeerId, newcomerSelfId);
    assert.equal(newcomerReq.targetKey, newcomerSelfKey);

    // Relay rejects forged proof or banned key when acting on behalf of a newcomer on host
    const forgedSig = `${'a'.repeat(128)}`;
    hostNet.sent.length = 0;
    await hostNet.actions.get('room_admission')!.onMessage!({
      kind: 'relay-request',
      targetPeerId: 'newcomer',
      targetKey: newcomerAuth.publicKey,
      password: '',
      signature: forgedSig,
    }, { peerId: 'member' });
    assert.equal(hostNet.sent.some((item) => item.action === 'room_admission' && item.data.kind === 'command'), false);

    // Admitted relay forwards newcomer's genuine signed relay-request to host
    const sigForHost = await newcomerAuth.signControl('relay-admit', [invite.roomId, 'newcomer', newcomerAuth.publicKey]);
    relayNet.sent.length = 0;
    await relayNet.actions.get('room_admission')!.onMessage!({
      kind: 'relay-request',
      targetPeerId: 'newcomer',
      targetKey: newcomerAuth.publicKey,
      password: '',
      signature: sigForHost,
    }, { peerId: 'newcomer' });
    const forwardedToHost = relayNet.sent.findLast((item) =>
      item.action === 'room_admission' && item.target === 'host' && item.data.kind === 'relay-request')!.data;

    hostNet.sent.length = 0;
    await hostNet.actions.get('room_admission')!.onMessage!(forwardedToHost, { peerId: 'member' });
    const issuedCommand = hostNet.sent.findLast((item) =>
      item.action === 'room_admission' && item.target === 'member' && item.data.kind === 'command')?.data.command;
    assert.ok(issuedCommand && issuedCommand.kind === 'admit' && issuedCommand.targetPeerId === 'newcomer');

    // Relay receives host command and forwards [selfAdmit, newcomerAdmit, sync] to newcomer before presence
    relayNet.sent.length = 0;
    await relayNet.actions.get('room_admission')!.onMessage!({ kind: 'command', command: issuedCommand }, { peerId: 'host' });
    const relaySyncToNewcomerIndex = relayNet.sent.findIndex((item) =>
      item.action === 'room_admission' && item.target === 'newcomer' && item.data.kind === 'sync');
    const relayPresenceToNewcomerIndex = relayNet.sent.findIndex((item) =>
      item.action === 'presence' && item.target === 'newcomer');
    assert.ok(relaySyncToNewcomerIndex >= 0 && relayPresenceToNewcomerIndex > relaySyncToNewcomerIndex,
      'relay must deliver admission sync before announcing presence to the newcomer');
    const packetsToNewcomer = relayNet.sent
      .filter((item) => item.action === 'room_admission' && item.target === 'newcomer')
      .map((item) => item.data);
    assert.equal(packetsToNewcomer[0]?.kind, 'command');
    assert.equal(packetsToNewcomer[0]?.command?.targetPeerId, relaySelfId);
    assert.equal(packetsToNewcomer[1]?.kind, 'command');
    assert.equal(packetsToNewcomer[1]?.command?.targetPeerId, 'newcomer');
    assert.equal(packetsToNewcomer[2]?.kind, 'sync');

    relayNet.sent.length = 0;
    await relayNet.actions.get('presence')!.onMessage!({ username: 'Newcomer' }, { peerId: 'newcomer' });
    assert.equal(relayManager.getConnectedPeers().some((peer) => peer.id === 'newcomer'), true,
      'admitted relay must display the newly admitted newcomer after presence');
    assert.equal(
      relayNet.sent.filter((item) => item.action === 'presence' && item.target === 'newcomer').length,
      1,
      'first presence from a newly admitted peer must trigger one reciprocal presence reply',
    );
    await relayNet.actions.get('presence')!.onMessage!({ username: 'Newcomer' }, { peerId: 'newcomer' });
    assert.equal(
      relayNet.sent.filter((item) => item.action === 'presence' && item.target === 'newcomer').length,
      1,
      'subsequent presence heartbeats must not trigger reciprocal presence loops',
    );

    // Verify newcomer side admits both member (first command) and itself (second command), then accepts sync
    const memberAdmitCmd = await hostAuthority.makeCommand('admit', { targetPeerId: 'member', targetKey: memberAuth.publicKey });
    const newcomerAdmitCmd = await hostAuthority.makeCommand('admit', { targetPeerId: newcomerSelfId, targetKey: newcomerSelfKey });
    await newcomerNet.actions.get('room_admission')!.onMessage!({ kind: 'command', command: memberAdmitCmd }, { peerId: 'member' });
    await newcomerNet.actions.get('room_admission')!.onMessage!({ kind: 'command', command: newcomerAdmitCmd }, { peerId: 'member' });
    await newcomerNet.actions.get('room_admission')!.onMessage!(
      { kind: 'sync', commands: [hostAdmittedMember, memberAdmitCmd, newcomerAdmitCmd] },
      { peerId: 'member' },
    );
    assert.equal(newcomerManager.hasAdmission(), true);
    await newcomerNet.actions.get('presence')!.onMessage!({ username: 'MemberRelay' }, { peerId: 'member' });
    assert.equal(newcomerManager.getConnectedPeers().some((peer) => peer.id === 'member'), true,
      'relayed newcomer must accept trusted sync and display its relay peer');

    // Admitted indirect peer reported via peer_exchange appears immediately as 'connecting'
    // (and stays visible across onPeerJoin handoff until direct presence arrives), while strangers stay hidden.
    const thirdPeerAuth = await PeerAuthenticator.create(invite.roomId, 'third-peer');
    const strangerAuth = await PeerAuthenticator.create(invite.roomId, 'stranger-peer');
    const thirdAdmitCmd = await hostAuthority.makeCommand('admit', {
      targetPeerId: 'third-peer',
      targetKey: thirdPeerAuth.publicKey,
    });
    let latestNewcomerVoice: Record<string, { inVoice: boolean; muted: boolean; deafened: boolean }> = {};
    (newcomerManager as any).callbacks.onVoiceStateUpdate = (states: typeof latestNewcomerVoice) => {
      latestNewcomerVoice = states;
    };
    await newcomerNet.actions.get('room_admission')!.onMessage!(
      { kind: 'command', command: thirdAdmitCmd },
      { peerId: 'member' },
    );
    await newcomerNet.actions.get('peer_exchange')!.onMessage!({
      peers: [
        {
          peerId: 'third-peer',
          username: 'Uai, Zé',
          isStreaming: false,
          isCreator: false,
          joinedAt: Date.now(),
          publicKey: thirdPeerAuth.publicKey,
          inVoice: true,
          voiceMuted: false,
          voiceDeafened: false,
        },
        {
          peerId: 'stranger-peer',
          username: 'UnadmittedStranger',
          isStreaming: false,
          isCreator: false,
          joinedAt: Date.now(),
          publicKey: strangerAuth.publicKey,
          inVoice: true,
        },
      ],
    }, { peerId: 'member' });

    const connectingThird = newcomerManager.getConnectedPeers().find((peer) => peer.id === 'third-peer');
    assert.ok(connectingThird, 'admitted indirect peer must appear immediately before 1-to-1 WebRTC finishes');
    assert.equal(connectingThird.connectionState, 'connecting');
    assert.equal(connectingThird.username, 'Uai, Zé');
    assert.equal(newcomerManager.getAllRoomSlots().some((slot) => slot.peerId === 'third-peer' && slot.connectionState === 'connecting'), true);
    assert.equal(latestNewcomerVoice['third-peer']?.inVoice, true, 'indirect admitted peer voice presence surfaces immediately');
    assert.equal(newcomerManager.getConnectedPeers().some((peer) => peer.id === 'stranger-peer'), false,
      'unadmitted PEX rumors must never appear in the room roster');

    // Direct WebRTC connects: peer must stay visible (not blink out) while identity/presence completes.
    (newcomerNet.room.getPeers() as Record<string, object>)['third-peer'] = {};
    newcomerNet.room.onPeerJoin('third-peer');
    assert.equal(newcomerManager.getConnectedPeers().some((peer) => peer.id === 'third-peer'), true,
      'indirect peer must not disappear during direct WebRTC identity handshake');
    await verifyDirectPeer(newcomerNet.actions, newcomerNet.sent, 'third-peer', thirdPeerAuth);
    await newcomerNet.actions.get('presence')!.onMessage!({ username: 'Uai, Zé' }, { peerId: 'third-peer' });
    assert.equal(
      newcomerManager.getConnectedPeers().find((peer) => peer.id === 'third-peer')?.connectionState,
      'connected',
      'peer upgrades cleanly from connecting to connected once direct presence arrives',
    );

    // Banned keys must still be rejected on relay-request
    const bannedAuth = await PeerAuthenticator.create(invite.roomId, 'banned-peer');
    (hostManager as any).bannedKeys.add(bannedAuth.publicKey);
    hostNet.sent.length = 0;
    await hostNet.actions.get('room_admission')!.onMessage!({
      kind: 'relay-request',
      targetPeerId: 'banned-peer',
      targetKey: bannedAuth.publicKey,
      password: '',
      signature: await bannedAuth.signControl('relay-admit', [invite.roomId, 'banned-peer', bannedAuth.publicKey]),
    }, { peerId: 'member' });
    assert.equal(hostNet.sent.some((item) => item.action === 'room_admission' && item.data.kind === 'command'), false);
  } finally {
    await newcomerManager?.leave();
    await relayManager?.leave();
    await hostManager.leave();
    await savedRooms.remove(invite.roomId);
    (signalingManager as any).joinRoom = originalJoin;
    (signalingManager as any).leaveRoom = originalLeave;
    (signalingManager as any).reannounce = originalReannounce;
  }
});

test('admin-managed room without host keeps indirect admins and preview-promoted peers visible and accepts forwarded admin-admit', async () => {
  const created = await createAuthenticatedInvite('Admin room without host');
  const baseInvite = parseRoomInvite(created.invite)!;
  const hostAuth = await PeerAuthenticator.create(baseInvite.roomId, 'offline-host', created.identity);
  const hostAuthority = new RoomAuthority(baseInvite.roomId, baseInvite.rootKey, hostAuth);

  const adminA = await PeerAuthenticator.create(baseInvite.roomId, 'augusto-peer');
  const adminB = await PeerAuthenticator.create(baseInvite.roomId, 'marcio-peer');
  const eduardo = await PeerAuthenticator.create(baseInvite.roomId, 'eduardo-peer');

  const grantA = await hostAuthority.makeCommand('admin', { targetPeerId: 'old-augusto-id', targetKey: adminA.publicKey });
  const grantB = await hostAuthority.makeCommand('admin', { targetPeerId: 'old-marcio-id', targetKey: adminB.publicKey });
  const signedInvite = await signRoomInvite({
    ...baseInvite,
    version: 4 as const,
    revision: 2,
    adminKeys: [adminA.publicKey, adminB.publicKey].sort(),
  }, hostAuth);
  const inviteCode = formatRoomInvite(signedInvite);

  // Admin A (Augusto) previously admitted Eduardo while Host was offline.
  const adminAAuthority = new RoomAuthority(baseInvite.roomId, baseInvite.rootKey, adminA);
  const eduardoAdminAdmit = await adminAAuthority.signAdminAdmission('eduardo-peer', eduardo.publicKey, grantA);

  // Save Admin B's identity in savedRooms so local manager joins as Admin B (not Host).
  await savedRooms.put({
    roomId: baseInvite.roomId,
    invite: inviteCode,
    name: 'Admin room without host',
    saved: true,
    owned: false,
    identity: adminB.exportIdentity(),
    hostCommands: [grantA, grantB],
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
    getPeers: () => ({ 'eduardo-peer': {} }),
    addStream: () => [],
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

  const callbacks = {
    onStreamsUpdate: () => {}, onSlotsUpdate: () => {}, onChat: () => {},
    onChatHistory: () => {}, onPeersUpdate: () => {}, onStatusChange: () => {},
  };

  const manager = new GroupRoomManager('iMarcioo', inviteCode, '', false);
  try {
    // 1. Start in preview mode (JoinRoomModal) and receive signed preview from Eduardo (admin-admitted member).
    await manager.join(callbacks, true);
    room.onPeerJoin('eduardo-peer');
    const nonce = sent.findLast((item) => item.action === 'peer_identity' && item.data.kind === 'challenge')!.data.nonce;
    await actions.get('peer_identity')!.onMessage!({
      kind: 'proof',
      nonce,
      key: eduardo.publicKey,
      signature: await eduardo.signControl('identity', [baseInvite.roomId, 'eduardo-peer', nonce]),
    }, { peerId: 'eduardo-peer' });

    const previewNonce = (manager as any).previewNonce;
    const preview = {
      name: 'Admin room without host',
      protected: false,
      participants: [
        { id: 'eduardo-peer', name: 'Eduardo', color: '#06b6d4' },
        { id: 'augusto-peer', name: 'Augusto', color: '#f59e0b' },
      ],
    };
    await actions.get('room_preview_v1')!.onMessage!({
      kind: 'response',
      nonce: previewNonce,
      preview,
      signature: await eduardo.signControl('room-preview', [previewNonce, preview]),
      adminMembership: eduardoAdminAdmit,
      canAdmit: false,
    }, { peerId: 'eduardo-peer' });

    // 2. Promote preview into active room as Admin B: Augusto must NOT vanish on entry!
    await manager.join(callbacks, false);
    assert.equal(manager.isRoomAdmin(), true);
    assert.equal(manager.hasAdmission(), true);
    assert.equal(
      manager.getConnectedPeers().some((p) => p.id === 'augusto-peer' && p.username === 'Augusto' && p.connectionState === 'connecting'),
      true,
      'indirect admin seen in verified preview must remain visible immediately upon entering the room',
    );

    // 3. Even if Eduardo sends a legacy v1.8.4 peer_exchange without publicKey, Augusto stays visible;
    //    and once mesh_ack delivers Augusto's admin publicKey, Augusto is recognized as an admin!
    await actions.get('peer_exchange')!.onMessage!({
      peers: [{ peerId: 'augusto-peer', username: 'Augusto', isStreaming: false, isCreator: false, joinedAt: Date.now() }],
    }, { peerId: 'eduardo-peer' });
    assert.equal(manager.getConnectedPeers().some((p) => p.id === 'augusto-peer'), true);

    await actions.get('mesh_relay')!.onMessage!({
      target: manager.getLocalPeerId(),
      origin: 'augusto-peer',
      kind: 'mesh_ack',
      payload: { username: 'Augusto', isCreator: false, joinedAt: Date.now(), isStreaming: false, publicKey: adminA.publicKey },
    }, { peerId: 'eduardo-peer' });
    const augustoInfo = manager.getConnectedPeers().find((p) => p.id === 'augusto-peer');
    assert.ok(augustoInfo);
    assert.equal(augustoInfo.isAdmin, true, 'indirect admin key pinned via mesh_ack must surface admin role');

    // 4. Forwarded admin-admit from non-admin Eduardo for another newcomer is accepted via cryptographic verification.
    const guestAuth = await PeerAuthenticator.create(baseInvite.roomId, 'late-guest');
    const relayedGuestAdmit = await adminAAuthority.signAdminAdmission('late-guest', guestAuth.publicKey, grantA);
    await actions.get('room_admission')!.onMessage!({
      kind: 'admin-admit',
      admission: relayedGuestAdmit,
    }, { peerId: 'eduardo-peer' });
    assert.equal(
      (manager as any).adminAdmissions.get('late-guest')?.targetKey,
      guestAuth.publicKey,
      'cryptographically valid admin-admit forwarded by an admitted non-admin member must be stored',
    );
  } finally {
    await manager.leave();
    await savedRooms.remove(baseInvite.roomId);
    (signalingManager as any).joinRoom = originalJoin;
    (signalingManager as any).leaveRoom = originalLeave;
    (signalingManager as any).reannounce = originalReannounce;
  }
});
