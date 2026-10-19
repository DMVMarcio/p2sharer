import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';

const dom = new JSDOM('<div id="root"></div>', { url: 'https://example.com', pretendToBeVisual: true });
for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'CustomEvent']) globalThis[key] = dom.window[key];
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
globalThis.getComputedStyle = window.getComputedStyle;
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
const catalog = { version: '1.4.4', platforms: [{ id: 'windows', artifacts: [
  { id: 'installer', size: 1024, url: 'https://example.com/installer.exe' },
  { id: 'msi', size: 2048, url: 'https://example.com/installer.msi' },
] }, { id: 'macos', artifacts: [] }, { id: 'linux', artifacts: [] }] };
const previousFetch = globalThis.fetch;
let failed = false;
globalThis.fetch = async () => new Response(failed ? '{}' : JSON.stringify(catalog), { status: failed ? 503 : 200 });
const bundle = await build({ entryPoints: ['src/components/common/DownloadPanel.tsx'], bundle: true, write: false, format: 'esm', platform: 'node', jsx: 'automatic', plugins: [{ name: 'download-boundaries', setup(builder) {
  builder.onResolve({ filter: /(?:^|\/)i18n$|\/useLocale$/ }, args => ({ path: args.path, namespace: 'fixture' }));
  builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path.endsWith('useLocale') ? 'export const useLocale = () => "en";' : 'export const t = key => key;' }));
  builder.onResolve({ filter: /^[^./]/ }, args => ({ path: import.meta.resolve(args.path), external: true }));
} }] });
const { DownloadPanel } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text + '\n//# sourceURL=web-downloads-test.js').toString('base64')}`);
const { createRoot } = await import('react-dom/client');
const root = createRoot(document.getElementById('root'));
const render = () => act(async () => root.render(React.createElement(DownloadPanel)));
after(async () => { await act(async () => root.unmount()); dom.window.close(); globalThis.fetch = previousFetch; });

test('download formats link to actual assets and unavailable systems never offer a file', async () => {
  await render();
  assert.equal(document.querySelector('a.btn-primary').href, 'https://example.com/installer.exe');
  assert.equal(document.querySelector('input[value="portable"]').disabled, true);
  await act(async () => document.querySelector('input[value="msi"]').click());
  assert.equal(document.querySelector('a.btn-primary').href, 'https://example.com/installer.msi');
  await act(async () => document.querySelector('[role="combobox"]').click());
  await act(async () => [...document.querySelectorAll('[role="option"]')].find(option => option.textContent.includes('macOS')).click());
  assert.equal(document.querySelector('a.btn-primary'), null);
  assert.equal(document.querySelector('[role="status"]').textContent, 'downloads.unavailable');
});

test('failed release discovery offers a retry and restores valid downloads', async () => {
  await act(async () => root.render(null)); failed = true;
  await render(); assert.ok(document.querySelector('[role="alert"]'));
  failed = false;
  await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === 'downloads.retry').click());
  assert.equal(document.querySelector('[role="alert"]'), null);
  assert.equal(document.querySelector('a.btn-primary').href, 'https://example.com/installer.exe');
});
