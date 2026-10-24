import { invoke } from '@tauri-apps/api/core';
import { t } from '../i18n/index.ts';
import { showToast } from '../hooks/useToast.ts';

/**
 * Converts a data URL, blob URL, or remote URL into a base64 data string.
 */
export async function imageSrcToBase64(src: string): Promise<string> {
  if (src.startsWith('data:')) {
    return src;
  }
  const response = await fetch(src);
  const blob = await response.blob();
  return blobToDataUrl(blob);
}

/** Encode an existing blob without a CSP-restricted fetch round trip. */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('Failed to convert image to base64'));
    };
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read image blob'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Converts an image blob to a PNG blob using an in-memory canvas.
 * Web browsers / Chromium require 'image/png' in ClipboardItem.
 */
export async function blobToPngBlob(blob: Blob, whiteMarginPadding?: number): Promise<Blob> {
  if (blob.type === 'image/png' && whiteMarginPadding === undefined) return blob;
  return new Promise<Blob>((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth || img.width;
      canvas.height = img.naturalHeight || img.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Canvas context unavailable'));
        return;
      }
      try {
        ctx.drawImage(img, 0, 0);
        const output = whiteMarginPadding === undefined ? canvas : trimWhiteCanvasMargins(canvas, whiteMarginPadding);
        output.toBlob((pngBlob) => {
          if (pngBlob) resolve(pngBlob);
          else reject(new Error('Failed to render PNG blob'));
        }, 'image/png');
      } catch (error) { reject(error); }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load image for PNG conversion'));
    };
    img.src = url;
  });
}

/** Crop rendered content against a white background, preserving padding in output pixels. */
export function trimWhiteCanvasMargins(canvas: HTMLCanvasElement, padding: number): HTMLCanvasElement {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas context unavailable');
  const { width, height } = canvas;
  const { data } = ctx.getImageData(0, 0, width, height);
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (data[i + 3] === 0 || (data[i] === 255 && data[i + 1] === 255 && data[i + 2] === 255)) continue;
      left = Math.min(left, x); top = Math.min(top, y);
      right = Math.max(right, x); bottom = Math.max(bottom, y);
    }
  }
  // An empty or completely erased board keeps its original dimensions.
  if (right < left) return canvas;
  const inset = Math.max(0, Math.ceil(padding));
  const output = document.createElement('canvas');
  output.width = right - left + 1 + inset * 2;
  output.height = bottom - top + 1 + inset * 2;
  const target = output.getContext('2d');
  if (!target) throw new Error('Canvas context unavailable');
  target.fillStyle = '#ffffff';
  target.fillRect(0, 0, output.width, output.height);
  target.drawImage(canvas, left, top, right - left + 1, bottom - top + 1, inset, inset, right - left + 1, bottom - top + 1);
  return output;
}

/**
 * Copies an image (from a data URL or blob URL) directly to the system clipboard.
 * Prefers the native Tauri command `copy_chat_image` (bypasses browser clipboard permission quirks
 * and sets native Win32 CF_DIB/CF_DIBV5), and falls back to `navigator.clipboard.write` for browser dev mode.
 */
export async function copyImageToClipboard(src: string): Promise<boolean> {
  try {
    const dataBase64 = await imageSrcToBase64(src);
    try {
      await invoke('copy_chat_image', { dataBase64 });
      showToast(t("message.copyImageSuccess"), 3500, 'success');
      return true;
    } catch (invokeError) {
      if (typeof navigator !== 'undefined' && navigator.clipboard && typeof ClipboardItem !== 'undefined') {
        const response = await fetch(src);
        const originalBlob = await response.blob();
        const pngBlob = await blobToPngBlob(originalBlob);
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
        showToast(t("message.copyImageSuccess"), 3500, 'success');
        return true;
      }
      throw invokeError;
    }
  } catch (error) {
    console.warn('[Clipboard] Failed to copy image:', error);
    showToast(t("message.copyImageError"), 3500, 'error');
    return false;
  }
}
