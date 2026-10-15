import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

test('native window capture publishes before frames, accepts late images and ends on source closure', { timeout: 20000 }, async () => {
  const require = createRequire(import.meta.url);
  const bundle = await build({ stdin: { contents: "export { NativeVideoBridge } from './src/video/native_video_bridge.ts';", resolveDir: process.cwd() },
    bundle: true, write: false, format: 'esm', platform: 'node', plugins: [{ name: 'native-window-fixture', setup(builder) {
      builder.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, args => ({ path: args.path, namespace: 'native' }));
      builder.onLoad({ filter: /.*/, namespace: 'native' }, () => ({ contents: `
        export const isTauri = () => false;
        export const invoke = async command => command === 'get_video_ws_port' ? 12345 :
          command === 'get_video_ws_token' ? 'fixture-token' : undefined;` }));
      builder.onResolve({ filter: /^[^./]/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
    } }] });
  const { NativeVideoBridge } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
  const globals = ['MediaStream', 'MediaStreamTrackGenerator', 'WebSocket', 'VideoFrame', 'createImageBitmap'];
  const previous = new Map(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const frames = [];
  let socket;
  globalThis.MediaStream = class {
    constructor(tracks = []) { this.tracks = tracks; }
    getTracks() { return this.tracks; }
    getVideoTracks() { return this.tracks; }
  };
  globalThis.MediaStreamTrackGenerator = class {
    readyState = 'live';
    writable = { getWriter: () => ({ ready: Promise.resolve(), write: async frame => frames.push(frame), abort: async () => {} }) };
    stop() { this.readyState = 'ended'; }
  };
  globalThis.VideoFrame = class { constructor(image) { this.image = image; } close() {} };
  globalThis.createImageBitmap = async () => ({ width: 1280, height: 720, close() {} });
  globalThis.WebSocket = class {
    constructor() { socket = this; queueMicrotask(() => this.onopen?.()); }
    send() { queueMicrotask(() => this.onmessage?.({ data: 'auth-ok' })); }
    close() {}
  };
  const bridge = new NativeVideoBridge('fixture-window');
  try {
    const stream = await bridge.startCapture('window:123', 30, { width: 1280, height: 720 });
    const track = stream.getVideoTracks()[0];
    assert.equal(frames.length, 0);
    assert.equal(track.readyState, 'live');
    const reasons = [];
    bridge.onFallbackNeeded = reason => reasons.push(reason);
    socket.onmessage({ data: JSON.stringify({ type: 'fallback', reason: 'window_minimized' }) });
    assert.equal(track.readyState, 'live');
    assert.deepEqual(reasons, []);
    socket.onmessage({ data: new ArrayBuffer(8) });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(frames.length, 1);
    assert.equal(bridge.getActiveStream(), stream);
    socket.onmessage({ data: JSON.stringify({ type: 'fallback', reason: 'window_closed' }) });
    assert.equal(track.readyState, 'ended');
    assert.deepEqual(reasons, ['window_closed']);
    const lateReasons = [];
    bridge.onFallbackNeeded = reason => lateReasons.push(reason);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(lateReasons, ['window_closed']);
  } finally {
    await bridge.stopCapture();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
