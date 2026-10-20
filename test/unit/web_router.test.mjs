import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';

const fixture = globalThis.webRouterFixture = { state: { roomSlots: [], currentRoomInvite: '' }, allow: false, exits: 0, leaves: 0, mounts: 0 };
const require = createRequire(import.meta.url);
const mocks = {
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
const bundle = await build({ stdin: { contents: `export { webRoutes } from './apps/web/router.tsx'; export { Component as WebApp } from './apps/web/AppPage.tsx';`, resolveDir: process.cwd() },
  bundle: true, write: false, format: 'esm', platform: 'node', jsx: 'automatic', loader: { '.css': 'empty', '.png': 'dataurl' },
  plugins: [{ name: 'web-fixtures', setup(builder) {
    builder.onResolve({ filter: /\/(useAppTheme|useLocale|i18n|language|Select|ContextMenu|DownloadPanel|AppContextMenu|app_runtime|state_store|room_invite|room_service|App)$/ }, args => ({ namespace: 'fixture', path: args.path.split('/').at(-1) }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: mocks[args.path], loader: 'js' }));
    builder.onResolve({ filter: /^[^./]/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
  } }] });
const { webRoutes, WebApp } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

test('web routing reuses the site layout, loads the app on demand and protects active rooms', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://example.com/' });
  const old = {};
  for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node']) { old[key] = globalThis[key]; globalThis[key] = dom.window[key]; }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  window.scrollTo = () => {};
  let releaseApp;
  const router = createMemoryRouter(webRoutes({ lazy: () => new Promise(resolve => { releaseApp = () => resolve({ Component: WebApp }); }) }));
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root'));
  const click = element => act(async () => { element.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })); });
  try {
    await act(async () => root.render(React.createElement(RouterProvider, { router })));
    const header = document.querySelector('.site-header');
    const footer = document.querySelector('.site-footer');
    await click(document.querySelector('.site-actions .download-link'));
    assert.equal(router.state.location.pathname, '/download');
    assert.equal(document.querySelector('.site-header'), header);
    assert.equal(document.querySelector('.site-footer'), footer);
    assert.ok(document.querySelector('.site-download'));
    assert.equal(document.activeElement.id, 'content');
    await act(async () => { await router.navigate(-1); });
    assert.ok(document.querySelector('.site-hero'));
    await click(document.querySelector('.site-actions a[href="/app"]'));
    assert.equal(router.state.navigation.state, 'loading');
    assert.ok(document.querySelector('[role="status"]'));
    assert.equal(document.querySelector('.site-header'), header);
    await act(async () => { releaseApp(); });
    assert.equal(router.state.location.pathname, '/app');
    assert.ok(document.documentElement.classList.contains('web-app'));
    assert.equal(fixture.mounts, 1);
    await click(document.querySelector('button'));
    assert.equal(router.state.location.pathname, '/app/' + 'a'.repeat(32));
    assert.equal(fixture.mounts, 1, 'room URL changes must preserve the mounted app');
    await act(async () => { void router.navigate(-1); });
    assert.equal(router.state.location.pathname, '/app/' + 'a'.repeat(32));
    assert.equal(fixture.exits, 1); assert.equal(fixture.leaves, 0);
    fixture.allow = true;
    await act(async () => { void router.navigate('/downloads'); });
    assert.equal(router.state.location.pathname, '/download');
    assert.equal(fixture.leaves, 1);
    assert.ok(document.documentElement.classList.contains('web-landing'));
    assert.ok(document.querySelector('.site-download'));
    assert.equal(window.location.href, 'https://example.com/', 'client navigation must not load another document');
  } finally {
    await act(async () => root.unmount()); router.dispose(); dom.window.close(); Object.assign(globalThis, old); delete globalThis.webRouterFixture;
  }
});
