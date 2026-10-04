import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';

const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
for (const key of ['window', 'document', 'HTMLElement']) globalThis[key] = dom.window[key];
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const callbacks = new Map();
const actions = [];
let desktop = true, maximized = false, fullscreen = false, focused = true, unlistens = 0;
const subscribe = async (key, callback) => {
  callbacks.set(key, callback);
  return () => { callbacks.delete(key); unlistens++; };
};
globalThis.windowChromeFixture = {
  isTauri: () => desktop,
  isMaximized: async () => maximized, isFullscreen: async () => fullscreen, isFocused: async () => focused,
  onResized: callback => subscribe('resize', callback), onFocusChanged: callback => subscribe('focus', callback),
  minimize: async () => { actions.push('minimize'); },
  toggleMaximize: async () => { actions.push('toggleMaximize'); maximized = !maximized; callbacks.get('resize')?.(); },
  close: async () => { actions.push('close'); },
};
const require = createRequire(import.meta.url);
const bundle = await build({
  stdin: { contents: `export { WindowTitlebar } from './src/components/header/WindowTitlebar.tsx';`, resolveDir: process.cwd() },
  bundle: true, write: false, format: 'esm', platform: 'node', jsx: 'automatic', loader: { '.png': 'dataurl' },
  plugins: [{ name: 'native-window-fixture', setup(builder) {
    builder.onResolve({ filter: /^@tauri-apps\/api\/(core|window)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path.endsWith('core')
      ? 'export const isTauri = () => globalThis.windowChromeFixture.isTauri();'
      : 'export const getCurrentWindow = () => globalThis.windowChromeFixture;' }));
    builder.onResolve({ filter: /^[^./]/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
  } }],
});
const { WindowTitlebar } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const { createRoot } = await import('react-dom/client');
const root = createRoot(document.getElementById('root'));
after(async () => { await act(async () => root.unmount()); dom.window.close(); delete globalThis.windowChromeFixture; });

test('caption buttons retain Windows order and invoke native actions', async () => {
  await act(async () => root.render(React.createElement(WindowTitlebar)));
  assert.deepEqual([...document.querySelectorAll('button')].map(button => button.getAttribute('aria-label')), ['Minimizar', 'Maximizar', 'Fechar']);
  assert.ok(document.querySelector('.window-titlebar-drag').hasAttribute('data-tauri-drag-region'));
  assert.ok([...document.querySelectorAll('button')].every(button => !button.hasAttribute('data-tauri-drag-region')));
  await act(async () => document.querySelector('[aria-label="Minimizar"]').click());
  await act(async () => document.querySelector('[aria-label="Maximizar"]').click());
  assert.ok(document.querySelector('[aria-label="Restaurar"]'));
  await act(async () => document.querySelector('[aria-label="Restaurar"]').click());
  await act(async () => document.querySelector('[aria-label="Fechar"]').click());
  assert.deepEqual(actions, ['minimize', 'toggleMaximize', 'toggleMaximize', 'close']);
});

test('external window changes update chrome, fullscreen hides it, and teardown releases listeners', async () => {
  maximized = true; focused = false;
  await act(async () => callbacks.get('focus')());
  assert.ok(document.querySelector('.window-titlebar.is-inactive'));
  assert.ok(document.querySelector('[aria-label="Restaurar"]'));
  fullscreen = true;
  await act(async () => callbacks.get('resize')());
  assert.equal(document.querySelector('.window-titlebar'), null);
  fullscreen = false;
  await act(async () => callbacks.get('resize')());
  assert.ok(document.querySelector('.window-titlebar'));
  await act(async () => root.render(null));
  assert.equal(callbacks.size, 0);
  assert.equal(unlistens, 2);
  desktop = false;
  await act(async () => root.render(React.createElement(WindowTitlebar)));
  assert.equal(document.querySelector('.window-titlebar'), null);
  assert.equal(callbacks.size, 0);
});
