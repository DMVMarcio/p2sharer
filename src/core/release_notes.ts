export interface NotesStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const RELEASE_NOTES_STORAGE_KEY = 'p2sharer_release_notes_v1';
interface NotesHistory { installedVersion: string; readVersions: string[] }
interface NotesState { open: boolean; pending: boolean }

/** Tracks installed releases, independently of update downloads and channels. */
export class ReleaseNotesController {
  private state: NotesState = { open: false, pending: false };
  private history: NotesHistory;
  private listeners = new Set<() => void>();
  private version: string;
  private storage: NotesStorage;

  constructor(version: string, storage: NotesStorage) {
    this.version = version;
    this.storage = storage;
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
    this.state.pending = !this.history.readVersions.includes(version);
    this.persist();
  }

  getSnapshot = (): NotesState => this.state;
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
    if (!this.history.readVersions.includes(this.version)) this.history.readVersions.push(this.version);
    this.persist();
    this.set({ open: false, pending: false });
  };
}
