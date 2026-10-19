import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';

const dom = new JSDOM('<div id="root"></div>', { url: 'https://example.com', pretendToBeVisual: true });
for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'Event']) globalThis[key] = dom.window[key];
globalThis.getComputedStyle = window.getComputedStyle;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
const fixture = globalThis.webCaptureFixture = {
  state: { editingStreamId: null, currentBitrate: 6000 }, captures: new Map(),
  requests: 0, published: [], closed: 0, stopped: 0, gesture: false, failPicker: false, failPublish: false,
};
const track = { getSettings: () => ({ width: 1280, height: 720, frameRate: 30 }), stop: () => fixture.stopped++ };
const stream = { getVideoTracks: () => [track], getTracks: () => [track] };
const media = { getDisplayMedia() {
  assert.equal(fixture.gesture, true, 'screen permission must start within the click');
  fixture.requests++;
  return fixture.failPicker ? Promise.reject(new DOMException('Permission denied', 'NotAllowedError')) : Promise.resolve(stream);
} };
Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: media });
const bundle = await build({ stdin: { contents: "export { BrowserCaptureModal } from './src/components/modals/BrowserCaptureModal.tsx';", resolveDir: process.cwd() },
  bundle: true, write: false, format: 'esm', platform: 'node', jsx: 'automatic', plugins: [{ name: 'web-capture-boundaries', setup(builder) {
    builder.onResolve({ filter: /room_service$|state_store$|useModal$|camera_devices$|i18n$|useLocale$/ }, args => ({ path: args.path.split('/').at(-1), namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: {
      room_service: `export const roomService = { localCaptures: globalThis.webCaptureFixture.captures, startCapture: async (...args) => {
        const f = globalThis.webCaptureFixture; if (f.failPublish) throw new Error('Room ended'); f.published.push(args);
      } };`,
      state_store: 'export const stateStore = globalThis.webCaptureFixture.state;',
      useModal: 'export const useModal = () => ({ closeModal: () => globalThis.webCaptureFixture.closed++ });',
      camera_devices: 'export const listCameras = async () => [];',
      i18n: 'export const t = key => key; export const localizeError = error => error.message;',
      useLocale: 'export const useLocale = () => "en";',
    }[path] }));
    builder.onResolve({ filter: /^[^./]/ }, args => ({ path: import.meta.resolve(args.path), external: true }));
  } }] });
const { BrowserCaptureModal } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text + '\n//# sourceURL=web-capture-test.js').toString('base64')}`);
const { createRoot } = await import('react-dom/client');
const root = createRoot(document.getElementById('root'));
let revision = 0;
const render = () => act(async () => root.render(React.createElement(BrowserCaptureModal, { key: ++revision })));
const share = () => [...document.querySelectorAll('button')].find(button => button.textContent === 'web.share');
const click = () => act(async () => { fixture.gesture = true; share().click(); fixture.gesture = false; });
after(async () => { await act(async () => root.unmount()); dom.window.close(); delete navigator.mediaDevices; delete globalThis.webCaptureFixture; });

test('screen permissions require a click and successful capture enters the shared room service', async () => {
  await render(); assert.equal(fixture.requests, 0); assert.equal(fixture.published.length, 0);
  await click();
  assert.equal(fixture.requests, 1); assert.equal(fixture.closed, 1);
  assert.equal(fixture.published[0][0], 'screen:browser');
  assert.equal(fixture.published[0][6].stream, stream);
  assert.equal(fixture.stopped, 0);
});

test('permission cancellation does not publish, and a room failure releases acquired tracks', async () => {
  fixture.failPicker = true;
  await render(); await click();
  assert.equal(fixture.published.length, 1); assert.equal(fixture.closed, 1);
  assert.match(document.querySelector('[role="alert"]').textContent, /Permission denied/);
  fixture.failPicker = false; fixture.failPublish = true;
  await render(); await click();
  assert.equal(fixture.stopped, 1); assert.equal(fixture.published.length, 1);
  assert.match(document.querySelector('[role="alert"]').textContent, /Room ended/);
  fixture.failPublish = false;
});

test('browser capture blocks insecure origins and native screen editing before permission prompts', async () => {
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
  const previous = fixture.requests;
  await render(); await click();
  assert.match(document.querySelector('[role="alert"]').textContent, /web.secureContext/);
  assert.equal(fixture.requests, previous);
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  fixture.state.editingStreamId = 'existing'; fixture.captures.set('existing', { kind: 'screen' });
  await render(); assert.equal(share().disabled, true); await click();
  assert.equal(fixture.requests, previous);
  assert.equal(document.querySelector('[role="status"]').textContent, 'web.desktopOnly');
});
