import { t } from '../i18n/index.ts';
import { blobToDataUrl } from '../core/image_clipboard.ts';
import { decodeBase64, inspectPngBytes, sha256Hex, verifyWhiteboardPng } from '../apps/whiteboard_image.ts';
import { browserRecord } from './web_storage.ts';
import { browserFileCommand, downloadBlob, pickBrowserFile } from './web_files.ts';
import type { ProfileImage } from '../core/profile_image.ts';
import type { SavedNote } from '../apps/NotepadFilesDialog.ts';
import { cropDimensions } from '../core/profile_crop.ts';

const drafts = new Map<string, Blob>();

function imageDataBlob(data: string): Blob {
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/s.exec(data);
  if (!match) throw new Error('Invalid image');
  return new Blob([decodeBase64(match[2]) as BlobPart], { type: match[1] });
}

async function normalizeImage(blob: Blob, banner = false, crop?: { x: number; y: number; size: number }) {
  if (blob.size > 8 * 1024 * 1024) throw new Error('Image too large');
  const bitmap = await createImageBitmap(blob);
  try {
    if (bitmap.width * bitmap.height > 40_000_000) throw new Error('Image dimensions exceed safety limits');
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 1920 / Math.max(bitmap.width, bitmap.height));
    canvas.width = crop ? banner ? 768 : 256 : Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = crop ? 256 : Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas unavailable');
    if (crop) {
      const { width, height } = cropDimensions(bitmap.width, bitmap.height, crop, banner ? 3 : 1);
      const x = Math.min(1, Math.max(0, crop.x)) * (bitmap.width - width);
      const y = Math.min(1, Math.max(0, crop.y)) * (bitmap.height - height);
      context.drawImage(bitmap, x, y, width, height, 0, 0, canvas.width, canvas.height);
    }
    else context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const data = canvas.toDataURL('image/png').split(',')[1];
    const bytes = decodeBase64(data);
    return { data, hash: await sha256Hex(bytes), width: canvas.width, height: canvas.height };
  } finally { bitmap.close(); }
}

