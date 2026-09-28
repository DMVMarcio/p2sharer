import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PeerAuthenticator } from '../../src/core/peer_auth.ts';
import { RoomAuthority } from '../../src/core/room_authority.ts';
import { createAuthenticatedInvite, parseRoomInvite } from '../../src/core/room_invite.ts';

test('invitation anchors host identity and rejects forged authority changes', async () => {
  const created = await createAuthenticatedInvite();
  const invite = parseRoomInvite(created.invite);
  assert.ok(invite);
  assert.equal(parseRoomInvite('cyber-falcon-482'), null);
  assert.equal(parseRoomInvite(created.invite + 'x'), null);

  const alice = await PeerAuthenticator.create(invite.roomId, 'alice', created.identity);
  const bob = await PeerAuthenticator.create(invite.roomId, 'bob');
  const mallory = await PeerAuthenticator.create(invite.roomId, 'mallory');
  const aliceAuthority = new RoomAuthority(invite.roomId, invite.rootKey, alice);
  const bobAuthority = new RoomAuthority(invite.roomId, invite.rootKey, bob);
  assert.equal(aliceAuthority.isLocalHost(), true);
  assert.equal(bobAuthority.isLocalHost(), false);

  const proposal = await aliceAuthority.proposeTransfer(bob.publicKey, 'bob');
  const accepted = await bobAuthority.acceptTransfer(proposal);
  assert.equal(await bobAuthority.applyTransfer({ ...accepted, nextKey: mallory.publicKey }), false);
  assert.equal(await bobAuthority.applyTransfer(accepted), true);
  assert.equal(await aliceAuthority.applyTransfer(accepted), true);
  assert.equal(bobAuthority.isLocalHost(), true);
  assert.equal(aliceAuthority.isLocalHost(), false);
  assert.equal(await aliceAuthority.applyTransfer(accepted), false);
  await assert.rejects(() => aliceAuthority.makeCommand('kick', { targetPeerId: 'bob', targetKey: bob.publicKey }));

  const kicked = await bobAuthority.makeCommand('kick', { targetPeerId: 'mallory', targetKey: mallory.publicKey });
  assert.equal(await aliceAuthority.verifyCommand({ ...kicked, targetPeerId: 'alice' }), false);
  assert.equal(await aliceAuthority.verifyCommand(kicked), true);
  assert.equal(await aliceAuthority.verifyCommand(kicked), false);

  const late = await PeerAuthenticator.create(invite.roomId, 'late');
  const lateAuthority = new RoomAuthority(invite.roomId, invite.rootKey, late);
  assert.equal(await lateAuthority.importChain([accepted]), true);
  assert.equal(lateAuthority.currentKey, bob.publicKey);
  assert.equal(await lateAuthority.verifyCommand(kicked), true);
});

test('signed commands remain verifiable out of order but cannot be replayed', async () => {
  const created = await createAuthenticatedInvite();
  const invite = parseRoomInvite(created.invite)!;
  const host = await PeerAuthenticator.create(invite.roomId, 'host', created.identity);
  const member = await PeerAuthenticator.create(invite.roomId, 'member');
  const source = new RoomAuthority(invite.roomId, invite.rootKey, host);
  const receiver = new RoomAuthority(invite.roomId, invite.rootKey, member);
  const admitted = await source.makeCommand('admit', { targetPeerId: 'member', targetKey: member.publicKey });
  const changedPassword = await source.makeCommand('password', { password: 'new-secret' });
  assert.equal(await receiver.verifyCommand(changedPassword), true);
  assert.equal(await receiver.verifyCommand(admitted), true);
  assert.equal(await receiver.verifyCommand(changedPassword), false);
  assert.equal(await receiver.verifyCommand({ ...admitted, targetKey: host.publicKey }), false);
});
