import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';

test('room exit requires consent, persists before leaving, and retains the session on save failure', async () => {
  const fixture = globalThis.roomExitFixture = {
    state: { currentRoomInvite: 'invite', currentRoomCode: 'code' },
    record: { roomId: 'room', saved: false, identity: { privateKey: 'synthetic' } },
    writes: [], errors: [], fail: false,
  };
  const require = createRequire(import.meta.url);
  const bundle = await build({
    stdin: { contents: "export { useRoomExit } from './src/hooks/useRoomExit';", resolveDir: process.cwd() },
    bundle: true, write: false, format: 'esm', platform: 'node',
    plugins: [{ name: 'exit-fixture', setup(builder) {
      builder.onResolve({ filter: /core\/state_store$/ }, () => ({ path: 'state', namespace: 'fixture' }));
      builder.onResolve({ filter: /core\/room_invite$/ }, () => ({ path: 'invite', namespace: 'fixture' }));
      builder.onResolve({ filter: /core\/saved_rooms$/ }, () => ({ path: 'rooms', namespace: 'fixture' }));
      builder.onResolve({ filter: /useToast$/ }, () => ({ path: 'toast', namespace: 'fixture' }));
      builder.onResolve({ filter: /i18n$/ }, () => ({ path: 'locale', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: {
        state: 'export const stateStore = globalThis.roomExitFixture.state;',
        invite: 'export const parseRoomInvite = value => value ? { roomId: "room" } : null;',
        rooms: `export const savedRooms = { get: async () => globalThis.roomExitFixture.record, put: async record => {
          const f = globalThis.roomExitFixture; if (f.fail) throw new Error('Synthetic failure'); f.writes.push(record); f.record = record;
        } };`,
        toast: 'export const showToast = message => globalThis.roomExitFixture.errors.push(message);',
        locale: 'export const t = key => key;',
      }[path] }));
      builder.onResolve({ filter: /^[^./]/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
    } }],
  });
  const { useRoomExit } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
  const dom = new JSDOM('<div id="root"></div>');
  for (const key of ['window', 'document', 'HTMLElement']) globalThis[key] = dom.window[key];
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root'));
  let exit;
  function Harness() { exit = useRoomExit(); return null; }
  await act(async () => root.render(React.createElement(Harness)));
  const request = async () => { let result; await act(async () => { result = exit.confirmExit(); }); return { result }; };
  try {
    let requestResult = await request();
    assert.equal(exit.pending, true);
    assert.equal(await exit.confirmExit(), false, 'duplicate requests cannot bypass consent');
    await act(async () => exit.decide(null));
    assert.equal(await requestResult.result, false);
    requestResult = await request();
    await act(async () => exit.decide(false));
    assert.equal(await requestResult.result, true);
    assert.equal(fixture.writes.length, 0);
    requestResult = await request();
    await act(async () => exit.decide(true));
    assert.equal(await requestResult.result, true);
    assert.equal(fixture.record.saved, true);
    assert.deepEqual(fixture.writes[0].identity, { privateKey: 'synthetic' });
    let savedResult;
    await act(async () => { savedResult = await exit.confirmExit(); });
    assert.equal(savedResult, true, 'saved rooms exit immediately');
    fixture.record.saved = false; fixture.fail = true;
    requestResult = await request();
    const warn = console.warn;
    try { console.warn = () => {}; await act(async () => exit.decide(true)); } finally { console.warn = warn; }
    assert.equal(await requestResult.result, false);
    assert.equal(fixture.errors.length, 1);
    fixture.fail = false;
    requestResult = await request();
    fixture.state.currentRoomInvite = 'different';
    await act(async () => exit.decide(true));
    assert.equal(await requestResult.result, false, 'consent belongs to the original room');
  } finally { await act(async () => root.unmount()); dom.window.close(); delete globalThis.roomExitFixture; }
});
