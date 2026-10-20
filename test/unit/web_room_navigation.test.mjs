import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { createAuthenticatedInvite, parseRoomInvite } from '../../src/core/room_invite.ts';
import { extractWebRoomCode, roomCodeFromPath, webRoomPath } from '../../src/core/web_room_links.ts';

test('web room URLs accept complete short codes and omit secrets or unsupported routes', () => {
  const id = 'a'.repeat(32);
  assert.equal(webRoomPath(id), `/app/${id}`);
  assert.equal(webRoomPath('short'), '/app');
  assert.equal(roomCodeFromPath(`/app/${id}/`), id);
  assert.equal(extractWebRoomCode(`https://example.com/app/${id}`), id);
  const credentialUrl = new URL(`https://example.com/app/${id}`);
  credentialUrl.username = 'fixture';
  assert.equal(extractWebRoomCode(credentialUrl.href), null);
  for (const value of [`javascript:/app/${id}`, 'https://example.com/app/12345678', `https://example.com/other/${id}`]) assert.equal(extractWebRoomCode(value), null);
});

test('room URLs defer preview for profile setup, survive remounts and preserve exit consent', async () => {
  const { invite } = await createAuthenticatedInvite('Web navigation fixture');
  const id = parseRoomInvite(invite).roomId;
  const dom = new JSDOM('', { url: `https://example.com/app/${id}` });
  const old = { window: globalThis.window, history: globalThis.history };
  globalThis.window = dom.window; globalThis.history = dom.window.history;
  const listeners = new Set(); const notify = () => listeners.forEach(fn => fn()); const opened = [];
  const subscribe = fn => { listeners.add(fn); return () => listeners.delete(fn); };
  const fixture = globalThis.webNavigationFixture = {
    state: { username: '', roomSlots: [], currentRoomInvite: '', subscribe },
    modal: { active: 'username', getActive() { return this.active; }, open(value) { this.active = value; opened.push(value); notify(); }, subscribe },
    service: { pendingJoinInvite: '', connectingOverlay: { visible: false }, subscribe,
      async leaveRoom() { fixture.state.roomSlots = []; fixture.state.currentRoomInvite = ''; notify(); } },
  };
  const bundle = await build({ entryPoints: ['src/services/web_room_navigation.ts'], bundle: true, write: false, platform: 'node', format: 'esm', plugins: [{ name: 'web-navigation-boundaries', setup(builder) {
    builder.onResolve({ filter: /^@tauri-apps\/api\/core$|(?:state_store|useModal|room_service)\.ts$/ }, args => ({ path: args.path, namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents:
      path.endsWith('/core') ? 'export const isTauri = () => false;' :
      path.endsWith('state_store.ts') ? 'export const stateStore = globalThis.webNavigationFixture.state;' :
      path.endsWith('useModal.ts') ? 'export const modalManager = globalThis.webNavigationFixture.modal;' :
      'export const roomService = globalThis.webNavigationFixture.service;' }));
  } }] });
  const { startWebRoomNavigation } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text + '\n//# sourceURL=web-navigation-test.js').toString('base64')}`);
  let allow = false; let stop = startWebRoomNavigation(async () => allow);
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  try {
    assert.deepEqual(opened, []);
    fixture.state.username = 'Viewer'; notify(); assert.deepEqual(opened, []);
    fixture.modal.active = null; notify();
    assert.deepEqual(opened, ['joinRoom']); assert.equal(fixture.service.pendingJoinInvite, id);
    stop(); stop = startWebRoomNavigation(async () => allow);
    fixture.modal.active = null; notify(); assert.equal(opened.length, 1, 'remount must not reopen a canceled preview');
    fixture.state.currentRoomInvite = invite; fixture.state.roomSlots = [{}]; notify();
    assert.equal(window.location.pathname, `/app/${id}`);
    history.pushState(null, '', '/app'); window.dispatchEvent(new window.PopStateEvent('popstate')); await settle();
    assert.equal(window.location.pathname, `/app/${id}`); assert.equal(fixture.state.roomSlots.length, 1);
    allow = true; history.pushState(null, '', '/app'); window.dispatchEvent(new window.PopStateEvent('popstate')); await settle();
    assert.equal(window.location.pathname, '/app'); assert.equal(fixture.state.roomSlots.length, 0);
    assert.equal(opened.length, 1);

    stop();
    const replacements = [];
    let routeChanged; let exitGuard;
    history.replaceState({ idx: 7 }, '', '/app');
    stop = startWebRoomNavigation(async () => allow, {
      replace: path => { replacements.push(path); history.replaceState(history.state, '', path); },
      subscribe: listener => { routeChanged = listener; return () => { routeChanged = null; }; },
      registerExit: callback => { exitGuard = callback; return () => { exitGuard = null; }; },
    });
    assert.equal(await exitGuard(), true);
    fixture.state.currentRoomInvite = invite; fixture.state.roomSlots = [{}]; notify();
    assert.deepEqual(replacements, [`/app/${id}`]);
    assert.equal(history.state.idx, 7, 'room updates must preserve the router history index');
    fixture.state.roomSlots = []; notify();
    assert.equal(window.location.pathname, '/app');
    history.pushState({ idx: 8 }, '', `/app/${id}`); routeChanged(); await settle();
    assert.equal(opened.length, 2, 'router notifications use the canonical room preview');
    stop(); assert.equal(routeChanged, null); assert.equal(exitGuard, null);
  } finally { stop(); assert.equal(listeners.size, 0); dom.window.close(); Object.assign(globalThis, old); delete globalThis.webNavigationFixture; }
});
