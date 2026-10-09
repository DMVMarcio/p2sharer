import { invoke } from '@tauri-apps/api/core';
import { t } from '../i18n';
import { showToast } from '../hooks/useToast';

/**
 * Converts a data URL, blob URL, or remote URL into a base64 data string.
 */
export async function imageSrcToBase64(src: string): Promise<string> {
  if (src.startsWith('data:')) {
    return src;
  }
  const response = await fetch(src);
  const blob = await response.blob();
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
async function blobToPngBlob(blob: Blob): Promise<Blob> {
  if (blob.type === 'image/png') return blob;
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
      ctx.drawImage(img, 0, 0);
      canvas.toBlob((pngBlob) => {
        if (pngBlob) resolve(pngBlob);
        else reject(new Error('Failed to render PNG blob'));
      }, 'image/png');
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load image for PNG conversion'));
    };
    img.src = url;
  });
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
      showToast(t("message.copyImageSuccess"));
      return true;
    } catch (invokeError) {
      if (typeof navigator !== 'undefined' && navigator.clipboard && typeof ClipboardItem !== 'undefined') {
        const response = await fetch(src);
        const originalBlob = await response.blob();
        const pngBlob = await blobToPngBlob(originalBlob);
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
        showToast(t("message.copyImageSuccess"));
        return true;
      }
      throw invokeError;
    }
  } catch (error) {
    console.warn('[Clipboard] Failed to copy image:', error);
    showToast(t("message.copyImageError"));
    return false;
  }
}
