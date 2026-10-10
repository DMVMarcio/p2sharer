import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { AppUpdateController } from '../../src/core/app_updates.ts';

test('the real header badge opens the update dialog and installation remains an explicit action', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  const globals = ['window', 'document', 'HTMLElement', 'Element', 'Node', 'localStorage', 'IS_REACT_ACT_ENVIRONMENT'];
  const previous = new Map(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of globals.slice(0, -1)) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const actions = [];
  globalThis.appUpdateUiFixture = new AppUpdateController({
    async check() { return { version: '1.1.0', body: '<img src=x> Release notes',
      async close() {}, async download(onEvent) { actions.push('download'); onEvent({ event: 'Finished' }); },
      async install() { actions.push('install'); } }; },
    async prepareInstall() { actions.push('cleanup'); },
    async restart() { actions.push('restart'); },
  });
  let root;
  try {
    const require = createRequire(import.meta.url);
    const bundle = await build({ stdin: { contents: `export { AppHeader } from './src/components/header/AppHeader';
      export { AppUpdateDialog } from './src/components/modals/AppUpdateDialog';`, resolveDir: fileURLToPath(new URL('../../', import.meta.url)) },
      write: false, bundle: true, format: 'esm', platform: 'node', jsx: 'automatic', loader: { '.png': 'dataurl' },
      plugins: [{ name: 'native-boundaries', setup(builder) {
        const mocks = {
          app_updates: 'export const appUpdates = globalThis.appUpdateUiFixture;',
          useRoom: 'export const useRoom = () => ({ isInRoom: false, username: "Test", currentRoomInvite: "" });',
          useModal: 'export const useModal = () => ({ openModal() {} }); export const modalManager = { openProfile() {} };',
          useToast: 'export const showToast = () => {};',
          saved_rooms: 'export const savedRooms = { subscribe: () => () => {} };',
        };
        builder.onResolve({ filter: /services\/app_updates$|hooks\/useRoom$|hooks\/useModal$|hooks\/useToast$|core\/saved_rooms$/ }, args => ({
          namespace: 'fixture', path: args.path.split('/').at(-1),
        }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: mocks[args.path], loader: 'js' }));
        builder.onResolve({ filter: /^[^./]/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
      } }] });
    const { AppHeader, AppUpdateDialog } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
    const { createRoot } = await import('react-dom/client');
    root = createRoot(document.getElementById('root'));
    await act(async () => root.render(React.createElement(React.Fragment, null, React.createElement(AppHeader), React.createElement(AppUpdateDialog))));
    assert.equal(document.querySelector('.app-update-badge'), null);
    await act(async () => { await globalThis.appUpdateUiFixture.check(); });
    const badge = document.querySelector('.header-room-info .app-update-badge');
    assert.ok(badge);
    assert.ok(badge.querySelector('.app-update-badge-icon'));
    assert.equal(document.querySelector('[role="dialog"]'), null);
    await act(async () => badge.click());
    assert.ok(document.querySelector('[role="dialog"][aria-modal="true"]'));
    assert.equal(document.querySelector('.app-update-notes img'), null);
    const button = text => [...document.querySelectorAll('[role="dialog"] button')].find(node => node.textContent === text);
    await act(async () => button('Baixar atualização').click());
    assert.deepEqual(actions, ['download']);
    assert.match(document.querySelector('.app-update-content').textContent, /encerrar transmissões/);
    await act(async () => button('Instalar e reiniciar').click());
    assert.deepEqual(actions, ['download', 'cleanup', 'install', 'restart']);
  } finally {
    if (root) await act(async () => root.unmount());
    dom.window.close();
    delete globalThis.appUpdateUiFixture;
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
