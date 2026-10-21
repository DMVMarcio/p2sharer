import assert from 'node:assert/strict';
import test, { beforeEach, afterEach } from 'node:test';
import { NativeJpegDecoder } from '../../src/video/native_jpeg_decoder.ts';

let previous;
beforeEach(() => { previous = new Map(['ImageDecoder', 'createImageBitmap', 'VideoFrame'].map(key =>
  [key, Object.getOwnPropertyDescriptor(globalThis, key)])); });
afterEach(() => { for (const [key, descriptor] of previous) {
  if (descriptor) Object.defineProperty(globalThis, key, descriptor);
  else Reflect.deleteProperty(globalThis, key);
} });
const picture = () => ({ displayWidth: 1920, displayHeight: 1080, format: 'I420',
  closes: 0, close() { this.closes++; } });

test('JPEG decoding preserves video planes and transfers frame ownership to the caller', async () => {
  const frames = [], decoders = [];
  const buffer = new Uint8Array([255, 216, 255, 217]).buffer;
  globalThis.ImageDecoder = class {
    constructor(options) {
      assert.equal(options.type, 'image/jpeg');
      assert.equal(options.colorSpaceConversion, 'none');
      assert.equal(options.data.buffer, buffer);
      this.closes = 0; decoders.push(this);
    }
    async decode(options) { assert.equal(options.frameIndex, 0); const image = picture(); frames.push(image); return { image }; }
    close() { this.closes++; }
  };
  globalThis.createImageBitmap = () => assert.fail('Direct JPEG frames must not pass through RGB bitmaps');
  const decoder = new NativeJpegDecoder();
  for (let index = 0; index < 2; index++) assert.equal(await decoder.decode(buffer), frames[index]);
  assert.deepEqual(decoders.map(decoder => decoder.closes), [1, 1]);
  decoder.close();
  assert.deepEqual(frames.map(frame => frame.closes), [0, 0]);
  frames.forEach(frame => frame.close());
});

test('incompatible direct decoding falls back once and keeps decoding later JPEGs', async () => {
  let attempts = 0, closes = 0, fallbacks = 0, bitmapDecodes = 0;
  globalThis.ImageDecoder = class {
    constructor() { attempts++; }
    async decode() { throw new DOMException('Unsupported JPEG decoder', 'NotSupportedError'); }
    close() { closes++; }
  };
  globalThis.createImageBitmap = async (blob, options) => {
    assert.equal(blob.type, 'image/jpeg');
    assert.equal(options.colorSpaceConversion, 'none');
    bitmapDecodes++; return { width: 1920, height: 1080, close() {} };
  };
  const decoder = new NativeJpegDecoder(() => fallbacks++);
  for (let index = 0; index < 2; index++) assert.equal((await decoder.decode(new ArrayBuffer(4))).width, 1920);
  assert.equal(attempts, 1); assert.equal(closes, 1);
  assert.equal(fallbacks, 1); assert.equal(bitmapDecodes, 2);
  decoder.close();
});

test('stopping capture releases pending direct work and rejects late output without bitmap fallback', async () => {
  let finish, closes = 0;
  globalThis.ImageDecoder = class {
    decode() { return new Promise(resolve => { finish = resolve; }); }
    close() { closes++; }
  };
  globalThis.createImageBitmap = () => assert.fail('Stopped capture must not decode a fallback bitmap');
  const decoder = new NativeJpegDecoder(() => assert.fail('Stopping is not an unsupported decoder'));
  const pending = decoder.decode(new ArrayBuffer(4));
  decoder.close(); decoder.close();
  const frame = picture(); finish({ image: frame });
  await assert.rejects(pending, /closed/);
  assert.equal(closes, 1); assert.equal(frame.closes, 1);
  await assert.rejects(decoder.decode(new ArrayBuffer(4)), /closed/);
});

test('older WebViews use bitmaps and close bitmap output arriving after stop', async () => {
  Reflect.deleteProperty(globalThis, 'ImageDecoder');
  let finish;
  const bitmap = { width: 1280, height: 720, closes: 0, close() { this.closes++; } };
  globalThis.createImageBitmap = () => new Promise(resolve => { finish = resolve; });
  const decoder = new NativeJpegDecoder();
  const pending = decoder.decode(new ArrayBuffer(4));
  decoder.close(); finish(bitmap);
  await assert.rejects(pending, /closed/);
  assert.equal(bitmap.closes, 1);
});

test('fresh and repeated JPEG pictures rebuild the media clock while preserving YUV layout and color', async () => {
  const layout = [{ offset: 0, stride: 2 }, { offset: 4, stride: 1 }, { offset: 5, stride: 1 }];
  const colorSpace = { matrix: 'bt470bg', fullRange: true };
  const picture = { format: 'I420', timestamp: 0, codedWidth: 2, codedHeight: 2,
    displayWidth: 2, displayHeight: 2, visibleRect: { x: 0, y: 0, width: 2, height: 2 }, colorSpace,
    allocationSize: () => 6, async copyTo(buffer) { buffer.set([20, 40, 60, 80, 100, 120]); return layout; } };
  const inputs = [];
  globalThis.VideoFrame = class {
    constructor(data, init) {
      assert.ok(data instanceof Uint8Array, 'Retiming must initialize the underlying media frame, not clone timestamp-zero output');
      inputs.push(data); this.init = init; this.pixels = [...data];
    }
  };
  const decoder = new NativeJpegDecoder();
  for (const timestamp of [100_000, 116_667, 133_334]) {
    const output = await decoder.createTrackFrame(picture, { timestamp, duration: 16667 });
    assert.equal(output.init.timestamp, timestamp);
    assert.equal(output.init.duration, 16667);
    assert.equal(output.init.format, 'I420');
    assert.deepEqual(output.init.layout, layout);
    assert.equal(output.init.colorSpace, colorSpace);
    assert.deepEqual(output.init.visibleRect, picture.visibleRect);
    assert.equal(output.init.codedWidth, 2); assert.equal(output.init.codedHeight, 2);
    assert.deepEqual(output.pixels, [20, 40, 60, 80, 100, 120]);
  }
  assert.equal(inputs[0], inputs[1]); assert.equal(inputs[1], inputs[2]);
  decoder.close();
});

test('a WebView rejecting plane copies retains a timed bitmap fallback', async () => {
  let fallbacks = 0, bitmapsClosed = 0;
  const input = { format: 'I420', allocationSize: () => 6, async copyTo() { throw new Error('Unmappable output'); } };
  globalThis.createImageBitmap = async frame => {
    assert.equal(frame, input); return { close() { bitmapsClosed++; } };
  };
  globalThis.VideoFrame = class { constructor(bitmap, init) { this.timestamp = init.timestamp; } };
  const decoder = new NativeJpegDecoder(() => fallbacks++);
  assert.equal((await decoder.createTrackFrame(input, { timestamp: 123 })).timestamp, 123);
  assert.equal((await decoder.createTrackFrame(input, { timestamp: 456 })).timestamp, 456);
  assert.equal(fallbacks, 1); assert.equal(bitmapsClosed, 2);
  decoder.close();
});
