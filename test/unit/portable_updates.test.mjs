import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

test('the production update bridge selects portable resources, preserves consent and releases obsolete downloads', async () => {
  const calls = [];
  let portable = true;
  globalThis.portableUpdateBridgeFixture = {
    calls,
    async invoke(command, args) {
      calls.push(command);
      if (command === 'check_app_update') return { portable, rid: 7, version: '2.0.0', currentVersion: '1.0.0' };
      if (command === 'download_portable_update') {
        assert.equal(args.rid, 7);
        args.onEvent.onmessage({ event: 'Started', data: { contentLength: 10 } });
        args.onEvent.onmessage({ event: 'Progress', data: { chunkLength: 10 } });
        args.onEvent.onmessage({ event: 'Finished' });
        return 8;
      }
      if (command === 'install_portable_update') assert.equal(args.bytesRid, 8);
    },
  };
  try {
    const bundle = await build({ entryPoints: [fileURLToPath(new URL('../../src/services/app_updates.ts', import.meta.url))],
      bundle: true, write: false, platform: 'node', format: 'esm',
      plugins: [{ name: 'native-update-boundaries', setup(builder) {
        const mocks = {
          '@tauri-apps/api/core': `export const isTauri = () => true;
            export const invoke = (...args) => globalThis.portableUpdateBridgeFixture.invoke(...args);
            export class Channel {}
            export class Resource { constructor(rid) { this.rid = rid; } async close() { globalThis.portableUpdateBridgeFixture.calls.push('close:' + this.rid); } }`,
          '@tauri-apps/plugin-updater': `import { Resource } from '@tauri-apps/api/core';
            export class Update extends Resource {
              constructor(metadata) { super(metadata.rid); Object.assign(this, metadata); }
              async download() { globalThis.portableUpdateBridgeFixture.calls.push('installer-download'); }
              async install() { globalThis.portableUpdateBridgeFixture.calls.push('installer-install'); }
            }`,
          './room_service': `export const roomService = { async leaveRoom() { globalThis.portableUpdateBridgeFixture.calls.push('leave-room'); } };`,
          '../i18n/index.ts': 'export const t = key => key;',
        };
        builder.onResolve({ filter: /@tauri-apps\/|room_service$|i18n\/index\.ts$/ }, args => ({ path: args.path, namespace: 'fixture' }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: mocks[args.path], loader: 'js' }));
      } }] });
    const { appUpdates } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
    await appUpdates.check(true);
    await appUpdates.install();
    assert.deepEqual(calls, ['check_app_update'], 'Installation requires a completed download');
    await appUpdates.download();
    assert.equal(appUpdates.getSnapshot().status, 'ready');
    assert.deepEqual(calls, ['check_app_update', 'download_portable_update'], 'Downloading never installs');
    await appUpdates.install();
    assert.deepEqual(calls.slice(2), ['leave-room', 'prepare_app_update', 'install_portable_update', 'restart_after_update']);
    portable = false;
    await appUpdates.check(true);
    assert.ok(calls.includes('close:8'));
    assert.ok(calls.includes('close:7'));
    await appUpdates.download();
    await appUpdates.install();
    assert.deepEqual(calls.slice(-5), ['installer-download', 'leave-room', 'prepare_app_update', 'installer-install', 'restart_after_update']);
  } finally { delete globalThis.portableUpdateBridgeFixture; }
});
