import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act, useState } from 'react';

async function fixture() {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const keys = ['window', 'document', 'HTMLElement', 'Element', 'Node', 'IS_REACT_ACT_ENVIRONMENT'];
  const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of keys.slice(0, -1)) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const require = createRequire(import.meta.url);
  const bundle = await build({ stdin: { contents: "export { useBrowserChrome } from './src/hooks/useBrowserChrome'; export { useMediaVolume } from './src/hooks/useMediaVolume'; export { MediaVolumeControl } from './src/components/common/MediaVolumeControl';", resolveDir: process.cwd() },
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
