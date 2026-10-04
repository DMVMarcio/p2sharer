import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppUpdateController, type AvailableUpdate } from '../../src/core/app_updates.ts';

function fixture() {
  const events: string[] = [];
  const update: AvailableUpdate = {
    version: '1.1.0', body: 'Release notes',
    async download(progress) {
      events.push('download');
      progress({ event: 'Started', data: { contentLength: 10 } });
      progress({ event: 'Progress', data: { chunkLength: 10 } });
      progress({ event: 'Finished' });
    },
    async install() { events.push('install'); },
    async close() { events.push('close'); },
  };
  const dependencies = {
    async check(): Promise<AvailableUpdate | null> { events.push('check'); return update; },
    async prepareInstall() { events.push('cleanup'); },
    async restart() { events.push('restart'); },
  };
  return { events, update, dependencies, controller: new AppUpdateController(dependencies) };
}

test('update lifecycle requires a verified download and explicit installation, with cleanup first', async () => {
  const { controller, events } = fixture();
  const snapshots: string[] = [];
  const unsubscribe = controller.subscribe(() => snapshots.push(controller.getSnapshot().status));
  await controller.check(true);
  assert.equal(controller.getSnapshot().version, '1.1.0');
  assert.equal(controller.getSnapshot().dialogOpen, true);
  await controller.install();
  assert.deepEqual(events, ['check']);
  await controller.download();
  assert.equal(controller.getSnapshot().status, 'ready');
  assert.equal(controller.getSnapshot().progress, 100);
  assert.deepEqual(events, ['check', 'download']);
  await controller.check();
  assert.deepEqual(events, ['check', 'download']);
  await controller.install();
  assert.deepEqual(events, ['check', 'download', 'cleanup', 'install', 'restart']);
  assert.ok(snapshots.includes('checking') && snapshots.includes('downloading'));
  unsubscribe();
});

test('disabled automatic checks persist and still permit manual checks', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  } });
  try {
    const { controller, events } = fixture();
    controller.setAutomatic(false);
    assert.equal(fixture().controller.getSnapshot().automatic, false);
    await controller.check();
    assert.deepEqual(events, []);
    await controller.check(true);
    assert.deepEqual(events, ['check']);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

test('failed signature/download never enables installation and failed install can retry', async () => {
  const { controller, update, events } = fixture();
  await controller.check(true);
  const download = update.download;
  update.download = async () => { throw new Error('invalid signature'); };
  await controller.download();
  assert.equal(controller.getSnapshot().status, 'error');
  await controller.install();
  assert.deepEqual(events, ['check']);
  update.download = download;
  await controller.download();
  update.install = async () => { throw new Error('installer blocked'); };
  await controller.install();
  assert.equal(controller.getSnapshot().status, 'ready');
  assert.ok(controller.getSnapshot().error);
  assert.ok(!events.includes('restart'));
});

test('duplicate requests are serialized and replaced updater resources are released', async () => {
  const { controller, dependencies, update, events } = fixture();
  let finish!: (result: AvailableUpdate | null) => void;
  dependencies.check = () => new Promise(resolve => { finish = resolve; });
  const first = controller.check(true);
  await controller.check(true);
  finish(update);
  await first;
  dependencies.check = async () => null;
  await controller.check(true);
  assert.equal(controller.getSnapshot().status, 'current');
  assert.equal(controller.getSnapshot().version, null);
  assert.deepEqual(events, ['close']);
});

test('unavailable endpoint fails gracefully and can be checked again', async () => {
  const { controller, dependencies } = fixture();
  dependencies.check = async () => { throw new Error('offline'); };
  await controller.check();
  assert.equal(controller.getSnapshot().status, 'error');
  assert.equal(controller.getSnapshot().dialogOpen, false);
  dependencies.check = async () => null;
  await controller.check(true);
  assert.equal(controller.getSnapshot().status, 'current');
  assert.equal(controller.getSnapshot().error, null);
});
