import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';

const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'localStorage']) globalThis[key] = dom.window[key];
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
let maximized = false, resize, removed = 0;
const actions = [];
globalThis.pipWindowFixture = {
  isMaximized: async () => maximized,
  onResized: async callback => { resize = callback; return () => { resize = undefined; removed++; }; },
  minimize: async () => { actions.push('minimize'); },
  toggleMaximize: async () => { actions.push('toggleMaximize'); maximized = !maximized; resize?.(); },
};
const bundle = await build({ stdin: { contents: `export { PipWindowControls } from './src/components/common/PipWindowControls.tsx';
  export { setLanguage } from './src/i18n/index.ts';`, resolveDir: process.cwd() },
  bundle: true, write: false, format: 'esm', platform: 'node', jsx: 'automatic',
  plugins: [{ name: 'pip-window', setup(builder) {
    builder.onResolve({ filter: /^@tauri-apps\/api\/(core|window)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path.endsWith('/core')
      ? 'export const isTauri = () => true;'
      : 'export const getCurrentWindow = () => globalThis.pipWindowFixture;' }));
    builder.onResolve({ filter: /^[^./]/ }, args => ({ path: import.meta.resolve(args.path), external: true }));
  } }] });
const { PipWindowControls, setLanguage } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
setLanguage('en');
const { createRoot } = await import('react-dom/client');
const root = createRoot(document.getElementById('root'));
const button = label => document.querySelector(`button[aria-label="${label}"]`);

after(async () => { await act(async () => root.unmount()); dom.window.close(); delete globalThis.pipWindowFixture; });

test('PiP captions minimize, maximize and restore, track native changes and release their listener', async () => {
  await act(async () => root.render(React.createElement(PipWindowControls)));
  assert.ok(button('Maximize'));
  assert.ok([...document.querySelectorAll('button')].every(value => !value.hasAttribute('data-tauri-drag-region')));
  await act(async () => button('Minimize').click());
  await act(async () => button('Maximize').click());
  assert.ok(button('Restore'));
  await act(async () => button('Restore').click());
  assert.deepEqual(actions, ['minimize', 'toggleMaximize', 'toggleMaximize']);
  await act(async () => { maximized = true; resize(); });
  assert.ok(button('Restore'));
  await act(async () => root.render(React.createElement(PipWindowControls, { fullscreen: true })));
  assert.equal(document.querySelectorAll('button').length, 0);
  await act(async () => root.render(React.createElement(PipWindowControls)));
  assert.ok(button('Restore'));
  await act(async () => root.render(null));
  assert.equal(removed, 1);
  assert.equal(resize, undefined);
});
