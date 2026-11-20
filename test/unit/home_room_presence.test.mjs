import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { savedRooms } from '../../src/core/saved_rooms.ts';
import { stateStore } from '../../src/core/state_store.ts';
import { createAuthenticatedInvite, parseRoomInvite } from '../../src/core/room_invite.ts';
import { createHomeRoomPresenceService, HOME_ROOM_PRESENCE_INTERVAL_MS } from '../../src/services/home_room_presence.ts';

const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'Event', 'localStorage']) {
  globalThis[key] = dom.window[key];
}
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

after(() => {
  dom.window.close();
});

test('home room presence polls saved rooms on a 5-minute interval and clears immediately when privacy polling is disabled', async context => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  const created = await createAuthenticatedInvite('Home polling room');
  const invite = parseRoomInvite(created.invite);
  await savedRooms.put({
    roomId: invite.roomId,
    invite: created.invite,
    name: 'Home polling room',
    saved: true,
    owned: false,
  });

  let probes = 0;
  let abortedSignals = 0;
  const service = createHomeRoomPresenceService(async (_room, signal) => {
    probes++;
    signal.addEventListener('abort', () => { abortedSignals++; }, { once: true });
    return [{ id: 'peer-1', name: 'Alice', color: '#06b6d4' }];
  });

  stateStore.savePrivacyPreferences({ homeRoomPresencePolling: true });
  const stop = service.start();
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(probes, 1, 'starts initial probe for saved rooms');
    assert.deepEqual(service.getParticipants(invite.roomId).map((p) => p.name), ['Alice']);

    assert.equal(HOME_ROOM_PRESENCE_INTERVAL_MS, 5 * 60 * 1000);
    context.mock.timers.tick(HOME_ROOM_PRESENCE_INTERVAL_MS);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(probes, 2, 're-polls once after 5 minutes');

    stateStore.savePrivacyPreferences({ homeRoomPresencePolling: false });
    assert.deepEqual(service.getParticipants(invite.roomId), [], 'clears cached members immediately when disabled');
    assert.equal(abortedSignals >= 0, true);

    context.mock.timers.tick(HOME_ROOM_PRESENCE_INTERVAL_MS);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(probes, 2, 'does not poll while disabled in privacy settings');
  } finally {
    stop();
    stateStore.savePrivacyPreferences({ homeRoomPresencePolling: true });
    await savedRooms.remove(invite.roomId);
  }
});

test('saved room cards show overlapping participant avatars at top-right and open profile on click', async () => {
  const require = createRequire(import.meta.url);
  const openedProfiles = [];
  let listeners = new Set();
  globalThis.homeUiFixture = {
    rooms: [{ roomId: 'room-12345678', invite: 'fixture-invite', name: 'Board Lounge', saved: true, owned: false }],
    participants: [
      { id: 'p1', name: 'Alice', color: '#06b6d4', avatar: 'data:image/png;base64,AA==' },
      { id: 'p2', name: 'Bob', color: '#f97316' },
    ],
    pollingEnabled: true,
    openProfile: (target) => openedProfiles.push(target),
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
  };

  const bundle = await build({
    stdin: { contents: "export { SavedRoomsSection } from './src/components/home/SavedRoomsSection.tsx';", resolveDir: process.cwd() },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    jsx: 'automatic',
    plugins: [{
      name: 'home-card-fixture',
      setup(builder) {
        builder.onResolve({ filter: /saved_rooms$|useModal$|useRoom$|useStore$|home_room_presence$|room_service$/ }, (args) => ({
          path: args.path,
          namespace: 'fixture',
        }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
          contents:
            args.path.endsWith('saved_rooms') ? 'export const savedRooms = { list: async () => globalThis.homeUiFixture.rooms, subscribe: () => () => {}, put: async () => {}, reorder: () => {} };' :
            args.path.endsWith('useModal') ? 'export const modalManager = { openProfile: (t) => globalThis.homeUiFixture.openProfile(t) }; export const useModal = () => ({ openModal: () => {} });' :
            args.path.endsWith('useRoom') ? "export const useRoom = () => ({ username: 'Viewer' });" :
            args.path.endsWith('useStore') ? 'export const useStore = (selector) => selector({ homeRoomPresencePolling: globalThis.homeUiFixture.pollingEnabled });' :
            args.path.endsWith('home_room_presence') ? 'export const homeRoomPresence = { start: () => () => {}, clear: () => {}, subscribe: (fn) => globalThis.homeUiFixture.subscribe(fn), snapshot: () => 1, getParticipants: (id) => id === "room-12345678" ? globalThis.homeUiFixture.participants : [] };' :
            'export const roomService = { pendingJoinInvite: "", pendingJoinAsOwner: false, pendingJoinPassword: "", pendingJoinError: "" };',
        }));
        builder.onResolve({ filter: /^[^./]/ }, (args) => ({
          path: pathToFileURL(require.resolve(args.path)).href,
          external: true,
        }));
      },
    }],
  });

  const { SavedRoomsSection } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root'));
  try {
    await act(async () => root.render(React.createElement(SavedRoomsSection)));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    const triggers = document.querySelectorAll('.saved-room-participants .room-app-participant-trigger');
    assert.equal(triggers.length, 2);
    assert.equal(triggers[0].getAttribute('aria-label'), 'Alice');
    await act(async () => triggers[0].click());
    assert.equal(openedProfiles.length, 1);
    assert.deepEqual(openedProfiles[0], {
      peerId: 'p1',
      name: 'Alice',
      color: '#06b6d4',
      imageUrl: 'data:image/png;base64,AA==',
      hideStats: true,
    });
  } finally {
    await act(async () => root.render(null));
    delete globalThis.homeUiFixture;
  }
});
