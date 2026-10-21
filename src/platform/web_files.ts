import type { NativeChatFile } from '../p2p/group_room.ts';
import { blobToDataUrl } from '../core/image_clipboard.ts';

export const WEB_FILE_LIMIT = Number.MAX_SAFE_INTEGER;

export function createSha256() {
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const buffer = new Uint8Array(64);
  let bufferLen = 0;
  let totalBytes = 0;
  const W = new Uint32Array(64);

  function processBlock(block: Uint8Array, offset: number) {
    for (let t = 0; t < 16; t++) {
      const idx = offset + (t << 2);
      W[t] = ((block[idx] << 24) | (block[idx + 1] << 16) | (block[idx + 2] << 8) | block[idx + 3]) >>> 0;
    }
    for (let t = 16; t < 64; t++) {
      const s0 = ((W[t - 15] >>> 7) | (W[t - 15] << 25)) ^ ((W[t - 15] >>> 18) | (W[t - 15] << 14)) ^ (W[t - 15] >>> 3);
      const s1 = ((W[t - 2] >>> 17) | (W[t - 2] << 15)) ^ ((W[t - 2] >>> 19) | (W[t - 2] << 13)) ^ (W[t - 2] >>> 10);
      W[t] = (W[t - 16] + s0 + W[t - 7] + s1) >>> 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let t = 0; t < 64; t++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[t] + W[t]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return {
    update(chunk: Uint8Array) {
      let offset = 0;
      totalBytes += chunk.length;
      if (bufferLen > 0) {
        const needed = 64 - bufferLen;
        if (chunk.length >= needed) {
          buffer.set(chunk.subarray(0, needed), bufferLen);
          processBlock(buffer, 0);
          offset += needed;
          bufferLen = 0;
        } else {
          buffer.set(chunk, bufferLen);
          bufferLen += chunk.length;
          return;
        }
      }
      while (offset + 64 <= chunk.length) {
        processBlock(chunk, offset);
        offset += 64;
      }
      if (offset < chunk.length) {
        buffer.set(chunk.subarray(offset), 0);
        bufferLen = chunk.length - offset;
      }
    },
    digestHex(): string {
      const totalBits = totalBytes * 8;
      buffer[bufferLen++] = 0x80;
      if (bufferLen > 56) {
        buffer.fill(0, bufferLen);
        processBlock(buffer, 0);
        bufferLen = 0;
      }
      buffer.fill(0, bufferLen, 56);
      const highBits = Math.floor(totalBits / 0x100000000);
      const lowBits = totalBits >>> 0;
      buffer[56] = (highBits >>> 24) & 0xff;
      buffer[57] = (highBits >>> 16) & 0xff;
      buffer[58] = (highBits >>> 8) & 0xff;
      buffer[59] = highBits & 0xff;
      buffer[60] = (lowBits >>> 24) & 0xff;
      buffer[61] = (lowBits >>> 16) & 0xff;
      buffer[62] = (lowBits >>> 8) & 0xff;
      buffer[63] = lowBits & 0xff;
      processBlock(buffer, 0);
      const out = [h0, h1, h2, h3, h4, h5, h6, h7];
      return out.map(x => x.toString(16).padStart(8, '0')).join('');
    },
  };
}

export async function computeBlobSha256(
  blob: Blob,
  signal?: AbortSignal,
  onProgress?: (bytes: number) => void
): Promise<string> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  if (blob.size <= 32 * 1024 * 1024) {
    const buffer = await blob.arrayBuffer();
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  }
  const hasher = createSha256();
  const chunkSize = 4 * 1024 * 1024;
  let offset = 0;
  while (offset < blob.size) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const slice = blob.slice(offset, Math.min(blob.size, offset + chunkSize));
    const buf = new Uint8Array(await slice.arrayBuffer());
    hasher.update(buf);
    offset += buf.length;
    onProgress?.(offset);
    if (offset % (16 * 1024 * 1024) === 0) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
  return hasher.digestHex();
}

interface BrowserDownloadEntry {
  name: string;
  size: number;
  hash: string;
  offset: number;
  hasher: ReturnType<typeof createSha256>;
  writable?: {
    write(param: { type: 'write'; position: number; data: Uint8Array } | Uint8Array): Promise<void>;
    close(): Promise<void>;
    abort(): Promise<void>;
  };
  chunks?: Uint8Array[];
}

const sources = new Map<string, { blob: Blob; file: NativeChatFile }>();
const downloads = new Map<string, BrowserDownloadEntry>();
const remembered = new Map<string, NativeChatFile>();

export function pickBrowserFiles(accept = '', multiple = true): Promise<File[]> {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.autocomplete = 'off';
    input.onchange = () => resolve(Array.from(input.files ?? []));
    input.oncancel = () => resolve([]);
    input.click();
  });
}

export function pickBrowserFile(accept = ''): Promise<File | null> {
  return pickBrowserFiles(accept, false).then(files => files[0] ?? null);
}

