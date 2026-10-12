import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { selfId } from '@trystero-p2p/core';

const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
for (const key of ['window', 'document', 'HTMLElement', 'Element', 'localStorage']) globalThis[key] = dom.window[key];
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = () => ({ matches: false });
const record = { roomId: 'room-one', name: 'Original name', customName: 'My saved room', saved: true, owned: true, password: 'secret' };
const writes = [];
const fixture = globalThis.fileOfferSavedRoomFixture = {
  records: [record], listeners: new Set(), actions: [],
  async put(room) { writes.push(room); this.records = [room]; this.listeners.forEach(listener => listener()); },
};
const mocks = {
  rooms: `export const savedRooms = {
    list: async () => globalThis.fileOfferSavedRoomFixture.records,
    subscribe: (listener) => { const set = globalThis.fileOfferSavedRoomFixture.listeners; set.add(listener); return () => set.delete(listener); },
    put: (room) => globalThis.fileOfferSavedRoomFixture.put(room), reorder: () => {},
  };`,
  useRoom: 'export const useRoom = () => ({ username: "Alice", joinRoom: () => {}, fileProgress: globalThis.fileOfferSavedRoomFixture.progress ?? {}, cancelFileTransfer: () => {}, dismissFileProgress: () => {}, revealSavedFile: async () => {} });',
  service: 'export const roomService = {};',
  menu: 'export const useContextMenu = () => (event, actions) => { event.preventDefault(); globalThis.fileOfferSavedRoomFixture.actions = actions; };',
  editing: 'export const EditSavedRoomDialog = () => null;',
  sorting: 'export const useSortableGrid = (ids) => ({ order: ids, draggingId: null, gridRef: null, cardRef: () => null, handleProps: () => ({}) });',
  toast: 'export const showToast = () => {};',
};
const require = createRequire(import.meta.url);
const bundle = await build({ stdin: { contents: `export { ChatFileOfferDialog } from './src/components/room/ChatFileOfferDialog.tsx';
export { ChatFileAttachment } from './src/components/room/ChatFileAttachment.tsx';
export { ChatTransferCenter } from './src/components/room/ChatTransferCenter.tsx';
export { SavedRoomsSection } from './src/components/home/SavedRoomsSection.tsx';`, resolveDir: process.cwd() },
  bundle: true, write: false, format: 'esm', platform: 'node', jsx: 'automatic', plugins: [{ name: 'fixture', setup(builder) {
    builder.onResolve({ filter: /saved_rooms$|useRoom$|room_service$|ContextMenu$|EditSavedRoomDialog$|useSortableGrid$|useToast$/ }, args => ({
      namespace: 'fixture', path: args.path.endsWith('saved_rooms') ? 'rooms' : args.path.endsWith('useRoom') ? 'useRoom' :
        args.path.endsWith('room_service') ? 'service' : args.path.endsWith('ContextMenu') ? 'menu' :
        args.path.endsWith('EditSavedRoomDialog') ? 'editing' : args.path.endsWith('useSortableGrid') ? 'sorting' : 'toast',
    }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: mocks[args.path] }));
    builder.onResolve({ filter: /^[^./]/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
  } }] });
const { ChatFileOfferDialog, ChatFileAttachment, SavedRoomsSection, ChatTransferCenter } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const { createRoot } = await import('react-dom/client');
const root = createRoot(document.getElementById('root'));
const render = async element => { await act(async () => root.render(element)); };
const click = async element => { assert.ok(element); await act(async () => element.click()); };
const settleExit = async () => { await act(async () => new Promise(resolve => setTimeout(resolve, 260))); };

test('each file initializes image acceptance independently and still permits manual overrides', async () => {
  const offers = [];
  const show = async (id, name, isImage) => render(React.createElement(ChatFileOfferDialog, {
    key: id, file: { id, name, isImage, size: 12, hash: 'hash' }, onClose: () => {},
    onOffer: async (...args) => { offers.push(args); },
  }));
  for (const extension of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']) {
    await show(extension, `photo.${extension}`, true);
    assert.equal(document.querySelector('[aria-label="Aceitar solicitações"]').checked, true);
  }
  await click(document.querySelector('[aria-label="Aceitar solicitações"]'));
  await click([...document.querySelectorAll('button')].find(button => button.textContent === 'Anexar'));
  assert.deepEqual(offers.at(-1), ['photo.bmp', false]);
  await show('document', 'report.pdf', false);
  assert.equal(document.querySelector('[aria-label="Aceitar solicitações"]').checked, false);
  await click(document.querySelector('[aria-label="Aceitar solicitações"]'));
  await show('archive', 'files.zip', false);
  assert.equal(document.querySelector('[aria-label="Aceitar solicitações"]').checked, false);
});

test('saved room removal requires confirmation through the card and context menu; cancel and Escape preserve it', async () => {
  await render(React.createElement(SavedRoomsSection));
  await click(document.querySelector('.saved-room-remove'));
  assert.deepEqual(writes, []);
  assert.ok(document.querySelector('[role="dialog"]').textContent.includes('My saved room'));
  assert.equal(document.activeElement.textContent, 'Cancelar');
  await click([...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent === 'Cancelar'));
  await settleExit();
  assert.equal(document.querySelector('[role="dialog"]'), null); assert.deepEqual(writes, []);
  await click(document.querySelector('.saved-room-remove'));
  await act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await settleExit(); assert.deepEqual(writes, []);
  await act(async () => document.querySelector('.saved-room-card').dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
  await act(async () => fixture.actions.find(action => action.id === 'remove').onSelect());
  assert.deepEqual(writes, []);
  await click([...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent === 'Remover'));
  await settleExit();
  assert.equal(writes.length, 1); assert.equal(writes[0].saved, false);
  assert.equal(writes[0].password, undefined); assert.equal(writes[0].owned, true);
  assert.equal(document.querySelector('.saved-room-card'), null);
});

test('own sent images expose Save and Save As while own non-image files retain their existing actions', async () => {
  const requests = [];
  const props = { message: { id: 'my-image', authorId: selfId, file: { name: 'clipboard.png', size: 12, sha256: 'a'.repeat(64), isImage: true } },
    transfers: [], preview: 'data:image/png;base64,AA==', speedUnit: 'MBps', onRequest: saveAs => requests.push(saveAs),
    onPreview: () => {}, onCancel: () => {}, onReveal: () => {} };
  await render(React.createElement(ChatFileAttachment, props));
  await click(document.querySelector('[aria-label="Baixar"]'));
  await click([...document.querySelectorAll('.chat-file-download-menu button')].find(button => button.textContent === 'Salvar'));
  await settleExit();
  await click(document.querySelector('[aria-label="Baixar"]'));
  await click([...document.querySelectorAll('.chat-file-download-menu button')].find(button => button.textContent === 'Salvar Como'));
  assert.deepEqual(requests, [false, true]);
  await render(React.createElement(ChatFileAttachment, { ...props, message: { ...props.message,
    file: { ...props.message.file, name: 'report.pdf', isImage: false } } }));
  assert.equal(document.querySelector('[aria-label="Baixar"]'), null);
});

test('transfer menus keep diagnostics in a keyboard-accessible hint beside the speed', async () => {
  const originalFrame = globalThis.requestAnimationFrame;
  const originalCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = callback => setTimeout(() => callback(Date.now()), 16);
  globalThis.cancelAnimationFrame = clearTimeout;
  fixture.progress = Object.fromEntries(['send', 'receive'].map(direction => [direction, {
    requestId: direction, messageId: 'fixture-file', direction, status: 'active',
    fileName: 'example.bin', peerName: 'Peer', bytes: 512, total: 1024, bytesPerSecond: 1000000,
    connectionType: 'P2P Direto', rttMs: 25,
    transport: { channelLabel: 'chat_file_bulk_v1', protocol: 'udp', localCandidateType: 'srflx', remoteCandidateType: 'srflx', pairBytesPerSecond: 1000000 },
    timings: { readMs: 100, prepareMs: 100, wireMs: 100, verifyMs: 100, writeMs: 100, ackMs: 100 },
  }]));
  try {
    await render(React.createElement(ChatTransferCenter));
    for (const direction of ['send', 'receive']) {
      await click(document.querySelector(`[aria-label="${direction === 'send' ? 'Envios' : 'Downloads'}"]`));
      const item = document.querySelector('.chat-transfer-item');
      assert.ok(item.textContent.includes('50%'));
      assert.ok(item.textContent.includes('512 B'));
      assert.ok(item.textContent.includes('MB/s'));
      assert.ok(!item.textContent.includes('WebRTC'));
      assert.ok(!item.textContent.includes('25 ms'));
      const hint = item.querySelector('[aria-label="Detalhes da transferência"]');
      await act(async () => {
        document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
        hint.focus();
      });
      await act(async () => new Promise(resolve => setTimeout(resolve, 120)));
      const tooltip = document.querySelector('[role="tooltip"]');
      assert.ok(tooltip);
      for (const detail of ['P2P', '25 ms', 'Canal dedicado', 'UDP', 'srflx → srflx', 'WebRTC']) {
        assert.ok(tooltip.textContent.includes(detail), detail);
      }
      assert.ok(tooltip.textContent.includes(direction === 'send' ? 'Preparação' : 'Verificação'));
      if (direction === 'receive') assert.ok(tooltip.textContent.includes('ACK'));
      await act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
      await settleExit();
    }
  } finally {
    await render(null); delete fixture.progress;
    globalThis.requestAnimationFrame = originalFrame;
    globalThis.cancelAnimationFrame = originalCancel;
  }
});

after(async () => { await act(async () => root.unmount()); dom.window.close(); delete globalThis.fileOfferSavedRoomFixture; });
