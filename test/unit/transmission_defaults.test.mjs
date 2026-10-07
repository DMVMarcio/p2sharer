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
  preview: `const take = async () => undefined;
    const retry = () => { globalThis.transmissionDefaultsFixture.retries = (globalThis.transmissionDefaultsFixture.retries || 0) + 1; };
    export const useCapturePreview = (_source, _res, _fps, _cursor, _quality, _closing, modes, rates) => {
      globalThis.transmissionDefaultsFixture.receiveModes = modes; globalThis.transmissionDefaultsFixture.receiveRates = rates;
      return { busy: !!globalThis.transmissionDefaultsFixture.previewBusy, take, retry };
    };`,
  cameras: 'export const listCameras = async () => [{ kind: "videoinput", deviceId: "fixture-camera", label: "Camera" }]; export const preferredCameraFrameRate = (rates, fps) => rates.includes(fps) ? fps : rates[0];',
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
  const retries = globalThis.transmissionDefaultsFixture.retries || 0;
  await act(async () => picker.confirmPicker());
  captureError = false;
  assert.equal(picker.error, 'Não foi possível aplicar a transmissão: Não foi possível concluir a operação. Tente novamente.');
  assert.deepEqual(saved(), ['1080p', '60', '15000', '90', 'true']);
  assert.equal(stateStore.currentFps, 60); assert.equal(stateStore.currentBitrate, 15000);
  assert.equal(globalThis.transmissionDefaultsFixture.retries, retries + 1);
});

test('camera capability choices and successful start preserve screen drafts and saved defaults', async () => {
  await act(async () => stateStore.saveTransmissionDefaults({ resolution: '1080p', fps: 60, bitrate: 15000, quality: 90, cursor: true }));
  await open();
  await act(async () => { picker.setResolution('4k'); picker.setFps(120); picker.setBitrate(35000); });
  await act(async () => picker.setCurrentTab('cameras'));
  const cameraRate = 29.97002997002997;
  await act(async () => {
    globalThis.transmissionDefaultsFixture.receiveModes([{ value: '1280x960', width: 1280, height: 960, label: '1280x960' }]);
    globalThis.transmissionDefaultsFixture.receiveRates([cameraRate, 15]);
  });
  assert.equal(picker.resolution, '1280x960'); assert.equal(picker.fps, cameraRate);
  await act(async () => { picker.setFps(15); picker.setBitrate(3000); });
  await act(async () => picker.setCurrentTab('screens'));
  assert.equal(picker.resolution, '4k'); assert.equal(picker.fps, 120); assert.equal(picker.bitrate, 35000);
  await act(async () => picker.setCurrentTab('cameras'));
  assert.equal(picker.resolution, '1280x960'); assert.equal(picker.fps, 15); assert.equal(picker.bitrate, 3000);
  await act(async () => picker.confirmPicker());
  assert.equal(captures.at(-1)[0], 'camera:fixture-camera');
  assert.equal(captures.at(-1)[1], 15);
  assert.deepEqual(captures.at(-1)[2], { width: 1280, height: 960 });
  assert.deepEqual(saved(), ['1080p', '60', '15000', '90', 'true']);
  assert.equal(stateStore.currentResolution.label, '1080p'); assert.equal(stateStore.currentFps, 60);
  assert.equal(stateStore.currentBitrate, 15000);
  await open();
  await act(async () => picker.setCurrentTab('cameras'));
  assert.equal(picker.resolution, '720p'); assert.equal(picker.fps, 30); assert.equal(picker.bitrate, 8000);
});

test('confirmation uses the current preview readiness after loading finishes without changing settings', async () => {
  globalThis.transmissionDefaultsFixture.previewBusy = true;
  await open();
  const count = captures.length;
  await act(async () => picker.confirmPicker());
  assert.equal(captures.length, count);
  globalThis.transmissionDefaultsFixture.previewBusy = false;
  await act(async () => root.render(React.createElement(Harness)));
  await act(async () => picker.confirmPicker());
  assert.equal(captures.length, count + 1);
});

test('editing a camera preserves exact active constraints without saving them as transmission defaults', async () => {
  const cameraRate = 29.97002997002997;
  globalThis.transmissionDefaultsFixture.localCaptures.set('camera-running', { kind: 'camera', sourceId: 'camera:fixture-camera',
    resolution: { width: 1280, height: 960 }, fps: cameraRate, bitrate: 8000, quality: 85, mouse: false });
  await act(async () => stateStore.set(state => { state.editingStreamId = 'camera-running'; }));
  try {
    await open();
    assert.equal(picker.currentTab, 'cameras'); assert.equal(picker.resolution, '1280x960'); assert.equal(picker.fps, cameraRate);
    await act(async () => picker.confirmPicker());
    assert.equal(captures.at(-1)[1], cameraRate);
    assert.deepEqual(saved(), ['1080p', '60', '15000', '90', 'true']);
    assert.equal(stateStore.currentFps, 60);
  } finally {
    await act(async () => stateStore.set(state => { state.editingStreamId = null; }));
  }
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
