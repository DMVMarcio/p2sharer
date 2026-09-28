export interface RoomInvite {
  version: 3;
  roomId: string;
  rootKey: string;
}

export interface RoomIdentity {
  publicKey: string;
  privateKey: string;
}

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');

export const hexToBytes = (value: string): Uint8Array =>
  Uint8Array.from(value.match(/../g) ?? [], (part) => Number.parseInt(part, 16));

function base64UrlEncode(value: string): string {
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(value: string): string {
  return atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4));
}

export function formatRoomInvite(invite: RoomInvite): string {
  return `p2s3.${base64UrlEncode(JSON.stringify([invite.roomId, invite.rootKey]))}`;
}

export function parseRoomInvite(value: string): RoomInvite | null {
  const text = value.trim();
  if (!/^p2s3\.[A-Za-z0-9_-]{200,260}$/.test(text)) return null;
  try {
    const parsed: unknown = JSON.parse(base64UrlDecode(text.slice(5)));
    if (!Array.isArray(parsed) || parsed.length !== 2 ||
        typeof parsed[0] !== 'string' || !/^[0-9a-f]{32}$/.test(parsed[0]) ||
        typeof parsed[1] !== 'string' || !/^04[0-9a-f]{128}$/.test(parsed[1])) return null;
    const invite = { version: 3 as const, roomId: parsed[0], rootKey: parsed[1] };
    return formatRoomInvite(invite) === text ? invite : null;
  } catch { return null; }
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

export async function createAuthenticatedInvite(): Promise<{ invite: string; identity: RoomIdentity }> {
  const identity = await createRoomIdentity();
  const roomId = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
  return { invite: formatRoomInvite({ version: 3, roomId, rootKey: identity.publicKey }), identity };
}
