import type { AuthorityTransfer } from './room_authority.ts';
import type { PeerAuthenticator } from './peer_auth.ts';

export interface LegacyRoomInvite {
  version: 3;
  roomId: string;
  rootKey: string;
}

export interface NamedRoomInvite {
  version: 4;
  roomId: string;
  rootKey: string;
  name: string;
  epoch: number;
  revision: number;
  adminKeys: string[];
  authorityChain: AuthorityTransfer[];
  signature: string;
}

export type RoomInvite = LegacyRoomInvite | NamedRoomInvite;

export interface RoomIdentity {
  publicKey: string;
  privateKey: string;
}

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');

export const hexToBytes = (value: string): Uint8Array =>
  Uint8Array.from(value.match(/../g) ?? [], (part) => Number.parseInt(part, 16));

export function validRoomName(value: string): boolean {
  return Boolean(value && value === value.trim() && value.length <= 80 &&
    !/[\x00-\x1f\x7f]/.test(value));
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(value: string): string {
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4));
  return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

export function roomInvitePayload(invite: NamedRoomInvite): unknown[] {
  return [invite.roomId, invite.rootKey, invite.name, invite.epoch, invite.revision,
    invite.adminKeys, invite.authorityChain];
}

export function formatRoomInvite(invite: RoomInvite): string {
  if (invite.version === 3) {
    return `p2s3.${base64UrlEncode(JSON.stringify([invite.roomId, invite.rootKey]))}`;
  }
  return `p2s4.${base64UrlEncode(JSON.stringify([...roomInvitePayload(invite), invite.signature]))}`;
}

export function parseRoomInvite(value: string): RoomInvite | null {
  const text = value.trim();
  if (!/^p2s[34]\.[A-Za-z0-9_-]{200,30000}$/.test(text)) return null;
  try {
    const parsed: unknown = JSON.parse(base64UrlDecode(text.slice(5)));
    if (!Array.isArray(parsed) ||
        typeof parsed[0] !== 'string' || !/^[0-9a-f]{32}$/.test(parsed[0]) ||
        typeof parsed[1] !== 'string' || !/^04[0-9a-f]{128}$/.test(parsed[1])) return null;
    if (text.startsWith('p2s3.') && parsed.length === 2) {
      const invite: LegacyRoomInvite = { version: 3, roomId: parsed[0], rootKey: parsed[1] };
      return formatRoomInvite(invite) === text ? invite : null;
    }
    if (!text.startsWith('p2s4.') || parsed.length !== 8 ||
        typeof parsed[2] !== 'string' || !validRoomName(parsed[2]) ||
        !Number.isSafeInteger(parsed[3]) || parsed[3] < 0 ||
        !Number.isSafeInteger(parsed[4]) || parsed[4] < 1 ||
        !Array.isArray(parsed[5]) || parsed[5].length > 32 ||
        !Array.isArray(parsed[6]) || parsed[6].length > 100 ||
        typeof parsed[7] !== 'string' || !/^[0-9a-f]{128}$/.test(parsed[7])) return null;
    const invite: NamedRoomInvite = {
      version: 4, roomId: parsed[0], rootKey: parsed[1], name: parsed[2],
      epoch: parsed[3], revision: parsed[4], adminKeys: parsed[5],
      authorityChain: parsed[6], signature: parsed[7],
    };
    return formatRoomInvite(invite) === text ? invite : null;
  } catch { return null; }
}

export function compareRoomInvites(left: RoomInvite, right: RoomInvite): number {
  const leftVersion = left.version === 4 ? [left.epoch, left.revision] : [0, 0];
  const rightVersion = right.version === 4 ? [right.epoch, right.revision] : [0, 0];
  return leftVersion[0] - rightVersion[0] || leftVersion[1] - rightVersion[1];
}

export async function signRoomInvite(invite: Omit<NamedRoomInvite, 'signature'>,
  auth: PeerAuthenticator): Promise<NamedRoomInvite> {
  const unsigned = { ...invite, signature: '' };
  return { ...unsigned, signature: await auth.signControl('invite-snapshot', roomInvitePayload(unsigned)) };
}

export async function createRoomIdentity(): Promise<RoomIdentity> {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'],
  ) as CryptoKeyPair;
  return {
    publicKey: bytesToHex(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))),
    privateKey: bytesToHex(new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))),
  };
}

export async function createAuthenticatedInvite(name = 'Minha sala'): Promise<{ invite: string; identity: RoomIdentity }> {
  const identity = await createRoomIdentity();
  const roomId = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
  const roomName = name.trim();
  if (!validRoomName(roomName)) throw new Error('Invalid room name');
  const unsigned: NamedRoomInvite = {
    version: 4, roomId, rootKey: identity.publicKey, name: roomName,
    epoch: 0, revision: 1, adminKeys: [], authorityChain: [], signature: '',
  };
  const privateKey = await crypto.subtle.importKey('pkcs8', hexToBytes(identity.privateKey),
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const data = new TextEncoder().encode(JSON.stringify([
    'p2sharer-control-v1', roomId, 'invite-snapshot', roomInvitePayload(unsigned),
  ]));
  const signature = bytesToHex(new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, privateKey, data)));
  return { invite: formatRoomInvite({ ...unsigned, signature }), identity };
}
