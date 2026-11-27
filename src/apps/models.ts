export interface RoomAppModel {
  localSnapshot?(): unknown;
  applyLocalSnapshot?(snapshot: unknown): void;
  applyLocalUpdate?(payload: unknown): Promise<void>;
  prepareJoin?(): Promise<void>;
  snapshot(): unknown;
  apply(payload: unknown, actor: string, fromSnapshot: boolean, receivedAt?: number): void;
  destroy(): void;
  setParticipants?(participants: string[]): void;
}

export interface RoomAppModelContext {
  localView?: boolean;
  localActor: string;
  emit(payload: unknown): void;
  changed(): void;
  instanceId?: string;
  createdBy?: string;
  rtcConfiguration?(): RTCConfiguration;
  send?(payload: unknown, target: string): Promise<void>;
}


export const MAX_UPDATE = 700_000;

export function encodeUpdate(update: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < update.length; offset += 8192)
    binary += String.fromCharCode(...update.subarray(offset, offset + 8192));
  return btoa(binary);
}

export function decodeUpdate(value: unknown, maxBytes = MAX_UPDATE): Uint8Array | null {
  if (typeof value !== 'string' || value.length > maxBytes * 1.4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  try { return Uint8Array.from(atob(value), (char) => char.charCodeAt(0)); }
  catch { return null; }
}
