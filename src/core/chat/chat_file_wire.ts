import { CHAT_FILE_CHUNK_BYTES } from './chat_file_limits.ts';

export interface SignedFileChunk {
  requestId: string;
  messageId: string;
  offset: number;
  hash: string;
  signature: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_HEADER_BYTES = 512;

export function fileChunkSignatureData(header: Pick<SignedFileChunk, 'requestId' | 'messageId' | 'offset' | 'hash'>): unknown[] {
  return [header.requestId, header.messageId, header.offset, header.hash];
}

export async function hashFileChunk(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
  return Array.from(digest, (value) => value.toString(16).padStart(2, '0')).join('');
}

export function fastFileChunkTag(bytes: Uint8Array, sessionToken: string, offset: number): string {
  let h0 = (0x243f6a88 ^ (offset & 0xffffffff)) >>> 0;
  let h1 = (0x85a308d3 ^ Math.floor(offset / 0x100000000)) >>> 0;
  let h2 = (0x13198a2e ^ bytes.length) >>> 0;
  let h3 = 0x03707344 >>> 0;
  let h4 = 0xa4093822 >>> 0;
  let h5 = 0x299f31d0 >>> 0;
  let h6 = 0x082efa98 >>> 0;
  let h7 = 0xec4e6c89 >>> 0;
  for (let i = 0; i < sessionToken.length; i++) {
    const code = sessionToken.charCodeAt(i);
    h0 = Math.imul(h0 ^ code, 0x9e3779b1) >>> 0;
    h1 = Math.imul(h1 ^ ((h0 >>> 16) + code), 0x85ebca77) >>> 0;
  }
  const len = bytes.length;
  let i = 0;
  for (; i + 4 <= len; i += 4) {
    const word = (bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24)) >>> 0;
    h0 = Math.imul(h0 ^ word, 0x85ebca77) >>> 0;
    h1 = Math.imul(h1 ^ ((word >>> 11) | (word << 21)), 0xc2b2ae3d) >>> 0;
    h2 = Math.imul(h2 + word, 0x27d4eb2f) >>> 0;
    h3 = Math.imul(h3 ^ (h0 + i), 0x165667b1) >>> 0;
    h4 = (h4 + Math.imul(word ^ h1, 0x9e3779b1)) >>> 0;
    h5 = (h5 ^ Math.imul(word + h2, 0x85ebca77)) >>> 0;
    h6 = (h6 + Math.imul(word ^ h3, 0xc2b2ae3d)) >>> 0;
    h7 = (h7 ^ Math.imul(word + h4, 0x27d4eb2f)) >>> 0;
  }
  for (; i < len; i++) {
    const byte = bytes[i];
    h0 = Math.imul(h0 ^ byte, 0x85ebca77) >>> 0;
    h1 = Math.imul(h1 + byte, 0xc2b2ae3d) >>> 0;
    h2 = Math.imul(h2 ^ (byte << 7), 0x27d4eb2f) >>> 0;
    h3 = Math.imul(h3 + (byte << 13), 0x165667b1) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((word) => (word >>> 0).toString(16).padStart(8, '0'))
    .join('');
}

export function decodeFileBase64(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function encodeFileBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
  }
  return btoa(parts.join(''));
}

export function encodeSignedFileChunk(header: SignedFileChunk, bytes: Uint8Array): Uint8Array {
  const metadata = encoder.encode(JSON.stringify(header));
  if (metadata.length > MAX_HEADER_BYTES || bytes.length === 0 || bytes.length > CHAT_FILE_CHUNK_BYTES) {
    throw new Error('Invalid file chunk');
  }
  const packet = new Uint8Array(2 + metadata.length + bytes.length);
  packet[0] = metadata.length >> 8;
  packet[1] = metadata.length & 255;
  packet.set(metadata, 2);
  packet.set(bytes, 2 + metadata.length);
  return packet;
}

export function decodeSignedFileChunk(packet: Uint8Array): { header: SignedFileChunk; bytes: Uint8Array } | null {
  if (packet.length < 3 || packet.length > CHAT_FILE_CHUNK_BYTES + MAX_HEADER_BYTES + 2) return null;
  const headerLength = packet[0] * 256 + packet[1];
  if (headerLength === 0 || headerLength > MAX_HEADER_BYTES || 2 + headerLength >= packet.length) return null;
  try {
    const header: SignedFileChunk = JSON.parse(decoder.decode(packet.subarray(2, 2 + headerLength)));
    if (!header || typeof header.requestId !== 'string' || header.requestId.length === 0 || header.requestId.length > 80 ||
        typeof header.messageId !== 'string' || header.messageId.length === 0 || header.messageId.length > 80 ||
        !Number.isSafeInteger(header.offset) || header.offset < 0 ||
        typeof header.hash !== 'string' || !/^[0-9a-f]{64}$/.test(header.hash) ||
        typeof header.signature !== 'string' || !/^[0-9a-f]{128}$/.test(header.signature)) return null;
    const bytes = packet.subarray(2 + headerLength);
    return bytes.length <= CHAT_FILE_CHUNK_BYTES ? { header, bytes } : null;
  } catch { return null; }
}
