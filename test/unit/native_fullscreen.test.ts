import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeFullscreenSession } from '../../src/core/native_fullscreen.ts';

test('fullscreen snapshots placement before resizing and restores it after native exit', async () => {
  const initial = { x: 100, y: 80, width: 640, height: 360, maximized: false };
  let placement = { ...initial };
  const calls: string[] = [];
  const session = new NativeFullscreenSession({
    isFullscreen: async () => false,
    capturePlacement: async () => { calls.push('capture'); return { ...placement }; },
    setFullscreen: async active => {
      calls.push(active ? 'enter' : 'exit');
      if (active) placement = { x: 0, y: 0, width: 1920, height: 1080, maximized: false };
    },
    restorePlacement: async saved => { calls.push('restore'); placement = saved; },
  });
  await session.enter();
  assert.notDeepEqual(placement, initial);
  await session.exit();
  assert.deepEqual(placement, initial);
  assert.deepEqual(calls, ['capture', 'enter', 'exit', 'restore']);
});

test('fullscreen restores the inherited native window state on exit and disposal', async () => {
  for (const previous of [false, true]) {
    const values: boolean[] = [];
    const session = new NativeFullscreenSession({ isFullscreen: async () => previous, setFullscreen: async value => { values.push(value); } });
    assert.equal(await session.enter(), true);
    await session.exit(); assert.deepEqual(values, [true, previous]);
    await session.enter(); session.dispose();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(values, [true, previous, true, previous]); assert.equal(await session.enter(), false);
  }
});
test('exit requested during entry waits for the native transition and failed exits can be retried', async () => {
  let complete!: () => void;
  const entered = new Promise<void>(resolve => { complete = resolve; });
  const values: boolean[] = []; let fail = true;
  const session = new NativeFullscreenSession({ isFullscreen: async () => false, setFullscreen: async value => {
    values.push(value); if (value) await entered;
    else if (fail) { fail = false; throw new Error('Fixture IPC failure'); }
  } });
  const entering = session.enter(); const exiting = session.exit();
  complete(); assert.equal(await entering, true);
  await assert.rejects(exiting, /Fixture IPC failure/);
  assert.equal(session.active, true);
  await session.exit(); assert.equal(session.active, false);
  assert.deepEqual(values, [true, false, false]);
});
test('disposing during fullscreen entry restores the window instead of leaving an orphaned fullscreen session', async () => {
  let complete!: () => void;
  const entered = new Promise<void>(resolve => { complete = resolve; });
  const values: boolean[] = [];
  const session = new NativeFullscreenSession({ isFullscreen: async () => false, setFullscreen: async value => {
    values.push(value); if (value) await entered;
  } });
  const pending = session.enter(); await new Promise<void>(resolve => setImmediate(resolve));
  session.dispose(); complete();
  assert.equal(await pending, false); assert.deepEqual(values, [true, false]); assert.equal(session.active, false);
});


test('failed native entry restores its captured placement before a retry', async () => {
  const original = { x: -1200, y: 80, width: 1100, height: 700, maximized: true };
  let restored = 0, fail = true;
  const session = new NativeFullscreenSession({ isFullscreen: async () => false,
    capturePlacement: async () => original,
    setFullscreen: async active => { if (active && fail) { fail = false; throw new Error('Entry failed'); } },
    restorePlacement: async placement => { assert.deepEqual(placement, original); restored++; },
  });
  await assert.rejects(session.enter(), /Entry failed/);
  assert.equal(restored, 1); assert.equal(session.active, false);
  await session.enter(); await session.exit(); assert.equal(restored, 2);
});


test('disposal during placement capture releases the native persistence guard without entering fullscreen', async () => {
  const original = { x: 100, y: 80, width: 1100, height: 700, maximized: false };
  let complete!: (placement: typeof original) => void;
  const captured = new Promise<typeof original>(resolve => { complete = resolve; });
  const values: boolean[] = []; let restored = 0;
  const session = new NativeFullscreenSession({ isFullscreen: async () => false,
    capturePlacement: () => captured, setFullscreen: async value => { values.push(value); },
    restorePlacement: async placement => { assert.deepEqual(placement, original); restored++; },
  });
  const entering = session.enter(); await new Promise<void>(resolve => setImmediate(resolve));
  session.dispose(); complete(original);
  assert.equal(await entering, false); assert.deepEqual(values, [false]); assert.equal(restored, 1);
});
