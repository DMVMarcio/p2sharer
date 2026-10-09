import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';

const browser = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' });
for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'CustomEvent', 'localStorage']) globalThis[key] = browser.window[key];
globalThis.getComputedStyle = window.getComputedStyle;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
globalThis.cancelAnimationFrame = clearTimeout;
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
window.matchMedia = () => ({ matches: false });
window.HTMLMediaElement.prototype.play = () => Promise.resolve();
window.HTMLMediaElement.prototype.pause = () => {};
window.HTMLMediaElement.prototype.load = () => {};
const require = createRequire(import.meta.url);
const bundle = await build({ stdin: { contents: `
export * from './src/components/room/RoomVideoContainer.tsx';
export * from './src/components/common/ContextMenu.tsx';
export { StreamHeaderBar } from './src/components/room/StreamHeaderBar.tsx';
export { stateStore } from './src/core/state_store.ts';
export { roomService } from './src/services/room_service.ts';
export { audioContextManager } from './src/audio/audio_context_manager.ts';
export { roomAppsService } from './src/apps/room_apps_service.ts';
`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm', platform: 'node', jsx: 'automatic',
  loader: { '.css': 'empty', '.png': 'dataurl' }, plugins: [{ name: 'packages', setup(builder) {
    builder.onResolve({ filter: /^[^./]/ }, (args) => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
  } }] });
const { RoomVideoContainer, StreamHeaderBar, ContextMenuProvider, stateStore, roomService, audioContextManager, roomAppsService } =
  await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
audioContextManager.attachPeerAudio = () => ({ volume: 100, isMuted: false });
audioContextManager.getPeerVolumeState = () => ({ volume: 100, isMuted: false });
const { createRoot } = await import('react-dom/client');
const root = createRoot(document.getElementById('root'));
const stream = (id) => ({ id, getVideoTracks: () => [{ id: `${id}-track`, getSettings: () => ({ width: 1920, height: 1080 }) }], getAudioTracks: () => [] });
const slot = (owner, id, kind) => ({ peerId: `${owner}/${id}`, ownerPeerId: owner, mediaId: id, mediaKind: kind,
  mediaLabel: kind, senderName: owner, isLocal: false, isStreaming: true, stream: stream(id), color: '#5599ff', pointerEligible: false });
const screen = slot('owner', 'screen', 'screen');
const camera = slot('owner', 'camera', 'camera');
const other = slot('other', 'screen', 'screen');
const render = async (mode = 'spotlight', featured = screen.peerId) => {
  await act(async () => {
    stateStore.set((state) => { state.layoutMode = mode; state.pinnedPeerId = featured; });
    root.render(React.createElement(ContextMenuProvider, null, React.createElement(RoomVideoContainer)));
  });
};
test('transmission menu edits sources, stops only the chosen source, and starts another capture', async () => {
  const stopped = [];
  const original = roomService.stopTransmission;
  roomService.stopTransmission = (id) => stopped.push(id);
  try {
    await act(async () => {
      stateStore.set((state) => { state.roomSlots = [{ ...screen, isLocal: true }, { ...camera, isLocal: true }, other]; });
      root.render(React.createElement(ContextMenuProvider, null, React.createElement(StreamHeaderBar)));
    });
    assert.equal(document.querySelector('#label-share-screen').textContent, 'Transmissão');
    assert.equal(document.querySelector('.transmission-stop-menu'), null);
    await act(async () => document.querySelector('#btn-toggle-share-screen').click());
    const actions = [...document.querySelectorAll('[role="menuitem"]')];
    assert.equal(actions.length, 5);
    assert.equal(document.querySelectorAll('.context-menu-row').length, 2);
    await act(async () => document.querySelector('[aria-label="Parar camera"]').click());
    assert.deepEqual(stopped, ['camera']);
    assert.equal(stateStore.editingStreamId, null);
    await act(async () => document.querySelector('#btn-toggle-share-screen').click());
    await act(async () => [...document.querySelectorAll('.context-menu-row > button:first-child')].find((button) => button.textContent === 'camera').click());
    assert.equal(stateStore.editingStreamId, 'camera');
    await act(async () => document.querySelector('#btn-toggle-share-screen').click());
    await act(async () => [...document.querySelectorAll('[role="menuitem"]')].find((button) => button.textContent === 'Iniciar nova transmissão').click());
    assert.equal(stateStore.editingStreamId, null);
    assert.deepEqual(stopped, ['camera']);
  } finally { roomService.stopTransmission = original; }
});

after(async () => { await act(async () => root.unmount()); browser.window.close(); });

test('room cards share order across modes, retain independent sizes, and preserve keyed videos', async () => {
  const prototype = window.HTMLElement.prototype;
  const previousWidth = Object.getOwnPropertyDescriptor(prototype, 'clientWidth');
  const previousHeight = Object.getOwnPropertyDescriptor(prototype, 'clientHeight');
  Object.defineProperty(prototype, 'clientWidth', { configurable: true, get() { return 1200; } });
  Object.defineProperty(prototype, 'clientHeight', { configurable: true, get() { return 800; } });
  const ids = [screen.peerId, camera.peerId, other.peerId];
  const frames = () => [...document.querySelectorAll('.streams-grid-wrapper [data-sortable-id]')];
  const width = id => frames().find(frame => frame.dataset.sortableId === id).style.width;
  try {
    stateStore.set(state => { state.roomSlots = [screen, camera, other]; state.subscribedStreams = new Set(ids); });
    await render('spotlight');
    await render('grid');
    const video = document.querySelector(`[data-sortable-id="${screen.peerId}"] video`);
    const otherWidth = width(other.peerId);
    const initialWidth = width(screen.peerId);
    await act(async () => frames()[0].dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, shiftKey: true, bubbles: true })));
    const resizedWidth = width(screen.peerId);
    assert.ok(parseFloat(resizedWidth) > parseFloat(initialWidth));
    assert.equal(width(other.peerId), otherWidth);
    const handle = frames()[0];
    handle.focus();
    await act(async () => handle.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, bubbles: true })));
    assert.deepEqual(frames().map(frame => frame.dataset.sortableId), [camera.peerId, screen.peerId, other.peerId]);
    assert.equal(document.querySelector(`[data-sortable-id="${screen.peerId}"] video`), video);
    assert.equal(document.activeElement, handle);
    await render('spotlight');
    assert.deepEqual([...document.querySelectorAll('.spotlight-tray-strip [data-sortable-id]')].map(frame => frame.dataset.sortableId),
      [camera.peerId, screen.peerId, other.peerId]);
    await act(async () => document.querySelector('.spotlight-tray-strip [data-sortable-id]').dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, bubbles: true })));
    await render('grid');
    assert.deepEqual(frames().map(frame => frame.dataset.sortableId), ids);
    assert.equal(width(screen.peerId), resizedWidth);
    await act(async () => frames()[0].querySelector('.stream-card').dispatchEvent(
      new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 80, clientY: 80 })));
    await act(async () => [...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent === 'Restaurar layout automático').click());
    assert.equal(width(screen.peerId), initialWidth);
  } finally {
    if (previousWidth) Object.defineProperty(prototype, 'clientWidth', previousWidth);
    else delete prototype.clientWidth;
    if (previousHeight) Object.defineProperty(prototype, 'clientHeight', previousHeight);
    else delete prototype.clientHeight;
  }
});

