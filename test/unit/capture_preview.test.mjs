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
const require = createRequire(import.meta.url);
const bundle = await build({ stdin: { contents: `export { useCapturePreview } from './src/hooks/useCapturePreview.ts';
export { NativeVideoBridge } from './src/video/native_video_bridge.ts';`, resolveDir: process.cwd() }, bundle: true,
  write: false, format: 'esm', platform: 'node', jsx: 'automatic', plugins: [{ name: 'external', setup(builder) {
    builder.onResolve({ filter: /^[^./]/ }, (args) => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
  } }] });
const { useCapturePreview, NativeVideoBridge } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
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

after(async () => { await act(async () => root.unmount()); dom.window.close(); });
