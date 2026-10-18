import { Channel, invoke } from '@tauri-apps/api/core';
import { selectedIcePair, type IceStat } from './ice_route.ts';
import { classifyIceAddress } from './ice_address_diagnostics.ts';

export interface DirectFileOffer { address: string; port: number; certificate: string; token: string }

function directAddress(address: unknown) {
  const result = classifyIceAddress(address);
  return ['ipv4-private', 'ipv4-shared', 'ipv4-public', 'ipv6-ula', 'ipv6-global'].includes(result.scope) ? result : null;
}

export function validDirectFileOffer(value: unknown): value is DirectFileOffer {
  if (!value || typeof value !== 'object') return false;
  const offer = value as DirectFileOffer;
  return typeof offer.address === 'string' && offer.address.length <= 64 && Boolean(directAddress(offer.address)) &&
    Number.isInteger(offer.port) && offer.port > 0 && offer.port <= 65535 &&
    typeof offer.certificate === 'string' && offer.certificate.length > 0 && offer.certificate.length <= 8192 &&
    typeof offer.token === 'string' && /^[a-f0-9]{64}$/.test(offer.token);
}

export function directFileSignature(offer?: DirectFileOffer): unknown {
  return offer ? [offer.address, offer.port, offer.certificate, offer.token] : null;
}

/** Numeric peer endpoints are bound to the signed certificate; never resolve URLs or NAT mappings. */
export async function directFileAddress(pc: RTCPeerConnection | undefined, side: 'local' | 'remote',
  announced?: string, lan = false): Promise<string | null> {
  if (!pc || pc.connectionState !== 'connected') return null;
  const pair = selectedIcePair(Array.from((await pc.getStats()).values()) as IceStat[]);
  if (pair?.local?.candidateType !== 'host' || !['host', 'prflx'].includes(pair.remote?.candidateType ?? '')) return null;
  const local = directAddress(pair.local.address);
  const remote = directAddress(pair.remote?.address);
  if (side === 'local') {
    if (!local || (!remote && !lan && local.scope !== 'ipv6-global')) return null;
    return local.canonical;
  }
  if (!announced) return remote?.canonical ?? null;
  const endpoint = directAddress(announced);
  if (!endpoint) return null;
  if (remote) return remote.canonical === endpoint.canonical ? endpoint.canonical : null;
  // Chromium may hide an unsignaled peer-reflexive address. The signed numeric
  // endpoint is usable in an explicit LAN room or a native global IPv6 route.
  return lan || (local?.scope === 'ipv6-global' && endpoint.scope === 'ipv6-global') ? endpoint.canonical : null;
}

export function receiveDirectFile(id: string, address: string, offer: DirectFileOffer, size: number,
  onProgress: (bytes: number) => void): Promise<{ bytes: number; error: string | null }> {
  const progress = new Channel<number>();
  progress.onmessage = onProgress;
  return invoke('receive_direct_chat_file', { id, address, offer, size, progress });
}

export function cancelDirectFile(id: string): Promise<void> {
  return invoke('cancel_direct_chat_file', { id });
}
