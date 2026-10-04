import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';

const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
for (const key of ['window', 'document', 'HTMLElement', 'localStorage']) globalThis[key] = dom.window[key];
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const require = createRequire(import.meta.url);
const bundle = await build({
  stdin: { contents: `export { RoomView } from './src/components/room/RoomView.tsx'; export { stateStore } from './src/core/state_store.ts';`, resolveDir: process.cwd() },
  bundle: true, write: false, format: 'esm', platform: 'node', jsx: 'automatic',
  plugins: [{ name: 'room-media-fixtures', setup(builder) {
    builder.onResolve({ filter: /services\/room_service/ }, () => ({ path: 'service', namespace: 'fixture' }));
    builder.onResolve({ filter: /\/(StreamHeaderBar|RoomVideoContainer|ChatFileRequests|ChatPane|ParticipantsPane)$/ }, args => ({ path: args.path.split('/').pop(), namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'service'
      ? 'export const roomService = new Proxy({ peers: [], subscribe: () => () => {} }, { get: (target, key) => key in target ? target[key] : () => {} });'
      : `export const ${args.path} = () => null;` }));
    builder.onResolve({ filter: /^[^./]/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
  } }],
});
const { RoomView, stateStore } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const { createRoot } = await import('react-dom/client');
const root = createRoot(document.getElementById('root'));
after(async () => { await act(async () => root.unmount()); dom.window.close(); });

test('collapsed chat shows an accessible counter and opening chat clears it', async () => {
  await act(async () => {
    stateStore.set(state => { state.isSidebarCollapsed = true; state.unreadChatMessages = 3; });
    root.render(React.createElement(RoomView));
  });
  const opener = document.getElementById('btn-sidebar-edge-toggle');
  assert.equal(opener.querySelector('[role="status"]').textContent, '3');
  assert.equal(opener.querySelector('[role="status"]').getAttribute('aria-label'), '3 mensagens não lidas');
  assert.ok(opener.parentElement.classList.contains('has-unread'));
  await act(async () => opener.click());
  assert.equal(stateStore.unreadChatMessages, 0);
  assert.equal(document.querySelector('.chat-unread-badge'), null);
});

test('opening participants retains unread messages until the chat tab is selected', async () => {
  await act(async () => stateStore.set(state => {
    state.isSidebarCollapsed = true; state.sidebarTab = 'participants'; state.unreadChatMessages = 120;
  }));
  assert.equal(document.querySelector('.chat-unread-badge').textContent, '99+');
  await act(async () => document.getElementById('btn-sidebar-edge-toggle').click());
  assert.equal(stateStore.unreadChatMessages, 120);
  assert.equal(document.getElementById('tab-btn-chat').querySelector('[role="status"]').textContent, '99+');
  await act(async () => document.getElementById('tab-btn-chat').click());
  assert.equal(stateStore.unreadChatMessages, 0);
  assert.equal(stateStore.sidebarTab, 'chat');
});
