import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';

const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'localStorage', 'Event', 'CustomEvent']) globalThis[key] = dom.window[key];
globalThis.getComputedStyle = window.getComputedStyle;
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
const captures = new Set();
HTMLElement.prototype.setPointerCapture = id => captures.add(id);
HTMLElement.prototype.releasePointerCapture = id => captures.delete(id);
HTMLElement.prototype.hasPointerCapture = id => captures.has(id);
const fixture = globalThis.whiteboardFixture = { model: null, listeners: new Set(), notes: new Map(), calls: [], messages: [], errors: [] };
fixture.invoke = async (command, args) => {
  fixture.calls.push({ command, args });
  assert.equal(args.library, 'whiteboard');
  if (command === 'list_saved_notes') return { directory: 'Whiteboards', notes: [...fixture.notes.values()] };
  if (command === 'read_saved_note') return fixture.notes.get(args.id);
  if (command === 'save_library_note') {
    const previous = fixture.notes.get(args.id);
    assert.equal(args.expectedUpdatedAt, previous?.updatedAt ?? null);
    const note = { ...args, updatedAt: (previous?.updatedAt ?? 0) + 1 };
    fixture.notes.set(args.id, note); return note;
  }
  if (command === 'save_note_file') return true;
  if (command === 'open_note_file') return fixture.imported ?? null;
  throw new Error(command);
};
const mocks = {
  core: 'export const invoke = (...args) => globalThis.whiteboardFixture.invoke(...args);',
  room_apps_service: `export const roomAppsService = { getModel: () => globalThis.whiteboardFixture.model, getLocalActor: () => 'local',
    subscribe: fn => { globalThis.whiteboardFixture.listeners.add(fn); return () => globalThis.whiteboardFixture.listeners.delete(fn); } };`,
  useRoom: "export const useRoom = () => ({ username: 'Local', peers: [{ id: 'remote', username: 'Remote' }] });",
  useToast: 'export const showToast = value => globalThis.whiteboardFixture.errors.push(value);',
};
const bundle = await build({ stdin: { contents: `export { WhiteboardApp } from './src/apps/WhiteboardApp.tsx';
  export { ContextMenuProvider } from './src/components/common/ContextMenu.tsx';
  export { WhiteboardModel } from './src/apps/whiteboard_model.ts'; export { setLanguage } from './src/i18n/index.ts';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'esm', jsx: 'automatic', plugins: [{ name: 'whiteboard-fixture', setup(builder) {
    builder.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: 'core', namespace: 'fixture' }));
    builder.onResolve({ filter: /\/(room_apps_service|useRoom|useToast)$/ }, args => ({ path: args.path.split('/').at(-1), namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: mocks[args.path] }));
    builder.onResolve({ filter: /^[^./]/ }, args => ({ path: import.meta.resolve(args.path), external: true }));
  } }] });
const api = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
api.setLanguage('en');
fixture.model = new api.WhiteboardModel({ localActor: 'local', emit: value => fixture.messages.push(value), changed: () => fixture.listeners.forEach(fn => fn()) });
const { createRoot } = await import('react-dom/client');
const root = createRoot(document.getElementById('root'));
const instanceId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
const canvas = () => document.querySelector('.whiteboard-canvas');
const button = (name, scope = document) => [...scope.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === name || b.textContent === name);
const click = async (name, scope = document) => { const b = button(name, scope); assert.ok(b, name); await act(async () => b.click()); await settle(); };
const pointer = async (type, x, y) => act(async () => {
  const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperty(event, 'pointerId', { value: 1 }); canvas().dispatchEvent(event);
});
after(async () => { await act(async () => root.unmount()); fixture.model.destroy(); dom.window.close(); delete globalThis.whiteboardFixture; });

test('drawing, object movement, canvas panning, wheel navigation and brush cursors use the production scene', async () => {
  await act(async () => root.render(React.createElement(api.ContextMenuProvider, null, React.createElement(api.WhiteboardApp, { instanceId }))));
  await settle();
  await click('Brush');
  await pointer('pointerdown', 100, 100); await pointer('pointermove', 140, 120);
  assert.equal(document.querySelector('rect[stroke-dasharray]'), null);
  await pointer('pointerup', 160, 140);
  assert.ok(document.querySelector('rect[stroke-dasharray]'));
  assert.equal(fixture.model.shapes.length, 1);
  const original = fixture.model.shapes[0];
  assert.equal(original.tool, 'brush');
  assert.ok(document.querySelector('.stream-pointer-brush'));
  await click('Select and move');
  await pointer('pointerdown', 100, 100); await pointer('pointermove', 120, 130); await pointer('pointerup', 120, 130);
  assert.equal(fixture.model.shapes[0].x, 20);
  assert.equal(fixture.model.shapes[0].y, 30);
  const beforePan = document.querySelector('.whiteboard-art > g').getAttribute('transform');
  await pointer('pointerdown', 400, 300); await pointer('pointermove', 450, 330); await pointer('pointerup', 450, 330);
  assert.notEqual(document.querySelector('.whiteboard-art > g').getAttribute('transform'), beforePan);
  const geometry = fixture.model.content;
  const beforeZoom = document.querySelector('.whiteboard-art > g').getAttribute('transform');
  await act(async () => canvas().dispatchEvent(new window.WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true })));
  await settle();
  assert.notEqual(document.querySelector('.whiteboard-art > g').getAttribute('transform'), beforeZoom);
  assert.equal(fixture.model.content, geometry);
  await act(async () => canvas().dispatchEvent(new window.WheelEvent('wheel', { deltaY: -200, ctrlKey: true, clientX: 100, clientY: 100, bubbles: true, cancelable: true })));
  await settle();
  assert.match(document.querySelector('.whiteboard-art > g').getAttribute('transform'), /scale\(1\./);
  await act(async () => canvas().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true })));
  assert.equal(fixture.model.shapes[0].x, 0);
});

test('layers toggle visibility and locking, and authenticated remote cursors retain brush size', async () => {
  assert.ok(document.querySelector('aside[aria-label="Layers"]'));
  await click('Toggle layer visibility'); assert.equal(fixture.model.shapes[0].hidden, true);
  await click('Toggle layer visibility'); assert.equal(fixture.model.shapes[0].hidden, false);
  await click('Lock or unlock layer'); assert.equal(fixture.model.shapes[0].locked, true);
  assert.equal(button('Delete layer').disabled, true);
  await click('Lock or unlock layer');
  await act(async () => {
    fixture.model.setParticipants(['local', 'remote']);
    fixture.model.apply({ cursor: { x: 80, y: 90, tool: 'brush', width: 30, color: '#ef4444' } }, 'remote', false);
  });
  assert.match(document.querySelector('.whiteboard-cursors').textContent, /Remote/);
  assert.equal(fixture.model.cursors.get('remote').width, 30);
});

test('shape tools offer accessible visual fill choices and stabilization persists locally', async () => {
  await click('Rectangle');
  const menu = document.querySelector('[role="menu"]');
  assert.ok(menu);
  assert.equal(menu.querySelectorAll('[role="menuitemradio"]').length, 2);
  assert.equal(menu.textContent, '');
  await click('Filled', menu);
  assert.equal(button('Rectangle').getAttribute('aria-pressed'), 'true');
  await pointer('pointerdown', 180, 170); await pointer('pointermove', 230, 210);
  assert.equal(document.querySelector('rect[stroke-dasharray]'), null);
  await pointer('pointercancel', 230, 210);
  const slider = document.querySelector('input[aria-label="Stabilization"]');
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(slider, '70');
    slider.dispatchEvent(new window.Event('input', { bubbles: true })); slider.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
  assert.equal(localStorage.getItem('p2sharer_whiteboard_smoothing'), '70');
  await click('Select and move');
  assert.equal(fixture.model.shapes.length, 1);
});

test('whiteboards save and reopen the same local file, export separately and confirm shared replacement', async () => {
  await click('Save'); await click('Save', document.querySelector('[role="dialog"]'));
  assert.equal(fixture.notes.size, 1);
  assert.equal(fixture.model.identity.id, instanceId);
  const first = fixture.notes.get(instanceId);
  await act(async () => fixture.model.put({ ...fixture.model.shapes[0], color: '#ef4444' }));
  await act(async () => canvas().dispatchEvent(new window.KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true })));
  await settle();
  assert.ok(fixture.notes.get(instanceId).updatedAt > first.updatedAt);
  assert.equal(fixture.notes.size, 1);
  await click('Export'); await click('Export', document.querySelector('[role="dialog"]'));
  assert.equal(fixture.calls.find(c => c.command === 'save_note_file').args.format, 'p2board');
  assert.equal(fixture.model.identity.id, instanceId);
  await click('New File');
  assert.equal(fixture.model.shapes.length, 1);
  await click('Replace content', document.querySelector('[role="dialog"]'));
  assert.equal(fixture.model.shapes.length, 0);
  assert.notEqual(fixture.model.identity.id, instanceId);
  await click('Open'); await click('Open', document.querySelector('[role="dialog"]'));
  assert.equal(fixture.model.shapes.length, 1);
  assert.equal(fixture.model.identity.id, instanceId);
  assert.match(document.querySelector('[role="status"]').textContent, /Saved on this computer/);
});
