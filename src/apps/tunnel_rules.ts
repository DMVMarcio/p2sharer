export interface TunnelRule { id: string; name: string; port: number; protocol: 'tcp' | 'udp' }
export interface TunnelExport extends TunnelRule { generation: string }
export interface TunnelAdvertisement extends TunnelExport { enabled: boolean }
export const TUNNEL_RULES_KEY = 'p2sharer_port_tunnels_v1';
const storageListeners = new WeakMap<object, Set<() => void>>();
export const isTunnelId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
export function validTunnelRule(value: unknown): value is TunnelRule {
  if (!value || typeof value !== 'object') return false;
  const row = value as TunnelRule;
  return isTunnelId(row.id) && typeof row.name === 'string' && Boolean(row.name.trim()) && row.name.length <= 80 &&
    !/[\u0000-\u001f\u007f]/.test(row.name) && Number.isInteger(row.port) && row.port >= 1 && row.port <= 65535 &&
    (row.protocol === 'tcp' || row.protocol === 'udp');
}
export function validTunnelExports(value: unknown): value is TunnelExport[] {
  return Array.isArray(value) && value.length <= 32 && value.every((row) => validTunnelRule(row) &&
    isTunnelId((row as TunnelExport).generation)) && new Set(value.map((row) => row.id)).size === value.length;
}
export function validTunnelAdvertisements(value: unknown): value is TunnelAdvertisement[] {
  return validTunnelExports(value) && value.every((row) => typeof (row as TunnelAdvertisement).enabled === 'boolean');
}
const LOCAL_PORTS_KEY = 'p2sharer_tunnel_local_ports_v1';
export function createTunnelRules(storage: Pick<Storage, 'getItem' | 'setItem'>) {
  let listeners = storageListeners.get(storage);
  if (!listeners) { listeners = new Set(); storageListeners.set(storage, listeners); }
  return {
    localPort(id: string, fallback: number): number {
      try {
        const raw = storage.getItem(LOCAL_PORTS_KEY);
        if (!raw || raw.length > 16_000) return fallback;
        const values = JSON.parse(raw);
        const port: unknown = values?.[id];
        return Number.isInteger(port) && (port as number) >= 0 && (port as number) <= 65535 ? port as number : fallback;
      } catch { return fallback; }
    },
    saveLocalPort(id: string, port: number): void {
      if (!isTunnelId(id) || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid local port');
      let values: Record<string, number> = {};
      try {
        const raw = storage.getItem(LOCAL_PORTS_KEY);
        const previous = raw && raw.length < 16_000 ? JSON.parse(raw) : {};
        values = Object.fromEntries(Object.entries(previous).filter(([key, value]) =>
          isTunnelId(key) && Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 65535).slice(-127)) as Record<string, number>;
      } catch { /* Discard invalid optional port preferences without changing tunnel definitions. */ }
      storage.setItem(LOCAL_PORTS_KEY, JSON.stringify({ ...values, [id]: port }));
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    list(): TunnelRule[] {
      const raw = storage.getItem(TUNNEL_RULES_KEY);
      if (!raw) return [];
      if (raw.length > 32_000) throw new Error('Invalid saved tunnels');
      const rows: unknown = JSON.parse(raw);
      if (!Array.isArray(rows) || rows.length > 32 || !rows.every(validTunnelRule) || new Set(rows.map((row) => row.id)).size !== rows.length)
        throw new Error('Invalid saved tunnels');
      // Never restore activation or untrusted extra fields from disk.
      return rows.map(({ id, name, port, protocol }) => ({ id, name, port, protocol }));
    },
    write(rows: TunnelRule[]): void {
      if (rows.length > 32 || !rows.every(validTunnelRule) || new Set(rows.map((row) => row.id)).size !== rows.length)
        throw new Error('Invalid saved tunnels');
      storage.setItem(TUNNEL_RULES_KEY, JSON.stringify(rows.map(({ id, name, port, protocol }) => ({ id, name, port, protocol }))));
      listeners.forEach((listener) => listener());
    },
  };
}
