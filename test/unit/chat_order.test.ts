import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeChatHistory, nextChatOrder } from '../../src/core/chat/chat_history.ts';
import { PeerAuthenticator } from '../../src/core/network/peer_auth.ts';
import type { ChatMessage } from '../../src/core/types.ts';

const message = (id: string, timestamp: number, logicalOrder: number): ChatMessage => ({
  id, timestamp, logicalOrder, sender: id, authorId: id, text: id, revision: 0,
});

test('observed messages precede replies despite minutes of clock skew and clock rollback', () => {
  const first = message('alice', 600_000, nextChatOrder([]));
  const second = message('bob', 1_000, nextChatOrder([first]));
  const third = message('carol', -100_000, nextChatOrder([first, second]));
  assert.deepEqual(mergeChatHistory([third], [second, first]).map((item) => item.id),
    ['alice', 'bob', 'carol']);
  assert.equal(second.timestamp, 1_000);
});

test('concurrent messages converge regardless of delivery order, locale or wall clock', () => {
  const a = message('Z', 1_000, 5);
  const b = message('a', 900_000, 5);
  assert.deepEqual(mergeChatHistory([a], [b]), mergeChatHistory([b], [a]));
  assert.deepEqual(mergeChatHistory([a], [b]).map((item) => item.id), ['Z', 'a']);
  assert.equal(nextChatOrder([b, a], 8), 9);
});

test('equal logicalOrder ties break chronologically by timestamp before code-unit ID', () => {
  const earlier = message('ffff', 1_000, 1);
  const later = message('0000', 2_000, 1);
  assert.deepEqual(mergeChatHistory([later], [earlier]).map((item) => item.id), ['ffff', '0000']);
  const sameTsZ = message('Z', 5_000, 5);
  const sameTsA = message('a', 5_000, 5);
  assert.deepEqual(mergeChatHistory([sameTsA], [sameTsZ]).map((item) => item.id), ['Z', 'a']);
});

test('nextChatOrder seeds from minOrder when history is empty or older and stays monotonic', () => {
  assert.equal(nextChatOrder([], 0, 1_700_000_000_000), 1_700_000_000_000);
  const prior = message('prior', 1_700_000_000_500, 1_700_000_000_500);
  assert.equal(nextChatOrder([prior], 0, 1_700_000_000_000), 1_700_000_000_501);
  assert.equal(nextChatOrder([message('legacy', 100, 2)], 0, 1_700_000_000_000), 1_700_000_000_000);
});

test('edits and deletion keep position and cannot change the original ordering fields', () => {
  const original = message('first', 100, 1);
  const later = message('second', 50, 2);
  const edit = { ...original, text: 'edited', revision: 1, editedAt: 1_000 };
  assert.deepEqual(mergeChatHistory([original, later], [edit]), [edit, later]);
  assert.deepEqual(mergeChatHistory([original, later], [{ ...edit, logicalOrder: 3 }]), [original, later]);
  assert.deepEqual(mergeChatHistory([original, later], [{ ...edit, timestamp: 200 }]), [original, later]);
  const deleted = { ...edit, text: '', revision: 2, deletedAt: 2_000 };
  assert.deepEqual(mergeChatHistory([edit, later], [deleted, original]), [deleted, later]);
});

test('pre-sequence history is retained and malformed sequence values are rejected', () => {
  const old = { ...message('old', 100, 1), logicalOrder: undefined };
  const fresh = message('fresh', 0, nextChatOrder([old]));
  assert.deepEqual(mergeChatHistory([fresh], [old]), [old, fresh]);
  for (const logicalOrder of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.deepEqual(mergeChatHistory([], [{ ...fresh, logicalOrder }]), []);
  }
  assert.throws(() => nextChatOrder([message('exhausted', 0, Number.MAX_SAFE_INTEGER)]));
});

test('signatures protect logical order against replacement, removal and invalid values', async () => {
  const alice = await PeerAuthenticator.create('order-room', 'alice');
  const bob = await PeerAuthenticator.create('order-room', 'bob');
  const signed = await alice.sign(message('alice', 100, 42));
  assert.equal(await bob.verify(signed, 'alice'), true);
  for (const logicalOrder of [43, undefined, 0, -1, 1.5, Infinity]) {
    assert.equal(await bob.verify({ ...signed, logicalOrder }, 'alice'), false);
  }
});
