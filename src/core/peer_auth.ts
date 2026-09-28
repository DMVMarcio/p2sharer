import type { ChatMessage } from './types.ts';
import { createRoomIdentity, hexToBytes, type RoomIdentity } from './room_invite.ts';

const encoder = new TextEncoder();
const hex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
const unhex = (value: string): Uint8Array => Uint8Array.from(value.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));

function signedChatData(roomId: string, message: ChatMessage): Uint8Array {
  return encoder.encode(JSON.stringify([
    'p2sharer-chat-v1', roomId.toLowerCase(), message.id, message.authorId,
    message.sender, message.text, message.timestamp, message.revision ?? 0,
    message.editedAt ?? null, message.deletedAt ?? null,
    message.replyTo ? [message.replyTo.id, message.replyTo.sender, message.replyTo.text] : null,
    Boolean(message.isHost), Boolean(message.isSystem), message.systemType ?? null,
    message.systemActor ?? null, message.systemRoom ?? null,
  ]));
}

type SignedChatMessage = ChatMessage & Required<Pick<ChatMessage, 'authorId' | 'authorKey' | 'signature'>>;

function hasSafeChatShape(value: unknown): value is SignedChatMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as ChatMessage;
  return typeof message.id === 'string' && message.id.length > 0 && message.id.length <= 80 &&
    typeof message.authorId === 'string' && message.authorId.length > 0 && message.authorId.length <= 80 &&
    typeof message.sender === 'string' && message.sender.length <= 80 &&
    typeof message.text === 'string' && message.text.length <= 4000 &&
    Number.isFinite(message.timestamp) &&
    Number.isInteger(message.revision) && (message.revision ?? -1) >= 0 && (message.revision ?? 0) <= 100000 &&
    (message.editedAt === undefined || Number.isFinite(message.editedAt)) &&
    (message.deletedAt === undefined || Number.isFinite(message.deletedAt)) &&
    (message.isHost === undefined || typeof message.isHost === 'boolean') &&
    (message.isSystem === undefined || typeof message.isSystem === 'boolean') &&
    (message.systemActor === undefined ||
      (typeof message.systemActor === 'string' && message.systemActor.length <= 80)) &&
    (message.systemRoom === undefined ||
      (typeof message.systemRoom === 'string' && message.systemRoom.length <= 80)) &&
    (message.systemType === undefined ||
      ['join', 'leave', 'info', 'generic', 'stream-start', 'stream-stop'].includes(message.systemType)) &&
    (message.replyTo === undefined ||
      (message.replyTo !== null && typeof message.replyTo === 'object' &&
       typeof message.replyTo.id === 'string' && message.replyTo.id.length <= 80 &&
       typeof message.replyTo.sender === 'string' && message.replyTo.sender.length <= 80 &&
       typeof message.replyTo.text === 'string' && message.replyTo.text.length <= 200)) &&
    typeof message.authorKey === 'string' && /^[0-9a-f]{130}$/.test(message.authorKey) &&
    typeof message.signature === 'string' && /^[0-9a-f]{128}$/.test(message.signature);
}

export class PeerAuthenticator {
  private static readonly localKeys = new Map<string, { keys: CryptoKeyPair; identity: RoomIdentity }>();
  private readonly knownKeys = new Map<string, string>();
  private readonly importedKeys = new Map<string, CryptoKey>();
  private readonly roomId: string;
  private readonly peerId: string;
  private readonly keys: CryptoKeyPair;
  readonly publicKey: string;
  private readonly identity: RoomIdentity;

  private constructor(
    roomId: string,
    peerId: string,
    keys: CryptoKeyPair,
    identity: RoomIdentity,
  ) {
    this.roomId = roomId;
    this.peerId = peerId;
    this.keys = keys;
    this.publicKey = identity.publicKey;
    this.identity = identity;
    this.knownKeys.set(peerId, identity.publicKey);
  }

  static async create(roomId: string, peerId: string, savedIdentity?: RoomIdentity): Promise<PeerAuthenticator> {
    // Keep the same identity when this app reconnects to a room. Other peers
    // pin our public key for the lifetime of their session.
    const cacheKey = JSON.stringify([roomId.toLowerCase(), peerId]);
    let cached = this.localKeys.get(cacheKey);
    if (!cached || (savedIdentity && cached.identity.publicKey !== savedIdentity.publicKey)) {
      const identity = savedIdentity ?? await createRoomIdentity();
      const privateKey = await crypto.subtle.importKey('pkcs8', hexToBytes(identity.privateKey),
        { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
      const publicKey = await crypto.subtle.importKey('raw', hexToBytes(identity.publicKey),
        { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      cached = { keys: { privateKey, publicKey }, identity };
      this.localKeys.set(cacheKey, cached);
    }
    return new PeerAuthenticator(roomId, peerId, cached.keys, cached.identity);
  }

  exportIdentity(): RoomIdentity { return { ...this.identity }; }

  getKnownKey(peerId: string): string | undefined { return this.knownKeys.get(peerId); }

  async signControl(purpose: string, payload: unknown): Promise<string> {
    const data = encoder.encode(JSON.stringify(['p2sharer-control-v1', this.roomId, purpose, payload]));
    return hex(new Uint8Array(await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' }, this.keys.privateKey, data,
    )));
  }

  async verifyControl(purpose: string, payload: unknown, signature: string, publicKey: string): Promise<boolean> {
    if (!/^[0-9a-f]{128}$/.test(signature) || !/^04[0-9a-f]{128}$/.test(publicKey)) return false;
    try {
      let key = this.importedKeys.get(publicKey);
      if (!key) {
        key = await crypto.subtle.importKey('raw', hexToBytes(publicKey),
          { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
        this.importedKeys.set(publicKey, key);
      }
      return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key,
        hexToBytes(signature), encoder.encode(JSON.stringify(['p2sharer-control-v1', this.roomId, purpose, payload])));
    } catch { return false; }
  }

  pinDirect(peerId: string, publicKey: string): boolean {
    const current = this.knownKeys.get(peerId);
    if (current && current !== publicKey) return false;
    this.knownKeys.set(peerId, publicKey);
    return true;
  }

  async sign(message: ChatMessage): Promise<ChatMessage> {
    if (message.authorId !== this.peerId) throw new Error('Cannot sign another peer\'s message');
    const unsigned = { ...message, authorKey: this.publicKey };
    const signature = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' }, this.keys.privateKey, signedChatData(this.roomId, unsigned),
    );
    return { ...unsigned, signature: hex(new Uint8Array(signature)) };
  }

  async verify(value: unknown, transportPeerId: string): Promise<boolean> {
    if (!hasSafeChatShape(value) || !transportPeerId || value.authorId === this.peerId) return false;
    const known = this.knownKeys.get(value.authorId);
    if (known && known !== value.authorKey) return false;
    if (!known && value.authorId !== transportPeerId) return false;
    try {
      let key = this.importedKeys.get(value.authorKey);
      if (!key) {
        key = await crypto.subtle.importKey('raw', unhex(value.authorKey),
          { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
        this.importedKeys.set(value.authorKey, key);
      }
      const valid = await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' }, key, unhex(value.signature), signedChatData(this.roomId, value),
      );
      if (!valid) return false;
      const current = this.knownKeys.get(value.authorId);
      if (current && current !== value.authorKey) return false;
      if (!current) this.knownKeys.set(value.authorId, value.authorKey);
      return true;
    } catch { return false; }
  }
}
