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
HTMLElement.prototype.scrollIntoView = () => {};
const fixture = globalThis.whiteboardFixture = { model: null, listeners: new Set(), notes: new Map(), calls: [], messages: [], errors: [] };
fixture.invoke = async (command, args) => {
  fixture.calls.push({ command, args });
  assert.equal(args.library, 'whiteboard');
  if (command === 'list_saved_notes') return { directory: 'Whiteboards', notes: [...fixture.notes.values()] };
  if (command === 'read_saved_note') return fixture.notes.get(args.id);
  if (command === 'delete_library_note') {
    assert.equal(args.expectedUpdatedAt, fixture.notes.get(args.id).updatedAt);
    fixture.notes.delete(args.id); return;
  }
  if (command === 'rename_library_note') {
    const previous = fixture.notes.get(args.id);
    assert.equal(args.expectedUpdatedAt, previous.updatedAt);
    const note = { ...previous, name: args.name, updatedAt: previous.updatedAt + 1 };
    fixture.notes.set(note.id, note); return note;
  }
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
  core: 'export const isTauri = () => false; export const invoke = (...args) => globalThis.whiteboardFixture.invoke(...args);',
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
const api = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text + '\n//# sourceURL=whiteboard-ui-test-bundle.js').toString('base64')}`);
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
  const initial = document.querySelector('.whiteboard-art > g').getAttribute('transform').match(/translate\(([-.\d]+) ([-.\d]+)\)/);
  assert.equal(Number(initial[1]) + 8000, 400); assert.equal(Number(initial[2]) + 5000, 250);
  await click('Pencil');
  await pointer('pointerdown', 100, 100); await pointer('pointermove', 140, 120);
  assert.equal(document.querySelector('rect[stroke-dasharray]'), null);
  await pointer('pointerup', 160, 140);
  assert.equal(document.querySelector('rect[stroke-dasharray]'), null);
  assert.equal(fixture.model.shapes.length, 1);
  const original = fixture.model.shapes[0];
  assert.equal(original.tool, 'brush');
  assert.equal(original.brushType, 'pencil');
  assert.ok(document.querySelector('.stream-pointer-brush'));
  await click('Select and move');
  await pointer('pointerdown', 100, 100); await pointer('pointermove', 120, 130);
  assert.ok(document.querySelector('[data-cursor-shape="move"]'));
  await pointer('pointerup', 120, 130);
  assert.equal(fixture.model.layers[0].x, 20);
  assert.equal(fixture.model.layers[0].y, 30);
  const beforePan = document.querySelector('.whiteboard-art > g').getAttribute('transform');
  await pointer('pointerdown', 400, 300); await pointer('pointermove', 450, 330); await pointer('pointerup', 450, 330);
  assert.notEqual(document.querySelector('.whiteboard-art > g').getAttribute('transform'), beforePan);
  const geometry = fixture.model.content;
  const cursorBeforeZoom = document.querySelector('.stream-pointer-remote:not(.is-interpolated)');
  const cursorPosition = [cursorBeforeZoom.style.left, cursorBeforeZoom.style.top];
  const beforeZoom = document.querySelector('.whiteboard-art > g').getAttribute('transform');
  await act(async () => canvas().dispatchEvent(new window.WheelEvent('wheel', { deltaY: 100, clientX: 450, clientY: 330, bubbles: true, cancelable: true })));
  await settle();
  assert.notEqual(document.querySelector('.whiteboard-art > g').getAttribute('transform'), beforeZoom);
  const cursorAfterZoom = document.querySelector('.stream-pointer-remote:not(.is-interpolated)');
  assert.deepEqual([cursorAfterZoom.style.left, cursorAfterZoom.style.top], cursorPosition);
  assert.equal(fixture.model.content, geometry);
  await act(async () => canvas().dispatchEvent(new window.WheelEvent('wheel', { deltaY: -200, ctrlKey: true, clientX: 100, clientY: 100, bubbles: true, cancelable: true })));
  await settle();
  assert.match(document.querySelector('.whiteboard-art > g').getAttribute('transform'), /scale\(1\./);
  await act(async () => canvas().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true })));
  assert.equal(fixture.model.layers[0].x, 0);
});

test('layers toggle visibility and locking, and authenticated remote cursors retain brush size', async () => {
  assert.ok(document.querySelector('aside[aria-label="Layers"]'));
  await click('Toggle layer visibility'); assert.equal(fixture.model.layers[0].hidden, true);
  await click('Toggle layer visibility'); assert.equal(fixture.model.layers[0].hidden, false);
  await click('Lock or unlock layer'); assert.equal(fixture.model.layers[0].locked, true);
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
  const widthDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
  const heightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get() { return this.classList.contains('context-menu') ? 120 : 0; } });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return this.classList.contains('context-menu') ? 64 : 0; } });
  button('Rectangle').getBoundingClientRect = () => new window.DOMRect(300, 400, 36, 34);
  await click('Rectangle');
  assert.equal(button('Rectangle').getAttribute('aria-pressed'), 'true');
  const menu = document.querySelector('[role="menu"]');
  assert.ok(menu);
  assert.equal(menu.querySelectorAll('[role="menuitemradio"]').length, 2);
  assert.equal(button('Outline', menu).getAttribute('aria-checked'), 'true');
  assert.equal(menu.textContent, '');
  assert.equal(Number.parseFloat(menu.style.left) + menu.offsetWidth / 2, 318);
  assert.ok(Number.parseFloat(menu.style.top) + menu.offsetHeight < 400);
  await click('Filled', menu);
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', widthDescriptor);
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', heightDescriptor);
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
  assert.ok(document.querySelector('.whiteboard-toolbar-main-row .whiteboard-toolbar-history'));
  assert.equal(document.querySelectorAll('.whiteboard-toolbar-main-row .whiteboard-toolbar-history button').length, 2);
  assert.equal(document.querySelectorAll('.whiteboard-tool-properties button').length, 0);
  await click('Pencil');
  const brushMenu = document.querySelector('[role="menu"]');
  assert.ok(brushMenu);
  assert.equal(brushMenu.querySelectorAll('[role="menuitemradio"]').length, 3);
  assert.equal(button('Pencil', brushMenu).getAttribute('aria-checked'), 'true');
  await click('Pen', brushMenu);
  assert.equal(button('Pen').getAttribute('aria-pressed'), 'true');
  await click('Pen');
  await click('Brush', document.querySelector('[role="menu"]'));
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


test('manual numeric entry rejects non-digits and corrects out-of-range values', async () => {
  const input = document.querySelector('input[inputmode="numeric"][aria-label="Thickness"]');
  const set = async value => act(async () => {
    input.focus(); Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true })); input.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
  await set('9999'); await act(async () => input.blur()); assert.equal(input.value, '100');
  await set('a.2'); assert.equal(input.value, '100');
  await set(''); await act(async () => input.blur()); assert.equal(input.value, '1');
  // Per-tool thickness memory & shortcuts (B, E, V, R, O)
  await act(async () => canvas().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'b', bubbles: true })));
  assert.equal(button('Brush').getAttribute('aria-pressed'), 'true');
  await set('25'); await act(async () => input.blur());
  assert.equal(input.value, '25');
  await act(async () => canvas().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'r', bubbles: true })));
  assert.equal(button('Rectangle').getAttribute('aria-pressed'), 'true');
  assert.equal(input.value, '1');
  await set('12'); await act(async () => input.blur());
  await act(async () => canvas().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'o', bubbles: true })));
  assert.equal(button('Ellipse').getAttribute('aria-pressed'), 'true');
  assert.equal(input.value, '1');
  await set('8'); await act(async () => input.blur());
  await act(async () => canvas().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'e', bubbles: true })));
  assert.equal(button('Eraser').getAttribute('aria-pressed'), 'true');
  assert.equal(input.value, '1');
  await act(async () => canvas().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'b', bubbles: true })));
  assert.equal(button('Brush').getAttribute('aria-pressed'), 'true');
  assert.equal(input.value, '25');
  // Space key temporarily turns cursor into pointer, pans board, and cancels drag on release
  await pointer('pointermove', 250, 250);
  await act(async () => canvas().dispatchEvent(new window.KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true })));
  assert.ok(document.querySelector('[data-cursor-shape="pointer"]'));
  const beforeSpacePan = document.querySelector('.whiteboard-art > g').getAttribute('transform');
  await pointer('pointerdown', 250, 250);
  assert.ok(document.querySelector('[data-cursor-shape="hand"]'));
  await pointer('pointermove', 300, 280);
  await settle();
  assert.ok(document.querySelector('[data-cursor-shape="hand"]'));
  const afterSpacePan = document.querySelector('.whiteboard-art > g').getAttribute('transform');
  assert.notEqual(afterSpacePan, beforeSpacePan);
  await act(async () => window.dispatchEvent(new window.KeyboardEvent('keyup', { key: ' ', code: 'Space', bubbles: true })));
  assert.ok(document.querySelector('.stream-pointer-brush'));
  await pointer('pointermove', 350, 320);
  await settle();
  assert.equal(document.querySelector('.whiteboard-art > g').getAttribute('transform'), afterSpacePan);
  await pointer('pointerup', 350, 320);
  // Restore brush thickness to 1 and tool to pointer for subsequent tests
  await set('1'); await act(async () => input.blur());
  await act(async () => canvas().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'v', bubbles: true })));
  assert.equal(button('Select and move').getAttribute('aria-pressed'), 'true');
});

test('paint stays in the active layer, erasing is scoped, and named layers reorder with a drag placeholder', async () => {
  await click('Add layer');
  const layer = fixture.model.layers[fixture.model.layers.length - 1];
  const row = () => document.querySelector(`[data-sortable-id="${layer.id}"]`);
  await click('Rename layer', row());
  const input = document.querySelector('input[aria-label="Rename layer"]');
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, 'Details');
    input.dispatchEvent(new window.Event('input', { bubbles: true })); input.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
  await act(async () => input.blur());
  assert.equal(fixture.model.layers.find(l => l.id === layer.id).name, 'Details');
  await click('Brush');
  await pointer('pointerdown', 200, 150); await pointer('pointermove', 220, 170); await pointer('pointerup', 230, 180);
  await pointer('pointerdown', 260, 220); await pointer('pointermove', 280, 240); await pointer('pointerup', 300, 250);
  assert.equal(fixture.model.shapes.filter(s => s.layerId === layer.id).length, 2);
  assert.equal(document.querySelector('rect[stroke-dasharray]'), null);
  assert.equal(fixture.model.shapes[fixture.model.shapes.length - 1].width, 20);
  await click('Eraser');
  await pointer('pointerdown', 200, 150); await pointer('pointermove', 220, 150); await pointer('pointerup', 230, 150);
  assert.ok(document.querySelector(`[data-board-layer="${layer.id}"] mask`));
  const grid = document.querySelector('.whiteboard-layer-list');
  grid.getBoundingClientRect = () => new window.DOMRect(600, 20, 200, 200);
  for (const element of grid.children) {
    Object.defineProperties(element, { offsetLeft: { configurable: true, get: () => 0 }, offsetTop: { configurable: true, get: () => [...grid.children].indexOf(element) * 80 },
      offsetWidth: { configurable: true, get: () => 200 }, offsetHeight: { configurable: true, get: () => 72 } });
    element.getBoundingClientRect = () => new window.DOMRect(600, 20 + [...grid.children].indexOf(element) * 80, 200, 72);
  }
  const dragEvent = (type, x, y) => { const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
    Object.defineProperty(event, 'pointerId', { value: 9 }); return event; };
  const before = fixture.model.layers.map(l => l.id);
  await act(async () => button('Drag to reorder layer', row()).dispatchEvent(dragEvent('pointerdown', 780, 56)));
  assert.ok(document.querySelector('.whiteboard-layer.is-dragging'));
  assert.ok(document.querySelector('.whiteboard-layer-drag'));
  await act(async () => window.dispatchEvent(dragEvent('pointermove', 780, 136))); await settle();
  assert.deepEqual([...grid.children].map(node => node.dataset.sortableId), before, 'The placeholder follows the prospective drop position');
  assert.deepEqual(fixture.model.layers.map(l => l.id), before);
  await act(async () => window.dispatchEvent(dragEvent('pointerup', 780, 136))); await settle();
  assert.deepEqual(fixture.model.layers.map(l => l.id), [...before].reverse());
  assert.equal(document.querySelector('.whiteboard-layer-drag'), null);
});


test('layer cards select grouped paint, names edit directly and panels collapse without changing content', async () => {
  const layer = fixture.model.layers.find(l => l.name === 'Details');
  const row = document.querySelector(`[data-sortable-id="${layer.id}"]`);
  await act(async () => row.click());
  assert.ok(document.querySelector('rect[stroke-dasharray]'));
  assert.ok(row.querySelector('.whiteboard-layer-preview path'));
  const content = fixture.model.content;
  await click('Hide tools');
  const tools = document.getElementById(button('Show tools').getAttribute('aria-controls'));
  assert.equal(tools.getAttribute('aria-hidden'), 'true');
  assert.ok(tools.hasAttribute('inert'));
  await click('Show tools');
  assert.equal(tools.hasAttribute('inert'), false);
  await click('Hide layers');
  const layers = document.getElementById(button('Show layers').getAttribute('aria-controls'));
  assert.ok(layers.hasAttribute('inert'));
  await click('Show layers');
  assert.equal(layers.hasAttribute('inert'), false);
  await click('Rename layer', row);
  const input = row.querySelector('input');
  await act(async () => input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.equal(fixture.model.content, content);
});

test('PNG export renders the full white board and sends binary image data through the native save flow', async () => {
  globalThis.FileReader = window.FileReader;
  const originalContext = window.HTMLCanvasElement.prototype.getContext;
  const originalToBlob = window.HTMLCanvasElement.prototype.toBlob;
  let renderedSvg = '', dimensions;
  globalThis.Image = class {
    naturalWidth = 4096; naturalHeight = 2560;
    set src(url) { void fetch(url).then(r => r.text()).then(svg => { renderedSvg = svg; this.onload(); }); }
  };
  window.HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {} });
  window.HTMLCanvasElement.prototype.toBlob = function(callback) {
    dimensions = [this.width, this.height];
    callback(new window.Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }));
  };
  // The raster helper creates a browser Blob; the Node fixture's URL API needs a Node Blob.
  const createUrl = URL.createObjectURL;
  URL.createObjectURL = blob => {
    if (blob instanceof window.Blob) throw new Error('PNG encoding must not fetch a blob URL');
    return createUrl(blob);
  };
  try {
    await click('Export');
    await click('Export format', document.querySelector('[role="dialog"]'));
    const png = [...document.querySelectorAll('[role="option"]')].find(option => option.textContent.includes('PNG (.png)'));
    assert.ok(png); await act(async () => png.click()); await settle();
    assert.match(document.querySelector('.notepad-files-hint').textContent, /4096 × 2560/);
    await click('Export', document.querySelector('[role="dialog"]')); await settle();
    const exported = fixture.calls.filter(c => c.command === 'save_note_file').at(-1).args;
    assert.equal(exported.format, 'png');
    assert.match(exported.content, /^data:image\/png;base64,/);
    assert.deepEqual(dimensions, [4096, 2560]);
    assert.match(renderedSvg, /viewBox="0 0 16000 10000"/);
    assert.match(renderedSvg, /fill="white"/);
  } finally {
    URL.createObjectURL = createUrl;
    window.HTMLCanvasElement.prototype.getContext = originalContext;
    window.HTMLCanvasElement.prototype.toBlob = originalToBlob;
    delete globalThis.Image; delete globalThis.FileReader;
  }
});


test('fullscreen retains the canvas and keeps file dialogs inside the fullscreen surface', async () => {
  const surface = document.querySelector('.whiteboard-app'), originalCanvas = canvas();
  surface.requestFullscreen = async () => { Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: surface }); document.dispatchEvent(new window.Event('fullscreenchange')); };
  document.exitFullscreen = async () => { Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null }); document.dispatchEvent(new window.Event('fullscreenchange')); };
  await click('Full screen');
  assert.equal(document.fullscreenElement, surface);
  assert.equal(canvas(), originalCanvas);
  await click('Open');
  assert.equal(document.querySelector('.modal-overlay').parentElement, surface);
  await click('Cancel', document.querySelector('[role="dialog"]'));
  await click('Exit full screen');
  assert.equal(document.fullscreenElement, null);
  assert.equal(canvas(), originalCanvas);
});

test('renaming an open board retains unsaved paint and subsequent saves use the new disk revision', async () => {
  await click('Save');
  const id = fixture.model.identity.id, oldContent = fixture.notes.get(id).content;
  await act(async () => fixture.model.put({ id: crypto.randomUUID(), order: 100, hidden: false, locked: false, tool: 'line', color: '#ef4444', width: 3, filled: false, x: 0, y: 0, points: [{ x: 20, y: 30 }, { x: 80, y: 90 }] }));
  const content = fixture.model.content;
  await click('Open');
  await click('Rename', document.querySelector('.notepad-files-row'));
  const child = [...document.querySelectorAll('[role="dialog"]')].at(-1), input = child.querySelector('input');
  await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, 'Renamed board'); input.dispatchEvent(new window.Event('input', { bubbles: true })); });
  await click('Rename', child);
  assert.equal(fixture.model.identity.name, 'Renamed board');
  assert.equal(fixture.model.content, content);
  assert.equal(fixture.notes.get(id).content, oldContent);
  await click('Cancel', document.querySelector('[role="dialog"]'));
  await click('Save');
  assert.equal(fixture.notes.get(id).content, content);
});


test('deleting the open saved board preserves paint and asks for a name before recreating its saved copy', async () => {
  const id = fixture.model.identity.id, content = fixture.model.content, name = fixture.model.identity.name;
  await click('Open');
  const row = [...document.querySelectorAll('.notepad-files-row')].find(row => row.textContent.includes(name));
  await click('Delete', row);
  await click('Delete', [...document.querySelectorAll('[role="dialog"]')].at(-1));
  assert.equal(fixture.notes.has(id), false);
  assert.equal(fixture.model.content, content);
  assert.equal(fixture.model.identity.id, id);
  await click('Cancel', document.querySelector('[role="dialog"]'));
  await click('Save');
  assert.equal(document.querySelector('[role="dialog"] input').value, name);
  await click('Save', document.querySelector('[role="dialog"]'));
  assert.equal(fixture.notes.get(id).content, content);
});

test('remote cursors retain world coordinates while every zoom frame uses the same camera transform as the board', async () => {
  await act(async () => { fixture.model.setParticipants(['local', 'remote']); fixture.model.apply({ cursor: {
    x: 80, y: 90, tool: 'brush', width: 30, color: '#ef4444' } }, 'remote', false); });
  const group = document.querySelector('.whiteboard-remote-cursors');
  const glyph = group.querySelector('.stream-pointer-remote');
  const initialCamera = group.style.transform;
  await act(async () => canvas().dispatchEvent(new window.WheelEvent('wheel', {
    deltaY: -200, ctrlKey: true, clientX: 300, clientY: 250, bubbles: true, cancelable: true })));
  for (let frame = 0; frame < 4; frame++) {
    await act(async () => new Promise(resolve => requestAnimationFrame(resolve)));
    const camera = document.querySelector('.whiteboard-art > g').getAttribute('transform').match(/translate\(([^ ]+) ([^)]+)\) scale\(([^)]+)\)/);
    const [x, y, zoom] = camera.slice(1).map(Number);
    assert.equal(group.style.transform, `translate(${x}px, ${y}px) scale(${zoom})`);
    assert.equal(glyph.style.left, '80px'); assert.equal(glyph.style.top, '90px');
    assert.equal(glyph.style.transform, `scale(${1 / zoom})`);
    assert.equal(Number.parseFloat(glyph.querySelector('i').style.width), 30 * zoom);
  }
  assert.notEqual(group.style.transform, initialCamera);
});
