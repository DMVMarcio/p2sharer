import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { verifyRoomInvite } from '../../src/core/room_invite_validation.ts';

const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'Event', 'CustomEvent', 'localStorage']) globalThis[key] = dom.window[key];
globalThis.getComputedStyle = window.getComputedStyle;
HTMLElement.prototype.scrollIntoView = () => {};
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const require = createRequire(import.meta.url);
let available = [];
let failInterfaces = false;
const records = [];
const joined = [];
globalThis.lanUiInvoke = async command => {
  assert.equal(command, 'list_lan_interfaces');
  if (failInterfaces) throw new Error('Fixture adapter enumeration failed');
  return available;
};
globalThis.lanUiSave = record => records.push(record);
globalThis.lanUiJoin = (...args) => joined.push(args);

const bundle = await build({
  stdin: { contents: `export { CreateRoomModal } from './src/components/modals/CreateRoomModal.tsx';`, resolveDir: process.cwd() },
  bundle: true, write: false, format: 'esm', platform: 'node', jsx: 'automatic',
  plugins: [{ name: 'lan-ui-fixture', setup(builder) {
    builder.onResolve({ filter: /useModal|useRoom|useToast|saved_rooms|@tauri-apps\/api\/core/ }, args => ({ path: args.path, namespace: 'lan-fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'lan-fixture' }, args => ({ contents:
      args.path.includes('useModal') ? 'export const useModal = () => ({ isClosing: false, closeModal() {} });' :
      args.path.includes('useRoom') ? 'export const useRoom = () => ({ joinRoom: (...args) => globalThis.lanUiJoin(...args) });' :
      args.path.includes('useToast') ? 'export const showToast = () => {};' :
      args.path.includes('saved_rooms') ? 'export const savedRooms = { put: async record => globalThis.lanUiSave(record) };' :
      'export const invoke = command => globalThis.lanUiInvoke(command);',
    }));
    builder.onResolve({ filter: /^[^./]/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
  } }],
});
const { CreateRoomModal } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const { createRoot } = await import('react-dom/client');
const root = createRoot(document.getElementById('root'));
let generation = 0;
async function mount() {
  await act(async () => { root.render(React.createElement(CreateRoomModal, { key: ++generation })); });
}
async function chooseLan() {
  await act(async () => { document.getElementById('create-room-connection').click(); });
  await act(async () => {
    [...document.querySelectorAll('[role="option"]')].find(option => option.textContent.includes('VPN')).click();
  });
}
after(async () => { await act(async () => root.unmount()); dom.window.close(); });

test('creation keeps internet P2P by default and signs a LAN invite using the detected virtual adapter', async () => {
  available = [
    { name: 'Ethernet fixture', address: '192.0.2.1' },
    { name: 'Radmin VPN fixture', address: '192.0.2.2' },
    { name: 'Radmin VPN fixture', address: '2001:db8::2' },
  ];
  await mount();
  assert.ok(document.getElementById('create-room-connection').textContent.includes('P2P'));
  assert.equal(document.getElementById('create-room-network'), null);
  await chooseLan();
  assert.ok(document.getElementById('create-room-network').textContent.includes('192.0.2.2'));
  assert.equal(document.querySelector('select'), null);
  assert.equal(document.getElementById('btn-confirm-create-dialog').disabled, false);
  await act(async () => { document.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); });
  for (let attempt = 0; attempt < 100 && joined.length === 0; attempt++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
  assert.equal(joined.length, 1);
  const invite = await verifyRoomInvite(joined[0][0]);
  assert.ok(invite && invite.version === 5);
  assert.equal(invite.connection.endpoint, 'ws://192.0.2.2:49154/');
  assert.equal(joined[0][2], true);
  assert.equal(records[0].invite, joined[0][0]);
});

test('LAN creation is disabled when no adapter is available or enumeration fails', async () => {
  available = [];
  await mount();
  await chooseLan();
  assert.equal(document.getElementById('btn-confirm-create-dialog').disabled, true);
  assert.ok(document.querySelector('[role="alert"]'));
  failInterfaces = true;
  await mount();
  await chooseLan();
  assert.equal(document.getElementById('btn-confirm-create-dialog').disabled, true);
  assert.ok(document.querySelector('[role="alert"]'));
});
