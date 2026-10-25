import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

test('native video bridge gates decoding by active consumers and drops frames when backpressured', { timeout: 20000 }, async () => {
  const require = createRequire(import.meta.url);
  const bundle = await build({ stdin: { contents: "export { NativeVideoBridge } from './src/video/native_video_bridge.ts';", resolveDir: process.cwd() },
    bundle: true, write: false, format: 'esm', platform: 'node', plugins: [{ name: 'native-consumption-fixture', setup(builder) {
      builder.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, args => ({ path: args.path, namespace: 'native' }));
      builder.onLoad({ filter: /.*/, namespace: 'native' }, () => ({ contents: `
        export const isTauri = () => false;
        export const invoke = async (command) => command === 'get_video_ws_port' ? 12345 :
          command === 'get_video_ws_token' ? 'fixture-token' : undefined;` }));
      builder.onResolve({ filter: /^[^./]/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
    } }] });
  const { NativeVideoBridge } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
  const globals = ['MediaStream', 'MediaStreamTrackGenerator', 'WebSocket', 'VideoFrame', 'createImageBitmap'];
  const previous = new Map(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const frames = [];
  let socket;
  let desiredSize = 1;
  globalThis.MediaStream = class {
    constructor(tracks = []) { this.tracks = tracks; }
    getTracks() { return this.tracks; }
    getVideoTracks() { return this.tracks; }
  };
  globalThis.MediaStreamTrackGenerator = class {
    readyState = 'live';
    writable = {
      getWriter: () => ({
        get desiredSize() { return desiredSize; },
        ready: Promise.resolve(),
        write: async frame => frames.push(frame),
        abort: async () => {},
      }),
    };
    stop() { this.readyState = 'ended'; }
  };
  globalThis.VideoFrame = class { constructor(image) { this.image = image; } close() {} };
  globalThis.createImageBitmap = async () => ({ width: 1280, height: 720, close() {} });
  globalThis.WebSocket = class {
    constructor() { socket = this; queueMicrotask(() => this.onopen?.()); }
    send() { queueMicrotask(() => this.onmessage?.({ data: 'auth-ok' })); }
    close() {}
  };

  const bridge = new NativeVideoBridge('consumption-test');
  try {
    const stream = await bridge.startCapture('window:123', 30, { width: 1280, height: 720 });
    assert.equal(stream.getVideoTracks()[0].readyState, 'live');

    // First frame establishes startup
    socket.onmessage({ data: new ArrayBuffer(8) });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(frames.length, 1, 'First frame must be decoded to verify live track');

    // With consumer active, subsequent frames are written
    bridge.setConsumerActive('local-preview', true);
    assert.equal(bridge.hasActiveConsumers(), true);
    socket.onmessage({ data: new ArrayBuffer(8) });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(frames.length, 2, 'Frame must be decoded when consumer is active');

    // Deactivating consumers pauses decoding and drops incoming frames
    bridge.setConsumerActive('local-preview', false);
    assert.equal(bridge.hasActiveConsumers(), false);
    socket.onmessage({ data: new ArrayBuffer(8) });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(frames.length, 2, 'Frame must be dropped without decoding when no consumers are active');

    // Reactivating consumer resumes frame decoding
    bridge.setConsumerActive('webrtc-peer', true);
    assert.equal(bridge.hasActiveConsumers(), true);
    socket.onmessage({ data: new ArrayBuffer(8) });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(frames.length, 3, 'Frame decoding resumes when a consumer reattaches');

    // Backpressured queue drops frames to prevent unbounded memory growth
    desiredSize = 0;
    socket.onmessage({ data: new ArrayBuffer(8) });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(frames.length, 3, 'Frame must be dropped when trackWriter queue is backpressured');
  } finally {
    await bridge.stopCapture();
    for (const [key, desc] of previous) {
      if (desc) Object.defineProperty(globalThis, key, desc);
      else delete globalThis[key];
    }
  }
});
