import { invoke } from '@tauri-apps/api/core';
import { blobToDataUrl } from '../core/image_clipboard.ts';
import { PROFILE_CHUNK, PROFILE_MAX_BYTES, validProfileHash } from '../core/profile_image.ts';

export const WHITEBOARD_IMAGE_MAX_SIDE = 1920;
export interface WhiteboardImageRecord { hash: string; data: string; width: number; height: number }

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IHDR_TAG = [0x49, 0x48, 0x44, 0x52];
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function stripDataPrefix(input: string): string {
  const index = input.indexOf(';base64,');
  return (index >= 0 ? input.slice(index + 8) : input).trim();
}

export function decodeBase64(encoded: string): Uint8Array {
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

export function validHttpImageUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const parsed = new URL(value.trim());
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
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

export async function pickWhiteboardImage(): Promise<WhiteboardImageRecord | null> {
  return invoke<WhiteboardImageRecord | null>('pick_whiteboard_image');
}

export async function prepareWhiteboardImage(
  data?: string,
  path?: string,
  url?: string,
): Promise<WhiteboardImageRecord> {
  if ((typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) || path || url) {
    return invoke<WhiteboardImageRecord>('paste_whiteboard_image', {
      data: data ?? null,
      path: path ?? null,
      url: url ?? null,
    });
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
    if (item.type?.startsWith('image/')) {
      const file = item.getAsFile?.();
      if (file) return blobToDataUrl(file);
    }
  }
  for (const file of Array.from(clipboardData.files ?? [])) {
    if (file.type.startsWith('image/')) return blobToDataUrl(file);
  }
  return undefined;
}

interface PendingImage {
  hash: string;
  peer: string;
  token: string;
  parts: string[];
  length: number;
  size: number;
  until: number;
  validating: boolean;
}

export interface PeerImageTransportContext {
  localView?: boolean;
  localActor: string;
  emit(payload: unknown): void;
  send?(payload: unknown, target: string): Promise<void>;
  changed(): void;
}

export class PeerImageStore {
  readonly images = new Map<string, string>();
  private imageSizes = new Map<string, number>();
  private imageSources = new Map<string, string>();
  private pendingImages = new Map<string, PendingImage>();
  private imageAttempts = new Map<string, number>();
  private lastImageSend = new Map<string, number>();
  private sendingPeers = new Set<string>();
  private queuedRequests = new Map<string, { hash: string; token: string; actor: string }>();
  private participants = new Set<string>();
  private destroyed = false;
  private expiry: ReturnType<typeof setInterval>;
  private context: PeerImageTransportContext;
  private getNeededHashes: () => Iterable<string>;

  constructor(context: PeerImageTransportContext, getNeededHashes: () => Iterable<string>) {
    this.context = context;
    this.getNeededHashes = getNeededHashes;
    this.expiry = setInterval(() => {
      for (const [hash, pending] of this.pendingImages) {
        if (pending.until < Date.now() && !pending.validating) this.pendingImages.delete(hash);
      }
      if (this.pendingImages.size < 4) this.requestWaitingImages();
    }, 1000);
    (this.expiry as unknown as { unref?: () => void }).unref?.();
  }

  imageUrl(hash: string): string | undefined {
    const data = this.images.get(hash);
    return data ? `data:image/png;base64,${data}` : undefined;
  }

  cacheImage(hash: string, data: string): void {
    const clean = data.startsWith('data:image/png;base64,') ? data.slice(22) : data;
    if (!validProfileHash(hash) || !clean || clean.length > Math.ceil(PROFILE_MAX_BYTES / 3) * 4) return;
    this.images.delete(hash);
    this.imageSizes.delete(hash);
    while (this.images.size && [...this.imageSizes.values()].reduce((sum, n) => sum + n, 0) + clean.length > MAX_CACHE_BYTES) {
      const oldest = this.images.keys().next().value!;
      this.images.delete(oldest);
      this.imageSizes.delete(oldest);
    }
    this.images.set(hash, clean);
    this.imageSizes.set(hash, clean.length);
  }

  setParticipants(participants: Iterable<string>): void {
    this.participants = new Set(participants);
    for (const [hash, pending] of this.pendingImages) {
      if (pending.peer && !this.participants.has(pending.peer) && !pending.validating) this.pendingImages.delete(hash);
    }
    this.requestWaitingImages();
  }

  private sendToPeer(payload: unknown, peerId: string): void {
    if (this.context.send && peerId && peerId !== this.context.localActor && this.participants.has(peerId)) {
      void this.context.send(payload, peerId).catch(() => {});
    } else {
      this.context.emit(payload);
    }
  }

  requestWaitingImages(preferredActor?: string): void {
    if (this.destroyed || this.context.localView) return;
    const needed = new Set<string>();
    for (const hash of this.getNeededHashes()) {
      if (validProfileHash(hash) && !this.images.has(hash)) {
        needed.add(hash);
        if (preferredActor && preferredActor !== this.context.localActor) {
          this.imageSources.set(hash, preferredActor);
        }
      }
    }
    for (const hash of needed) {
      if (this.pendingImages.has(hash) || this.pendingImages.size >= 4) continue;
      const peer = this.imageSources.get(hash) ?? [...this.participants].find(p => p !== this.context.localActor) ?? '';
      const attemptKey = `${peer}:${hash}`;
      const count = this.imageAttempts.get(attemptKey) ?? 0;
      if (count >= 2) continue;
      this.imageAttempts.set(attemptKey, count + 1);
      const token = crypto.randomUUID();
      this.pendingImages.set(hash, { hash, peer, token, parts: [], length: 0, size: 0, until: Date.now() + 60_000, validating: false });
      this.sendToPeer({ imageRequest: { hash, token } }, peer);
    }
  }

  handleImageRequest(req: unknown, actor: string): void {
    if (this.destroyed || !req || typeof req !== 'object') return;
    if (this.participants.size > 0 && !this.participants.has(actor) && actor !== this.context.localActor) return;
    const { hash, token } = req as { hash?: unknown; token?: unknown };
    if (!validProfileHash(hash) || typeof token !== 'string' || !UUID_RE.test(token)) return;
    const data = this.images.get(hash);
    if (!data) return;
    if (this.sendingPeers.has(actor)) {
      this.queuedRequests.set(actor, { hash, token, actor });
      return;
    }
    const sendKey = `${actor}:${hash}`;
    const lastAt = this.lastImageSend.get(sendKey) ?? 0;
    if (Date.now() - lastAt < 3000) return;
    this.lastImageSend.set(sendKey, Date.now());
    this.sendingPeers.add(actor);
    void (async () => {
      try {
        for (let offset = 0; offset < data.length; offset += PROFILE_CHUNK) {
          if (this.destroyed || (this.participants.size > 0 && !this.participants.has(actor) && actor !== this.context.localActor)) break;
          this.sendToPeer({
            imageChunk: {
              hash,
              token,
              size: data.length,
              index: offset / PROFILE_CHUNK,
              data: data.slice(offset, offset + PROFILE_CHUNK),
            },
          }, actor);
          await Promise.resolve();
        }
      } finally {
        this.sendingPeers.delete(actor);
        const next = this.queuedRequests.get(actor);
        this.queuedRequests.delete(actor);
        if (next) this.handleImageRequest(next, next.actor);
      }
    })();
  }

  handleImageChunk(chunk: unknown, actor: string): void {
    if (this.destroyed || !chunk || typeof chunk !== 'object') return;
    const c = chunk as { hash?: unknown; token?: unknown; size?: unknown; index?: unknown; data?: unknown };
    if (!validProfileHash(c.hash) || typeof c.token !== 'string' || !UUID_RE.test(c.token)) return;
    const pending = this.pendingImages.get(c.hash);
    if (!pending || pending.validating || pending.until < Date.now() || pending.token !== c.token ||
      (pending.peer && pending.peer !== actor)) return;
    const size = c.size as number;
    if (!Number.isInteger(size) || size <= 0 || size > Math.ceil(PROFILE_MAX_BYTES / 3) * 4 ||
      (pending.size !== 0 && pending.size !== size)) return;
    if (c.index !== pending.parts.length || typeof c.data !== 'string' ||
      c.data.length !== Math.min(PROFILE_CHUNK, size - pending.length) ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(c.data)) return;
    pending.size = size;
    pending.parts.push(c.data);
    pending.length += c.data.length;
    if (pending.length === size) {
      pending.validating = true;
      const assembled = pending.parts.join('');
      const targetHash = pending.hash;
      void verifyWhiteboardPng(assembled, targetHash)
        .then(verified => {
          if (this.destroyed) return;
          this.cacheImage(targetHash, verified.data);
          this.context.changed();
        })
        .catch(() => {})
        .finally(() => {
          if (this.pendingImages.get(targetHash) === pending) this.pendingImages.delete(targetHash);
          this.requestWaitingImages();
        });
    }
  }

  destroy(): void {
    this.destroyed = true;
    clearInterval(this.expiry);
    this.pendingImages.clear();
    this.queuedRequests.clear();
  }
}
