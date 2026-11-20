export interface NotesStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const RELEASE_NOTES_STORAGE_KEY = 'p2sharer_release_notes_v1';
interface NotesHistory { installedVersion: string; readVersions: string[] }
export interface NotesState { open: boolean; pending: boolean }

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function compareSemver(left: string, right: string): number {
  const safeLeft = typeof left === 'string' ? left : '';
  const safeRight = typeof right === 'string' ? right : '';
  if (safeLeft === safeRight) return 0;
  const a = SEMVER_RE.exec(safeLeft);
  const b = SEMVER_RE.exec(safeRight);
  if (!a || !b) return safeLeft.localeCompare(safeRight);
  for (let i = 1; i <= 3; i++) {
    const diff = Number(a[i]) - Number(b[i]);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  const preA = a[4];
  const preB = b[4];
  if (!preA && !preB) return 0;
  if (!preA) return 1;
  if (!preB) return -1;
  const partsA = preA.split('.');
  const partsB = preB.split('.');
  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i++) {
    if (i >= partsA.length) return -1;
    if (i >= partsB.length) return 1;
    const pa = partsA[i];
    const pb = partsB[i];
    if (pa === pb) continue;
    const numA = /^\d+$/.test(pa);
    const numB = /^\d+$/.test(pb);
    if (numA && numB) return Number(pa) < Number(pb) ? -1 : 1;
    if (numA !== numB) return numA ? -1 : 1;
    return pa < pb ? -1 : 1;
  }
  return 0;
}

/** Tracks installed releases and computes unread version timelines, independently of update downloads. */
export class ReleaseNotesController {
  private state: NotesState = { open: false, pending: false };
  private history: NotesHistory;
  private listeners = new Set<() => void>();
  private version: string;
  private storage: NotesStorage;
  private historyVersions: string[];
  private pendingVersions: string[];

  constructor(version: string, storage: NotesStorage, availableVersions: readonly string[] = []) {
    this.version = version;
    this.storage = storage;
    const catalog = Array.from(new Set([...availableVersions.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0), version]))
      .sort((a, b) => compareSemver(b, a));
    this.historyVersions = catalog.filter(entry => compareSemver(entry, version) <= 0);

    let saved: NotesHistory | undefined;
    try {
      const value = JSON.parse(storage.getItem(RELEASE_NOTES_STORAGE_KEY) ?? 'null');
      if (typeof value?.installedVersion === 'string' && Array.isArray(value.readVersions)
        && value.readVersions.every((item: unknown) => typeof item === 'string')) saved = value;
    } catch { /* Missing or inaccessible storage uses session-only history. */ }
    let existingProfile = false;
    try { existingProfile = Boolean(storage.getItem('p2sharer_username')); } catch { /* Session-only. */ }
    // Versions before 1.4.1 have no release history; a saved profile migrates them.
    this.history = saved ?? { installedVersion: version, readVersions: existingProfile ? [] : [version] };
    this.history.installedVersion = version;
    this.pendingVersions = this.computePendingVersions();
    this.state.pending = this.pendingVersions.length > 0;
    this.persist();
  }

  private computePendingVersions(): string[] {
    if (this.history.readVersions.includes(this.version)) return [];
    let baseline: string | undefined;
    for (const read of this.history.readVersions) {
      if (compareSemver(read, this.version) > 0) continue;
      if (!baseline || compareSemver(read, baseline) > 0) baseline = read;
    }
    return this.historyVersions.filter(entry =>
      !this.history.readVersions.includes(entry)
      && (!baseline || compareSemver(entry, baseline) > 0),
    );
  }

  getSnapshot = (): NotesState => this.state;
  getVisibleVersions = (): readonly string[] => (this.pendingVersions.length > 0 ? this.pendingVersions : this.historyVersions);
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private set(state: NotesState) {
    this.state = state;
    this.listeners.forEach(listener => listener());
  }
  private persist() {
    try { this.storage.setItem(RELEASE_NOTES_STORAGE_KEY, JSON.stringify(this.history)); }
    catch { /* Keep the acknowledgement in memory when storage is unavailable. */ }
  }
  open = () => { this.set({ ...this.state, open: true }); };
  openPending = () => { if (this.state.pending && !this.state.open) this.open(); };
  close = () => {
    const acked = this.pendingVersions.length > 0 ? this.pendingVersions : [this.version];
    for (const entry of acked) {
      if (!this.history.readVersions.includes(entry)) this.history.readVersions.push(entry);
    }
    this.pendingVersions = [];
    this.persist();
    this.set({ open: false, pending: false });
  };
}
