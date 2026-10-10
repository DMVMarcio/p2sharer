import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';

const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'Event', 'localStorage']) globalThis[key] = dom.window[key];
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const require = createRequire(import.meta.url);
let revision = 0;
const listeners = new Set();
let closed = 0;
let left = 0;
const joined = [];
let discovery;
let ready = Promise.resolve();
globalThis.previewUi = {
  roomService: { pendingJoinInvite: 'saved-fixture', pendingJoinPassword: 'remembered-fixture', pendingJoinAsOwner: true,
    pendingJoinError: '',
    joinOutcome: 'admitted', joinError: '', roomStatusText: 'Connecting',
    async joinRoom(...args) { joined.push(args); }, async leaveRoom() { left++; } },
  store: { username: 'Viewer', getTurnConfig: () => undefined },
  subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); }, snapshot: () => revision,
  close: () => closed++,
  discover: callbacks => { discovery = callbacks; return ready; }, release: () => left++,
};
const bundle = await build({ stdin: { contents: "export { JoinRoomModal } from './src/components/modals/JoinRoomModal.tsx';", resolveDir: process.cwd() },
  bundle: true, write: false, format: 'esm', platform: 'node', jsx: 'automatic',
  plugins: [{ name: 'preview-fixture', setup(builder) {
    builder.onResolve({ filter: /useModal$|useRoom$|room_service$|state_store$|group_room$|room_invite_validation$/ }, args => ({ path: args.path, namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents:
      args.path.endsWith('useModal') ? 'export const useModal = () => ({ closeModal: globalThis.previewUi.close });' :
      args.path.endsWith('useRoom') ? "import { useSyncExternalStore } from 'react'; export const useRoom = () => { useSyncExternalStore(globalThis.previewUi.subscribe, globalThis.previewUi.snapshot); return globalThis.previewUi.roomService; };" :
      args.path.endsWith('room_service') ? 'export const roomService = globalThis.previewUi.roomService;' :
      args.path.endsWith('state_store') ? 'export const stateStore = globalThis.previewUi.store;' :
      args.path.endsWith('group_room') ? 'export class GroupRoomManager { join(callbacks) { return globalThis.previewUi.discover(callbacks); } requestPreview() {} async leave() { globalThis.previewUi.release(); } }' :
      "export const verifyRoomInvite = async () => ({ version: 4, roomId: 'fixture', name: 'Fixture room' });",
    }));
    builder.onResolve({ filter: /^[^./]/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
  } }],
});
const { JoinRoomModal } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const { createRoot } = await import('react-dom/client');
const root = createRoot(document.getElementById('root'));
async function submit() {
  await act(async () => { document.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); });
}
async function outcome(state, error = '') {
  await act(async () => { Object.assign(previewUi.roomService, { joinOutcome: state, joinError: error }); revision++; listeners.forEach(fn => fn()); });
}
after(async () => { await act(async () => root.unmount()); dom.window.close(); delete globalThis.previewUi; });

test('a saved room previews people and keeps connection and password errors in the dialog until admitted', async () => {
  await act(async () => root.render(React.createElement(JoinRoomModal)));
  assert.ok(document.querySelector('[role="dialog"]'));
  assert.equal(joined.length, 0);
  assert.equal(document.getElementById('join-room-password'), null,
    'a remembered password must not expose the field before protection is confirmed');
  await act(async () => discovery.onPreview({ name: 'Online room', protected: false,
    participants: [{ id: 'host', name: 'Host', color: '#06b6d4' }] }));
  assert.equal(document.getElementById('join-room-password'), null,
    'an unprotected room must not request a password');
  await act(async () => discovery.onPreview({ name: 'Online room', protected: true,
    participants: [{ id: 'host', name: 'Host', color: '#06b6d4' }] }));
  assert.ok(document.querySelector('li').textContent.includes('Host'));
  assert.equal(document.getElementById('join-room-password').value, 'remembered-fixture');
  await submit();
  assert.equal(closed, 0, 'an old admission result must not close a new attempt');
  assert.equal(joined.length, 1);
  assert.deepEqual(joined[0], ['saved-fixture', 'remembered-fixture', true, { waitForAdmission: true }]);
  assert.equal(document.querySelector('button[type="submit"]').disabled, true);
  await outcome('error', 'Senha incorreta para esta sala');
  assert.ok(document.querySelector('[role="alert"]'));
  assert.equal(document.getElementById('join-room-password').disabled, false);
  assert.equal(closed, 0);
  await submit();
  assert.equal(joined.length, 2);
  await outcome('admitted');
  assert.equal(closed, 1);
  await act(async () => root.render(null));
});

test('unmount during discovery releases the connection after initialization without joining', async () => {
  Object.assign(previewUi.roomService, { pendingJoinInvite: 'another-fixture', pendingJoinAsOwner: false });
  let resolve;
  ready = new Promise(done => { resolve = done; });
  const before = left;
  await act(async () => root.render(React.createElement(JoinRoomModal)));
  await act(async () => root.render(null));
  assert.equal(left, before);
  await act(async () => { resolve(); await ready; });
  assert.equal(left, before + 1);
  assert.equal(joined.length, 2);
});

test('an unanswered discovery allows immediate entry and closes on local waiting readiness', async () => {
  ready = Promise.resolve();
  Object.assign(previewUi.roomService, { pendingJoinInvite: 'empty-fixture', pendingJoinPassword: '',
    pendingJoinAsOwner: false, pendingJoinError: '', joinOutcome: 'admitted' });
  const before = closed;
  await act(async () => root.render(React.createElement(JoinRoomModal)));
  assert.equal(document.getElementById('join-room-password'), null);
  assert.equal(document.querySelector('button[type="submit"]').disabled, false,
    'participant discovery must not disable joining after invite validation');
  await submit();
  assert.deepEqual(joined.at(-1), ['empty-fixture', '', false, { waitForAdmission: false }]);
  assert.equal(closed, before);
  await outcome('waiting');
  assert.equal(closed, before + 1);
  await act(async () => root.render(null));
});

test('a deferred password rejection resumes the same dialog without another discovery delay', async () => {
  Object.assign(previewUi.roomService, { pendingJoinInvite: 'protected-fixture', pendingJoinPassword: 'wrong-fixture',
    pendingJoinAsOwner: false, pendingJoinError: 'Senha incorreta para esta sala', joinOutcome: 'error' });
  const before = closed;
  await act(async () => root.render(React.createElement(JoinRoomModal)));
  assert.ok(document.querySelector('[role="alert"]'));
  assert.equal(document.getElementById('join-room-password').value, 'wrong-fixture');
  await submit();
  assert.deepEqual(joined.at(-1), ['protected-fixture', 'wrong-fixture', false, { waitForAdmission: true }]);
  assert.equal(closed, before);
  await outcome('admitted');
  await act(async () => root.render(null));
});
