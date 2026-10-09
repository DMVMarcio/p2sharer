import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act, useRef } from 'react';

const browser = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' });
for (const key of ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Element', 'Node', 'MutationObserver', 'CustomEvent']) globalThis[key] = browser.window[key];
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
  assert.equal(document.querySelectorAll('[role="menuitemradio"]').length, 11);
  assert.equal(document.querySelector('[role="menuitemradio"][aria-checked="true"]').textContent, 'Vermelho');
  await act(async () => document.querySelector('[aria-label="Cor"]').dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true })));
  await click('[aria-label="Cor"]');
  assert.equal(document.querySelector('[role="menu"]').hasAttribute('inert'), true);
  await click('[aria-label="Cor"]');
  await act(async () => [...document.querySelectorAll('[role="menuitemradio"]')].find(item => item.textContent === 'Marrom').click());
  await pointer('pointerdown', 80, 90); await pointer('pointerup', 400, 225);
  assert.equal(globalThis.__pointerTestSent.at(-1).drawing.color, '#a47754');
  await click('[aria-label="Cor"]');
  await act(async () => [...document.querySelectorAll('[role="menuitemradio"]')].find(item => item.textContent === 'Azul').click());
  await pointer('pointerdown', 80, 90); await pointer('pointerup', 400, 225);
  assert.equal(globalThis.__pointerTestSent.at(-1).drawing.color, '#3b82f6');
  await click('[aria-label="Cor"]');
  assert.equal(document.querySelector('[role="menuitemradio"][aria-checked="true"]').textContent, 'Azul');
  await click('[aria-label="Cor"]');
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
  assert.equal(document.querySelector('[aria-label="Texto do rabisco"]'), null);
  await pointer('pointerdown', 400, 225);
  const input = document.querySelector('[aria-label="Texto do rabisco"]');
  assert.equal(input.autocomplete, 'off');
  assert.equal(document.activeElement, input);
  await act(async () => video.dispatchEvent(new window.MouseEvent('mousedown', { button: 0, bubbles: true })));
  assert.equal(document.activeElement, input);
  const drawsBefore = globalThis.__pointerTestSent.filter(p => p.kind === 'draw').length;
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(input, '<script>instruction</script>');
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  assert.equal(globalThis.__pointerTestSent.filter(p => p.kind === 'draw').length, drawsBefore);
  await act(async () => input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })));
  assert.equal(document.querySelector('[aria-label="Texto do rabisco"]'), input);
  await act(async () => input.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
  assert.ok(document.querySelector('[role="menu"]'));
  assert.equal(document.querySelector('[aria-label="Texto do rabisco"]'), input);
  await act(async () => document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await act(async () => input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
  assert.equal(document.querySelector('[aria-label="Texto do rabisco"]'), null);
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
  await pointer('pointerdown', 400, 225);
  const before = globalThis.__pointerTestSent.length;
  document.querySelector('[aria-label="Texto do rabisco"]').focus();
  assert.equal((await key('z')).defaultPrevented, false);
  assert.equal((await key('y')).defaultPrevented, false);
  assert.equal(globalThis.__pointerTestSent.length, before);
  await act(async () => document.activeElement.blur());
  await act(async () => streamPointerView.set('host', { kind: 'state', sentAt: Date.now(), visuals: [], drawingAllowed: true,
    history: [{ peerId: 'viewer', undo: 0, redo: 0 }] }, { name: 'Viewer', color: 'cyan', localPeerId: 'viewer' }));
  assert.equal(document.querySelector('[aria-label="Desfazer"]').disabled, true);
  assert.equal(document.querySelector('[aria-label="Refazer"]').disabled, true);
  await key('z'); assert.equal(globalThis.__pointerTestSent.length, before);
});

test('inline text preserves Shift+Enter and confirms once on outside clicks without committing empty drafts', async () => {
  await click('[aria-label="Mouse"]');
  await click('[aria-label="Texto"]');
  await pointer('pointerdown', 160, 135);
  const input = document.querySelector('[aria-label="Texto do rabisco"]');
  const before = globalThis.__pointerTestSent.filter(p => p.kind === 'draw').length;
  const shiftEnter = new window.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true });
  await act(async () => input.dispatchEvent(shiftEnter));
  assert.equal(shiftEnter.defaultPrevented, false);
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(input, 'First line\n\nThird line');
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await pointer('pointerdown', 500, 300);
  assert.equal(document.querySelector('[aria-label="Texto do rabisco"]'), null);
  const packet = globalThis.__pointerTestSent.at(-1);
  assert.equal(packet.kind, 'draw');
  assert.equal(packet.drawing.text, 'First line\n\nThird line');
  await act(async () => streamPointerView.set('host', { kind: 'state', sentAt: Date.now(), drawingAllowed: true,
    visuals: [{ id: 'multiline', peerId: 'viewer', name: 'Viewer', color: packet.drawing.color, ...packet.drawing.points[0],
      expires: Date.now() + 3000, ping: false, drawing: packet.drawing }] }, { name: 'Viewer', color: 'cyan', localPeerId: 'viewer' }));
  assert.equal(document.querySelectorAll('.stream-drawing-layer text tspan').length, 3);
  assert.equal(document.querySelectorAll('.stream-drawing-layer text tspan')[2].textContent, 'Third line');
  assert.deepEqual(packet.drawing.points[0], { x: .2, y: .3 });
  assert.equal(globalThis.__pointerTestSent.filter(p => p.kind === 'draw').length, before + 1);
  await pointer('pointerdown', 500, 300);
  await act(async () => document.body.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true })));
  assert.equal(globalThis.__pointerTestSent.filter(p => p.kind === 'draw').length, before + 1);
  assert.equal(document.querySelector('[aria-label="Texto do rabisco"]'), null);
});

