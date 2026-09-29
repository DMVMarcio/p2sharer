import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeChatHistory } from '../../src/core/chat_history.ts';
import { PeerAuthenticator } from '../../src/core/peer_auth.ts';
import type { ChatMessage } from '../../src/core/types.ts';

test('forged edits, deletions, relays, history and replay cannot change another author', async () => {
  const alice = await PeerAuthenticator.create('secure-room', 'alice');
  const bob = await PeerAuthenticator.create('secure-room', 'bob');
  const mallory = await PeerAuthenticator.create('secure-room', 'mallory');
  const otherRoom = await PeerAuthenticator.create('other-room', 'bob');
  const original = await alice.sign({
    id: 'm1', authorId: 'alice', sender: 'Alice', text: 'Original', timestamp: 1000, revision: 0,
  });

  assert.equal(await bob.verify(original, 'alice'), true);
  assert.equal(await otherRoom.verify(original, 'alice'), false);
  assert.equal(await bob.verify({ ...original, text: 'Hacked', revision: 1 }, 'mallory'), false);
  assert.equal(await bob.verify({ ...original, text: '', deletedAt: 2000, revision: 2 }, 'mallory'), false);
  assert.equal(await bob.verify({ ...original, replyTo: null }, 'alice'), false);
  assert.equal(await bob.verify({ ...original, isSystem: 'true' }, 'alice'), false);

  const appNotice = await alice.sign({
    id: 'app-notice', authorId: 'alice', sender: 'Sistema', text: 'Alice iniciou YouTube',
    timestamp: 1100, revision: 0, isSystem: true, systemType: 'app-start',
    systemActor: 'Alice', systemAppKind: 'youtube',
  });
  assert.equal(await bob.verify(appNotice, 'alice'), true);
  assert.equal(await bob.verify({ ...appNotice, systemAppKind: 'notepad' }, 'alice'), false);

  const forgedIdentity = await mallory.sign({
    ...original, authorId: 'mallory', text: 'Forged', revision: 9,
  });
  assert.equal(await bob.verify({ ...forgedIdentity, authorId: 'alice' }, 'mallory'), false);
  assert.equal(await bob.verify(forgedIdentity, 'mallory'), true);
  assert.deepEqual(mergeChatHistory([original], [forgedIdentity]), [original]);

  const authenticEdit = await alice.sign({ ...original, text: 'Edited', revision: 1, editedAt: 2000 });
  assert.equal(await bob.verify(authenticEdit, 'mallory'), true);
  let history: ChatMessage[] = mergeChatHistory([original], [authenticEdit]);
  assert.equal(history[0].text, 'Edited');

  const authenticDelete = await alice.sign({ ...authenticEdit, text: '', revision: 2, deletedAt: 3000 });
  assert.equal(await bob.verify(authenticDelete, 'mallory'), true);
  history = mergeChatHistory(history, [authenticDelete, original, authenticEdit]);
  assert.equal(history[0].deletedAt, 3000);
  assert.equal(history[0].text, '');

  const unknown = await PeerAuthenticator.create('secure-room', 'unknown');
  const unknownMessage = await unknown.sign({
    id: 'm2', authorId: 'unknown', sender: 'Unknown', text: 'Not yet bound', timestamp: 4000, revision: 0,
  });
  assert.equal(await bob.verify(unknownMessage, 'mallory'), false);
});
