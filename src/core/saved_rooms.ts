import { invoke } from '@tauri-apps/api/core';
import { compareRoomInvites, parseRoomInvite, type RoomIdentity } from './room_invite.ts';
import { verifyRoomInvite } from './room_invite_validation.ts';
import type { AuthorityTransfer, HostCommand } from './room_authority.ts';
import { saveSavedRoomOrder } from './saved_room_order.ts';

export interface SavedRoom {
  roomId: string;
  invite: string;
  name: string;
  customName?: string;
  saved: boolean;
  owned: boolean;
  protected?: boolean;
  password?: string;
  identity?: RoomIdentity;
  authorityChain?: AuthorityTransfer[];
  hostCommands?: HostCommand[];
}

export function savedRoomCustomName(record: SavedRoom): string | undefined {
  if (record.customName !== undefined) return record.customName;
  if (record.owned) return undefined;
  const invite = parseRoomInvite(record.invite);
  const sharedName = invite && invite.version !== 3 ? invite.name : record.roomId.slice(0, 8);
  return record.name !== sharedName ? record.name : undefined;
}

const memory = new Map<string, SavedRoom>();
const listeners = new Set<() => void>();
const pendingMutations = new Map<string, Promise<void>>();
const native = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

async function serializeMutation(roomId: string, task: () => Promise<void>): Promise<void> {
  const previous = pendingMutations.get(roomId) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  pendingMutations.set(roomId, current);
  try { await current; } finally {
    if (pendingMutations.get(roomId) === current) pendingMutations.delete(roomId);
  }
}

function validRecord(value: unknown): value is SavedRoom {
  if (!value || typeof value !== 'object') return false;
  const record = value as SavedRoom;
  return typeof record.roomId === 'string' &&
    parseRoomInvite(record.invite)?.roomId === record.roomId &&
    typeof record.name === 'string' && record.name.length <= 80 &&
    (record.customName === undefined || (typeof record.customName === 'string' &&
      record.customName.length <= 80)) &&
    typeof record.saved === 'boolean' && typeof record.owned === 'boolean' &&
    (record.protected === undefined || typeof record.protected === 'boolean') &&
    (record.password === undefined || (typeof record.password === 'string' && record.password.length <= 128)) &&
    (record.identity === undefined || (typeof record.identity.publicKey === 'string' &&
      typeof record.identity.privateKey === 'string')) &&
    (record.authorityChain === undefined || (Array.isArray(record.authorityChain) && record.authorityChain.length <= 100)) &&
    (record.hostCommands === undefined || (Array.isArray(record.hostCommands) && record.hostCommands.length <= 200));
}

export const savedRooms = {
  reorder(ids: string[]): void {
    saveSavedRoomOrder(ids);
    listeners.forEach((listener) => listener());
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  async list(): Promise<SavedRoom[]> {
    if (!native()) return [...memory.values()];
    const rows = await invoke<string[]>('list_room_records');
    const parsed = rows.flatMap((row) => {
      try {
        const value: unknown = JSON.parse(row);
        return validRecord(value) ? [value] : [];
      } catch { return []; }
    });
    const verified = await Promise.all(parsed.map(async (record) =>
      await verifyRoomInvite(record.invite) ? record : null));
    return verified.filter((record): record is SavedRoom => record !== null);
  },

  async get(roomId: string): Promise<SavedRoom | undefined> {
    return (await this.list()).find((room) => room.roomId === roomId);
  },

  async put(record: SavedRoom): Promise<void> {
    await serializeMutation(record.roomId, async () => {
      if (!validRecord(record)) throw new Error('Invalid saved room');
      const incoming = await verifyRoomInvite(record.invite);
      if (!incoming) throw new Error('Invalid saved room invitation');
      const previous = await this.get(record.roomId);
      if (previous) {
        const known = parseRoomInvite(previous.invite)!;
        if (known.rootKey !== incoming.rootKey) throw new Error('Room creator key changed');
        const order = compareRoomInvites(incoming, known);
        if (order === 0 && record.invite !== previous.invite) throw new Error('Conflicting room invitation revision');
        if (order < 0) record = { ...record, invite: previous.invite, name: previous.name,
          customName: record.customName ?? previous.customName };
      }
      if (native()) await invoke('save_room_record', { roomId: record.roomId, data: JSON.stringify(record) });
      else memory.set(record.roomId, record);
      listeners.forEach((listener) => listener());
    });
  },

  async remove(roomId: string): Promise<void> {
    await serializeMutation(roomId, async () => {
      if (native()) await invoke('delete_room_record', { roomId });
      else memory.delete(roomId);
      listeners.forEach((listener) => listener());
    });
  },
};
