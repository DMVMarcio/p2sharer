import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createBrowserRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';

const fixture = globalThis.webRouterFixture = { state: { roomSlots: [], currentRoomInvite: '' }, allow: false, exits: 0, leaves: 0, mounts: 0 };
const require = createRequire(import.meta.url);
const mocks = {
  appearance_preferences: 'export const isReducedMotion = () => false;',
  useAppTheme: 'export const useAppTheme = () => {};',
  useLocale: 'export const useLocale = () => {};',
  i18n: 'export const t = key => key; export const getLanguage = () => "en"; export const setLanguage = () => {};',
  language: 'export const LANGUAGE_OPTIONS = [];',
  Select: 'export const Select = () => null;',
  ContextMenu: 'export const ContextMenuProvider = ({children}) => children;',
  DownloadPanel: 'export const DownloadPanel = () => null;',
  AppContextMenu: 'export const AppContextMenu = ({children}) => children;',
  app_runtime: 'export const initializeAppRuntime = () => {};',
  state_store: 'export const stateStore = globalThis.webRouterFixture.state;',
  room_invite: 'export const parseRoomInvite = invite => invite ? {roomId: "a".repeat(32)} : null;',
  room_service: 'export const roomService = {leaveRoom: async () => { globalThis.webRouterFixture.leaves++; globalThis.webRouterFixture.state.roomSlots = []; }};',
  App: `import React from 'react';
    export default function App({webNavigation}) {
      React.useEffect(() => { globalThis.webRouterFixture.mounts++; return webNavigation.registerExit(async () => { globalThis.webRouterFixture.exits++; return globalThis.webRouterFixture.allow; }); }, [webNavigation]);
      return React.createElement('button', {onClick: () => {
        globalThis.webRouterFixture.state.roomSlots = [{}]; globalThis.webRouterFixture.state.currentRoomInvite = 'fixture';
        webNavigation.replace('/app/' + 'a'.repeat(32));
      }}, 'Join fixture');
    }`,
};
const bundle = await build({ stdin: { contents: `export { webRoutes } from './apps/web/router.tsx'; export { NavigationFeedback } from './apps/web/NavigationFeedback.tsx'; export { Component as WebApp } from './apps/web/AppPage.tsx';`, resolveDir: process.cwd() },
  bundle: true, write: false, format: 'esm', platform: 'node', jsx: 'automatic', loader: { '.css': 'empty', '.png': 'dataurl' },
  plugins: [{ name: 'web-fixtures', setup(builder) {
    builder.onResolve({ filter: /\/(appearance_preferences|useAppTheme|useLocale|i18n|language|Select|ContextMenu|DownloadPanel|AppContextMenu|app_runtime|state_store|room_invite|room_service|App)$/ }, args => ({ namespace: 'fixture', path: args.path.split('/').at(-1) }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: mocks[args.path], loader: 'js' }));
    builder.onResolve({ filter: /^[^./]/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
  } }] });
const { webRoutes, WebApp, NavigationFeedback } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

test('web routing reuses the site layout, loads the app on demand and protects active rooms', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://example.com/' });
  const old = {};
  for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node']) { old[key] = globalThis[key]; globalThis[key] = dom.window[key]; }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  window.scrollTo = () => {};
  let releaseApp; let paintFrame; let transitions = 0; let unloads = 0;
  // Control browser timers so slow test hosts cannot trigger the hidden-tab fallback.
  let timerId = 0;
  const timers = new Map();
  window.setTimeout = (callback, delay = 0) => { timers.set(++timerId, { callback, delay }); return timerId; };
  window.clearTimeout = id => timers.delete(id);
  const runTasks = () => {
    for (const [id, task] of [...timers]) if (task.delay === 0) { timers.delete(id); task.callback(); }
  };
  window.requestAnimationFrame = callback => { paintFrame = callback; return 1; };
  window.cancelAnimationFrame = () => {};
  window.addEventListener('beforeunload', () => { unloads++; });
  document.startViewTransition = update => {
    transitions++;
    const done = Promise.resolve().then(update);
    return { ready: Promise.resolve(), updateCallbackDone: done, finished: done, skipTransition() {} };
  };
  const originalDocument = document;
  const router = createBrowserRouter(webRoutes(() => new Promise(resolve => { releaseApp = () => resolve({ Component: WebApp }); })), { window });
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root'));
  const settle = async () => {
    await new Promise(resolve => setTimeout(resolve, 0)); runTasks();
    await new Promise(resolve => setTimeout(resolve, 0)); runTasks();
  };
  const click = element => act(async () => { element.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })); });
  try {
    await act(async () => root.render(React.createElement(React.Fragment, null, React.createElement(NavigationFeedback, { router }), React.createElement(RouterProvider, { router }))));
    assert.equal(document.activeElement, document.body, 'initial entry must not move focus to the page container');
    const header = document.querySelector('.site-header');
    const footer = document.querySelector('.site-footer');
    await click(document.querySelector('.site-actions .download-link'));
    assert.equal(router.state.location.pathname, '/download');
    assert.equal(transitions, 1, 'internal links request a complete browser view transition');
    assert.equal(document.querySelector('.site-header'), header);
    assert.equal(document.querySelector('.site-footer'), footer);
    assert.ok(document.querySelector('.site-download'));
    assert.equal(document.activeElement.id, 'content');
    await act(async () => { void router.navigate(-1); await settle(); });
    assert.ok(document.querySelector('.site-hero'));
    await click(document.querySelector('.site-actions a[href="/app"]'));
    assert.equal(router.state.navigation.state, 'loading');
    const status = document.querySelector('[role="status"]');
    assert.ok(status);
    assert.equal(status.closest('[aria-hidden="true"], [inert]'), null);
    assert.ok(document.querySelector('[role="progressbar"]'));
    assert.equal(releaseApp, undefined, 'feedback commits before the app module starts evaluating');
    await act(async () => { paintFrame(0); await settle(); });
    assert.equal(typeof releaseApp, 'function');
    assert.equal(document.querySelector('.site-header'), header);
    await act(async () => { releaseApp(); });
    assert.equal(router.state.location.pathname, '/app');
    assert.ok(document.documentElement.classList.contains('web-app'));
    assert.equal(fixture.mounts, 1);
    await click(document.querySelector('button'));
    assert.equal(router.state.location.pathname, '/app/' + 'a'.repeat(32));
    assert.equal(fixture.mounts, 1, 'room URL changes must preserve the mounted app');
    await act(settle);
    assert.equal(document.querySelector('iframe'), null, 'joining in the web app must not trigger a desktop handoff');
    await act(async () => { void router.navigate(-1); await settle(); });
    assert.equal(router.state.location.pathname, '/app/' + 'a'.repeat(32));
    assert.equal(fixture.exits, 1); assert.equal(fixture.leaves, 0);
    fixture.allow = true;
    await act(async () => { void router.navigate('/downloads'); });
    assert.equal(router.state.location.pathname, '/download');
    assert.equal(fixture.leaves, 1);
    assert.ok(document.documentElement.classList.contains('web-landing'));
    assert.ok(document.querySelector('.site-download'));
    assert.equal(document, originalDocument);
    assert.equal(unloads, 0, 'client navigation must not unload the document');
    const other = 'b'.repeat(32);
    await act(async () => { await router.navigate(`/app/${other}`); await settle(); });
    await act(settle);
    assert.equal(document.querySelector('iframe').src, `p2sharer://invite/${other}`);
    await act(async () => { await router.navigate('/app'); await settle(); });
    assert.equal(document.querySelector('iframe'), null, 'leaving an invitation cleans up its protocol frame');
  } finally {
    await act(async () => root.unmount()); router.dispose(); dom.window.close(); Object.assign(globalThis, old); delete globalThis.webRouterFixture;
  }
});
