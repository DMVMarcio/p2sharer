import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act, useState } from 'react';

async function fixture() {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const keys = ['window', 'document', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'navigator', 'IS_REACT_ACT_ENVIRONMENT'];
  const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of keys.slice(0, -1)) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.matchMedia = () => ({ matches: false });
  const require = createRequire(import.meta.url);
  const bundle = await build({ stdin: { contents: "export { useBrowserPointerLock } from './src/hooks/useBrowserPointerLock'; export { useBrowserChrome } from './src/hooks/useBrowserChrome'; export { useMediaVolume } from './src/hooks/useMediaVolume'; export { MediaVolumeControl } from './src/components/common/MediaVolumeControl'; export { useSelectAllOnFocus } from './src/hooks/useSelectAllOnFocus'; export { BrowserTabs } from './src/apps/BrowserTabs'; export { BrowserContextMenu } from './src/apps/BrowserContextMenu'; export { ContextMenuProvider } from './src/components/common/ContextMenu'; export { t } from './src/i18n'; export { useVideoPresentation } from './src/hooks/useVideoPresentation';", resolveDir: process.cwd() },
    bundle: true, write: false, format: 'esm', platform: 'node', loader: { '.css': 'empty' },
    plugins: [{ name: 'browser-controls-fixture', setup(builder) {
      builder.onResolve({ filter: /^[^./]/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
    } }] });
  const components = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root'));
  return { ...components, dom, root, async cleanup() {
    await act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  } };
}

test('manual toolbar collapse survives pointer movement and fullscreen changes until explicitly expanded', async context => {
  const f = await fixture();
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const Harness = () => {
    const [fullscreen, setFullscreen] = useState(false);
    const chrome = f.useBrowserChrome(fullscreen);
    return React.createElement('div', null,
      React.createElement('div', { id: 'chrome', inert: !chrome.visible }, 'Toolbar'),
      React.createElement('button', { id: 'collapse', onClick: chrome.collapse }, 'Collapse'),
      React.createElement('button', { id: 'expand', onClick: chrome.expand }, 'Expand'),
      React.createElement('button', { id: 'move', onClick: chrome.reveal }, 'Move'),
      React.createElement('button', { id: 'fullscreen', onClick: () => setFullscreen(value => !value) }, 'Fullscreen'));
  };
  const click = async id => act(async () => document.getElementById(id).click());
  const hidden = () => document.getElementById('chrome').hasAttribute('inert');
  try {
    await act(async () => f.root.render(React.createElement(Harness)));
    assert.equal(hidden(), false);
    await click('collapse'); await click('move'); assert.equal(hidden(), true);
    await click('fullscreen'); await click('move'); assert.equal(hidden(), true);
    await click('expand'); assert.equal(hidden(), false);
    await act(async () => context.mock.timers.tick(1801)); assert.equal(hidden(), true);
    await click('move'); assert.equal(hidden(), false);
    await click('collapse'); await click('fullscreen'); assert.equal(hidden(), true);
    await click('expand'); assert.equal(hidden(), false);
  } finally { await f.cleanup(); context.mock.timers.reset(); }
});

test('address activation selects everything once and subsequent clicks preserve caret placement', async () => {
  const f = await fixture();
  const Harness = () => React.createElement('input', { ...f.useSelectAllOnFocus(), defaultValue: 'https://example.com/' });
  try {
    await act(async () => f.root.render(React.createElement(Harness)));
    const input = document.querySelector('input');
    await act(async () => input.dispatchEvent(new f.dom.window.MouseEvent('pointerdown', { bubbles: true, button: 0, cancelable: true })));
    await act(async () => input.click());
    assert.equal(document.activeElement, input); assert.equal(input.selectionStart, 0); assert.equal(input.selectionEnd, input.value.length);
    const second = new f.dom.window.MouseEvent('pointerdown', { bubbles: true, button: 0, cancelable: true });
    await act(async () => input.dispatchEvent(second)); assert.equal(second.defaultPrevented, false);
    input.setSelectionRange(4, 4); await act(async () => input.click()); assert.equal(input.selectionStart, 4); assert.equal(input.selectionEnd, 4);
    await act(async () => { input.blur(); input.focus(); }); assert.equal(input.selectionStart, 0); assert.equal(input.selectionEnd, input.value.length);
  } finally { await f.cleanup(); }
});

test('tab dragging emits relative moves and closed tabs retire inertly without losing the active tab focus', async context => {
  const f = await fixture(); const commands = [];
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const tabs = [1, 2, 3].map(id => ({ id, url: `https://example.com/${id}`, title: `Tab ${id}` }));
  const render = list => act(async () => f.root.render(React.createElement(f.BrowserTabs, { tabs: list, active: 3, running: true, canControl: true, command: command => commands.push(command) })));
  const pointer = async (target, type, x) => act(async () => {
    const event = new f.dom.window.MouseEvent(type, { bubbles: true, button: 0, clientX: x, cancelable: true });
    Object.defineProperty(event, 'pointerId', { value: 7 }); target.dispatchEvent(event);
  });
  try {
    const captures = new WeakSet();
    f.dom.window.HTMLElement.prototype.setPointerCapture = function() { captures.add(this); };
    f.dom.window.HTMLElement.prototype.hasPointerCapture = function() { return captures.has(this); };
    f.dom.window.HTMLElement.prototype.releasePointerCapture = function() { captures.delete(this); };
    await render(tabs);
    const row = document.querySelector('[role=group]'); row.getBoundingClientRect = () => ({ left: 0, right: 360 });
    [...row.querySelectorAll('[data-browser-tab]')].forEach((element, index) => { element.getBoundingClientRect = () => ({ left: index * 120, top: 0, width: 120, height: 28 }); });
    const first = row.querySelector('[data-browser-tab="1"] button');
    await act(async () => first.dispatchEvent(new f.dom.window.MouseEvent('auxclick', { bubbles: true, button: 1, cancelable: true })));
    assert.deepEqual(commands.pop(), { kind: 'close-tab', id: 1 });
    await act(async () => first.dispatchEvent(new f.dom.window.MouseEvent('auxclick', { bubbles: true, button: 2, cancelable: true })));
    assert.equal(commands.length, 0);
    await pointer(first, 'pointerdown', 40); await pointer(first, 'pointermove', 400);
    const preview = document.querySelector('.browser-tab-preview'); const placeholder = row.querySelector('.browser-tab-placeholder');
    assert.equal(preview.textContent, 'Tab 1'); assert.equal(preview.getAttribute('aria-hidden'), 'true');
    assert.equal(placeholder.nextElementSibling.querySelector('svg') !== null, true);
    assert.equal(placeholder.style.width, preview.style.width);
    await pointer(first, 'pointercancel', 400);
    assert.equal(document.querySelector('.browser-tab-preview'), null); assert.equal(row.querySelector('.browser-tab-placeholder'), null);
    assert.equal(commands.length, 0);
    await pointer(first, 'pointerdown', 40); await pointer(first, 'pointermove', 100); await pointer(first, 'pointermove', 400); await pointer(first, 'pointerup', 400);
    await act(async () => first.click());
    assert.deepEqual(commands, [{ kind: 'move-tab', id: 1, before: null }]);
    await render([tabs[1], tabs[2], tabs[0]]);
    const close = row.querySelector('[data-browser-tab="2"] .browser-tab-close');
    await act(async () => { close.focus(); close.click(); });
    assert.deepEqual(commands.at(-1), { kind: 'close-tab', id: 2 });
    await render([tabs[2], tabs[0]]);
    assert.equal(row.querySelector('[data-browser-tab="2"]').hasAttribute('inert'), true);
    assert.equal(document.activeElement, row.querySelector('[data-browser-tab="3"] .browser-tab-label'));
    await act(async () => context.mock.timers.tick(151));
    assert.equal(row.querySelector('[data-browser-tab="2"]'), null);
    assert.deepEqual([...row.querySelectorAll('[data-browser-tab]')].map(element => Number(element.dataset.browserTab)), [3, 1]);
    f.dom.window.matchMedia = () => ({ matches: true });
    await render([tabs[0]]); assert.equal(row.querySelector('[data-browser-tab="3"]'), null);
  } finally { await f.cleanup(); context.mock.timers.reset(); }
});

test('the grouped volume control restores the last level and adjusting its slider unmutes', async () => {
  const f = await fixture(); let current;
  const Harness = () => {
    const audio = f.useMediaVolume(0.4); current = audio;
    const [fullscreen, setFullscreen] = useState(false);
    return React.createElement('div', null, React.createElement(f.MediaVolumeControl, { key: String(fullscreen), ...audio,
      label: 'Volume', muteLabel: 'Mute', unmuteLabel: 'Unmute', onVolumeChange: audio.changeVolume, onToggleMute: audio.toggleMute }),
      React.createElement('button', { id: 'fullscreen', onClick: () => setFullscreen(value => !value) }, 'Fullscreen'));
  };
  const slide = async value => act(async () => {
    const range = document.querySelector('input');
    Object.getOwnPropertyDescriptor(f.dom.window.HTMLInputElement.prototype, 'value').set.call(range, String(value));
    range.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
  });
  try {
    await act(async () => f.root.render(React.createElement(Harness)));
    assert.equal(document.querySelector('[role=group]').getAttribute('aria-label'), 'Volume');
    await act(async () => document.querySelector('button').click());
    assert.equal(document.querySelector('input').value, '0');
    assert.equal(document.querySelector('button').getAttribute('aria-label'), 'Unmute');
    await act(async () => document.getElementById('fullscreen').click());
    await act(async () => document.querySelector('button').click());
    assert.equal(document.querySelector('input').value, '40');
    await slide(0); await slide(65);
    assert.equal(current.volume, 0.65); assert.equal(current.muted, false);
    assert.equal(document.querySelector('input').getAttribute('aria-valuetext'), '65%');
  } finally { await f.cleanup(); }
});


test('page context actions operate the shared page and use the requesting client clipboard', async () => {
  const f = await fixture(); f.dom.window.matchMedia = () => ({ matches: true }); const commands = []; let clipboard = 'Local clipboard';
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { clipboard = text; }, readText: async () => clipboard } });
  const surface = { current: null };
  const model = { canControl: true, state: { active: 1, tabs: [{ id: 1, canBack: false, canForward: false }] }, contextMenu: null, consumeContextMenu() { this.contextMenu = null; }, command: command => commands.push(command) };
  const open = async key => {
    model.contextMenu = { id: key, tab: 1, x: 50, y: 60, link: 'https://example.com/', source: '', selection: 'Page selection', editable: true };
    await act(async () => f.root.render(React.createElement(f.ContextMenuProvider, null,
      React.createElement('div', { ref: surface, tabIndex: 0 }), React.createElement(f.BrowserContextMenu, { model, surface }))));
  };
  const select = async label => act(async () => [...document.querySelectorAll('[role=menuitem]')].find(button => button.textContent === f.t(label)).click());
  try {
    await open(1); assert.equal(document.querySelectorAll('[role=menu]').length, 1);
    await select('browser.context.open.link'); assert.deepEqual(commands.pop(), { kind: 'new-tab', url: 'https://example.com/' });
    await open(2); await select('browser.context.copyText'); assert.equal(clipboard, 'Page selection');
    clipboard = 'Local paste'; await open(3); await select('browser.context.paste'); assert.deepEqual(commands.pop(), { kind: 'text', text: 'Local paste' });
    await open(4); model.state.active = 2; await select('browser.reload'); assert.equal(commands.length, 0);
  } finally { await f.cleanup(); }
});


