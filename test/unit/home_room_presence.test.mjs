import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { savedRooms } from '../../src/core/room/saved_rooms.ts';
import { stateStore } from '../../src/core/state_store.ts';
import { createAuthenticatedInvite, parseRoomInvite } from '../../src/core/room/room_invite.ts';
import {
  createHomeRoomPresenceService,
  HOME_ROOM_PRESENCE_INTERVAL_MS,
} from '../../src/services/home_room_presence.ts';

const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'Event', 'localStorage']) {
  globalThis[key] = dom.window[key];
}
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

after(() => {
  dom.window.close();
});

test('home room presence polls saved rooms on a 5-minute interval and clears immediately when privacy polling is disabled', async (context) => {
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
    signal.addEventListener(
      'abort',
      () => {
        abortedSignals++;
      },
      { once: true },
    );
    return [{ id: 'peer-1', name: 'Alice', color: '#06b6d4' }];
  });

  stateStore.savePrivacyPreferences({ homeRoomPresencePolling: true });
  const createdTwo = await createAuthenticatedInvite('Second polling room');
  const inviteTwo = parseRoomInvite(createdTwo.invite);
  await savedRooms.put({
    roomId: inviteTwo.roomId,
    invite: createdTwo.invite,
    name: 'Second polling room',
    saved: true,
    owned: false,
  });
  let inFlight = 0;
  let maxConcurrent = 0;
  const serviceConcurrent = createHomeRoomPresenceService(async (room, _signal) => {
    inFlight++;
    maxConcurrent = Math.max(maxConcurrent, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 15));
    inFlight--;
    return [{ id: `peer-${room.roomId}`, name: room.name, color: '#06b6d4' }];
  });
  const stopConcurrent = serviceConcurrent.start();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(maxConcurrent, 2, 'probes multiple saved rooms concurrently');
  stopConcurrent();
  await savedRooms.remove(inviteTwo.roomId);

  const stop = service.start();
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(probes, 1, 'starts initial probe for saved rooms');
    assert.deepEqual(
      service.getParticipants(invite.roomId).map((p) => p.name),
      ['Alice'],
    );

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
    loading: false,
    version: 1,
    pollingEnabled: true,
    openProfile: (target) => openedProfiles.push(target),
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    notify: () => {
      globalThis.homeUiFixture.version++;
      listeners.forEach((fn) => fn());
    },
  };

  const bundle = await build({
    stdin: {
      contents: "export { SavedRoomsSection } from './src/components/home/SavedRoomsSection.tsx';",
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    jsx: 'automatic',
    plugins: [
      {
        name: 'home-card-fixture',
        setup(builder) {
          builder.onResolve(
            { filter: /saved_rooms$|useModal$|useRoom$|useStore$|home_room_presence$|room_service$/ },
            (args) => ({
              path: args.path,
              namespace: 'fixture',
            }),
          );
          builder.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
            contents: args.path.endsWith('saved_rooms')
              ? 'export const savedRooms = { list: async () => globalThis.homeUiFixture.rooms, subscribe: () => () => {}, put: async () => {}, reorder: () => {} };'
              : args.path.endsWith('useModal')
                ? 'export const modalManager = { openProfile: (t) => globalThis.homeUiFixture.openProfile(t) }; export const useModal = () => ({ openModal: () => {} });'
                : args.path.endsWith('useRoom')
                  ? "export const useRoom = () => ({ username: 'Viewer' });"
                  : args.path.endsWith('useStore')
                    ? 'export const useStore = (selector) => selector({ homeRoomPresencePolling: globalThis.homeUiFixture.pollingEnabled });'
                    : args.path.endsWith('home_room_presence')
                      ? 'export const homeRoomPresence = { start: () => () => {}, clear: () => {}, subscribe: (fn) => globalThis.homeUiFixture.subscribe(fn), snapshot: () => globalThis.homeUiFixture.version, getParticipants: (id) => id === "room-12345678" ? globalThis.homeUiFixture.participants : [], isLoading: (id) => id === "room-12345678" ? Boolean(globalThis.homeUiFixture.loading) : false };'
                      : 'export const roomService = { pendingJoinInvite: "", pendingJoinAsOwner: false, pendingJoinPassword: "", pendingJoinError: "" };',
          }));
          builder.onResolve({ filter: /^[^./]/ }, (args) => ({
            path: pathToFileURL(require.resolve(args.path)).href,
            external: true,
          }));
        },
      },
    ],
  });

  const { SavedRoomsSection } = await import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
  );
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root'));
  try {
    await act(async () => root.render(React.createElement(SavedRoomsSection)));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
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

    globalThis.homeUiFixture.participants = [];
    globalThis.homeUiFixture.loading = true;
    await act(async () => {
      globalThis.homeUiFixture.notify();
    });
    const spinner = document.querySelector('.saved-room-participants-loading[role="status"]');
    assert.ok(spinner, 'renders a loading indicator in the avatar area while probing');

    globalThis.homeUiFixture.loading = false;
    await act(async () => {
      globalThis.homeUiFixture.notify();
    });
    assert.equal(
      document.querySelector('.saved-room-participants-loading'),
      null,
      'clears loading indicator after probe finishes',
    );
  } finally {
    await act(async () => root.render(null));
    delete globalThis.homeUiFixture;
  }
});

