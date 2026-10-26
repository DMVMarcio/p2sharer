import assert from 'node:assert/strict';
import test from 'node:test';
import { TwitchModel } from '../../src/apps/models.ts';
import type { TwitchState } from '../../src/apps/types.ts';

test('TwitchModel updates state and emits snapshots with incremented clock', () => {
  const emitted: unknown[] = [];
  let changeCount = 0;

  const model = new TwitchModel({
    localActor: 'peer-a',
    emit: (payload) => emitted.push(payload),
    changed: () => { changeCount++; },
  });

  assert.equal(model.state.channel, '');
  assert.equal(model.state.playing, true);

  const nextState: TwitchState = {
    channel: 'gaules',
    playing: true,
    updatedAt: 100,
    syncReason: 'channel',
  };

  model.update(nextState);

  assert.equal(model.state.channel, 'gaules');
  assert.equal(model.actor, 'peer-a');
  assert.equal(changeCount, 1);
  assert.equal(emitted.length, 1);
  assert.deepEqual(emitted[0], {
    state: nextState,
    clock: 1,
    actor: 'peer-a',
  });
});

test('TwitchModel applies remote updates honoring Lamport clock and actor ordering', () => {
  let changeCount = 0;
  const model = new TwitchModel({
    localActor: 'peer-a',
    emit: () => {},
    changed: () => { changeCount++; },
  });

  const remoteState: TwitchState = {
    channel: 'alanzoka',
    playing: true,
    updatedAt: 200,
  };

  // Valid remote update with clock 1
  model.apply({ state: remoteState, clock: 1, actor: 'peer-b' }, 'peer-b', false);
  assert.equal(model.state.channel, 'alanzoka');
  assert.equal(model.actor, 'peer-b');
  assert.equal(changeCount, 1);

  // Stale update with clock 0 should be rejected
  model.apply({ state: { ...remoteState, channel: 'shroud' }, clock: 0, actor: 'peer-c' }, 'peer-c', false);
  assert.equal(model.state.channel, 'alanzoka');
  assert.equal(changeCount, 1);

  // Same clock tie break: actor 'peer-a' <= 'peer-b' should be rejected
  model.apply({ state: { ...remoteState, channel: 'shroud' }, clock: 1, actor: 'peer-a' }, 'peer-a', false);
  assert.equal(model.state.channel, 'alanzoka');
  assert.equal(changeCount, 1);

  // Advance clock with higher clock: 2
  model.apply({ state: { ...remoteState, channel: 'shroud' }, clock: 2, actor: 'peer-c' }, 'peer-c', false);
  assert.equal(model.state.channel, 'shroud');
  assert.equal(model.actor, 'peer-c');
  assert.equal(changeCount, 2);
});
