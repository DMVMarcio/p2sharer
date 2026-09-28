import { invoke } from '@tauri-apps/api/core';
import { parseRoomInvite, type RoomIdentity } from './room_invite.ts';
import type { AuthorityTransfer, HostCommand } from './room_authority.ts';

export interface SavedRoom {
  roomId: string;
  invite: string;
  name: string;
  saved: boolean;
  owned: boolean;
  protected?: boolean;
  password?: string;
  identity?: RoomIdentity;
  authorityChain?: AuthorityTransfer[];
  hostCommands?: HostCommand[];
}

const memory = new Map<string, SavedRoom>();
const listeners = new Set<() => void>();
const native = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

function validRecord(value: unknown): value is SavedRoom {
  if (!value || typeof value !== 'object') return false;
  const record = value as SavedRoom;
  return typeof record.roomId === 'string' &&
    parseRoomInvite(record.invite)?.roomId === record.roomId &&
    typeof record.name === 'string' && record.name.length <= 80 &&
    typeof record.saved === 'boolean' && typeof record.owned === 'boolean' &&
    (record.protected === undefined || typeof record.protected === 'boolean') &&
    (record.password === undefined || (typeof record.password === 'string' && record.password.length <= 128)) &&
    (record.identity === undefined || (typeof record.identity.publicKey === 'string' &&
      typeof record.identity.privateKey === 'string')) &&
    (record.authorityChain === undefined || (Array.isArray(record.authorityChain) && record.authorityChain.length <= 100)) &&
    (record.hostCommands === undefined || (Array.isArray(record.hostCommands) && record.hostCommands.length <= 200));
}

export const savedRooms = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  async list(): Promise<SavedRoom[]> {
    if (!native()) return [...memory.values()];
    const rows = await invoke<string[]>('list_room_records');
    return rows.flatMap((row) => {
      try {
        const value: unknown = JSON.parse(row);
        return validRecord(value) ? [value] : [];
      } catch { return []; }
    });
  },

  async get(roomId: string): Promise<SavedRoom | undefined> {
    return (await this.list()).find((room) => room.roomId === roomId);
  },

  async put(record: SavedRoom): Promise<void> {
    if (!validRecord(record)) throw new Error('Invalid saved room');
    if (native()) await invoke('save_room_record', { roomId: record.roomId, data: JSON.stringify(record) });
    else memory.set(record.roomId, record);
    listeners.forEach((listener) => listener());
  },

  async remove(roomId: string): Promise<void> {
    if (native()) await invoke('delete_room_record', { roomId });
    else memory.delete(roomId);
    listeners.forEach((listener) => listener());
  },
};
