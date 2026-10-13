import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAuthenticatedInvite } from '../../src/core/room_invite.ts';
import { verifyRoomInvite } from '../../src/core/room_invite_validation.ts';
import { extractRoomInvite, roomInviteLink, RoomDeepLinkInbox } from '../../src/core/room_deep_links.ts';

test('application invitation links preserve signed credentials and reject ambiguous URL fields', async () => {
  const { invite } = await createAuthenticatedInvite('Link fixture');
  const link = roomInviteLink(invite);
  assert.equal(new URL(link).pathname, `/${invite}`);
  assert.equal(extractRoomInvite(new URL(link).href), invite);
  assert.equal(extractRoomInvite(` p2sharer://convite/${invite} `), invite);
  assert.equal(extractRoomInvite(invite), invite);
  assert.ok(await verifyRoomInvite(extractRoomInvite(link)!));
  for (const value of [`https://invite/${invite}`, `${link}?password=fixture`, `${link}#fragment`,
    `${link}/`, `p2sharer://user@invite/${invite}`, `p2sharer://invite:123/${invite}`,
    `p2sharer://invite/%70${invite.slice(1)}`, 'p2sharer://invite/invalid']) {
    assert.equal(extractRoomInvite(value), null);
  }
  assert.equal(roomInviteLink('invalid'), '');
});

test('external invitations wait for readiness and retain only the latest pending room', async () => {
  const first = (await createAuthenticatedInvite('First fixture')).invite;
  const second = (await createAuthenticatedInvite('Second fixture')).invite;
  let ready = false;
  const opened: string[] = [];
  const inbox = new RoomDeepLinkInbox(invite => { opened.push(invite); ready = false; }, () => ready);
  inbox.receive([roomInviteLink(first)]);
  inbox.receive([roomInviteLink(second), 'https://example.com', 'p2sharer://invalid']);
  inbox.flush();
  assert.deepEqual(opened, []);
  ready = true;
  inbox.flush();
  assert.deepEqual(opened, [second]);
  ready = true;
  inbox.flush();
  assert.deepEqual(opened, [second], 'finishing a dialog must not reopen a consumed invitation');
  inbox.receive([roomInviteLink(first)]);
  assert.deepEqual(opened, [second, first]);
});
