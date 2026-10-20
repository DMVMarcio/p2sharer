import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { crc32 } from 'node:zlib';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import UPNG from 'upng-js';
import 'fake-indexeddb/auto';

const bundle = await build({ stdin: { contents: `export { invokeBrowser } from './src/platform/web_commands.ts'; export { cropProfileGif, inspectProfileGif } from './src/platform/web_profile_gif.ts';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'esm',
  plugins: [{ name: 'profile-browser-boundaries', setup(builder) {
    builder.onResolve({ filter: /(?:^|\/)i18n(?:\/index\.ts)?$/ }, () => ({ path: 'i18n', namespace: 'fixture' }));
    builder.onResolve({ filter: /\/web_files\.ts$/ }, () => ({ path: 'files', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path === 'i18n' ? 'export const t = key => key;' :
      'export const pickBrowserFile = async () => globalThis.profileGifFile; export const downloadBlob = () => {}; export const browserFileCommand = () => {};' }));
  } }] });
const api = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

// Synthetic GIFs use a four-color palette and clear codes between literals.
function gif(width, height, frames, loop = 3) {
  const bytes = [...Buffer.from('GIF89a'), width & 255, width >> 8, height & 255, height >> 8, 0x81, 0, 0,
    0,0,0, 255,0,0, 0,255,0, 0,0,255,
    0x21,0xff,11, ...Buffer.from('NETSCAPE2.0'), 3,1,loop & 255,loop >> 8,0];
  for (const frame of frames) {
    const { w = width, h = height, left = 0, top = 0, disposal = 1, delay = 8, pixels = Array(w * h).fill(1) } = frame;
    bytes.push(0x21,0xf9,4, (disposal << 2) | 1, delay & 255,delay >> 8,0,0,
      0x2c,left & 255,left >> 8,top & 255,top >> 8,w & 255,w >> 8,h & 255,h >> 8,0,2);
    const data = []; let bits = 0, count = 0;
    const emit = code => { bits |= code << count; count += 3; while (count >= 8) { data.push(bits & 255); bits >>= 8; count -= 8; } };
    for (const pixel of pixels) { emit(4); emit(pixel); } emit(5);
    if (count) data.push(bits & 255);
    for (let offset = 0; offset < data.length; offset += 255) { const block = data.slice(offset, offset + 255); bytes.push(block.length, ...block); }
    bytes.push(0);
  }
  bytes.push(0x3b); return new Uint8Array(bytes);
}
const animation = () => gif(6, 2, [
  {}, { w: 1, h: 1, left: 1, pixels: [2], disposal: 3, delay: 12 },
  { w: 1, h: 1, pixels: [3], disposal: 2, delay: 20 },
  { w: 1, h: 1, pixels: [0], delay: 5 },
]);
function decode(data) {
  const bytes = Buffer.from(data, 'base64');
  const sequences = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8);
    assert.equal(bytes.readUInt32BE(offset + 8 + length), crc32(bytes.subarray(offset + 4, offset + 8 + length)), `${type} CRC`);
    if (type === 'fcTL' || type === 'fdAT') sequences.push(bytes.readUInt32BE(offset + 8));
    offset += length + 12;
  }
  const decoded = UPNG.decode(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
  return { ...decoded, rgba: UPNG.toRGBA8(decoded).map(frame => new Uint8Array(frame)), sequences };
}

test('GIF previews preserve original bytes and saved avatar/banner retain animation, crop and transparency', async () => {
  const old = Object.fromEntries(['document', 'FileReader', 'createImageBitmap'].map(key => [key, globalThis[key]]));
  let canvases = 0;
  globalThis.document = { createElement(tag) { assert.equal(tag, 'canvas'); canvases++; return createCanvas(1, 1); } };
  globalThis.FileReader = class {
    readAsDataURL(blob) { void blob.arrayBuffer().then(buffer => { this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString('base64')}`; this.onloadend(); }); }
  };
  globalThis.createImageBitmap = async blob => {
    const image = await loadImage(Buffer.from(await blob.arrayBuffer()));
    return { width: image.width, height: image.height, close() {} };
  };
  try {
    const original = animation();
    globalThis.profileGifFile = new Blob([original], { type: 'image/gif' });
    for (const banner of [false, true]) {
      const before = canvases;
      const draft = await api.invokeBrowser('pick_profile_image');
      assert.equal(canvases, before, 'selection must not flatten the source through a canvas');
      assert.equal(draft.preview, `data:image/gif;base64,${Buffer.from(original).toString('base64')}`);
      assert.equal(draft.width, 6); assert.equal(draft.height, 2);
      const saved = await api.invokeBrowser('save_profile_image', { token: draft.token, crop: { x: 0, y: 0, size: 1 }, banner, color: '#123456' });
      const decoded = decode(saved.data);
      assert.equal(decoded.width, banner ? 6 : 2); assert.equal(decoded.height, 2, 'small sources must not be upscaled');
      assert.equal(decoded.frames.length, 4); assert.equal(decoded.tabs.acTL.num_plays, 3);
      assert.deepEqual(decoded.frames.map(frame => frame.delay), [80,120,200,50]);
      assert.deepEqual(decoded.sequences, [0,1,2,3,4,5,6]);
      const pixel = (frame, x) => [...decoded.rgba[frame].subarray(x * 4, x * 4 + 4)];
      assert.deepEqual(pixel(0, 0), [255,0,0,255]);
      assert.deepEqual(pixel(1, 1), [0,255,0,255]);
      assert.deepEqual(pixel(2, 1), [255,0,0,255], 'restore-previous disposal removes the green patch');
      assert.deepEqual(pixel(2, 0), [0,0,255,255]);
      assert.equal(pixel(3, 0)[3], 0, 'restore-background disposal clears the blue patch');
      assert.deepEqual(await api.invokeBrowser('load_profile_image', { banner }), saved);
      const bytes = Uint8Array.from(Buffer.from(saved.data, 'base64'));
      const hash = Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
      assert.equal(saved.hash, hash);
      await api.invokeBrowser('validate_profile_image_bytes', bytes, { headers: { 'x-profile-hash': hash, 'x-profile-banner': String(banner) } });
      const moved = await api.invokeBrowser('save_profile_image', { token: draft.token, crop: { x: 1, y: 0, size: 1 }, banner: false, color: '#123456' });
      assert.deepEqual([...decode(moved.data).rgba[1].subarray(0, 4)], [255,0,0,255]);
      await api.invokeBrowser('discard_profile_image', { token: draft.token });
      await assert.rejects(api.invokeBrowser('save_profile_image', { token: draft.token, banner }), /draft unavailable/);
    }
    const looped = await api.cropProfileGif(gif(6, 2, [{}, {}], 0), { x: 0, y: 0, size: 1 });
    assert.equal(decode(Buffer.from(looped.bytes).toString('base64')).tabs.acTL.num_plays, 0);
    const single = await api.cropProfileGif(gif(6, 2, [{}]), { x: 0, y: 0, size: 1 });
    assert.equal(decode(Buffer.from(single.bytes).toString('base64')).tabs.acTL, undefined);
    const large = await api.cropProfileGif(gif(1800, 600, [{}, { pixels: Array(1800 * 600).fill(2) }]), { x: .5, y: .5, size: 1 }, true);
    assert.equal(large.width, 960); assert.equal(large.height, 320);
    assert.equal(decode(Buffer.from(large.bytes).toString('base64')).frames.length, 2);
  } finally { Object.assign(globalThis, old); delete globalThis.profileGifFile; }
});

test('GIF bounds reject oversized or malformed animations before allocating frame canvases', async () => {
  assert.throws(() => api.inspectProfileGif(animation().subarray(0, 20)), /Invalid GIF/);
  assert.throws(() => api.inspectProfileGif(gif(6, 2, Array(513).fill({ w: 1, h: 1, pixels: [1] }))), /safety limits/);
  assert.throws(() => api.inspectProfileGif(gif(4000, 4000, Array(9).fill({ w: 1, h: 1, pixels: [1] }))), /safety limits/);
  await assert.rejects(api.cropProfileGif(animation(), { x: 0, y: 0, size: NaN }), /Invalid image crop/);
});
