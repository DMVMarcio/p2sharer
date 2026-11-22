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

    // Reactivating consumer resumes frame decoding (including peer-scoped webrtc-<peerId> consumers)
    bridge.setConsumerActive('webrtc-peer-1', true);
    assert.equal(bridge.hasActiveConsumers(), true);
    socket.onmessage({ data: new ArrayBuffer(8) });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(frames.length, 3, 'Frame decoding resumes when a peer-scoped webrtc consumer attaches');
    bridge.setConsumerActive('webrtc-peer-1', false);
    assert.equal(bridge.hasActiveConsumers(), false);

    // Backpressured queue drops frames when consumer is active
    bridge.setConsumerActive('webrtc-peer', true);
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

test('window capture registers NVENC sender immediately and probing consumer does not disable encoder', { timeout: 20000 }, async () => {
  const require = createRequire(import.meta.url);
  const encoderCalls = [];
  const bundle = await build({
    stdin: {
      contents: "export { NativeVideoBridge } from './src/video/native_video_bridge.ts'; export { nativeSenderSource } from './src/video/native_sender_source.ts';",
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    plugins: [{
      name: 'native-nvenc-probing-fixture',
      setup(builder) {
        builder.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, args => ({ path: args.path, namespace: 'native' }));
        builder.onLoad({ filter: /.*/, namespace: 'native' }, () => ({
          contents: `
            globalThis.__encoderDisableCalls ??= [];
            export const isTauri = () => false;
            export const invoke = async (command, args) => {
              if (command === 'get_native_encoder_support') return { driver_api_available: true, experimental_enabled: true, reason: null };
              if (command === 'get_video_ws_port') return 12345;
              if (command === 'get_video_ws_token') return 'fixture-token';
              if (command === 'control_capture_encoder' && args?.disable === true) globalThis.__encoderDisableCalls.push(args);
              return undefined;
            };
          `,
        }));
        builder.onResolve({ filter: /^[^./]/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
      },
    }],
  });
  const { NativeVideoBridge, nativeSenderSource } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
  const globals = ['MediaStream', 'MediaStreamTrackGenerator', 'WebSocket', 'VideoDecoder', 'EncodedVideoChunk', 'localStorage', '__encoderDisableCalls'];
  const previous = new Map(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  let socket;
  globalThis.__encoderDisableCalls = encoderCalls;
  globalThis.localStorage = { getItem: (k) => k === 'p2sharer_video_encoder' ? 'nvenc' : null, setItem() {} };
  globalThis.MediaStream = class { constructor(tracks = []) { this.tracks = tracks; } getTracks() { return this.tracks; } getVideoTracks() { return this.tracks; } };
  globalThis.MediaStreamTrackGenerator = class {
    readyState = 'live';
    writable = { getWriter: () => ({ desiredSize: 1, ready: Promise.resolve(), write: async () => {}, abort: async () => {} }) };
    stop() { this.readyState = 'ended'; }
  };
  globalThis.EncodedVideoChunk = class { constructor(init) { this.timestamp = init.timestamp; } };
  globalThis.VideoDecoder = class {
    state = 'configured';
    constructor(cb) { this.error = cb.error; }
    configure() {}
    decode() { this.error(new Error('transient preview failure')); }
    close() { this.state = 'closed'; }
  };
  globalThis.WebSocket = class {
    constructor() { socket = this; queueMicrotask(() => this.onopen?.()); }
    send() { queueMicrotask(() => this.onmessage?.({ data: 'auth-ok' })); }
    close() {}
  };

  const bridge = new NativeVideoBridge('window-nvenc-test');
  try {
    const stream = await bridge.startCapture('window:123', 60, { width: 1280, height: 720 }, true, 90);
    const track = stream.getVideoTracks()[0];
    assert.equal(nativeSenderSource(track)?.sessionId, 'window-nvenc-test', 'window: NVENC capture registers sender source immediately before first frame');

    bridge.setConsumerActive('webrtc-probing-viewer1', true);
    assert.equal(bridge.hasActiveConsumers(), true);
    const buffer = new ArrayBuffer(33);
    const view = new DataView(buffer);
    new Uint8Array(buffer).set([80, 50, 78, 86, 1, 1]);
    view.setUint32(8, 1280, true); view.setUint32(12, 720, true);
    view.setUint32(16, 1, true); view.setBigUint64(20, 1_000_000n, true);
    new Uint8Array(buffer, 28).set([0, 0, 0, 1, 0x65]);
    socket.onmessage({ data: buffer });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(globalThis.__encoderDisableCalls.length, 0, 'Probing native consumer must not disable native encoder on preview failure');

    bridge.setConsumerActive('webrtc-viewer1', true);
    assert.equal(globalThis.__encoderDisableCalls.length, 1, 'Required browser consumer disables native encoder after preview failure');
  } finally {
    await bridge.stopCapture();
    for (const [key, desc] of previous) {
      if (desc) Object.defineProperty(globalThis, key, desc);
      else delete globalThis[key];
    }
  }
});
