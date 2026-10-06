import { t } from '../i18n/index.ts';
import type { AuthorityTransfer } from './room_authority.ts';
import type { PeerAuthenticator } from './peer_auth.ts';
import { validLanConnection, type LanRoomConnection } from './lan_room.ts';

export interface LegacyRoomInvite {
  version: 3;
  roomId: string;
  rootKey: string;
}

export interface NamedRoomInvite {
  version: 4 | 5;
  roomId: string;
  rootKey: string;
  name: string;
  epoch: number;
  revision: number;
  adminKeys: string[];
  authorityChain: AuthorityTransfer[];
  signature: string;
  connection?: LanRoomConnection;
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
  const payload = [invite.roomId, invite.rootKey, invite.name, invite.epoch, invite.revision,
    invite.adminKeys, invite.authorityChain];
  return invite.version === 5 ? [...payload, invite.connection] : payload;
}

export function formatRoomInvite(invite: RoomInvite): string {
  if (invite.version === 3) {
    return `p2s3.${base64UrlEncode(JSON.stringify([invite.roomId, invite.rootKey]))}`;
  }
  return `p2s${invite.version}.${base64UrlEncode(JSON.stringify([...roomInvitePayload(invite), invite.signature]))}`;
}

export function parseRoomInvite(value: string): RoomInvite | null {
  const text = value.trim();
  if (!/^p2s[345]\.[A-Za-z0-9_-]{200,30000}$/.test(text)) return null;
  try {
    const parsed: unknown = JSON.parse(base64UrlDecode(text.slice(5)));
    if (!Array.isArray(parsed) ||
        typeof parsed[0] !== 'string' || !/^[0-9a-f]{32}$/.test(parsed[0]) ||
        typeof parsed[1] !== 'string' || !/^04[0-9a-f]{128}$/.test(parsed[1])) return null;
    if (text.startsWith('p2s3.') && parsed.length === 2) {
      const invite: LegacyRoomInvite = { version: 3, roomId: parsed[0], rootKey: parsed[1] };
      return formatRoomInvite(invite) === text ? invite : null;
    }
    const lan = text.startsWith('p2s5.');
    const signature = parsed[lan ? 8 : 7];
    if ((!lan && !text.startsWith('p2s4.')) || parsed.length !== (lan ? 9 : 8) ||
        (lan && !validLanConnection(parsed[7])) ||
        typeof parsed[2] !== 'string' || !validRoomName(parsed[2]) ||
        !Number.isSafeInteger(parsed[3]) || parsed[3] < 0 ||
        !Number.isSafeInteger(parsed[4]) || parsed[4] < 1 ||
        !Array.isArray(parsed[5]) || parsed[5].length > 32 ||
        !Array.isArray(parsed[6]) || parsed[6].length > 100 ||
        typeof signature !== 'string' || !/^[0-9a-f]{128}$/.test(signature)) return null;
    const invite: NamedRoomInvite = {
      version: lan ? 5 : 4, roomId: parsed[0], rootKey: parsed[1], name: parsed[2],
      epoch: parsed[3], revision: parsed[4], adminKeys: parsed[5],
      authorityChain: parsed[6], signature,
      ...(lan ? { connection: parsed[7] as LanRoomConnection } : {}),
    };
    return formatRoomInvite(invite) === text ? invite : null;
  } catch { return null; }
}

export function compareRoomInvites(left: RoomInvite, right: RoomInvite): number {
  const leftVersion = left.version !== 3 ? [left.epoch, left.revision] : [0, 0];
  const rightVersion = right.version !== 3 ? [right.epoch, right.revision] : [0, 0];
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

export async function createAuthenticatedInvite(name = t("message.659cf77f64fc"),
  connection?: LanRoomConnection): Promise<{ invite: string; identity: RoomIdentity }> {
  if (connection && !validLanConnection(connection)) throw new Error('Invalid LAN connection');
  const identity = await createRoomIdentity();
  const roomId = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
  const roomName = name.trim();
  if (!validRoomName(roomName)) throw new Error('Invalid room name');
  const unsigned: NamedRoomInvite = {
    version: connection ? 5 : 4, roomId, rootKey: identity.publicKey, name: roomName,
    epoch: 0, revision: 1, adminKeys: [], authorityChain: [], signature: '',
    ...(connection ? { connection } : {}),
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
