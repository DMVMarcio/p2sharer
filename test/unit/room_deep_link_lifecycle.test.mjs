import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createAuthenticatedInvite } from '../../src/core/room_invite.ts';
import { roomInviteLink } from '../../src/core/room_deep_links.ts';

test('the production listener handles startup, live delivery, profile setup and cleanup without joining', async () => {
  const first = (await createAuthenticatedInvite('Startup fixture')).invite;
  const second = (await createAuthenticatedInvite('Live fixture')).invite;
  const listeners = new Set();
  const notify = () => listeners.forEach(fn => fn());
  let handler;
  let stopCount = 0;
  let current = [roomInviteLink(first)];
  const opened = [];
  const fixture = globalThis.deepLinkFixture = {
    store: { username: '', roomSlots: [], currentRoomInvite: '', subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); } },
    modal: { active: 'username', getActive() { return this.active; }, open(value) { this.active = value; opened.push(value); notify(); },
      subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); } },
    service: { pendingJoinInvite: '', pendingJoinPassword: 'old', pendingJoinAsOwner: true, pendingJoinError: 'old',
      connectingOverlay: { visible: false }, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); } },
    async onOpenUrl(fn) { handler = fn; return () => { stopCount++; }; },
    onRead: () => {},
    async getCurrent() { fixture.onRead(); return current; },
  };
  const require = createRequire(import.meta.url);
  try {
    const bundle = await build({ entryPoints: ['src/services/room_deep_links.ts'], bundle: true, write: false,
      format: 'esm', platform: 'node', plugins: [{ name: 'native-boundary', setup(builder) {
        builder.onResolve({ filter: /^(?:@tauri-apps\/api\/core|@tauri-apps\/plugin-deep-link)$|(?:state_store|useModal|useToast|room_service)\.ts$/ }, args => ({ path: args.path, namespace: 'fixture' }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents:
          args.path.endsWith('/core') ? 'export const isTauri = () => true;' :
          args.path.endsWith('plugin-deep-link') ? 'export const { getCurrent, onOpenUrl } = globalThis.deepLinkFixture;' :
          args.path.endsWith('state_store.ts') ? 'export const stateStore = globalThis.deepLinkFixture.store;' :
          args.path.endsWith('useModal.ts') ? 'export const modalManager = globalThis.deepLinkFixture.modal;' :
          args.path.endsWith('useToast.ts') ? 'export const showToast = () => {};' :
          'export const roomService = globalThis.deepLinkFixture.service;',
        }));
        builder.onResolve({ filter: /^[^./]/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
      } }] });
    const { startRoomDeepLinks } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
    const settle = async () => { for (let index = 0; index < 20; index++) await new Promise(resolve => setTimeout(resolve, 10)); };
    const stop = startRoomDeepLinks();
    await settle();
    assert.deepEqual(opened, []);
    fixture.store.username = 'Viewer';
    notify();
    assert.deepEqual(opened, [], 'profile setup must finish closing before showing a room');
    fixture.modal.active = null;
    notify();
    handler([roomInviteLink(first)]);
    await settle();
    assert.deepEqual(opened, ['joinRoom']);
    assert.equal(fixture.service.pendingJoinInvite, first);
    assert.equal(fixture.service.pendingJoinPassword, '');
    assert.equal(fixture.service.pendingJoinAsOwner, false);
    handler([roomInviteLink(first)]);
    fixture.modal.active = null;
    notify();
    await settle();
    assert.equal(opened.length, 1, 'repeated delivery during preview must not reopen a dismissed invite');
    handler([roomInviteLink(second)]);
    await settle();
    assert.equal(fixture.service.pendingJoinInvite, second);
    assert.equal(opened.length, 2);
    fixture.modal.active = null; notify();
    const short = 'a'.repeat(32);
    handler([roomInviteLink(short)]);
    await settle();
    assert.equal(fixture.service.pendingJoinInvite, short, 'short deep links open the canonical discovery preview');
    assert.equal(opened.length, 3);
    handler([roomInviteLink(short)]);
    await settle(); assert.equal(opened.length, 3);
    stop();
    assert.equal(stopCount, 1);
    assert.equal(listeners.size, 0);
    fixture.modal.active = null;
    handler([roomInviteLink(first)]);
    await settle();
    assert.equal(opened.length, 3, 'a disposed subscription cannot open dialogs');

    // A live event received while reading the startup URL supersedes that snapshot.
    fixture.onRead = () => handler([roomInviteLink(second)]);
    current = [roomInviteLink(first)];
    const stopAgain = startRoomDeepLinks();
    await settle();
    assert.equal(fixture.service.pendingJoinInvite, second);
    stopAgain();
  } finally { delete globalThis.deepLinkFixture; }
});