test('body drag previews an empty destination, preserves one player, cancels cleanly, and borders resize', async () => {
  const prototype = window.HTMLElement.prototype;
  const previous = new Map(['clientWidth', 'clientHeight', 'getBoundingClientRect', 'setPointerCapture', 'hasPointerCapture', 'releasePointerCapture']
    .map(key => [key, Object.getOwnPropertyDescriptor(prototype, key)]));
  Object.defineProperty(prototype, 'clientWidth', { configurable: true, get() { return 1200; } });
  Object.defineProperty(prototype, 'clientHeight', { configurable: true, get() { return 800; } });
  const rectangle = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height,
    x: left, y: top, toJSON() {} });
  prototype.getBoundingClientRect = function () {
    if (this.matches('[data-sortable-id], .room-app-card')) {
      return rectangle(parseFloat(this.style.left) || 0, parseFloat(this.style.top) || 0,
        parseFloat(this.style.width) || 160, parseFloat(this.style.height) || 90);
    }
    const frame = this.closest('[data-sortable-id]');
    if (frame) return frame.getBoundingClientRect();
    return rectangle(0, 0, 1200, 800);
  };
  let captured = false;
  prototype.setPointerCapture = () => { captured = true; };
  prototype.hasPointerCapture = () => captured;
  prototype.releasePointerCapture = () => { captured = false; };
  const pointer = (type, target, x, y) => {
    const event = new window.Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { pointerId: 17, button: 0, clientX: x, clientY: y });
    target.dispatchEvent(event);
  };
  const frame = id => document.querySelector(`[data-sortable-id="${id}"]`);
  const videoCount = () => document.querySelectorAll('.streams-grid-wrapper video').length;
  const appId = '00000000-0000-4000-8000-000000000017';
  try {
    stateStore.set(state => { state.currentRoomCode = 'gesture-fixture'; state.roomSlots = [screen, camera, other]; state.subscribedStreams = new Set([screen.peerId, camera.peerId, other.peerId]); });
    await render('grid');
    const active = frame(screen.peerId);
    const video = active.querySelector('video');
    const original = active.getBoundingClientRect();
    const target = frame(camera.peerId).getBoundingClientRect();
    const startX = original.left + original.width / 2, startY = original.top + original.height / 2;
    await act(async () => pointer('pointerdown', video, startX, startY));
    await act(async () => pointer('pointermove', window, startX + 2, startY + 1));
    assert.equal(document.querySelector('.room-card-placeholder'), null);
    await act(async () => pointer('pointermove', window, target.left + 20, target.top + target.height / 2));
    const placeholder = document.querySelector('.room-card-placeholder');
    assert.ok(placeholder);
    assert.equal(placeholder.children.length, 0);
    assert.equal(videoCount(), 3);
    assert.equal(active.querySelector('video'), video);
    assert.notEqual(active.style.left, `${original.left}px`);
    await act(async () => window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', cancelable: true })));
    assert.equal(document.querySelector('.room-card-placeholder'), null);
    assert.equal(active.style.left, `${original.left}px`);
    assert.equal(captured, false);
    await act(async () => pointer('pointerdown', video, startX, startY));
    await act(async () => pointer('pointermove', window, 600, 799));
    const destinationTop = document.querySelector('.room-card-placeholder').style.top;
    await act(async () => pointer('pointerup', window, 600, 799));
    assert.equal(active.style.top, destinationTop);
    assert.equal(active.querySelector('video'), video);
    assert.equal(videoCount(), 3);
    await act(async () => video.click());
    assert.equal(stateStore.layoutMode, 'grid');
    const before = parseFloat(active.style.width);
    const rect = active.getBoundingClientRect();
    await act(async () => pointer('pointerdown', active.querySelector('[data-room-resize="s"]'), rect.left + rect.width / 2, rect.bottom));
    await act(async () => pointer('pointermove', window, rect.left + rect.width / 2, rect.bottom + 40));
    assert.ok(parseFloat(active.style.width) > before);
    await act(async () => pointer('pointercancel', window, 0, 0));
    assert.equal(parseFloat(active.style.width), before);
    // Persistent app content receives the same body gesture without a second rendered app.
    await act(async () => roomAppsService.initializeLocalView({ id: appId, kind: 'notepad', createdBy: 'fixture', createdAt: 0 }));
    const app = document.querySelector(`.room-app-card[data-peer-id="app:${appId}"]`);
    const appRect = app.getBoundingClientRect();
    await act(async () => pointer('pointerdown', app.querySelector('svg'), appRect.left + 20, appRect.top + 20));
    await act(async () => pointer('pointermove', window, 20, 400));
    assert.ok(document.querySelector('.room-card-placeholder'));
    assert.equal(document.querySelectorAll('.room-app-card').length, 1);
    assert.equal(document.querySelector('.room-app-card'), app);
    assert.equal(parseFloat(app.style.left), parseFloat(frame(`app:${appId}`).style.left));
    await act(async () => pointer('pointercancel', window, 0, 0));
  } finally {
    await act(async () => { roomAppsService.stop(appId); stateStore.set(state => { state.currentRoomCode = ''; }); });
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(prototype, key, descriptor);
      else delete prototype[key];
    }
  }
});

