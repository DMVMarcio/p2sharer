import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act, useRef } from 'react';

const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'CustomEvent']) globalThis[key] = dom.window[key];
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
window.matchMedia = () => ({ matches: false });
HTMLElement.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, right: 400, bottom: 225, width: 400, height: 225 });
Object.defineProperties(window.HTMLVideoElement.prototype, {
  videoWidth: { get: () => 1920 }, videoHeight: { get: () => 1080 },
});
HTMLElement.prototype.setPointerCapture = () => {};
HTMLElement.prototype.hasPointerCapture = () => false;
const packets = globalThis.pointerReviewPackets = [];
const require = createRequire(import.meta.url);
const bundle = await build({ stdin: { contents: "export { useStreamPointer } from './src/hooks/useStreamPointer.tsx';", resolveDir: process.cwd() },
  bundle: true, write: false, format: 'esm', platform: 'node', jsx: 'automatic', plugins: [{ name: 'boundary-fixtures', setup(builder) {
    builder.onResolve({ filter: /room_service$|stream_pointer_view$|@tauri-apps\/api\/event/ }, args => ({ namespace: 'fixture',
      path: args.path.endsWith('room_service') ? 'room' : args.path.endsWith('stream_pointer_view') ? 'scene' : 'events' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'room'
      ? 'export const roomService = { refreshStreamPointerView() {}, sendStreamPointer: packet => globalThis.pointerReviewPackets.push(packet) };'
      : args.path === 'events' ? 'export const listen = async () => () => {}; export const emitTo = async () => {};'
        : `const scene = { visuals: [], localPeerId: 'self', name: 'Alice', color: '#abcdef', drawingAllowed: true, history: [] };
          export const streamPointerView = { subscribe: () => () => {}, get: () => scene };` }));
    builder.onResolve({ filter: /^[^./]/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
  } }] });
const { useStreamPointer } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text + '\n//# sourceURL=react-pointer-review.js').toString('base64')}`);
const { createRoot } = await import('react-dom/client');
const root = createRoot(document.getElementById('root'));
const media = { id: 'stream' };
function Fixture() {
  const container = useRef(null), video = useRef(null);
  const pointer = useStreamPointer(container, video, 'peer', true, media);
  return React.createElement('div', { ref: container },
    React.createElement('button', { onClick: pointer.toggle, 'aria-label': 'Pointing' }, 'Pointing'),
    React.createElement('video', { ref: video, className: pointer.cursorActive ? 'stream-pointer-active-cursor' : undefined }),
    pointer.toolbar, pointer.indicator);
}
const render = async () => {
  await act(async () => root.render(null));
  await act(async () => root.render(React.createElement(Fixture)));
  await act(async () => document.querySelector('[aria-label="Pointing"]').click());
};
const dispatch = async (type, target, clientX = 100, clientY = 100) => act(async () => {
  const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY, button: 0 });
  Object.defineProperty(event, 'pointerId', { value: 1 }); target.dispatchEvent(event);
});
after(async () => { await act(async () => root.unmount()); dom.window.close(); });

test('React cursor state follows native movement, video bounds and surface departure', async () => {
  await render();
  const video = document.querySelector('video');
  await dispatch('pointermove', video);
  assert.ok(video.classList.contains('stream-pointer-active-cursor'));
  assert.equal(packets.at(-1).kind, 'move');
  await dispatch('pointermove', video, -5, 100);
  assert.equal(video.classList.contains('stream-pointer-active-cursor'), false);
  assert.equal(packets.at(-1).kind, 'leave');
  await dispatch('pointermove', video);
  assert.ok(video.classList.contains('stream-pointer-active-cursor'));
  await dispatch('pointerleave', video.parentElement);
  assert.equal(video.classList.contains('stream-pointer-active-cursor'), false);
  assert.equal(packets.at(-1).kind, 'leave');
});

test('inline drawing uses the registered editor ref and outside clicks finish the draft once', async () => {
  await render();
  await act(async () => document.querySelector('[aria-label="Texto"]').click());
  await dispatch('pointerdown', document.querySelector('video'));
  const editor = document.querySelector('.stream-drawing-text-editor');
  assert.ok(editor); assert.equal(document.activeElement, editor);
  const before = packets.filter(packet => packet.kind === 'draw').length;
  await dispatch('pointerdown', document.body);
  assert.equal(document.querySelector('.stream-drawing-text-editor'), null);
  assert.equal(packets.filter(packet => packet.kind === 'draw').length, before, 'Empty drafts never publish');
});