export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function registerBrowserFile(blob: Blob, name: string, signal?: AbortSignal): Promise<NativeChatFile> {
  if (!blob || !(blob instanceof Blob)) throw new Error('Invalid file');
  if (sources.size >= 128) throw new Error('web.fileLimit');
  const id = crypto.randomUUID();
  const hash = await computeBlobSha256(blob, signal);
  const file: NativeChatFile = {
    id,
    path: id,
    name,
    size: blob.size,
    hash,
    isImage: blob.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(name),
  };
  sources.set(id, { blob, file });
  return file;
}

export async function browserFileCommand(
  command: string,
  args: Record<string, any>,
  options?: { headers?: Record<string, string> }
): Promise<unknown> {
  const source = sources.get(args.id);
  switch (command) {
    case 'pick_chat_file': {
      const files = await pickBrowserFiles();
      if (!files.length) return null;
      if (files.length > 32) throw new Error('message.3ac7f82e95fe');
      const registered: NativeChatFile[] = [];
      for (const file of files) {
        registered.push(await registerBrowserFile(file, file.name));
      }
      return registered.length === 1 ? registered[0] : registered;
    }
    case 'inspect_chat_file':
      if (!source) throw new Error('Source unavailable');
      return source.file;
    case 'discard_chat_file':
      sources.delete(args.id);
      return;
    case 'remember_chat_file_source':
      remembered.set(`${args.roomId}/${args.messageId}`, sources.get(args.sourceId)!.file);
      return;
    case 'restore_chat_file_source':
      return remembered.get(`${args.roomId}/${args.messageId}`) ?? null;
    case 'read_chat_file_bytes':
    case 'read_chat_file_chunk': {
      if (
        !source ||
        !Number.isSafeInteger(args.offset) ||
        args.offset < 0 ||
        !Number.isSafeInteger(args.length) ||
        args.length < 0 ||
        args.length > 4 * 1024 * 1024
      ) {
        throw new Error('Invalid read');
      }
      const blob = source.blob.slice(args.offset, args.offset + args.length);
      return command.endsWith('_bytes') ? blob.arrayBuffer() : (await blobToDataUrl(blob)).split(',')[1];
    }
    case 'read_chat_image_preview':
      if (!source || !source.file.isImage || source.blob.size > 8 * 1024 * 1024) throw new Error('Invalid image');
      return (await blobToDataUrl(source.blob)).split(',')[1];
    case 'choose_chat_download': {
      if (!Number.isSafeInteger(args.size) || args.size < 0) throw new Error('Invalid download size');
      if (downloads.size >= 8) throw new Error('Too many active transfers');

      let writable: BrowserDownloadEntry['writable'];
      const picker = typeof window !== 'undefined' ? (window as any).showSaveFilePicker : (globalThis as any).showSaveFilePicker;
      if (typeof picker === 'function') {
        try {
          const handle = await picker({ suggestedName: args.name });
          writable = await handle.createWritable();
        } catch (err: any) {
          if (err?.name === 'AbortError') return false;
        }
      }

      const hasher = createSha256();
      downloads.set(args.id, {
        name: args.name,
        size: args.size,
        hash: args.hash,
        offset: 0,
        hasher,
        writable,
        chunks: writable ? undefined : [],
      });
      return true;
    }
    case 'write_chat_download_bytes':
    case 'write_chat_download_chunk': {
      const binary = command.endsWith('_bytes');
      const id = binary ? options?.headers?.['x-chat-download-id'] : args.id;
      const offset = binary ? Number(options?.headers?.['x-chat-offset']) : args.offset;
      const entry = downloads.get(id ?? '');
      const bytes = binary
        ? new Uint8Array(args as unknown as ArrayLike<number>)
        : Uint8Array.from(atob(args.data), c => c.charCodeAt(0));
      if (!entry || offset !== entry.offset || bytes.length > entry.size - offset) {
        throw new Error('Invalid download offset');
      }
      if (entry.writable) {
        await entry.writable.write({ type: 'write', position: offset, data: bytes });
      } else if (entry.chunks) {
        entry.chunks.push(bytes.slice());
      }
      entry.hasher.update(bytes);
      entry.offset += bytes.length;
      return entry.offset;
    }
    case 'finish_chat_download': {
      const entry = downloads.get(args.id);
      if (!entry || entry.offset !== entry.size) throw new Error('Incomplete download');
      try {
        if (entry.writable) {
          await entry.writable.close();
        }
        const digest = entry.hasher.digestHex();
        if (digest !== entry.hash) throw new Error('File hash mismatch');
        if (!entry.writable && entry.chunks) {
          const blob = new Blob(entry.chunks as BlobPart[]);
          downloadBlob(blob, entry.name);
        }
        return entry.name;
      } finally {
        downloads.delete(args.id);
      }
    }
    case 'cancel_chat_download': {
      const entry = downloads.get(args.id);
      if (entry?.writable) {
        await entry.writable.abort().catch(() => {});
      }
      downloads.delete(args.id);
      return;
    }
    case 'cancel_direct_chat_file':
      return;
    default:
      throw new Error('web.desktopOnly');
  }
}
