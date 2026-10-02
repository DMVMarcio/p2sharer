import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act, useRef } from 'react';

const browser = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' });
for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'CustomEvent']) globalThis[key] = browser.window[key];
globalThis.getComputedStyle = window.getComputedStyle;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
window.matchMedia = () => ({ matches: false });
globalThis.__pointerTestSent = [];
const require = createRequire(import.meta.url);
const bundle = await build({ stdin: { contents: "export * from './src/hooks/useStreamPointer.tsx'; export * from './src/services/stream_pointer_view.ts'; export * from './src/components/common/ContextMenu.tsx';", resolveDir: process.cwd() },
  bundle: true, write: false, format: 'esm', platform: 'node', jsx: 'automatic', plugins: [{ name: 'dependencies', setup(builder) {
    builder.onResolve({ filter: /services\/room_service$/ }, () => ({ path: 'room-service', namespace: 'stub' }));
    builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const roomService = { refreshStreamPointerView() {}, sendStreamPointer(packet) { globalThis.__pointerTestSent.push(packet); } };' }));
    builder.onResolve({ filter: /^[^./]/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
  } }] });
const { useStreamPointer, streamPointerView, ContextMenuProvider } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const { createRoot } = await import('react-dom/client');
const root = createRoot(document.getElementById('root'));
const stream = {};
function Fixture() {
  const container = useRef(null), video = useRef(null);
  const pointer = useStreamPointer(container, video, 'host', true, stream);
  return React.createElement('div', { ref: container }, React.createElement('video', { ref: video }), pointer.indicator, pointer.toolbar,
    React.createElement('button', { id: 'toggle', onClick: pointer.toggle }, 'Toggle'));
}
await act(async () => root.render(React.createElement(ContextMenuProvider, null, React.createElement(Fixture))));
const video = document.querySelector('video');
const rect = { left: 0, top: 0, width: 800, height: 450 };
video.getBoundingClientRect = () => rect;
video.parentElement.getBoundingClientRect = () => rect;
Object.defineProperties(video, { videoWidth: { value: 1920 }, videoHeight: { value: 1080 } });
let captured = false;
video.setPointerCapture = () => { captured = true; };
video.hasPointerCapture = () => captured;
video.releasePointerCapture = () => { captured = false; };
const click = async selector => act(async () => document.querySelector(selector).click());
const pointer = async (kind, x, y) => act(async () => {
  const event = new window.MouseEvent(kind, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperty(event, 'pointerId', { value: 1 }); video.dispatchEvent(event);
});
after(async () => { await act(async () => root.unmount()); browser.window.close(); });

test('drawing tools preserve the video node, capture complete gestures, and do not send pings', async () => {
  await click('#toggle');
  await click('[aria-label="Pincel"]');
  await pointer('pointerdown', 80, 90);
  await pointer('pointermove', 400, 225);
  await pointer('pointerup', 640, 360);
  await act(async () => video.click());
  const draw = globalThis.__pointerTestSent.find(p => p.kind === 'draw');
  assert.ok(draw);
  assert.deepEqual(draw.drawing.points[0], { x: .1, y: .2 });
  assert.deepEqual(draw.drawing.points.at(-1), { x: .8, y: .8 });
  assert.equal(globalThis.__pointerTestSent.some(p => p.kind === 'ping'), false);
  assert.equal(captured, false);
  await click('#toggle'); await click('#toggle');
  assert.equal(document.querySelector('video'), video);
  await click('[aria-label="Quadrado"]');
  await pointer('pointerdown', 640, 360); await pointer('pointerup', 80, 90);
  assert.equal(globalThis.__pointerTestSent.at(-1).drawing.tool, 'rectangle');
  assert.equal(globalThis.__pointerTestSent.at(-1).drawing.points.length, 2);
});

test('color palette uses the canonical menu and broadcaster consent removes drawing controls', async () => {
  await click('[aria-label="Cor"]');
  assert.equal(document.querySelectorAll('[role="menuitem"]').length, 10);
  await act(async () => document.querySelectorAll('[role="menuitem"]')[5].click());
  await pointer('pointerdown', 80, 90); await pointer('pointerup', 400, 225);
  assert.equal(globalThis.__pointerTestSent.at(-1).drawing.color, '#3b82f6');
  const now = Date.now();
  await act(async () => streamPointerView.set('host', { kind: 'state', sentAt: now, visuals: [], drawingAllowed: false }, { name: 'Viewer', color: 'cyan', localPeerId: 'viewer' }));
  assert.equal(document.querySelector('[aria-label="Rabiscos"]'), null);
  assert.equal(document.querySelector('video'), video);
});

test('circle and literal text use the same normalized projection and cancelled gestures do not publish', async () => {
  await act(async () => streamPointerView.set('host', { kind: 'state', sentAt: Date.now(), visuals: [], drawingAllowed: true }, { name: 'Viewer', color: 'cyan', localPeerId: 'viewer' }));
  await click('[aria-label="Círculo"]');
  await pointer('pointerdown', 80, 90); await pointer('pointerup', 400, 225);
  const circle = globalThis.__pointerTestSent.at(-1);
  assert.equal(circle.drawing.tool, 'ellipse');
  await pointer('pointerdown', 100, 100);
  const before = globalThis.__pointerTestSent.filter(p => p.kind === 'draw').length;
  await pointer('pointercancel', 200, 200);
  await pointer('pointerup', 200, 200);
  assert.equal(globalThis.__pointerTestSent.filter(p => p.kind === 'draw').length, before);
  await click('[aria-label="Texto"]');
  const input = document.querySelector('[aria-label="Texto do rabisco"]');
  assert.equal(input.autocomplete, 'off');
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, '<script>instruction</script>');
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  input.focus();
  await pointer('pointerdown', 400, 225);
  assert.equal(document.activeElement, video.parentElement);
  const text = globalThis.__pointerTestSent.at(-1);
  assert.equal(text.drawing.tool, 'text');
  assert.equal(text.drawing.text, '<script>instruction</script>');
  const now = Date.now();
  await act(async () => streamPointerView.set('host', { kind: 'state', sentAt: now, drawingAllowed: true,
    visuals: [circle, text].map((packet, index) => ({ id: String(index), peerId: 'viewer', name: 'Viewer', color: packet.drawing.color,
      ...packet.drawing.points[0], expires: now + 3000, ping: false, drawing: packet.drawing })) }, { name: 'Viewer', color: 'cyan', localPeerId: 'viewer' }));
  assert.equal(document.querySelector('.stream-drawing-layer ellipse').getAttribute('fill'), 'none');
  assert.equal(document.querySelector('.stream-drawing-layer text').textContent, '<script>instruction</script>');
  assert.equal(document.querySelector('.stream-drawing-layer script'), null);
  assert.equal(document.querySelector('video'), video);
});

test('history buttons and Ctrl+Z/Ctrl+Y issue scoped commands while input editing keeps its shortcuts', async () => {
  await act(async () => streamPointerView.set('host', { kind: 'state', sentAt: Date.now(), visuals: [], drawingAllowed: true,
    history: [{ peerId: 'viewer', undo: 2, redo: 1 }] }, { name: 'Viewer', color: 'cyan', localPeerId: 'viewer' }));
  assert.equal(document.querySelector('[aria-label="Desfazer"]').disabled, false);
  assert.equal(document.querySelector('[aria-label="Refazer"]').disabled, false);
  await click('[aria-label="Desfazer"]'); assert.equal(globalThis.__pointerTestSent.at(-1).kind, 'undo');
  await click('[aria-label="Refazer"]'); assert.equal(globalThis.__pointerTestSent.at(-1).kind, 'redo');
  await pointer('pointermove', 200, 200);
  const key = async key => {
    const event = new window.KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true });
    await act(async () => window.dispatchEvent(event)); return event;
  };
  await key('z'); assert.equal(globalThis.__pointerTestSent.at(-1).kind, 'undo');
  await key('y'); assert.equal(globalThis.__pointerTestSent.at(-1).kind, 'redo');
  const before = globalThis.__pointerTestSent.length;
  document.querySelector('[aria-label="Texto do rabisco"]').focus();
  assert.equal((await key('z')).defaultPrevented, false);
  assert.equal((await key('y')).defaultPrevented, false);
  assert.equal(globalThis.__pointerTestSent.length, before);
  document.activeElement.blur();
  await act(async () => streamPointerView.set('host', { kind: 'state', sentAt: Date.now(), visuals: [], drawingAllowed: true,
    history: [{ peerId: 'viewer', undo: 0, redo: 0 }] }, { name: 'Viewer', color: 'cyan', localPeerId: 'viewer' }));
  assert.equal(document.querySelector('[aria-label="Desfazer"]').disabled, true);
  assert.equal(document.querySelector('[aria-label="Refazer"]').disabled, true);
  await key('z'); assert.equal(globalThis.__pointerTestSent.length, before);
});
