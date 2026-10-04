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
const captures = [];
let captureError = false;
let finishCapture;
globalThis.transmissionDefaultsFixture = {
  localCaptures: new Map(),
  startCapture: async (...args) => {
    captures.push(args);
    if (captureError) throw new Error('Capture failed');
    if (finishCapture) await finishCapture;
  },
};
const mocks = {
  room: 'export const roomService = { localCaptures: globalThis.transmissionDefaultsFixture.localCaptures, startCapture: (...args) => globalThis.transmissionDefaultsFixture.startCapture(...args) };',
  preview: 'export const useCapturePreview = () => ({ busy: false, take: async () => undefined });',
  cameras: 'export const listCameras = async () => []; export const preferredCameraFrameRate = (rates, fps) => rates.includes(fps) ? fps : rates[0];',
  tauri: 'export const invoke = async () => ({ monitors: [{ id: "screen:0", name: "Monitor" }], windows: [] });',
};
const bundle = await build({ stdin: { contents: `export { useScreenPicker } from './src/hooks/useScreenPicker.ts';
export { stateStore, StateStore } from './src/core/state_store.ts';`, resolveDir: process.cwd() },
  bundle: true, write: false, format: 'esm', platform: 'node', jsx: 'automatic', plugins: [{ name: 'fixture', setup(builder) {
    builder.onResolve({ filter: /room_service|useCapturePreview|camera_devices|@tauri-apps\/api\/core/ }, args => ({
      path: args.path.includes('room_service') ? 'room' : args.path.includes('useCapturePreview') ? 'preview' :
        args.path.includes('camera_devices') ? 'cameras' : 'tauri', namespace: 'fixture',
    }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: mocks[args.path] }));
    builder.onResolve({ filter: /^[^./]/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
  } }] });
const { useScreenPicker, stateStore, StateStore } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const { createRoot } = await import('react-dom/client');
const root = createRoot(document.getElementById('root'));
let picker;
function Harness() { picker = useScreenPicker(); return null; }
async function open() {
  await act(async () => root.render(null));
  await act(async () => root.render(React.createElement(Harness)));
  await act(async () => picker.loadSources());
}
async function choose() {
  await act(async () => {
    picker.setResolution('720p'); picker.setFps(30); picker.setBitrate(3000);
    picker.setQuality(75); picker.setShowCursor(false);
  });
}
function saved() {
  return ['res', 'fps', 'bitrate', 'quality', 'cursor'].map(key => localStorage.getItem(`p2sharer_default_${key}`));
}

test('first launch remembers settings only after successful confirmation, and they survive reload', async () => {
  localStorage.clear(); stateStore.loadFromStorage();
  assert.equal(new StateStore().rememberTransmissionSettings, true);
  assert.deepEqual(stateStore.currentResolution, { width: 1280, height: 720, label: '720p' });
  assert.equal(stateStore.currentFps, 30);
  assert.equal(stateStore.currentBitrate, 8000);
  await open();
  assert.equal(picker.resolution, '720p');
  assert.equal(picker.fps, 30);
  assert.equal(picker.bitrate, 8000);
  await choose();
  assert.deepEqual(saved(), [null, null, null, null, null]);
  let resolve;
  finishCapture = new Promise(done => { resolve = done; });
  let confirmation;
  await act(async () => { confirmation = picker.confirmPicker(); await new Promise(done => setTimeout(done, 0)); });
  assert.deepEqual(saved(), [null, null, null, null, null]);
  await act(async () => { resolve(); await confirmation; });
  finishCapture = undefined;
  assert.deepEqual(saved(), ['720p', '30', '3000', '75', 'false']);
  assert.equal(captures.at(-1)[7], 3000);
  const reloaded = new StateStore();
  assert.equal(reloaded.currentResolution.label, '720p');
  assert.equal(reloaded.currentBitrate, 3000);
  await open();
  assert.equal(picker.resolution, '720p'); assert.equal(picker.showCursor, false);
});

test('disabling remembering preserves manual defaults while the new capture uses selected settings', async () => {
  await act(async () => stateStore.saveTransmissionDefaults({ resolution: '1080p', fps: 60, bitrate: 15000, quality: 90, cursor: true }));
  localStorage.setItem('p2sharer_remember_transmission_settings', 'false'); stateStore.loadFromStorage();
  assert.equal(new StateStore().rememberTransmissionSettings, false);
  await open(); await choose();
  await act(async () => picker.confirmPicker());
  assert.deepEqual(saved(), ['1080p', '60', '15000', '90', 'true']);
  assert.equal(captures.at(-1)[1], 30); assert.equal(captures.at(-1)[7], 3000);
  await open();
  assert.equal(picker.resolution, '1080p'); assert.equal(picker.bitrate, 15000);
});

test('cancelled and failed attempts preserve both stored defaults and prior runtime state', async () => {
  localStorage.setItem('p2sharer_remember_transmission_settings', 'true'); stateStore.loadFromStorage();
  await open(); await choose(); await open();
  assert.equal(picker.resolution, '1080p');
  await choose(); captureError = true;
  await act(async () => picker.confirmPicker());
  captureError = false;
  assert.ok(picker.error.includes('Capture failed'));
  assert.deepEqual(saved(), ['1080p', '60', '15000', '90', 'true']);
  assert.equal(stateStore.currentFps, 60); assert.equal(stateStore.currentBitrate, 15000);
});

test('camera dimensions and fractional frame rates retain their exact saved values', async () => {
  await act(async () => stateStore.saveTransmissionDefaults({ resolution: '1280x960', fps: 29.97002997002997, bitrate: 8000, quality: 85, cursor: false }));
  const reloaded = new StateStore();
  assert.equal(reloaded.currentResolution.width, 1280); assert.equal(reloaded.currentResolution.height, 960);
  assert.equal(reloaded.currentFps, 29.97002997002997);
});

test('editing a running transmission replaces defaults only when its changes are confirmed', async () => {
  globalThis.transmissionDefaultsFixture.localCaptures.set('running', { kind: 'screen', sourceId: 'window:4',
    resolution: { width: 1920, height: 1080 }, fps: 60, bitrate: 15000, quality: 90, mouse: true });
  await act(async () => stateStore.set(state => { state.editingStreamId = 'running'; }));
  await open();
  assert.equal(picker.editingId, 'running'); assert.equal(picker.selectedSourceId, 'window:4');
  const previous = saved();
  await choose();
  assert.deepEqual(saved(), previous);
  await act(async () => picker.confirmPicker());
  assert.deepEqual(saved(), ['720p', '30', '3000', '75', 'false']);
  assert.equal(captures.at(-1)[0], 'window:4');
  await act(async () => stateStore.set(state => { state.editingStreamId = null; }));
});

after(async () => {
  await act(async () => root.unmount()); dom.window.close(); delete globalThis.transmissionDefaultsFixture;
});
