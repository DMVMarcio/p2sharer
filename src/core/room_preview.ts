import { validProfileColor } from './profile_image.ts';

export interface RoomPreviewParticipant { id: string; name: string; color: string; avatar?: string }
export interface RoomPreview { name: string; protected: boolean; participants: RoomPreviewParticipant[] }

function validPreviewAvatar(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > 8192 ||
      !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(value)) return false;
  try {
    const bytes = Uint8Array.from(atob(value.slice('data:image/png;base64,'.length)), character => character.charCodeAt(0));
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    if (bytes.length < 33 || !signature.every((byte, index) => bytes[index] === byte)) return false;
    const header = new DataView(bytes.buffer);
    if (header.getUint32(8) !== 13 || header.getUint32(12) !== 0x49484452) return false;
    const width = header.getUint32(16), height = header.getUint32(20);
    return width > 0 && width <= 32 && height > 0 && height <= 32;
  } catch { return false; }
}

export function validRoomPreview(value: unknown): value is RoomPreview {
  if (!value || typeof value !== 'object') return false;
  const data = value as RoomPreview;
  return typeof data.name === 'string' && data.name.length <= 100 && typeof data.protected === 'boolean' &&
    Array.isArray(data.participants) && data.participants.length <= 64 && data.participants.every(person =>
      person && typeof person.id === 'string' && person.id.length <= 100 &&
      typeof person.name === 'string' && person.name.length <= 100 && validProfileColor(person.color) &&
      (person.avatar === undefined || validPreviewAvatar(person.avatar))) &&
    new Set(data.participants.map(person => person.id)).size === data.participants.length;
}

/** Send only a small static thumbnail, never the full profile animation. */
export async function profileThumbnail(url?: string): Promise<string | undefined> {
  if (!url) return undefined;
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 32;
    canvas.getContext('2d')!.drawImage(image, 0, 0, 32, 32);
    const data = canvas.toDataURL('image/png');
    return data.length <= 8192 ? data : undefined;
  } catch { return undefined; }
}
