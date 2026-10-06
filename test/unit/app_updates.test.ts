import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppUpdateController, UPDATE_CHECK_INTERVAL_MS, type AvailableUpdate } from '../../src/core/app_updates.ts';

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
    async check(_includePrereleases: boolean): Promise<AvailableUpdate | null> { events.push('check'); return update; },
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

test('an installer launch failure restores child containment before allowing a retry', async () => {
  const { dependencies, update, events } = fixture();
  const controller = new AppUpdateController({ ...dependencies,
    async cancelInstall() { events.push('restore-policy'); },
  });
  await controller.check(true);
  await controller.download();
  update.install = async () => { events.push('blocked-install'); throw new Error('launch failed'); };
  await controller.install();
  assert.deepEqual(events, ['check', 'download', 'cleanup', 'blocked-install', 'restore-policy']);
  assert.equal(controller.getSnapshot().status, 'ready');
  update.install = async () => { events.push('install'); };
  await controller.install();
  assert.deepEqual(events.slice(-3), ['cleanup', 'install', 'restart']);
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

function isolatedStorage(context: { after: (callback: () => void) => void }) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  } });
  context.after(() => {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });
}

test('beta opt-in defaults off, persists independently, and applies to manual checks', async context => {
  isolatedStorage(context);
  const { controller, dependencies } = fixture();
  assert.equal(controller.getSnapshot().includePrereleases, false);
  const channels: boolean[] = [];
  dependencies.check = async preview => { channels.push(preview); return null; };
  controller.setPreferences(false, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture().controller.getSnapshot().includePrereleases, true);
  assert.equal(fixture().controller.getSnapshot().automatic, false);
  await controller.check();
  assert.deepEqual(channels, [true]);
  assert.equal(controller.getSnapshot().dialogOpen, false);
  await controller.check(true);
  controller.close();
  controller.setPreferences(false, false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(controller.getSnapshot().dialogOpen, false);
  await controller.check(true);
  assert.deepEqual(channels, [true, true, false, false]);
});

test('switching channels discards a verified download and cannot install it', async context => {
  isolatedStorage(context);
  const { controller, dependencies, events } = fixture();
  controller.setPreferences(false, true);
  await new Promise(resolve => setImmediate(resolve));
  await controller.download();
  dependencies.check = async () => null;
  controller.setPreferences(false, false);
  await controller.install();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(controller.getSnapshot().status, 'current');
  assert.equal(controller.getSnapshot().version, null);
  assert.deepEqual(events, ['check', 'download', 'close']);
});

test('in-flight results from an old channel are released, including rapid preference changes', async context => {
  isolatedStorage(context);
  const { controller, dependencies, update, events } = fixture();
  controller.setPreferences(false, false);
  let finish!: (result: AvailableUpdate) => void;
  let requests = 0;
  dependencies.check = () => ++requests === 1
    ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(null);
  const pending = controller.check(true);
  controller.setPreferences(false, true);
  controller.setPreferences(false, false);
  finish(update);
  await pending;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(controller.getSnapshot().includePrereleases, false);
  assert.equal(controller.getSnapshot().version, null);
  assert.equal(controller.getSnapshot().status, 'current');
  assert.deepEqual(events, ['close']);
});

test('automatic checks restart on the selected channel after an obsolete request finishes', async context => {
  isolatedStorage(context);
  const { controller, dependencies, update } = fixture();
  let finish!: (result: AvailableUpdate) => void;
  const channels: boolean[] = [];
  dependencies.check = preview => {
    channels.push(preview);
    return channels.length === 1 ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(null);
  };
  const pending = controller.check();
  controller.setPreferences(true, true);
  finish(update);
  await pending;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(channels, [false, true]);
  assert.equal(controller.getSnapshot().status, 'current');
});

test('channel changes are rejected during a download, preserving the selected installer', async context => {
  isolatedStorage(context);
  const { controller, update } = fixture();
  controller.setPreferences(false, true);
  await new Promise(resolve => setImmediate(resolve));
  let finish!: () => void;
  update.download = () => new Promise(resolve => { finish = resolve; });
  const pending = controller.download();
  controller.setPreferences(false, false);
  assert.equal(controller.getSnapshot().includePrereleases, true);
  finish();
  await pending;
  assert.equal(controller.getSnapshot().status, 'ready');
});

test('opting out of beta offers stable immediately even with automatic checks disabled', async context => {
  isolatedStorage(context);
  const { controller, dependencies, update } = fixture();
  const channels: boolean[] = [];
  update.version = '1.0.0';
  update.currentVersion = '1.1.0-beta.2';
  dependencies.check = async preview => { channels.push(preview); return update; };
  controller.setPreferences(false, true);
  controller.setPreferences(false, false);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(channels, [true, false]);
  assert.equal(controller.getSnapshot().automatic, false);
  assert.equal(controller.getSnapshot().dialogOpen, false);
  assert.equal(controller.getSnapshot().version, '1.0.0');
  assert.equal(controller.getSnapshot().status, 'available');
  assert.equal(controller.getSnapshot().returnToStable, true);
});

test('automatic checks run at startup and every 30 minutes, respect opt-out and stop on teardown', async context => {
  isolatedStorage(context);
  context.mock.timers.enable({ apis: ['setInterval'] });
  const { controller, dependencies } = fixture();
  let checks = 0;
  dependencies.check = async () => { checks++; return null; };
  const stop = controller.startAutomaticChecks();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(checks, 1);
  assert.equal(UPDATE_CHECK_INTERVAL_MS, 1_800_000);
  context.mock.timers.tick(1_799_999);
  assert.equal(checks, 1);
  context.mock.timers.tick(1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(checks, 2);
  context.mock.timers.tick(1_800_000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(checks, 3);
  controller.setAutomatic(false);
  context.mock.timers.tick(1_800_000);
  assert.equal(checks, 3);
  stop();
  controller.setAutomatic(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(checks, 4);
  context.mock.timers.tick(1_800_000);
  assert.equal(checks, 4);
});