test('continuous brush strokes retain 192 points before simplifying their path', async () => {
  await click('[aria-label="Pincel"]');
  await pointer('pointerdown', 0, 225);
  for (let i = 0; i < 190; i++) await pointer('pointermove', 1 + i * 3, 225);
  await pointer('pointerup', 799, 225);
  const packet = globalThis.__pointerTestSent.at(-1);
  assert.equal(packet.kind, 'draw');
  assert.equal(packet.drawing.points.length, 192);
  assert.deepEqual(packet.drawing.points[0], { x: 0, y: .5 });
  assert.deepEqual(packet.drawing.points.at(-1), { x: 799 / 800, y: .5 });
});

test('clicking each active drawing tool again returns to Mouse', async () => {
  for (const label of ['Pincel', 'Quadrado', 'Círculo', 'Texto']) {
    await click('[aria-label="Mouse"]');
    await click(`[aria-label="${label}"]`);
    assert.equal(document.querySelector(`[aria-label="${label}"]`).getAttribute('aria-pressed'), 'true');
    await click(`[aria-label="${label}"]`);
    assert.equal(document.querySelector(`[aria-label="${label}"]`).getAttribute('aria-pressed'), 'false');
    assert.equal(document.querySelector('[aria-label="Mouse"]').getAttribute('aria-pressed'), 'true');
  }
});

test('pen and touch tablet inputs draw properly and container has touch-action class active', async () => {
  assert.ok(document.querySelector('.is-stream-pointer-active'));
  await click('[aria-label="Pincel"]');
  const initialDraws = globalThis.__pointerTestSent.filter(p => p.kind === 'draw').length;
  await act(async () => {
    const penDown = new window.MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 160, clientY: 90, button: 0 });
    Object.defineProperties(penDown, { pointerId: { value: 2 }, pointerType: { value: 'pen' } });
    video.dispatchEvent(penDown);
  });
  await act(async () => {
    const penMove = new window.MouseEvent('pointermove', { bubbles: true, cancelable: true, clientX: 320, clientY: 180, button: -1 });
    Object.defineProperties(penMove, { pointerId: { value: 2 }, pointerType: { value: 'pen' }, buttons: { value: 1 } });
    video.dispatchEvent(penMove);
  });
  await act(async () => {
    const penUp = new window.MouseEvent('pointerup', { bubbles: true, cancelable: true, clientX: 480, clientY: 270, button: 0 });
    Object.defineProperties(penUp, { pointerId: { value: 2 }, pointerType: { value: 'pen' } });
    video.dispatchEvent(penUp);
  });
  const penDraws = globalThis.__pointerTestSent.filter(p => p.kind === 'draw');
  assert.equal(penDraws.length, initialDraws + 1);
  assert.equal(penDraws.at(-1).drawing.tool, 'brush');
  assert.deepEqual(penDraws.at(-1).drawing.points[0], { x: 0.2, y: 0.2 });
});
