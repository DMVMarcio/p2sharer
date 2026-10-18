import { invoke } from '@tauri-apps/api/core';
import { blobToDataUrl } from '../core/image_clipboard.ts';
import { PROFILE_MAX_BYTES, validProfileHash } from '../core/profile_image.ts';

export const WHITEBOARD_IMAGE_MAX_SIDE = 1920;
export interface WhiteboardImageRecord { hash: string; data: string; width: number; height: number }

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IHDR_TAG = [0x49, 0x48, 0x44, 0x52];

function stripDataPrefix(input: string): string {
  const index = input.indexOf(';base64,');
  return (index >= 0 ? input.slice(index + 8) : input).trim();
}

function decodeBase64(encoded: string): Uint8Array {
  if (!encoded || encoded.length > Math.ceil(PROFILE_MAX_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new Error('Invalid image');
  }
  return Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

export function inspectPngBytes(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.byteLength < 33 || bytes.byteLength > PROFILE_MAX_BYTES) throw new Error('Invalid image');
  for (let i = 0; i < PNG_MAGIC.length; i++) if (bytes[i] !== PNG_MAGIC[i]) throw new Error('Unsupported image format');
  for (let i = 0; i < IHDR_TAG.length; i++) if (bytes[12 + i] !== IHDR_TAG[i]) throw new Error('Invalid image');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16, false), height = view.getUint32(20, false);
  if (width < 1 || height < 1 || width > WHITEBOARD_IMAGE_MAX_SIDE || height > WHITEBOARD_IMAGE_MAX_SIDE) {
    throw new Error('Image dimensions exceed safety limits');
  }
  return { width, height };
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', copy));
  return Array.from(digest, b => b.toString(16).padStart(2, '0')).join('');
}

export async function verifyWhiteboardPng(data: string, expectedHash: string): Promise<WhiteboardImageRecord> {
  if (!validProfileHash(expectedHash)) throw new Error('Invalid image');
  const clean = stripDataPrefix(data);
  const bytes = decodeBase64(clean);
  const { width, height } = inspectPngBytes(bytes);
  const actualHash = await sha256Hex(bytes);
  if (actualHash !== expectedHash) throw new Error('Invalid image');
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    return invoke<WhiteboardImageRecord>('validate_whiteboard_image', { data: clean, hash: expectedHash });
  }
  return { hash: expectedHash, data: encodeBase64(bytes), width, height };
}

export async function prepareWhiteboardImage(data?: string, path?: string): Promise<WhiteboardImageRecord> {
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    return invoke<WhiteboardImageRecord>('paste_whiteboard_image', { data: data ?? null, path: path ?? null });
  }
  if (!data) throw new Error('whiteboard.noClipboardImage');
  const clean = stripDataPrefix(data);
  const bytes = decodeBase64(clean);
  const { width, height } = inspectPngBytes(bytes);
  const hash = await sha256Hex(bytes);
  return { hash, data: encodeBase64(bytes), width, height };
}

export async function readClipboardImageDataUrl(clipboardData?: DataTransfer | null): Promise<string | undefined> {
  if (!clipboardData) return undefined;
  for (const item of Array.from(clipboardData.items ?? [])) {
    if (item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) return blobToDataUrl(file);
    }
  }
  for (const file of Array.from(clipboardData.files ?? [])) {
    if (file.type.startsWith('image/')) return blobToDataUrl(file);
  }
  return undefined;
}
