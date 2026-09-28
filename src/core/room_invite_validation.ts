import { PeerAuthenticator } from './peer_auth.ts';
import { RoomAuthority } from './room_authority.ts';
import type { AuthorityTransfer } from './room_authority.ts';
import { parseRoomInvite, roomInvitePayload, type RoomInvite } from './room_invite.ts';

export async function verifyRoomInvite(value: string): Promise<RoomInvite | null> {
  const invite = parseRoomInvite(value);
  if (!invite || invite.version === 3) return invite;
  try {
    const auth = await PeerAuthenticator.create(invite.roomId, 'invite-verifier');
    const authority = new RoomAuthority(invite.roomId, invite.rootKey, auth);
    if (invite.authorityChain.length !== invite.epoch ||
        !await authority.importChain(invite.authorityChain) || authority.epoch !== invite.epoch) return null;
    const keys = new Set<string>();
    for (const key of invite.adminKeys) {
      if (typeof key !== 'string' || !/^04[0-9a-f]{128}$/.test(key) || keys.has(key)) return null;
      keys.add(key);
    }
    if (!await auth.verifyControl('invite-snapshot', roomInvitePayload(invite),
      invite.signature, authority.currentKey)) return null;
    return invite;
  } catch { return null; }
}

export function isAuthorityChainPrefix(known: AuthorityTransfer[], candidate: AuthorityTransfer[]): boolean {
  return known.length <= candidate.length && known.every((transfer, index) => {
    const other = candidate[index];
    return other && transfer.roomId === other.roomId && transfer.epoch === other.epoch &&
      transfer.previousKey === other.previousKey && transfer.nextKey === other.nextKey &&
      transfer.nextPeerId === other.nextPeerId &&
      transfer.previousSignature === other.previousSignature && transfer.nextSignature === other.nextSignature;
  });
}