test('late audio in a stable video container reaches the canonical audio sink', async () => {
  const calls = [];
  const original = audioContextManager.attachPeerAudio;
  audioContextManager.attachPeerAudio = (_key, stream) => { calls.push(stream.getAudioTracks().length); return { volume: 100, isMuted: false }; };
  const tracks = [];
  const stable = { ...slot('late-owner', 'late-screen', 'screen') };
  stable.stream.getAudioTracks = () => tracks;
  try {
    stateStore.set(state => { state.roomSlots = [stable]; state.subscribedStreams = new Set([stable.peerId]); });
    await render('grid');
    const video = document.querySelector('video');
    assert.deepEqual(calls, [0]);
    tracks.push({ id: 'late-audio', readyState: 'live' });
    await act(async () => stateStore.set(state => { state.roomSlots = [{ ...stable }]; }));
    assert.deepEqual(calls, [0, 1]);
    assert.equal(document.querySelector('video'), video);
    assert.equal(video.srcObject, stable.stream);
  } finally { audioContextManager.attachPeerAudio = original; }
});

test('spotlight automatically subscribes the owner camera and grid mounts no overlays', async () => {
  stateStore.set((state) => { state.roomSlots = [screen, camera, other]; state.subscribedStreams = new Set([screen.peerId, other.peerId]); });
  await render();
  assert.ok(stateStore.subscribedStreams.has(camera.peerId));
  assert.equal(document.querySelectorAll('.spotlight-featured-area .stream-overlay').length, 1);
  assert.match(document.querySelector('.stream-overlay').getAttribute('aria-label'), /owner/);
  await render('grid');
  assert.equal(document.querySelectorAll('.stream-overlay').length, 0);
});