/** Browser-owned storage and consent dialogs. Unsupported OS commands fail explicitly. */
export async function invokeBrowser(command: string, input?: unknown, options?: { headers?: Record<string, string> }): Promise<unknown> {
  // Native command arguments are validated again in each browser implementation.
  const args = (input ?? {}) as Record<string, any>;
  const library = args.library === 'whiteboard' ? 'whiteboard' : 'notes';
  const libraryKey = `library:${library}`;
  if (command.includes('chat_') || command === 'cancel_direct_chat_file') {
    try { return await browserFileCommand(command, args, options); }
    catch (error) { if (error instanceof Error && error.message.startsWith('web.')) throw new Error(t(error.message)); throw error; }
  }
  switch (command) {
    case 'list_room_records': return Object.values(await browserRecord<Record<string, string>>('rooms') ?? {});
    case 'save_room_record': await browserRecord<Record<string, string>>('rooms', rows => ({ ...rows, [args.roomId]: args.data })); return;
    case 'delete_room_record': await browserRecord<Record<string, string>>('rooms', rows => { const next = { ...rows }; delete next[args.roomId]; return next; }); return;
    case 'list_saved_notes': return { directory: t('web.localStorage'), notes: Object.values(await browserRecord<Record<string, SavedNote>>(libraryKey) ?? {}).sort((a, b) => b.updatedAt - a.updatedAt) };
    case 'read_saved_note': {
      const note = (await browserRecord<Record<string, SavedNote>>(libraryKey))?.[args.id];
      if (!note) throw new Error('Document unavailable'); return note;
    }
    case 'save_library_note':
    case 'rename_library_note':
    case 'delete_library_note': {
      let saved: SavedNote | undefined;
      await browserRecord<Record<string, SavedNote>>(libraryKey, rows => {
        const next = { ...rows }; const previous = next[args.id];
        if (args.expectedUpdatedAt !== undefined && (previous?.updatedAt ?? null) !== args.expectedUpdatedAt) throw new Error('Document changed');
        if (command === 'delete_library_note') { delete next[args.id]; return next; }
        if (typeof args.name !== 'string' || !args.name.trim() || args.name.length > 180) throw new Error('Invalid document name');
        const content = command === 'rename_library_note' ? previous?.content : args.content;
        if (typeof content !== 'string' || content.length > 16 * 1024 * 1024) throw new Error('Invalid document content');
        saved = { id: args.id, name: args.name.trim(), content, updatedAt: Math.max(Date.now(), (previous?.updatedAt ?? 0) + 1) };
        next[args.id] = saved; return next;
      });
      return saved;
    }
    case 'open_note_file': {
      const file = await pickBrowserFile(library === 'whiteboard' ? '.json' : '.txt,.md,.html,.htm');
      if (!file) return null;
      if (file.size > 16 * 1024 * 1024) throw new Error('Document too large');
      return [await file.text(), file.name.split('.').pop() === 'htm' ? 'html' : file.name.split('.').pop()];
    }
    case 'save_note_file': {
      if (!['html', 'md', 'txt', 'json', 'svg', 'png'].includes(args.format)) throw new Error('Invalid export format');
      const blob = args.format === 'png' ? imageDataBlob(args.content) : new Blob([args.content], { type: 'text/plain;charset=utf-8' });
      downloadBlob(blob, `P2Sharer.${args.format}`); return true;
    }
    case 'load_profile_image': return await browserRecord<ProfileImage>(args.banner ? 'banner' : 'profile') ?? null;
    case 'pick_profile_image': {
      const file = await pickBrowserFile('image/png,image/jpeg,image/webp,image/gif');
      if (!file) return null;
      const normalized = await normalizeImage(file);
      const blob = new Blob([decodeBase64(normalized.data) as BlobPart], { type: 'image/png' });
      const token = crypto.randomUUID(); drafts.set(token, blob);
      return { token, preview: `data:image/png;base64,${normalized.data}`, width: normalized.width, height: normalized.height };
    }
    case 'discard_profile_image': drafts.delete(args.token); return;
    case 'save_profile_image': {
      const key = args.banner ? 'banner' : 'profile';
      const image = args.token ? drafts.get(args.token) : undefined;
      if (args.token && !image) throw new Error('Image draft unavailable');
      const normalized = image && !args.remove ? await normalizeImage(image, args.banner, args.crop ?? { x: 0.5, y: 0.5, size: 1 }) : undefined;
      return browserRecord<ProfileImage>(key, previous => ({
        hash: args.remove ? '' : normalized?.hash ?? previous?.hash ?? '',
        data: args.remove ? '' : normalized?.data ?? previous?.data ?? '',
        color: args.color, cardColor: args.cardColor, bannerEnabled: args.bannerEnabled, bannerBlur: args.bannerBlur,
      }));
    }
    case 'validate_profile_image':
    case 'validate_profile_image_bytes': {
      const bytes = command.endsWith('_bytes') ? new Uint8Array(input as Uint8Array) : decodeBase64(args.data);
      const dimensions = inspectPngBytes(bytes);
      const hash = command.endsWith('_bytes') ? options?.headers?.['x-profile-hash'] : args.hash;
      const banner = command.endsWith('_bytes') ? options?.headers?.['x-profile-banner'] === 'true' : args.banner === true;
      const validDimensions = banner ? dimensions.width === dimensions.height * 3 && dimensions.width <= 960
        : dimensions.width === dimensions.height && dimensions.width <= 512;
      if (!validDimensions || await sha256Hex(bytes) !== hash) throw new Error('Invalid image');
      const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: 'image/png' }));
      bitmap.close();
      return blobToDataUrl(new Blob([bytes as BlobPart], { type: 'image/png' }));
    }
    case 'pick_whiteboard_image': {
      const file = await pickBrowserFile('image/png,image/jpeg,image/webp,image/gif');
      return file ? normalizeImage(file) : null;
    }
    case 'paste_whiteboard_image': {
      if (args.path) throw new Error(t('web.desktopOnly'));
      if (typeof args.data === 'string' && args.data.startsWith('data:')) return normalizeImage(imageDataBlob(args.data));
      const url = new URL(args.url ?? args.data);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid image URL');
      const response = await fetch(url); if (!response.ok) throw new Error('Image unavailable');
      return normalizeImage(await response.blob());
    }
    case 'validate_whiteboard_image': return verifyWhiteboardPng(args.data, args.hash);
    default: throw new Error(t('web.desktopOnly'));
  }
}
