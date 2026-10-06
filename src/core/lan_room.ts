/** LAN rendezvous is a bearer capability; it never carries a room password. */
export interface LanRoomConnection {
  mode: 'lan';
  endpoint: string;
  token: string;
}

export interface LanInterface {
  name: string;
  address: string;
}

export const LAN_SIGNALING_PORT = 49154;

export function lanEndpoint(address: string): string {
  return `ws://${address.includes(':') ? `[${address}]` : address}:${LAN_SIGNALING_PORT}/`;
}

export function validLanConnection(value: unknown): value is LanRoomConnection {
  if (!value || typeof value !== 'object') return false;
  const connection = value as LanRoomConnection;
  if (connection.mode !== 'lan' || typeof connection.endpoint !== 'string' ||
      typeof connection.token !== 'string' || !/^[0-9a-f]{64}$/.test(connection.token)) return false;
  if (Object.keys(connection).sort().join(',') !== 'endpoint,mode,token') return false;
  try {
    const url = new URL(connection.endpoint);
    const host = url.hostname;
    const ipv4 = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) &&
      host.split('.').every((part) => Number(part) <= 255) &&
      !host.startsWith('0.') && !host.startsWith('127.') && Number(host.split('.')[0]) < 224;
    const ipv6 = /^\[[0-9a-f:]+\]$/i.test(host) && host !== '[::]' && host !== '[::1]' &&
      !/^\[(?:ff|fe[89ab]|::ffff:)/i.test(host);
    return url.protocol === 'ws:' && (ipv4 || ipv6) && Boolean(url.port) &&
      !url.username && !url.password && !url.search && !url.hash && url.pathname === '/' &&
      url.href === connection.endpoint;
  } catch { return false; }
}

export function createLanConnection(address: string): LanRoomConnection {
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)),
    (byte) => byte.toString(16).padStart(2, '0')).join('');
  const connection: LanRoomConnection = { mode: 'lan', endpoint: lanEndpoint(address), token };
  if (!validLanConnection(connection)) throw new Error('Invalid LAN interface address');
  return connection;
}
