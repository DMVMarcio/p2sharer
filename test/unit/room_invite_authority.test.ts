import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PeerAuthenticator } from '../../src/core/peer_auth.ts';
import { RoomAuthority } from '../../src/core/room_authority.ts';
import { createAuthenticatedInvite, parseRoomInvite } from '../../src/core/room_invite.ts';
import { latestAdminCommand, roomStateFingerprint } from '../../src/core/room_state_sync.ts';

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

test('only a host-granted administrator can sign room-scoped admissions', async () => {
  const created = await createAuthenticatedInvite();
  const invite = parseRoomInvite(created.invite)!;
  const host = await PeerAuthenticator.create(invite.roomId, 'admin-test-host', created.identity);
  const admin = await PeerAuthenticator.create(invite.roomId, 'admin-test-admin');
  const guest = await PeerAuthenticator.create(invite.roomId, 'admin-test-guest');
  const attacker = await PeerAuthenticator.create(invite.roomId, 'admin-test-attacker');
  const issuer = new RoomAuthority(invite.roomId, invite.rootKey, host);
  const adminAuthority = new RoomAuthority(invite.roomId, invite.rootKey, admin);
  const receiver = new RoomAuthority(invite.roomId, invite.rootKey, guest);
  const grant = await issuer.makeCommand('admin', { targetPeerId: 'admin-test-admin', targetKey: admin.publicKey });
  assert.equal(await receiver.verifyGrant(grant), true);
  assert.equal(await receiver.verifyGrant({ ...grant, targetKey: attacker.publicKey }), false);
  const admission = await adminAuthority.signAdminAdmission('admin-test-guest', guest.publicKey, grant);
  assert.equal(await receiver.verifyAdminAdmission(admission), true);
  assert.equal(await receiver.verifyAdminAdmission({ ...admission, targetPeerId: 'other-device' }), false);
  assert.equal(await receiver.verifyAdminAdmission({ ...admission, targetKey: attacker.publicKey }), false);
  await assert.rejects(() => new RoomAuthority(invite.roomId, invite.rootKey, attacker)
    .signAdminAdmission('admin-test-guest', guest.publicKey, grant));
});

test('forged and replayed host commands fail across restored room state', async () => {
  const created = await createAuthenticatedInvite();
  const invite = parseRoomInvite(created.invite)!;
  const host = await PeerAuthenticator.create(invite.roomId, 'restored-host', created.identity);
  const member = await PeerAuthenticator.create(invite.roomId, 'restored-member');
  const attacker = await PeerAuthenticator.create(invite.roomId, 'restored-attacker');
  const issuer = new RoomAuthority(invite.roomId, invite.rootKey, host);
  const receiver = new RoomAuthority(invite.roomId, invite.rootKey, member);
  const grant = await issuer.makeCommand('admin', { targetPeerId: 'restored-member', targetKey: member.publicKey });
  const revoke = await issuer.makeCommand('revoke-admin',
    { targetPeerId: 'restored-member', targetKey: member.publicKey });
  const forged = { ...grant, signature: await attacker.signControl('host-command', [
    grant.roomId, grant.epoch, grant.sequence, grant.kind, grant.targetPeerId, grant.targetKey, null,
  ]) };

  assert.equal(await receiver.verifyCommand(forged), false);
  assert.equal(await receiver.verifyCommand({ ...grant, roomId: 'other-room' }), false);
  assert.equal(await receiver.verifyCommand(revoke), true);
  assert.equal(await receiver.verifyCommand(grant), true, 'genuine commands can arrive out of order');
  assert.equal(latestAdminCommand([revoke, grant], 0, member.publicKey)?.kind, 'revoke-admin');
  assert.equal(await receiver.verifyCommand(grant), false, 'replayed grant is rejected');

  const restored = new RoomAuthority(invite.roomId, invite.rootKey,
    await PeerAuthenticator.create(invite.roomId, 'restored-member-restart', member.exportIdentity()));
  const savedCommands = structuredClone([revoke, grant]);
  for (const command of savedCommands) assert.equal(await restored.verifyCommand(command), true);
  assert.equal(await restored.verifyCommand(grant), false, 'restored history preserves replay protection');
  assert.equal(latestAdminCommand(savedCommands, 0, member.publicKey)?.kind, 'revoke-admin');
});

test('room state fingerprints detect missing revocations despite reordered history', async () => {
  const created = await createAuthenticatedInvite();
  const invite = parseRoomInvite(created.invite)!;
  const host = await PeerAuthenticator.create(invite.roomId, 'summary-host', created.identity);
  const admin = await PeerAuthenticator.create(invite.roomId, 'summary-admin');
  const issuer = new RoomAuthority(invite.roomId, invite.rootKey, host);
  const grant = await issuer.makeCommand('admin', { targetPeerId: 'summary-admin', targetKey: admin.publicKey });
  const revoke = await issuer.makeCommand('revoke-admin',
    { targetPeerId: 'summary-admin', targetKey: admin.publicKey });
  const complete = await roomStateFingerprint(0, [grant, revoke]);
  assert.equal(complete, await roomStateFingerprint(0, [revoke, grant]));
  assert.notEqual(complete, await roomStateFingerprint(0, [grant]));
  assert.notEqual(complete, await roomStateFingerprint(1, [grant, revoke]));
  assert.notEqual(complete, await roomStateFingerprint(0, [{ ...grant, signature: revoke.signature }, revoke]));
});
