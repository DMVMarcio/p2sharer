import { parseGIF, decompressFrame, type ParsedGif } from 'gifuct-js';
import { PngAnimationEncoder } from '../core/png_animation';
import { cropDimensions } from '../core/profile_crop';
import type { ImageCrop } from '../core/profile_image';

export const PROFILE_INPUT_LIMIT = 32 * 1024 * 1024;
const PIXEL_BUDGET = 128 * 1024 * 1024;
type GifFrame = Parameters<typeof decompressFrame>[0];

export function isGif(bytes: Uint8Array) {
  return bytes.length >= 13 && new TextDecoder().decode(bytes.subarray(0, 6)).match(/^GIF8[79]a$/) !== null;
}

function readGif(bytes: Uint8Array): ParsedGif {
  if (bytes.length > PROFILE_INPUT_LIMIT || !isGif(bytes) || bytes[bytes.length - 1] !== 0x3b) throw new Error('Invalid GIF');
  const gif = parseGIF(bytes.slice().buffer);
  const { width, height } = gif.lsd;
  const frames = gif.frames.filter((frame): frame is GifFrame => 'image' in frame);
  if (width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > 16_000_000 ||
      !frames.length || frames.length > 512 || frames.length * width * height > PIXEL_BUDGET) throw new Error('Animation exceeds safety limits');
  for (const frame of frames) {
    const { width: w, height: h, left, top } = frame.image.descriptor;
    if (!w || !h || left + w > width || top + h > height || frame.image.data.minCodeSize < 2 || frame.image.data.minCodeSize > 8 ||
        !frame.image.data.blocks.length) throw new Error('Invalid GIF frame');
  }
  return gif;
}

/** Selection keeps original animation bytes; frame allocation is bounded before decompression. */
export function inspectProfileGif(bytes: Uint8Array) {
  const gif = readGif(bytes);
  for (const frame of gif.frames) if ('image' in frame) decompressFrame(frame, gif.gct, false);
  return { width: gif.lsd.width, height: gif.lsd.height };
}

function loopCount(gif: ParsedGif) {
  for (const frame of gif.frames) if ('application' in frame && ['NETSCAPE2.0', 'ANIMEXTS1.0'].includes(frame.application.id)) {
    const data = frame.application.blocks;
    if (data.length >= 3 && data[0] === 1) return data[1] | data[2] << 8;
  }
  return 1;
}

function canvas(width: number, height: number) {
  const image = document.createElement('canvas');
  image.width = width; image.height = height;
  const context = image.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Canvas unavailable');
  return { image, context };
}

/** Composite patches before cropping: GIF disposal applies after displaying each frame. */
async function encodeProfileGif(bytes: Uint8Array, crop: ImageCrop, banner = false) {
  if (![crop.x, crop.y, crop.size].every(Number.isFinite) || crop.x < 0 || crop.x > 1 || crop.y < 0 || crop.y > 1 || crop.size <= 0 || crop.size > 1) throw new Error('Invalid image crop');
  const gif = readGif(bytes);
  const { width, height } = gif.lsd;
  if (banner && width < 3) throw new Error('Image is too narrow for a banner');
  const aspect = banner ? 3 : 1;
  const dimensions = cropDimensions(width, height, crop, aspect);
  const h = Math.min(height, Math.max(1, Math.round(dimensions.height)));
  const w = h * aspect;
  const x = Math.round(crop.x * (width - w)), y = Math.round(crop.y * (height - h));
  const outputHeight = Math.min(h, banner ? 320 : 512), outputWidth = outputHeight * aspect;
  const frames = gif.frames.filter((frame): frame is GifFrame => 'image' in frame);
  if (frames.length * outputWidth * outputHeight * 4 > 128 * 1024 * 1024) throw new Error('Animation exceeds memory limits');
  const encoder = new PngAnimationEncoder(outputWidth, outputHeight, frames.length, loopCount(gif));
  const source = canvas(width, height), output = canvas(outputWidth, outputHeight);
  const screen = new Uint8ClampedArray(width * height * 4);
  output.context.imageSmoothingQuality = 'high';
  try {
    for (let index = 0; index < frames.length; index++) {
      const frame = decompressFrame(frames[index], gif.gct, true);
      const before = frame.disposalType === 3 ? screen.slice() : null;
      const { left, top, width: fw, height: fh } = frame.dims;
      for (let row = 0; row < fh; row++) for (let col = 0; col < fw; col++) {
        const pixel = (row * fw + col) * 4;
        if (frame.patch[pixel + 3]) screen.set(frame.patch.subarray(pixel, pixel + 4), ((row + top) * width + col + left) * 4);
      }
      const image = source.context.createImageData(width, height);
      image.data.set(screen); source.context.putImageData(image, 0, 0);
      output.context.clearRect(0, 0, outputWidth, outputHeight);
      output.context.drawImage(source.image, x, y, w, h, 0, 0, outputWidth, outputHeight);
      encoder.addFrame(output.context.getImageData(0, 0, outputWidth, outputHeight).data, frame.delay ?? 100);
      if (frame.disposalType === 2) {
        for (let row = 0; row < fh; row++) screen.fill(0, ((row + top) * width + left) * 4, ((row + top) * width + left + fw) * 4);
      } else if (before) screen.set(before);
      // Permit progress indicators and cancellation controls to render between bounded jobs.
      if (index % 8 === 7) await new Promise(resolve => setTimeout(resolve, 0));
    }
    return { bytes: encoder.finish(), width: outputWidth, height: outputHeight };
  } finally {
    source.image.width = source.image.height = output.image.width = output.image.height = 1;
  }
}

let pending: Promise<unknown> = Promise.resolve();

/** Match the native serialized image-work boundary and release it after failures. */
export function cropProfileGif(bytes: Uint8Array, crop: ImageCrop, banner = false) {
  const work = pending.then(() => encodeProfileGif(bytes, crop, banner));
  pending = work.catch(() => {});
  return work;
}
