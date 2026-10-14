import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeFullscreenSession } from '../../src/core/native_fullscreen.ts';

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
