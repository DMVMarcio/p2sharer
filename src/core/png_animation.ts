import { deflate } from 'pako';

const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function chunk(type: string, data: Uint8Array) {
  const bytes = new Uint8Array(data.length + 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, data.length);
  bytes.set(Array.from(type, char => char.charCodeAt(0)), 4);
  bytes.set(data, 8);
  let crc = 0xffffffff;
  for (const byte of bytes.subarray(4, -4)) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  view.setUint32(bytes.length - 4, (crc ^ 0xffffffff) >>> 0);
  return bytes;
}

/** Full RGBA frames use source blending, preserving transparency without frame dependencies. */
export class PngAnimationEncoder {
  private chunks = [signature];
  private bytes = signature.length;
  private sequence = 0;
  private written = 0;
  constructor(readonly width: number, readonly height: number, readonly frames: number, readonly plays: number,
    private readonly limit = 8 * 1024 * 1024) {
    if (![width, height, frames].every(value => Number.isSafeInteger(value) && value > 0) ||
        width > 8192 || height > 8192 || width * height > 16_000_000 || frames > 512 ||
        !Number.isSafeInteger(plays) || plays < 0 || plays > 0xffffffff) throw new Error('Invalid animation dimensions');
    const header = new Uint8Array(13);
    const view = new DataView(header.buffer);
    view.setUint32(0, width); view.setUint32(4, height);
    header[8] = 8; header[9] = 6;
    this.append('IHDR', header);
    if (frames > 1) {
      const animation = new Uint8Array(8);
      const control = new DataView(animation.buffer);
      control.setUint32(0, frames); control.setUint32(4, plays);
      this.append('acTL', animation);
    }
  }
  private append(type: string, data: Uint8Array) {
    const encoded = chunk(type, data);
    if (this.bytes + encoded.length > this.limit) throw new Error('Processed animation exceeds safety limits');
    this.chunks.push(encoded); this.bytes += encoded.length;
  }
  addFrame(rgba: Uint8Array | Uint8ClampedArray, delay: number) {
    if (this.written >= this.frames || rgba.length !== this.width * this.height * 4 || !Number.isFinite(delay)) throw new Error('Invalid animation frame');
    if (this.frames > 1) {
      const control = new Uint8Array(26);
      const view = new DataView(control.buffer);
      view.setUint32(0, this.sequence++);
      view.setUint32(4, this.width); view.setUint32(8, this.height);
      // Milliseconds are an exact fraction below one minute; preserve longer GIF delays in centiseconds.
      const long = delay > 65535;
      view.setUint16(20, Math.min(65535, Math.max(10, Math.round(long ? delay / 10 : delay))));
      view.setUint16(22, long ? 100 : 1000);
      this.append('fcTL', control);
    }
    const row = this.width * 4;
    const scanlines = new Uint8Array((row + 1) * this.height);
    for (let y = 0; y < this.height; y++) scanlines.set(rgba.subarray(y * row, (y + 1) * row), y * (row + 1) + 1);
    const compressed = deflate(scanlines, { level: 9 });
    if (!this.written) this.append('IDAT', compressed);
    else {
      const data = new Uint8Array(compressed.length + 4);
      new DataView(data.buffer).setUint32(0, this.sequence++);
      data.set(compressed, 4); this.append('fdAT', data);
    }
    this.written++;
  }
  finish(): Uint8Array {
    if (this.written !== this.frames) throw new Error('Incomplete animation');
    this.append('IEND', new Uint8Array());
    const output = new Uint8Array(this.bytes);
    let offset = 0;
    for (const part of this.chunks) { output.set(part, offset); offset += part.length; }
    return output;
  }
}
