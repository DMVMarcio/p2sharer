import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PeerAuthenticator } from '../../src/core/peer_auth.ts';
import { RoomAuthority } from '../../src/core/room_authority.ts';
import { compareRoomInvites, createAuthenticatedInvite, formatRoomInvite,
  parseRoomInvite, signRoomInvite } from '../../src/core/room_invite.ts';
import { verifyRoomInvite } from '../../src/core/room_invite_validation.ts';
import { savedRooms } from '../../src/core/saved_rooms.ts';

test('named invitations reject tampered names, administrator grants, and signatures', async () => {
  const created = await createAuthenticatedInvite('Sala do Café');
  const initial = await verifyRoomInvite(created.invite);
  assert.ok(initial && initial.version === 4);
  assert.equal(initial.name, 'Sala do Café');
  assert.equal(parseRoomInvite(created.invite)?.roomId, initial.roomId);

  const host = await PeerAuthenticator.create(initial.roomId, 'snapshot-host', created.identity);
  const admin = await PeerAuthenticator.create(initial.roomId, 'snapshot-admin');
  const authority = new RoomAuthority(initial.roomId, initial.rootKey, host);
  await authority.makeCommand('admin',
    { targetPeerId: 'snapshot-admin', targetKey: admin.publicKey });
  const updated = await signRoomInvite({
    version: 4, roomId: initial.roomId, rootKey: initial.rootKey, name: 'Sala Atualizada',
    epoch: 0, revision: authority.nextSnapshotRevision(), adminKeys: [admin.publicKey], authorityChain: [],
  }, host);
  assert.ok(await verifyRoomInvite(formatRoomInvite(updated)));
  assert.ok(compareRoomInvites(updated, initial) > 0);
  assert.equal(await verifyRoomInvite(formatRoomInvite({ ...updated, name: 'Sala Falsa' })), null);
  assert.equal(await verifyRoomInvite(formatRoomInvite({ ...updated, adminKeys: [] })), null);
  assert.equal(await verifyRoomInvite(formatRoomInvite({ ...updated,
    adminKeys: [host.publicKey] })), null);

  const revoked = await signRoomInvite({ ...updated,
    revision: authority.nextSnapshotRevision(), adminKeys: [] }, host);
  assert.ok(await verifyRoomInvite(formatRoomInvite(revoked)));
  assert.ok(compareRoomInvites(revoked, updated) > 0);
  assert.equal(revoked.adminKeys.length, 0);
});

test('a successor can sign an updated invitation only with a valid ownership chain', async () => {
  const created = await createAuthenticatedInvite('Original');
  const original = await verifyRoomInvite(created.invite);
  assert.ok(original && original.version === 4);
  const host = await PeerAuthenticator.create(original.roomId, 'transfer-host', created.identity);
  const successor = await PeerAuthenticator.create(original.roomId, 'transfer-successor');
  const hostAuthority = new RoomAuthority(original.roomId, original.rootKey, host);
  const successorAuthority = new RoomAuthority(original.roomId, original.rootKey, successor);
  const offer = await hostAuthority.proposeTransfer(successor.publicKey, 'transfer-successor');
  const transfer = await successorAuthority.acceptTransfer(offer);
  assert.equal(await successorAuthority.applyTransfer(transfer), true);
  const updated = await signRoomInvite({
    version: 4, roomId: original.roomId, rootKey: original.rootKey, name: 'Novo anfitrião',
    epoch: 1, revision: successorAuthority.nextSnapshotRevision(),
    adminKeys: [], authorityChain: [transfer],
  }, successor);
  assert.ok(await verifyRoomInvite(formatRoomInvite(updated)));
  assert.equal(await verifyRoomInvite(formatRoomInvite({ ...updated, authorityChain: [] })), null);
  assert.equal(await verifyRoomInvite(formatRoomInvite({ ...updated, epoch: 0 })), null);
});

test('saved room updates retain the newest invitation and a custom local title', async () => {
  const created = await createAuthenticatedInvite('Nome original');
  const initial = await verifyRoomInvite(created.invite);
  assert.ok(initial && initial.version === 4);
  const host = await PeerAuthenticator.create(initial.roomId, 'saved-host', created.identity);
  const updated = await signRoomInvite({
    version: 4, roomId: initial.roomId, rootKey: initial.rootKey, name: 'Nome novo',
    epoch: 0, revision: 2, adminKeys: [], authorityChain: [],
  }, host);
  const currentInvite = formatRoomInvite(updated);
  try {
    await savedRooms.put({ roomId: initial.roomId, invite: created.invite,
      name: initial.name, customName: 'Meu apelido', saved: true, owned: false });
    await Promise.all([
      savedRooms.put({ roomId: initial.roomId, invite: currentInvite,
        name: updated.name, customName: 'Meu apelido', saved: true, owned: false }),
      savedRooms.put({ roomId: initial.roomId, invite: created.invite,
        name: initial.name, saved: true, owned: false }),
    ]);
    const stored = await savedRooms.get(initial.roomId);
    assert.equal(stored?.invite, currentInvite);
    assert.equal(stored?.name, 'Nome novo');
    assert.equal(stored?.customName, 'Meu apelido');
  } finally {
    await savedRooms.remove(initial.roomId);
  }
});