test('tab presentation waits for the selected capture and visible video frames rather than document loading', async () => {
  const f = await fixture(); const video = { current: null }; const stream = {}; let frame; let bright = false; let cancelled = 0;
  f.dom.window.HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray([bright ? 100 : 0, 0, 0, 255]) }) });
  const Harness = ({ tab, sampling }) => React.createElement('div', { 'data-waiting': f.useVideoPresentation(video, tab, stream, true, sampling) },
    React.createElement('video', { ref: video }));
  const render = (tab, sampling) => act(async () => f.root.render(React.createElement(Harness, { tab, sampling })));
  const waiting = () => document.querySelector('[data-waiting]').getAttribute('data-waiting');
  const present = async () => act(async () => frame());
  try {
    await render(1, false);
    Object.defineProperties(video.current, { readyState: { value: 2 }, videoWidth: { value: 1280 } });
    video.current.requestVideoFrameCallback = callback => { frame = callback; return 7; };
    video.current.cancelVideoFrameCallback = () => { cancelled++; };
    await render(1, true); await present(); await present(); assert.equal(waiting(), 'true');
    bright = true; await present(); assert.equal(waiting(), 'false');
    await render(2, false); assert.equal(waiting(), 'true');
    await render(2, true); await present(); assert.equal(waiting(), 'true');
    await present(); assert.equal(waiting(), 'false');
    await render(3, true); assert.ok(cancelled > 0);
  } finally { await f.cleanup(); }
});


