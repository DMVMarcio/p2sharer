import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { selfId } from '@trystero-p2p/core';

const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
for (const key of ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Element', 'Node', 'MutationObserver', 'CustomEvent', 'localStorage']) {
  globalThis[key] = dom.window[key];
}
globalThis.getComputedStyle = window.getComputedStyle;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
window.matchMedia = () => ({ matches: false });
HTMLElement.prototype.scrollIntoView = () => {};
const plays = new Map(), pauses = new Map(), loads = new Map();
const count = (map, element) => map.set(element, (map.get(element) || 0) + 1);
window.HTMLMediaElement.prototype.play = function () { count(plays, this); return Promise.resolve(); };
window.HTMLMediaElement.prototype.pause = function () { count(pauses, this); };
window.HTMLMediaElement.prototype.load = function () { count(loads, this); };
const actions = [];
const fixture = globalThis.frontendLifecycleFixture = {
  instances: [], sinks: new Map(), pip: new Set(),
  room: { roomSlots: [], chatMessages: [], layoutMode: 'grid', pinnedPeerId: null,
    streamFilter: 'all', username: 'Alice', isSpotlightTrayCollapsed: false,
    toggleSpotlightTray() {}, setStreamFilter() {}, togglePin() {}, returnToGrid() {},
    requestStream() {}, stopWatchingStream() {}, getPeerPing: () => 25,
    sendChatMessage() {}, editChatMessage: async () => true, deleteChatMessage: async () => true,
    offerFile() {}, requestFile() {}, requestFilePreview() {}, cancelFileTransfer() {},
    fileProgress: [], localFilePreviews: {}, imagePreviews: {}, savedDownloads: {}, revealSavedFile() {},
  },
  store: { subscribedStreams: new Set(), streamOverlays: {}, dismissedAutoOverlays: {},
    currentResolution: { width: 1920, height: 1080, label: '1080p' }, currentFps: 60, currentBitrate: 15000,
    localPreviewStreams: {}, isPeerInPip: id => fixture.pip.has(id), set: updater => updater(fixture.store),
  },
  copied: actions,
};
const mocks = {
  useRoom: 'export const useRoom = () => globalThis.frontendLifecycleFixture.room;',
  useStore: 'export const useStore = selector => selector(globalThis.frontendLifecycleFixture.store);',
  state: 'export const stateStore = globalThis.frontendLifecycleFixture.store;',
  service: 'export const roomService = { localCaptures: new Map(), requestStream() {}, stopTransmission: id => globalThis.frontendLifecycleFixture.copied.push(id), roomManager: null };',
  apps: `export const roomAppsService = { subscribe: () => () => {},
    getInstances: () => globalThis.frontendLifecycleFixture.instances, getJoinedInstances: () => [] };`,
  appCard: `import React from 'react'; export const RoomAppCard = ({ instance, style }) =>
    React.createElement('div', { className: 'room-app-card', 'data-instance': instance.id, style });`,
  audio: `export const audioContextManager = {
    attachPeerAudio: (id, stream) => globalThis.frontendLifecycleFixture.sinks.set(id, stream),
    getPeerVolumeState: () => ({ volume: 100, isMuted: false }), setPeerVolume() {} };`,
  pip: 'export const pipService = { updateStream() {}, restoreFromPip() {} };',
  pointer: 'export const useStreamPointer = () => ({ enabled: false, toggle() {}, toolbar: null, indicator: null });',
  modal: 'export const useModal = () => ({ openModal() {} }); export const modalManager = { open() {} };',
  toast: 'export const showToast = () => {};',
  files: 'export const useChatFileInput = () => ({ selectedFile: null, dragging: false, close() {}, markOffered() {}, pickFile() {} });',
  composer: `import React from 'react'; export const EmojiComposerInput = React.forwardRef((props, ref) => {
    React.useImperativeHandle(ref, () => ({ focus() {}, hasText: () => false }));
    return React.createElement('textarea', { 'aria-label': props['aria-label'] }); });`,
};
const names = { useRoom: 'useRoom', useStore: 'useStore', state_store: 'state', room_service: 'service',
  room_apps_service: 'apps', RoomAppCard: 'appCard', audio_context_manager: 'audio', pip_service: 'pip',
  useStreamPointer: 'pointer', useModal: 'modal', useToast: 'toast', useChatFileInput: 'files', EmojiComposerInput: 'composer' };