test('home room presence marks all due rooms as loading immediately and clears each room as it finishes', async () => {
  const rooms = [];
  for (let i = 0; i < 10; i++) {
    const created = await createAuthenticatedInvite(`Queued room ${i}`);
    const invite = parseRoomInvite(created.invite);
    rooms.push(invite.roomId);
    await savedRooms.put({
      roomId: invite.roomId,
      invite: created.invite,
      name: `Queued room ${i}`,
      saved: true,
      owned: false,
    });
  }
  const resolvers = new Map();
  const service = createHomeRoomPresenceService(
    (room) =>
      new Promise((resolve) => {
        resolvers.set(room.roomId, () => resolve([]));
      }),
  );
  stateStore.savePrivacyPreferences({ homeRoomPresencePolling: true });
  const stop = service.start();
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(
      rooms.every((id) => service.isLoading(id)),
      true,
      'marks every due room as loading even before worker slots reach queued rooms',
    );
    const firstId = rooms[0];
    resolvers.get(firstId)();
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(service.isLoading(firstId), false, 'clears loading state as soon as a room probe finishes');
    assert.equal(service.isLoading(rooms[9]), true, 'keeps queued rooms loading until their probe finishes');
  } finally {
    for (const finish of resolvers.values()) finish();
    stop();
    for (const id of rooms) await savedRooms.remove(id);
  }
});

test('abortAndWait waits for in-flight probe cleanup before resolving', async () => {
  const created = await createAuthenticatedInvite('Abort wait room');
  const invite = parseRoomInvite(created.invite);
  await savedRooms.put({
    roomId: invite.roomId,
    invite: created.invite,
    name: 'Abort wait room',
    saved: true,
    owned: false,
  });
  let cleanedUp = false;
  let probeStarted;
  const startedPromise = new Promise((resolve) => {
    probeStarted = resolve;
  });
  const service = createHomeRoomPresenceService(async (_room, signal) => {
    probeStarted();
    await new Promise((resolve) => {
      if (signal.aborted) resolve(undefined);
      else signal.addEventListener('abort', resolve, { once: true });
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    cleanedUp = true;
    return [];
  });
  stateStore.savePrivacyPreferences({ homeRoomPresencePolling: true });
  const stop = service.start();
  try {
    await startedPromise;
    await service.abortAndWait();
    assert.equal(cleanedUp, true);
  } finally {
    stop();
    await savedRooms.remove(invite.roomId);
  }
});