test('local game capture forwards relative movement and releases on Escape, blur and ownership loss', async () => {
  const f = await fixture(); const commands = [];
  const surface = { current: null };
  Object.defineProperty(document, 'pointerLockElement', { configurable: true, writable: true, value: null });
  const change = () => document.dispatchEvent(new f.dom.window.Event('pointerlockchange'));
  f.dom.window.HTMLElement.prototype.requestPointerLock = function () { document.pointerLockElement = this; change(); return Promise.resolve(); };
  document.exitPointerLock = () => { document.pointerLockElement = null; change(); };
  const Harness = ({ enabled }) => { f.useBrowserPointerLock(surface, enabled, command => commands.push(command)); return React.createElement('div', { ref: surface }); };
  const render = enabled => act(async () => f.root.render(React.createElement(Harness, { enabled })));
  try {
    await render(true); assert.equal(document.pointerLockElement, surface.current);
    await act(async () => {
      const move = new f.dom.window.MouseEvent('mousemove', { bubbles: true });
      Object.defineProperties(move, { movementX: { value: 40 }, movementY: { value: -12 } });
      surface.current.dispatchEvent(move);
      await new Promise(resolve => window.requestAnimationFrame(resolve));
    });
    assert.deepEqual(commands.pop(), { kind: 'relative-mouse', dx: 40, dy: -12 });
    await act(async () => window.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    assert.equal(document.pointerLockElement, null); assert.equal(commands.at(-1).kind, 'release');
    await render(false); await render(true);
    await act(async () => window.dispatchEvent(new f.dom.window.Event('blur')));
    assert.equal(document.pointerLockElement, null); assert.equal(commands.at(-1).kind, 'release');
    await render(false); await render(true); await render(false);
    assert.equal(document.pointerLockElement, null); assert.equal(commands.at(-1).kind, 'release');
  } finally { await f.cleanup(); }
});