const require = createRequire(import.meta.url);
const bundle = await build({ stdin: { contents: `export { RoomVideoContainer } from './src/components/room/RoomVideoContainer.tsx';
export { ChatPane } from './src/components/room/ChatPane.tsx';
export { WatchersTooltipContent } from './src/components/room/WatchersTooltipContent.tsx';
export { ContextMenuProvider } from './src/components/common/ContextMenu.tsx';`, resolveDir: process.cwd() },
  bundle: true, write: false, format: 'esm', platform: 'node', jsx: 'automatic', loader: { '.css': 'empty' }, plugins: [{ name: 'fixtures', setup(builder) {
    builder.onResolve({ filter: /\/(useRoom|useStore|state_store|room_service|room_apps_service|RoomAppCard|audio_context_manager|pip_service|useStreamPointer|useModal|useToast|useChatFileInput|EmojiComposerInput)$/ }, args => ({
      namespace: 'fixture', path: names[args.path.split('/').at(-1)],
    }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: mocks[args.path], loader: 'js' }));
    builder.onResolve({ filter: /^[^./]/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
  } }] });
const { RoomVideoContainer, ChatPane, ContextMenuProvider, WatchersTooltipContent } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const { createRoot } = await import('react-dom/client');
const root = createRoot(document.getElementById('root'));
const render = async (Component = RoomVideoContainer) => act(async () => root.render(React.createElement(ContextMenuProvider, null, React.createElement(Component))));
const clear = async () => act(async () => root.render(null));
const stream = id => ({ id, getAudioTracks: () => [], getVideoTracks: () => [{ id: `${id}-video`, readyState: 'live' }] });
const slot = (id, name = id) => ({ peerId: id, senderName: name, color: '#abcdef', isLocal: false, isStreaming: true, stream: stream(id) });
const card = id => document.querySelector(`[data-peer-id="${id}"]`);
const video = id => card(id)?.querySelector('video');
const reset = async slots => {
  await clear();
  fixture.room.roomSlots = slots;
  fixture.room.layoutMode = 'grid'; fixture.room.streamFilter = 'all'; fixture.room.pinnedPeerId = null;
  fixture.store.subscribedStreams = new Set(slots.map(entry => entry.peerId));
  fixture.store.localPreviewStreams = {}; fixture.pip.clear();
  await render();
};
after(async () => { await clear(); await act(async () => root.unmount()); dom.window.close(); });

test('stream controls place volume before pointing and distinguish interface visibility from window pinning', async () => {
  await reset([slot('controls')]);
  const controls = card('controls').querySelector('.stream-controls-group');
  assert.ok(controls.querySelector('.stream-volume-controller').compareDocumentPosition(controls.querySelector('[aria-label="Apontar na transmissão"]')) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
  assert.ok(controls.querySelector('.btn-stream-pin .lucide-panels-top-left'));
});

test('viewer identity badge remains correct when two participants share a username', async () => {
  await clear();
  await act(async () => root.render(React.createElement(WatchersTooltipContent, { watchers: [
    { peerId: 'other', username: 'Same name', isSelf: false }, { peerId: 'self', username: 'Same name', isSelf: true },
  ] })));
  const rows = [...document.querySelectorAll('.watchers-tooltip-item')];
  assert.equal(rows[0].querySelector('.badge-you'), null);
  assert.equal(rows[1].querySelector('.badge-you').textContent, 'VOCÊ');
});

test('the grid stop control ends only its own local transmission without changing the layout', async () => {
  const local = { ...slot('local/camera'), isLocal: true, mediaId: 'camera-session', mediaKind: 'camera' };
  await reset([local, slot('other')]);
  const button = card(local.peerId).querySelector('.btn-stop-watch-stream');
  assert.ok(button);
  const count = actions.length;
  await act(async () => button.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
  assert.deepEqual(actions.slice(count), ['camera-session']);
  assert.equal(fixture.room.layoutMode, 'grid');
});

test('React keeps video nodes and decoders stable across repeated updates, sibling churn and reordering', async () => {
  const first = slot('first'), second = slot('second');
  await reset([first, second]);
  const firstVideo = video('first'), secondVideo = video('second');
  const playCount = plays.get(firstVideo);
  for (let i = 0; i < 50; i++) { fixture.room.roomSlots = [{ ...first, senderName: `Name ${i}` }, second]; await render(); }
  assert.equal(video('first'), firstVideo);
  assert.equal(plays.get(firstVideo), playCount);
  assert.equal(pauses.get(firstVideo), undefined);
  const third = slot('third'); fixture.store.subscribedStreams.add('third');
  fixture.room.roomSlots = [third, second, first]; await render();
  assert.equal(video('first'), firstVideo); assert.equal(video('second'), secondVideo);
  fixture.room.roomSlots = [second, first]; await render();
  assert.equal(video('first'), firstVideo); assert.equal(video('second'), secondVideo);
});

test('stream replacement updates the existing video and unsubscription releases only that decoder', async () => {
  const first = slot('first'), second = slot('second'); await reset([first, second]);
  const original = video('first'), unaffected = video('second');
  const replacement = stream('replacement');
  fixture.room.roomSlots = [{ ...first, stream: replacement }, second]; await render();
  assert.equal(video('first'), original); assert.equal(original.srcObject, replacement);
  assert.equal(pauses.get(original), undefined); assert.equal(loads.get(original), undefined);
  fixture.store.subscribedStreams.delete('first'); await render();
  assert.equal(video('first'), null); assert.equal(original.srcObject, null);
  assert.equal(pauses.get(original), 1); assert.equal(loads.get(original), 1);
  assert.equal(video('second'), unaffected);
});

test('only the active layout owns videos, the selected tray uses a placeholder, and teardown releases all nodes', async () => {
  await reset([slot('first'), slot('second')]);
  for (let i = 0; i < 10; i++) {
    fixture.room.layoutMode = 'spotlight'; fixture.room.pinnedPeerId = 'first'; await render();
    assert.equal(document.querySelectorAll('video').length, 2);
    assert.equal(document.querySelector('.streams-grid-wrapper').children.length, 0);
    assert.equal(document.querySelector('.spotlight-tray-strip [data-peer-id="first"] video'), null);
    fixture.room.layoutMode = 'grid'; await render();
    assert.equal(document.querySelectorAll('video').length, 2);
    assert.equal(document.querySelector('.spotlight-stage').children.length, 0);
  }
  const nodes = [...document.querySelectorAll('video')]; await clear();
  for (const node of nodes) { assert.equal(node.srcObject, null); assert.equal(pauses.get(node), 1); assert.equal(loads.get(node), 1); }
});

test('React escapes participant names and preserves native preview and external-window placeholders', async () => {
  const name = '<img id="injected" src="x" onerror="alert(1)">';
  await reset([{ ...slot('local', name), isLocal: true, mediaKind: 'screen' }]);
  assert.equal(video('local'), null);
  assert.ok(card('local').textContent.includes(name)); assert.equal(document.getElementById('injected'), null);
  fixture.store.localPreviewStreams.local = true; await render();
  const preview = video('local'); assert.ok(preview);
  fixture.pip.add('local'); await render();
  assert.equal(video('local'), null); assert.equal(preview.srcObject, null);
  assert.ok(card('local').querySelector('.pip-broadcaster-placeholder'));
  fixture.pip.delete('local'); await render(); assert.ok(video('local'));
});

test('Strict Mode probes retain active media and final unmount releases the video', async () => {
  await clear(); fixture.room.roomSlots = [slot('strict')]; fixture.store.subscribedStreams.add('strict');
  await act(async () => root.render(React.createElement(React.StrictMode, null, React.createElement(RoomVideoContainer))));
  const node = video('strict'); assert.ok(node); assert.equal(node.srcObject, fixture.room.roomSlots[0].stream);
  await clear(); assert.equal(node.srcObject, null); assert.ok(loads.get(node) > 0);
});

test('registered app slots retain the same app node across grid and spotlight placement', async () => {
  await clear(); fixture.room.roomSlots = []; fixture.instances = [];
  fixture.room.layoutMode = 'grid';
  const originalMeasure = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function () {
    const left = this.dataset.roomAppRole === 'featured' ? 30 : 10;
    return { left, top: 20, right: left + 200, bottom: 120, width: 200, height: 100, x: left, y: 20 };
  };
  try {
    await render();
    fixture.instances = [{ id: 'notes', kind: 'notepad' }]; await render();
    const app = document.querySelector('[data-instance="notes"]'); assert.ok(app);
    assert.equal(app.style.width, '200px'); assert.equal(app.style.visibility, '');
    fixture.room.layoutMode = 'spotlight'; fixture.room.pinnedPeerId = 'app:notes'; await render();
    assert.equal(document.querySelector('[data-instance="notes"]'), app);
    assert.equal(app.style.left, '20px');
    fixture.room.layoutMode = 'grid'; await render();
    assert.equal(document.querySelector('[data-instance="notes"]'), app); assert.equal(app.style.left, '0px');
  } finally { fixture.instances = []; HTMLElement.prototype.getBoundingClientRect = originalMeasure; await clear(); }
});

test('message right-click and dots share actions, including editor exclusions and menu keyboard focus', async () => {
  await clear();
  fixture.room.chatMessages = [{ id: 'message', authorId: 'remote', sender: '<b>Sender</b>', text: 'Hello', timestamp: Date.now() }];
  await render(ChatPane);
  const message = document.querySelector('.chat-msg');
  await act(async () => message.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 30 })));
  const labels = () => [...document.querySelectorAll('[role="menuitem"]')].map(button => button.textContent);
  assert.deepEqual(labels(), ['Responder', 'Copiar Texto']);
  assert.equal(document.activeElement.textContent, 'Responder');
  await act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })));
  assert.equal(document.activeElement.textContent, 'Copiar Texto');
  await act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  await act(async () => document.querySelector('.chat-msg-menu-trigger').click());
  assert.deepEqual(labels(), ['Responder', 'Copiar Texto']);
  assert.ok(document.querySelector('.chat-msg-sender').textContent.includes('<b>Sender</b>'));
  assert.equal(document.querySelector('.chat-msg-sender b'), null);
  await clear(); fixture.room.chatMessages[0].authorId = selfId; await render(ChatPane);
  await act(async () => document.querySelector('.chat-msg-menu-trigger').click());
  assert.deepEqual(labels(), ['Responder', 'Copiar Texto', 'Editar', 'Excluir']);
  await act(async () => [...document.querySelectorAll('[role="menuitem"]')].find(button => button.textContent === 'Editar').click());
  await act(async () => new Promise(resolve => setTimeout(resolve, 280)));
  const editor = document.querySelector('.chat-msg textarea'); assert.ok(editor);
  await act(async () => editor.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
  assert.equal(labels().includes('Responder'), false);
});
