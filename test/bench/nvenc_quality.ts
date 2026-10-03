import { NativeEncodedDecoder, parseNativeEncodedPacket } from '../../src/video/native_encoded_video';

/** Decode the real driver fixture produced by the opt-in native detail test in packaged WebView2. */
export async function measureNvencDetail(base64: string, validate = false) {
  const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  const decoder = new NativeEncodedDecoder('quality-fixture', 'quality-fixture');
  const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720;
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  const frames: Array<{ index: number; key: boolean; bytes: number; psnr: number }> = [];
  try {
    for (let offset = 0; offset < bytes.length;) {
      const length = view.getUint32(offset, true); offset += 4;
      const buffer = bytes.slice(offset, offset + length).buffer; offset += length;
      const packet = parseNativeEncodedPacket(buffer);
      const frame = await decoder.decode(buffer);
      if (!frame || frame.displayWidth !== 1280 || frame.displayHeight !== 720) throw new Error('Fixture frame missing or resized');
      context.drawImage(frame, 0, 0); frame.close();
      const actual = context.getImageData(0, 0, 1280, 720).data;
      let squared = 0, count = 0;
      for (let y = 0; y < 720; y += 2) for (let x = 0; x < 1280; x += 2) {
        const ink = x % 13 === 0 || y % 19 === 0 ||
          (x % 13 >= 3 && x % 13 < 10 && y % 19 >= 5 && y % 19 < 14 && (x + y) % 7 < 2);
        const expected = ink ? 24 : 224, pixel = (y * 1280 + x) * 4;
        const luma = (actual[pixel] + actual[pixel + 1] + actual[pixel + 2]) / 3;
        squared += (luma - expected) ** 2; count++;
      }
      frames.push({ index: frames.length, key: packet.key, bytes: packet.data.length,
        psnr: squared ? 10 * Math.log10(255 ** 2 / (squared / count)) : 100 });
    }
    const keys = frames.filter(frame => frame.key), deltas = frames.filter(frame => !frame.key);
    if (validate) {
      if (keys.length !== 3 || keys.some((frame, index) => frame.index !== [0, 90, 270][index])) {
        throw new Error('Bitrate edits or elapsed GOP time inserted unsolicited keyframes');
      }
      for (const index of [180, 240]) {
        if (frames[index].psnr < frames[index - 1].psnr - 0.5) throw new Error(`Detail collapsed on bitrate edit at ${index}`);
      }
    }
    return { frames: frames.length, keys, minimumPsnr: Math.min(...frames.map(frame => frame.psnr)),
      averageDeltaPsnr: deltas.reduce((sum, frame) => sum + frame.psnr, 0) / deltas.length,
      transitions: frames.filter(frame => [89, 90, 91, 119, 120, 121, 179, 180, 181, 239, 240, 241, 269, 270, 271, 359, 360].includes(frame.index)) };
  } finally { decoder.close(); }
}
