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
window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
const catalog = { version: '1.4.4', platforms: [{ id: 'windows', artifacts: [
  { id: 'installer', size: 1024, url: 'https://example.com/installer.exe' },
  { id: 'msi', size: 2048, url: 'https://example.com/installer.msi' },
] }, { id: 'macos', artifacts: [] }, { id: 'linux', artifacts: [] }] };
const previousFetch = globalThis.fetch;
let failed = false;
globalThis.fetch = async () => new Response(failed ? '{}' : JSON.stringify(catalog), { status: failed ? 503 : 200 });
const bundle = await build({ stdin: { contents: "export { DownloadPanel } from './src/components/common/DownloadPanel.tsx'; export { DownloadButton } from './src/components/common/DownloadButton.tsx';", resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'esm', platform: 'node', jsx: 'automatic', plugins: [{ name: 'download-boundaries', setup(builder) {
  builder.onResolve({ filter: /(?:^|\/)i18n$|\/useLocale$/ }, args => ({ path: args.path, namespace: 'fixture' }));
  builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path.endsWith('useLocale') ? 'export const useLocale = () => "en";' : 'export const t = key => key;' }));
  builder.onResolve({ filter: /^[^./]/ }, args => ({ path: import.meta.resolve(args.path), external: true }));
} }] });
const { DownloadPanel, DownloadButton } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text + '\n//# sourceURL=web-downloads-test.js').toString('base64')}`);
const { createRoot } = await import('react-dom/client');
const root = createRoot(document.getElementById('root'));
const render = () => act(async () => root.render(React.createElement(DownloadPanel)));
after(async () => { await act(async () => root.unmount()); dom.window.close(); globalThis.fetch = previousFetch; });

const systemButton = name => [...document.querySelectorAll('.download-system')].find(button => button.textContent.includes(name));
const fileLink = id => document.querySelector(`a[aria-label="common.download · downloads.${id}"]`);

test('only available systems advance to direct package downloads', async () => {
  await render();
  assert.equal(document.querySelector('.download-files'), null);
  assert.equal(systemButton('Windows').disabled, false);
  assert.equal(systemButton('macOS').disabled, true);
  assert.equal(systemButton('Linux').disabled, true);
  await act(async () => systemButton('macOS').click());
  assert.equal(document.querySelector('.download-files'), null);
  await act(async () => systemButton('Windows').click());
  assert.equal(fileLink('installer').href, 'https://example.com/installer.exe');
  assert.equal(fileLink('msi').href, 'https://example.com/installer.msi');
  assert.equal(document.querySelector('.download-file.is-unavailable button').disabled, true);
  assert.equal(fileLink('portable'), null);
  assert.equal(document.activeElement, document.querySelector('.download-step-heading'));
  await act(async () => document.querySelector('.download-back').click());
  assert.ok(systemButton('Windows'));
  assert.equal(document.querySelector('.download-files'), null);
});

test('failed release discovery offers a retry and restores available systems', async () => {
  await act(async () => root.render(null)); failed = true;
  await render(); assert.ok(document.querySelector('[role="alert"]'));
  assert.equal(systemButton('Windows').disabled, true);
  failed = false;
  await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === 'downloads.retry').click());
  assert.equal(document.querySelector('[role="alert"]'), null);
  assert.equal(systemButton('Windows').disabled, false);
  await act(async () => systemButton('Windows').click());
  assert.equal(fileLink('installer').href, 'https://example.com/installer.exe');
});

test('download links open the dedicated page and preserve a web room in another tab', async () => {
  await act(async () => root.render(React.createElement(DownloadButton, { compact: true, newTab: true })));
  const link = document.querySelector('a');
  assert.equal(link.href, 'https://example.com/download');
  assert.equal(link.target, '_blank');
  assert.match(link.rel, /noopener/);
  assert.equal(document.querySelector('button'), null);
});

test('download steps retain inert outgoing content during motion', async () => {
  await act(async () => root.render(null));
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  await render();
  await act(async () => systemButton('Windows').click());
  assert.equal(document.querySelector('.content-transition').hasAttribute('inert'), true);
  await act(async () => new Promise(resolve => setTimeout(resolve, 180)));
  assert.equal(document.querySelector('.content-transition').hasAttribute('inert'), false);
  assert.equal(document.activeElement, document.querySelector('.download-step-heading'));
  assert.ok(fileLink('installer'));
  window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
});
