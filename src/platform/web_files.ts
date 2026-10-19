import { sha256Hex } from '../apps/whiteboard_image.ts';
import type { NativeChatFile } from '../p2p/group_room.ts';
import { blobToDataUrl } from '../core/image_clipboard.ts';

export const WEB_FILE_LIMIT = 256 * 1024 * 1024;
const sources = new Map<string, { blob: Blob; file: NativeChatFile }>();
const downloads = new Map<string, { name: string; size: number; hash: string; offset: number; chunks: Uint8Array[] }>();
const remembered = new Map<string, NativeChatFile>();

export function pickBrowserFile(accept = ''): Promise<File | null> {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = accept; input.autocomplete = 'off';
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function registerBrowserFile(blob: Blob, name: string): Promise<NativeChatFile> {
  if (blob.size > WEB_FILE_LIMIT || sources.size >= 32 ||
      [...sources.values()].reduce((sum, source) => sum + source.blob.size, 0) + blob.size > WEB_FILE_LIMIT) throw new Error('web.fileLimit');
  const id = crypto.randomUUID();
  const file = { id, path: id, name, size: blob.size,
    hash: await sha256Hex(new Uint8Array(await blob.arrayBuffer())), isImage: blob.type.startsWith('image/') };
  sources.set(id, { blob, file });
  return file;
}

export async function browserFileCommand(command: string, args: Record<string, any>, options?: { headers?: Record<string, string> }): Promise<unknown> {
  const source = sources.get(args.id);
  switch (command) {
    case 'pick_chat_file': {
      const file = await pickBrowserFile();
      return file ? registerBrowserFile(file, file.name) : null;
    }
    case 'inspect_chat_file': if (!source) throw new Error('Source unavailable'); return source.file;
    case 'discard_chat_file': sources.delete(args.id); return;
    case 'remember_chat_file_source': remembered.set(`${args.roomId}/${args.messageId}`, sources.get(args.sourceId)!.file); return;
    case 'restore_chat_file_source': return remembered.get(`${args.roomId}/${args.messageId}`) ?? null;
    case 'read_chat_file_bytes':
    case 'read_chat_file_chunk': {
      if (!source || !Number.isSafeInteger(args.offset) || args.offset < 0 || !Number.isSafeInteger(args.length) || args.length < 0 || args.length > 4 * 1024 * 1024) throw new Error('Invalid read');
      const blob = source.blob.slice(args.offset, args.offset + args.length);
      return command.endsWith('_bytes') ? blob.arrayBuffer() : (await blobToDataUrl(blob)).split(',')[1];
    }
    case 'read_chat_image_preview':
      if (!source || !source.file.isImage || source.blob.size > 8 * 1024 * 1024) throw new Error('Invalid image');
      return (await blobToDataUrl(source.blob)).split(',')[1];
    case 'choose_chat_download':
      if (!Number.isSafeInteger(args.size) || args.size < 0 || args.size > WEB_FILE_LIMIT || downloads.size >= 8 ||
          [...downloads.values()].reduce((sum, item) => sum + item.size, 0) + args.size > WEB_FILE_LIMIT) throw new Error('web.fileLimit');
      downloads.set(args.id, { name: args.name, size: args.size, hash: args.hash, offset: 0, chunks: [] }); return true;
    case 'write_chat_download_bytes':
    case 'write_chat_download_chunk': {
      const binary = command.endsWith('_bytes');
      const id = binary ? options?.headers?.['x-chat-download-id'] : args.id;
      const offset = binary ? Number(options?.headers?.['x-chat-offset']) : args.offset;
      const entry = downloads.get(id ?? '');
      const bytes = binary ? new Uint8Array(args as unknown as Uint8Array) : Uint8Array.from(atob(args.data), c => c.charCodeAt(0));
      if (!entry || offset !== entry.offset || bytes.length > entry.size - offset) throw new Error('Invalid download offset');
      entry.chunks.push(bytes.slice()); entry.offset += bytes.length; return entry.offset;
    }
    case 'finish_chat_download': {
      const entry = downloads.get(args.id);
      if (!entry || entry.offset !== entry.size) throw new Error('Incomplete download');
      try {
        const blob = new Blob(entry.chunks as BlobPart[]);
        if (await sha256Hex(new Uint8Array(await blob.arrayBuffer())) !== entry.hash) throw new Error('File hash mismatch');
        downloadBlob(blob, entry.name); return entry.name;
      } finally { downloads.delete(args.id); }
    }
    case 'cancel_chat_download': downloads.delete(args.id); return;
    case 'cancel_direct_chat_file': return;
    default: throw new Error('web.desktopOnly');
  }
}
