import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';

const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
for (const key of ['window', 'document', 'HTMLElement', 'localStorage']) globalThis[key] = dom.window[key];
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = () => ({ matches: false });
window.HTMLMediaElement.prototype.play = () => Promise.resolve();
const require = createRequire(import.meta.url);
const bundle = await build({ stdin: { contents: `export { useCapturePreview } from './src/hooks/useCapturePreview.ts';
export { NativeVideoBridge } from './src/video/native_video_bridge.ts';
export { MediaPreview } from './src/components/common/MediaPreview.tsx';`, resolveDir: process.cwd() }, bundle: true,
  write: false, format: 'esm', platform: 'node', jsx: 'automatic', plugins: [{ name: 'external', setup(builder) {
    builder.onResolve({ filter: /^[^./]/ }, (args) => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
  } }] });
const { useCapturePreview, NativeVideoBridge, MediaPreview } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const { createRoot } = await import('react-dom/client');
const root = createRoot(document.getElementById('root'));
let preview, captures = [], pending;
NativeVideoBridge.prototype.startCapture = async function(sourceId, fps, resolution) {
  if (pending) await pending;
  const track = { stopped: false, stop() { this.stopped = true; }, getSettings: () => ({ ...resolution, frameRate: fps }) };
  const capture = { sourceId, bridge: this, track, getVideoTracks: () => [track], getTracks: () => [track] };
  captures.push(capture); this.testCapture = capture;
  return capture;
};
NativeVideoBridge.prototype.stopCapture = async function() { this.testCapture?.track.stop(); };
function Harness({ source = 'screen:1', width = 640, disabled = false }) {
  preview = useCapturePreview(source, { width, height: 360 }, 30, false, 90, disabled, () => {}, () => {});
  return null;
}
const render = async (props) => { await act(async () => { root.render(React.createElement(Harness, props)); }); };

test('selected native preview replaces its own session and releases it when cancelled', async () => {
  await render({});
  assert.equal(captures.length, 1); assert.equal(preview.stream, captures[0]);
  await render({ source: 'window:2' });
  assert.equal(captures[0].track.stopped, true);
  assert.equal(captures[1].track.stopped, false);
  assert.notEqual(captures[0].bridge.sessionId, captures[1].bridge.sessionId);
  await render({ source: 'window:2', disabled: true });
  assert.equal(captures[1].track.stopped, true); assert.equal(preview.stream, null);
});

test('preview ownership transfers without stopping or reopening the published track', async () => {
  await render({ source: 'screen:4' });
  const owned = preview.stream;
  let prepared;
  await act(async () => { prepared = await preview.take(); });
  assert.equal(prepared.stream, owned);
  await render({ source: 'screen:4', disabled: true });
  assert.equal(owned.track.stopped, false);
  await prepared.bridge.stopCapture();
});

test('late capture completion after cancellation cannot retain a live session', async () => {
  let resolve;
  pending = new Promise((done) => { resolve = done; });
  await render({ source: 'screen:5' });
  await render({ source: 'screen:5', disabled: true });
  await act(async () => { resolve(); await new Promise((done) => setTimeout(done, 0)); });
  pending = null;
  assert.equal(captures.at(-1).track.stopped, true); assert.equal(preview.stream, null);
});

test('side preview crossfades only after a decoded frame and repeats loading on source switches', async () => {
  const callbacks = [];
  window.HTMLVideoElement.prototype.requestVideoFrameCallback = (callback) => { callbacks.push(callback); return callbacks.length; };
  window.HTMLVideoElement.prototype.cancelVideoFrameCallback = () => {};
  const display = async (stream, busy, sourceKey) => {
    await act(async () => root.render(React.createElement(MediaPreview, { stream, busy, sourceKey, label: sourceKey, settings: {} })));
  };
  await display(null, true, 'screen:1');
  assert.ok(document.querySelector('.media-preview-skeleton'));
  await display(null, false, 'screen:1');
  assert.ok(document.querySelector('.media-preview-skeleton:not(.fade-out)'));
  await display({ id: 'first' }, false, 'screen:1');
  await act(async () => document.querySelector('video').dispatchEvent(new window.Event('loadeddata')));
  assert.equal(document.querySelector('.media-preview-video').classList.contains('ready'), false);
  const staleFrame = callbacks.at(-1);
  await act(async () => staleFrame());
  assert.ok(document.querySelector('.media-preview-skeleton.fade-out'));
  assert.ok(document.querySelector('.media-preview-video.ready'));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 425)));
  assert.equal(document.querySelector('.media-preview-skeleton'), null);
  await display(null, true, 'window:2');
  assert.ok(document.querySelector('.media-preview-skeleton:not(.fade-out)'));
  await display({ id: 'second' }, false, 'window:2');
  await act(async () => staleFrame());
  assert.equal(document.querySelector('.media-preview-video.ready'), null);
  await act(async () => document.querySelector('video').dispatchEvent(new window.Event('loadeddata')));
  await act(async () => callbacks.at(-1)());
  assert.ok(document.querySelector('.media-preview-video.ready'));
});

test('preview skeleton respects reduced motion while retaining frame readiness', async () => {
  window.matchMedia = () => ({ matches: true });
  let frame;
  window.HTMLVideoElement.prototype.requestVideoFrameCallback = (callback) => { frame = callback; return 1; };
  await act(async () => root.render(React.createElement(MediaPreview, { stream: null, busy: true, label: 'camera', settings: {} })));
  await act(async () => root.render(React.createElement(MediaPreview, { stream: { id: 'camera' }, busy: false, label: 'camera', settings: {} })));
  assert.ok(document.querySelector('.media-preview-skeleton'));
  await act(async () => document.querySelector('video').dispatchEvent(new window.Event('loadeddata')));
  await act(async () => frame());
  assert.equal(document.querySelector('.media-preview-skeleton'), null);
  window.matchMedia = () => ({ matches: false });
});

after(async () => { await act(async () => root.unmount()); dom.window.close(); });
