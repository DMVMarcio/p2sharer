import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';

test('page copy writes the local clipboard and hardware changes restart only after explicit confirmation', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const keys = ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Element', 'Node', 'MutationObserver', 'localStorage', 'navigator', 'Event', 'CustomEvent', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT'];
  const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of keys.slice(0, 12)) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.matchMedia = () => ({ matches: false });
  HTMLElement.prototype.scrollIntoView = () => {};
  const copied = []; let restarts = 0; const commands = [];
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { copied.push(text); } } });
  const model = { state: { tabs: [{ id: 1, title: 'Fixture', url: 'https://example.com/' }], active: 1, temporary: false },
    isHost: true, host: 'local', hostOnline: true, running: true, canControl: true, canStart: false, busy: false,
    hardwareAcceleration: true, extensions: [], media: null, stream: null, pointer: null, controller: '', activity: null,
    command: command => commands.push(command), setLocalVolume: async () => {}, manageExtensions: async () => {},
    copy: async () => 'Shared selection', configureHardwareAcceleration: enabled => { model.hardwareAcceleration = enabled; },
    restart: async () => { restarts++; },
  };
  globalThis.browserSettingsFixture = model;
  let root;
  try {
    const require = createRequire(import.meta.url);
    const bundle = await build({ stdin: { contents: "export { BrowserApp } from './src/apps/BrowserApp'; export { t } from './src/i18n';", resolveDir: process.cwd() },
      bundle: true, write: false, format: 'esm', platform: 'node', loader: { '.css': 'empty' }, plugins: [{ name: 'browser-ui-boundaries', setup(builder) {
        const mocks = {
          room_apps_service: 'export const roomAppsService = { subscribe: () => () => {}, getModel: () => globalThis.browserSettingsFixture, getLocalActor: () => "local" };',
          useRoom: 'export const useRoom = () => ({ peers: [], username: "Local" });',
          useToast: 'export const showToast = error => { throw new Error(error); };',
        };
        builder.onResolve({ filter: /\/(room_apps_service|useRoom|useToast)$/ }, args => ({ namespace: 'fixture', path: args.path.split('/').at(-1) }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: mocks[args.path], loader: 'js' }));
        builder.onResolve({ filter: /^[^./]/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
      } }] });
    const { BrowserApp, t } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
    const { createRoot } = await import('react-dom/client'); root = createRoot(document.getElementById('root'));
    await act(async () => root.render(React.createElement(BrowserApp, { instanceId: 'fixture' })));
    const keyboard = document.querySelector('.browser-keyboard');
    await act(async () => {
      keyboard.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'c', code: 'KeyC', ctrlKey: true, bubbles: true, cancelable: true }));
      keyboard.dispatchEvent(new window.KeyboardEvent('keyup', { key: 'c', code: 'KeyC', ctrlKey: true, bubbles: true, cancelable: true }));
    });
    assert.deepEqual(copied, ['Shared selection']);
    assert.equal(commands.some(command => command.kind === 'key' && command.code === 'KeyC'), false);
    const click = async element => { assert.ok(element); await act(async () => element.click()); };
    await click(document.querySelector(`[aria-label="${t('browser.settings')}"]`));
    const hardwareSwitch = () => document.querySelector(`input[type="checkbox"][aria-label="${t('browser.hardwareAcceleration')}"]`);
    assert.equal(hardwareSwitch().checked, true);
    await click(hardwareSwitch());
    assert.equal(hardwareSwitch().checked, false);
    assert.equal(model.hardwareAcceleration, false); assert.equal(restarts, 0);
    await click([...document.querySelectorAll('button')].find(button => button.textContent === t('browser.restartLater')));
    assert.equal(restarts, 0);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 400)); });
    await click(hardwareSwitch());
    assert.equal(hardwareSwitch().checked, true);
    assert.equal(model.hardwareAcceleration, true);
    assert.equal(restarts, 0);
    await click([...document.querySelectorAll('button')].find(button => button.textContent === t('browser.restartNow')));
    assert.equal(restarts, 1);
  } finally {
    if (root) await act(async () => root.unmount()); dom.window.close(); Reflect.deleteProperty(globalThis, 'browserSettingsFixture');
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
