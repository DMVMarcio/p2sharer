const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
export const PEER_PAYLOAD_MAX = 65507;
export function encodePeerPayload(header: unknown, bytes = new Uint8Array()): Uint8Array {
  const metadata = encoder.encode(JSON.stringify(header));
  if (metadata.length > 2048 || bytes.length > PEER_PAYLOAD_MAX) throw new Error('Peer payload exceeds limit');
  const frame = new Uint8Array(2 + metadata.length + bytes.length);
  new DataView(frame.buffer).setUint16(0, metadata.length);
  frame.set(metadata, 2); frame.set(bytes, 2 + metadata.length);
  return frame;
}
export function decodePeerPayload(frame: Uint8Array): { header: any; bytes: Uint8Array } | null {
  if (frame.length < 2 || frame.length > PEER_PAYLOAD_MAX + 2050) return null;
  const length = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint16(0);
  if (!length || length > 2048 || 2 + length > frame.length) return null;
  try {
    const header = JSON.parse(decoder.decode(frame.subarray(2, 2 + length)));
    if (!header || typeof header !== 'object' || Array.isArray(header)) return null;
    return { header, bytes: frame.subarray(2 + length) };
  } catch { return null; }
}
