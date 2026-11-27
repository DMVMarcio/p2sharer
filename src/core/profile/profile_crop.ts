import type { ImageCrop } from './profile_image';

export function cropDimensions(width: number, height: number, crop: ImageCrop, aspect = 1) {
  const maximum = Math.min(width / aspect, height);
  const croppedHeight = aspect === 1 ? maximum * crop.size : Math.max(1, Math.round(Math.floor(maximum) * crop.size));
  return { width: croppedHeight * aspect, height: croppedHeight };
}

export function zoomCrop(width: number, height: number, current: ImageCrop, factor: number, aspect = 1): ImageCrop {
  const size = Math.min(1, Math.max(0.01, current.size * factor));
  const before = cropDimensions(width, height, current, aspect);
  const after = cropDimensions(width, height, { ...current, size }, aspect);
  const position = (axis: 'x' | 'y', dimension: number, oldSize: number, newSize: number) => dimension === newSize ? 0.5 :
    Math.min(1, Math.max(0, (current[axis] * (dimension - oldSize) + (oldSize - newSize) / 2) / (dimension - newSize)));
  return { size, x: position('x', width, before.width, after.width), y: position('y', height, before.height, after.height) };
}
