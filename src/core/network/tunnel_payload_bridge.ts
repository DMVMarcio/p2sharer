import { Channel, invoke } from '@tauri-apps/api/core';
import { decodePeerPayload, encodePeerPayload } from './peer_payload.ts';
export async function listenTunnelPayloads(scope: string, handler: (header: any, bytes: Uint8Array) => void): Promise<() => void> {
  const channel = new Channel<ArrayBuffer>();
  let active = true;
  channel.onmessage = frame => {
    if (!active || !(frame instanceof ArrayBuffer)) return;
    const decoded = decodePeerPayload(new Uint8Array(frame));
    if (decoded && decoded.header.scope === scope) handler(decoded.header, decoded.bytes);
  };
  await invoke('subscribe_tunnel_payloads', { scope, channel });
  return () => { active = false; void invoke('unsubscribe_tunnel_payloads', { scope }).catch(() => {}); };
}
export function receiveTunnelPayload(scope: string, peer: string, payload: any): Promise<void> {
  const data = payload.type === 'wire' ? payload.packet?.data : payload.data;
  const header = payload.type === 'wire'
    ? { type: 'wire', scope, peer, packet: { ...payload.packet, data: undefined } }
    : { type: 'virtual-packet', scope, peer };
  return invoke('receive_tunnel_payload', encodePeerPayload(header, data instanceof Uint8Array ? data : new Uint8Array()));
}
