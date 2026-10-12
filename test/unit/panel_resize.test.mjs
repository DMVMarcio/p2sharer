import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act, useRef } from 'react';

const browser = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
for (const key of ['window', 'document', 'HTMLElement', 'localStorage']) globalThis[key] = browser.window[key];
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let measure;
let width = 1200;
Object.defineProperty(HTMLElement.prototype, 'clientWidth', { get: () => width });
HTMLElement.prototype.setPointerCapture = () => {};
HTMLElement.prototype.hasPointerCapture = () => false;
globalThis.ResizeObserver = class { constructor(callback) { measure = callback; } observe() {} disconnect() {} };
const require = createRequire(import.meta.url);
const bundle = await build({ stdin: { contents: `export * from './src/hooks/usePanelSize.ts';
export * from './src/components/common/PanelResizeHandle.tsx';`, resolveDir: process.cwd() },
  bundle: true, write: false, format: 'esm', platform: 'node', jsx: 'automatic', plugins: [{ name: 'packages', setup(builder) {
    builder.onResolve({ filter: /^[^./]/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
  } }] });
const { usePanelSize, PanelResizeHandle } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const { createRoot } = await import('react-dom/client');
const root = createRoot(document.getElementById('root'));
function Panel() {
  const ref = useRef(null);
  const size = usePanelSize(ref, 'width', 'test_panel', 320, 240, 240);
  return React.createElement('div', { ref }, React.createElement(PanelResizeHandle, { axis: 'width', label: 'Resize', controls: 'panel', ...size }));
}
const render = () => act(async () => root.render(React.createElement(Panel)));
const handle = () => document.querySelector('[role="separator"]');
const key = async key => act(async () => handle().dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true })));
const pointer = async (type, x) => act(async () => {
  const event = new window.MouseEvent(type, { clientX: x, button: 0, bubbles: true });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  handle().dispatchEvent(event);
});

test('panel resizing persists gestures, enforces bounds, and restores preference after viewport constraints', async () => {
  await render();
  await pointer('pointerdown', 880);
  await pointer('pointermove', 600);
  await pointer('pointerup', 600);
  assert.equal(handle().getAttribute('aria-valuenow'), '600');
  assert.equal(localStorage.getItem('test_panel'), '600');
  width = 600;
  await act(async () => measure());
  assert.equal(handle().getAttribute('aria-valuenow'), '360');
  assert.equal(localStorage.getItem('test_panel'), '600');
  width = 1200;
  await act(async () => measure());
  assert.equal(handle().getAttribute('aria-valuenow'), '600');
  await act(async () => root.render(null));
  await render();
  assert.equal(handle().getAttribute('aria-valuenow'), '600');
  await key('Home'); await key('ArrowRight');
  assert.equal(handle().getAttribute('aria-valuenow'), '240');
  await key('End'); await key('ArrowLeft');
  assert.equal(handle().getAttribute('aria-valuenow'), '960');
});
after(async () => { await act(async () => root.unmount()); browser.window.close(); });
