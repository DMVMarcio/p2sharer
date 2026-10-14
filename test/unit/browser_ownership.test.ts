import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserOwnership } from '../../src/apps/browser_ownership.ts';

test('the first accepted starter owns the browser, concurrent starts cannot split ownership, and stale releases cannot stop its successor', async () => {
  const models = new Map<string, BrowserOwnership>();
  const members = ['alice','bob','creator'];
  for (const actor of members) models.set(actor, new BrowserOwnership(actor, async (packet, peer) => {
    models.get(peer)?.handle(packet, actor, false);
  }, () => {}));
  for (const model of models.values()) model.updateMembers(members);
  assert.ok([...models.values()].every(model => !model.host));
  const results = await Promise.all([models.get('bob')!.request(), models.get('creator')!.request()]);
  assert.deepEqual(results, [true, false]); assert.ok([...models.values()].every(model => model.host === 'bob'));
  const oldTerm = models.get('bob')!.term;
  const oldVersion = models.get('bob')!.version - 1;
  models.get('alice')!.handle({ type: 'host-release', term: oldTerm }, 'creator', false);
  assert.equal(models.get('alice')!.host, 'bob');
  await models.get('bob')!.release(); assert.ok([...models.values()].every(model => !model.host));
  models.get('alice')!.handle({ type: 'host-request', id: oldTerm, version: oldVersion }, 'bob', false);
  assert.equal(models.get('alice')!.host, '', 'a replayed start cannot reserve a later session');
  assert.equal(await models.get('creator')!.request(), true);
  models.get('alice')!.handle({ type: 'host-release', term: oldTerm }, 'bob', false);
  models.get('bob')!.handle({ type: 'ownership', host: 'bob', term: crypto.randomUUID(), version: 1000 }, 'creator', false);
  assert.equal(models.get('bob')!.host, 'creator');
  for (const model of models.values()) model.cancel();
});

test('coordinator departure, a new host and a returning coordinator preserve the current ownership term', async () => {
  const models = new Map<string, BrowserOwnership>(); const members = ['alice','bob','creator'];
  for (const actor of members) models.set(actor, new BrowserOwnership(actor, async (packet, peer) => {
    models.get(peer)?.handle(packet, actor, false);
  }, () => {}));
  for (const model of models.values()) model.updateMembers(members);
  await models.get('bob')!.request();
  for (const model of models.values()) model.updateMembers(['bob','creator']);
  await models.get('bob')!.release(); await models.get('creator')!.request();
  const term = models.get('creator')!.term;
  for (const model of models.values()) model.updateMembers(members);
  assert.ok([...models.values()].every(model => model.host === 'creator' && model.term === term));
  for (const model of models.values()) model.updateMembers(['alice','bob']);
  assert.ok(['alice','bob'].every(actor => !models.get(actor)!.host));
  assert.equal(await models.get('bob')!.request(), true);
  for (const model of models.values()) model.cancel();
});
