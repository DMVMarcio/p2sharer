export interface ProfileStats {
  callMs: number; calls: number; longestCallMs: number; messages: number;
  filesSent: number; filesReceived: number; bytesSent: number; bytesReceived: number;
}
const keys = ['callMs', 'calls', 'longestCallMs', 'messages', 'filesSent', 'filesReceived', 'bytesSent', 'bytesReceived'] as const;
const empty = (): ProfileStats => Object.fromEntries(keys.map(key => [key, 0])) as unknown as ProfileStats;
const STORAGE_KEY = 'p2sharer_profile_stats_v1';
export function parseProfileStats(value: unknown): ProfileStats | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length) return;
  if (!keys.every(key => Number.isSafeInteger(record[key]) && (record[key] as number) >= 0)) return;
  if ((record.longestCallMs as number) > (record.callMs as number)) return;
  return Object.fromEntries(keys.map(key => [key, record[key]])) as unknown as ProfileStats;
}
export class ProfileStatistics {
  private value = empty();
  private listeners = new Set<() => void>();
  private localListeners = new Set<() => void>();
  private peers = new Map<string, ProfileStats>();
  private revision = 0;
  private lastTick: number | null = null;
  private sessionMs = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private completedTransfers = new Set<string>();
  private storage?: Pick<Storage, 'getItem' | 'setItem'>;
  private now: () => number;
  constructor(storage?: Pick<Storage, 'getItem' | 'setItem'>, now = () => performance.now()) {
    this.storage = storage; this.now = now;
    try { this.value = parseProfileStats(JSON.parse(storage?.getItem(STORAGE_KEY) ?? 'null')) ?? empty(); } catch {}
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.revision;
  subscribeLocal = (listener: () => void) => { this.localListeners.add(listener); return () => { this.localListeners.delete(listener); }; };
  get(peerId = 'local', local = false): ProfileStats | undefined {
    return local || peerId === 'local' ? { ...this.value } : this.peers.get(peerId);
  }
  private publish() {
    try { this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.value)); } catch (error) {
      console.warn('[Profile] Statistics could not be saved:', error);
    }
    this.revision++; this.listeners.forEach(listener => listener());
    this.localListeners.forEach(listener => listener());
  }
  private add(key: keyof ProfileStats, amount: number) {
    this.value[key] = Math.min(Number.MAX_SAFE_INTEGER, this.value[key] + amount);
  }
  flush = () => {
    if (this.lastTick === null) return;
    const now = this.now();
    const elapsed = Math.max(0, Math.floor(now - this.lastTick));
    this.lastTick = now; this.sessionMs += elapsed; this.add('callMs', elapsed);
    this.value.longestCallMs = Math.min(this.value.callMs, Math.max(this.value.longestCallMs, this.sessionMs));
    this.publish();
  };
  setInCall(active: boolean) {
    if (active === (this.lastTick !== null)) return;
    if (active) {
      this.lastTick = this.now(); this.sessionMs = 0; this.add('calls', 1);
      this.timer = setInterval(this.flush, 15_000); this.publish();
    } else {
      this.flush(); this.lastTick = null; this.sessionMs = 0;
      clearInterval(this.timer); this.timer = undefined; this.completedTransfers.clear();
    }
  }
  messageSent() { this.add('messages', 1); this.publish(); }
  transferCompleted(requestId: string, direction: 'send' | 'receive', bytes: number, previewOnly = false) {
    if (previewOnly || !Number.isSafeInteger(bytes) || bytes < 0 || this.completedTransfers.has(requestId)) return;
    this.completedTransfers.add(requestId);
    this.add(direction === 'send' ? 'filesSent' : 'filesReceived', 1);
    this.add(direction === 'send' ? 'bytesSent' : 'bytesReceived', bytes); this.publish();
  }
  receive(peerId: string, value: unknown) {
    const stats = parseProfileStats(value);
    if (!stats) return;
    this.peers.set(peerId, stats); this.revision++; this.listeners.forEach(listener => listener());
  }
  forget(peerId: string) { this.peers.delete(peerId); this.revision++; this.listeners.forEach(listener => listener()); }
  clearPeers() { this.peers.clear(); this.revision++; this.listeners.forEach(listener => listener()); }
}
let storage: Storage | undefined;
try { if (typeof window !== 'undefined') storage = window.localStorage; } catch {}
export const profileStats = new ProfileStatistics(storage);
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') window.addEventListener('beforeunload', profileStats.flush);

export function formatProfileDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}min` : `${minutes}min`;
}
