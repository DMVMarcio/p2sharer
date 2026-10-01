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
export { stateStore } from './src/core/state_store.ts';
export { roomService } from './src/services/room_service.ts';
export { audioContextManager } from './src/audio/audio_context_manager.ts';
`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm', platform: 'node', jsx: 'automatic',
  loader: { '.css': 'empty', '.png': 'dataurl' }, plugins: [{ name: 'packages', setup(builder) {
    builder.onResolve({ filter: /^[^./]/ }, (args) => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
  } }] });
const { RoomVideoContainer, ContextMenuProvider, stateStore, roomService, audioContextManager } =
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
after(async () => { await act(async () => root.unmount()); browser.window.close(); });

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
