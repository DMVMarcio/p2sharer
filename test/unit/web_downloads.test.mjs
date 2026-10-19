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

test('download formats link to actual assets and unavailable systems never offer a file', async () => {
  await render();
  assert.equal(document.querySelector('a.btn-primary'), null, 'system selection precedes download');
  await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent.includes('Windows')).click());
  assert.equal(document.querySelector('a.btn-primary').href, 'https://example.com/installer.exe');
  assert.equal(document.querySelector('input[value="portable"]').disabled, true);
  await act(async () => document.querySelector('input[value="msi"]').click());
  assert.equal(document.querySelector('a.btn-primary').href, 'https://example.com/installer.msi');
  await act(async () => document.querySelector('.download-back').click());
  await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent.includes('macOS')).click());
  assert.equal(document.querySelector('a.btn-primary'), null);
  assert.equal(document.querySelector('[role="status"]').textContent, 'downloads.unavailable');
});

test('failed release discovery offers a retry and restores valid downloads', async () => {
  await act(async () => root.render(null)); failed = true;
  await render(); assert.ok(document.querySelector('[role="alert"]'));
  failed = false;
  await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === 'downloads.retry').click());
  assert.equal(document.querySelector('[role="alert"]'), null);
  await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent.includes('Windows')).click());
  assert.equal(document.querySelector('a.btn-primary').href, 'https://example.com/installer.exe');
});

test('download disclosure supports keyboard entry, steps, Escape and outside dismissal', async () => {
  await act(async () => root.render(React.createElement(DownloadButton)));
  const trigger = document.querySelector('button[aria-expanded]');
  await act(async () => trigger.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })));
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  assert.equal(document.querySelector('[role="dialog"]'), null);
  assert.equal(document.activeElement.textContent, 'Windows');
  await act(async () => document.activeElement.click());
  assert.equal(document.activeElement, document.querySelector('.download-step-heading'));
  assert.equal(trigger.getAttribute('aria-expanded'), 'true', 'step focus remains inside disclosure');
  await act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(document.activeElement, trigger);
  assert.equal(document.querySelector('.download-dropdown-panel'), null);
  await act(async () => trigger.click());
  await act(async () => document.body.dispatchEvent(new window.Event('pointerdown', { bubbles: true })));
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
});

test('download steps and closing overlays retain inert outgoing content during motion', async () => {
  await act(async () => root.render(null));
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  await act(async () => root.render(React.createElement(DownloadButton)));
  const trigger = document.querySelector('button[aria-expanded]');
  await act(async () => trigger.click());
  await act(async () => document.activeElement.click());
  assert.equal(document.querySelector('.content-transition').hasAttribute('inert'), true);
  await act(async () => new Promise(resolve => setTimeout(resolve, 180)));
  assert.equal(document.querySelector('.content-transition').hasAttribute('inert'), false);
  assert.equal(document.activeElement, document.querySelector('.download-step-heading'));
  await act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.equal(document.querySelector('.download-dropdown-panel').hasAttribute('inert'), true);
  await act(async () => new Promise(resolve => setTimeout(resolve, 300)));
  assert.equal(document.querySelector('.download-dropdown-panel'), null);
  window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
});
