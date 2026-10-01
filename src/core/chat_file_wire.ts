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