test('tray context action layers another screen and removing an automatic camera stays dismissed', async () => {
  await render();
  const trayCard = document.querySelector(`.spotlight-tray-strip [data-peer-id="${other.peerId}"]`);
  await act(async () => trayCard.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 80, clientY: 80 })));
  const overlayAction = [...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent.includes('Sobrepor na transmissão atual'));
  assert.ok(overlayAction);
  await act(async () => overlayAction.click());
  assert.equal(document.querySelectorAll('.stream-overlay').length, 2);
  const cameraOverlay = [...document.querySelectorAll('.stream-overlay')].find((element) => element.getAttribute('aria-label').includes('owner'));
  await act(async () => cameraOverlay.querySelector('button').click());
  assert.equal(document.querySelectorAll('.stream-overlay').length, 1);
  await render('grid');
  await render();
  assert.equal(document.querySelectorAll('.stream-overlay').length, 1);
});

test('camera spotlight can host multiple arbitrary screen and camera overlays', async () => {
  await render('spotlight', camera.peerId);
  await act(async () => { roomService.overlayStream(screen.peerId); roomService.overlayStream(other.peerId); });
  assert.equal(document.querySelectorAll('.stream-overlay').length, 2);
  const overlay = document.querySelector('.stream-overlay');
  const bounds = { x: 0, y: 0, top: 0, left: 0, width: 1000, height: 600, right: 1000, bottom: 600 };
  overlay.parentElement.getBoundingClientRect = () => bounds;
  const before = overlay.style.left;
  await act(async () => overlay.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true })));
  assert.notEqual(overlay.style.left, before);
  const width = overlay.style.width;
  await act(async () => overlay.dispatchEvent(new window.KeyboardEvent('keydown', { key: '+', bubbles: true, cancelable: true })));
  assert.notEqual(overlay.style.width, width);
  await act(async () => overlay.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true })));
  assert.equal(document.querySelectorAll('.stream-overlay').length, 1);
});
