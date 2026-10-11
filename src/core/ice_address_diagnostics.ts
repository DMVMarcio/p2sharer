/** Address classes describe syntax, not reachability or the physical interface. */
export function classifyIceAddress(value: unknown) {
  if (typeof value !== 'string' || !value) return { family: null, scope: 'unavailable', canonical: null, prefix: null };
  const address = value.toLowerCase();
  if (address.endsWith('.local')) return { family: 'unknown', scope: 'mdns', canonical: null, prefix: null };
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(address)) {
    const octets = address.split('.').map(Number);
    if (octets.every(n => n <= 255)) {
      const [a, b] = octets;
      const scope = a === 0 ? 'unspecified' : a === 127 ? 'loopback' :
        a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ? 'ipv4-private' :
        a === 100 && b >= 64 && b <= 127 ? 'ipv4-shared' :
        a === 169 && b === 254 ? 'ipv4-link-local' : a >= 224 ? 'ipv4-special' : 'ipv4-public';
      return { family: 'ipv4', scope, canonical: octets.join('.'), prefix: null };
    }
  }
  // URL performs IPv6 validation and normalizes embedded IPv4 and compressed forms.
  if (/^[0-9a-f:.]+$/.test(address) && address.includes(':')) {
    try {
      const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1);
      const [left, right] = normalized.split('::');
      const start = left ? left.split(':') : [];
      const end = right ? right.split(':') : [];
      const segments = right === undefined ? start : [...start, ...Array(8 - start.length - end.length).fill('0'), ...end];
      const words = segments.map(s => parseInt(s, 16));
      const canonical = words.map(n => n.toString(16).padStart(4, '0')).join(':');
      const scope = words.every(n => n === 0) ? 'unspecified' :
        words.slice(0, 7).every(n => n === 0) && words[7] === 1 ? 'loopback' :
        words.slice(0, 5).every(n => n === 0) && words[5] === 0xffff ? 'ipv4-mapped' :
        (words[0] & 0xffc0) === 0xfe80 ? 'ipv6-link-local' :
        (words[0] & 0xfe00) === 0xfc00 ? 'ipv6-ula' :
        (words[0] & 0xff00) === 0xff00 ? 'multicast' :
        words[0] === 0x2001 && words[1] === 0 ? 'ipv6-teredo' :
        words[0] === 0x2002 ? 'ipv6-6to4' :
        (words[0] & 0xe000) === 0x2000 ? 'ipv6-global' : 'ipv6-other';
      return { family: 'ipv6', scope, canonical, prefix: words.slice(0, 4).map(n => n.toString(16).padStart(4, '0')).join(':') };
    } catch { /* Invalid or zone-qualified addresses remain unreported. */ }
  }
  return { family: 'unknown', scope: 'unknown', canonical: null, prefix: null };
}

type KeyStorage = Pick<Storage, 'getItem' | 'setItem'>;
const KEY_NAME = 'p2sharer_ice_diagnostic_key_v1';

/** HMAC identifiers are comparable only within one profile; the key is never logged. */
export function createIceAddressFingerprinter(storage?: KeyStorage) {
  const ready = (async () => {
    let stored: string | null = null;
    try { stored = storage?.getItem(KEY_NAME) ?? null; } catch { /* Use a process key. */ }
    let scope: 'profile' | 'process' = 'profile';
    const bytes = stored && /^[0-9a-f]{64}$/.test(stored) ?
      new Uint8Array(stored.match(/../g)!.map(s => parseInt(s, 16))) : crypto.getRandomValues(new Uint8Array(32));
    if (!stored || !/^[0-9a-f]{64}$/.test(stored)) {
      try {
        if (!storage) throw new Error('No storage');
        storage.setItem(KEY_NAME, Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(''));
      } catch { scope = 'process'; }
    }
    const key = await crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sign = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key,
      new TextEncoder().encode(value))).slice(0, 16), b => b.toString(16).padStart(2, '0')).join('');
    return { scope, sign, keyId: await sign('diagnostic-key-id-v1') };
  })().catch(() => null);
  return async (address: unknown, port?: unknown, protocol?: unknown) => {
    const { canonical, prefix, ...classification } = classifyIceAddress(address);
    const context = await ready;
    const usablePort = typeof port === 'number' && Number.isInteger(port) && port >= 0 && port <= 65535;
    const usableProtocol = protocol === 'udp' || protocol === 'tcp';
    return { ...classification, identityScope: context?.scope ?? 'unavailable', identityKey: context?.keyId ?? null,
      addressToken: context && canonical ? await context.sign(JSON.stringify(['address', canonical])) : null,
      prefixToken: context && prefix ? await context.sign(JSON.stringify(['prefix64', prefix])) : null,
      endpointToken: context && canonical && usablePort && usableProtocol ?
        await context.sign(JSON.stringify(['endpoint', canonical, port, protocol])) : null };
  };
}

let fingerprinter: ReturnType<typeof createIceAddressFingerprinter> | undefined;
export function fingerprintIceAddress(address: unknown, port?: unknown, protocol?: unknown) {
  if (!fingerprinter) {
    let storage: Storage | undefined;
    try { storage = globalThis.localStorage; } catch { /* Restricted storage. */ }
    fingerprinter = createIceAddressFingerprinter(storage);
  }
  return fingerprinter(address, port, protocol);
}
