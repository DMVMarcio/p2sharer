import type { YouTubeEntry } from './types.ts';

export interface SavedYouTubeQueue {
  id: string;
  name: string;
  entries: YouTubeEntry[];
  updatedAt: number;
}

export const SAVED_YOUTUBE_QUEUES_KEY = 'p2sharer_youtube_saved_queues_v1';
export const savedQueueNameKey = (name: string) => name.trim().normalize('NFKC').toLowerCase();

function cleanEntries(entries: YouTubeEntry[]): YouTubeEntry[] {
  if (!Array.isArray(entries) || !entries.length || entries.length > 200 || entries.some((entry) =>
    !entry || typeof entry.videoId !== 'string' || !/^[\w-]{11}$/.test(entry.videoId) ||
    typeof entry.title !== 'string' || entry.title.length > 300)) throw new Error('Invalid queue');
  return entries.map(({ videoId, title }) => ({ videoId, title }));
}

function cleanName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 80 || /[\u0000-\u001f\u007f]/.test(trimmed)) throw new Error('Invalid queue name');
  return trimmed;
}

export function createSavedYouTubeQueues(storage: Pick<Storage, 'getItem' | 'setItem'>) {
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  const list = (): SavedYouTubeQueue[] => {
    const raw = storage.getItem(SAVED_YOUTUBE_QUEUES_KEY);
    if (!raw) return [];
    const rows: unknown = JSON.parse(raw);
    if (!Array.isArray(rows) || rows.length > 100) throw new Error('Invalid saved queues');
    const ids = new Set<string>();
    const names = new Set<string>();
    return rows.map((row) => {
      if (!row || typeof row.id !== 'string' || !row.id || row.id.length > 80 ||
        typeof row.name !== 'string' || !Number.isFinite(row.updatedAt) || row.updatedAt <= 0 ||
        ids.has(row.id) || names.has(savedQueueNameKey(row.name))) throw new Error('Invalid saved queue');
      const name = cleanName(row.name);
      ids.add(row.id);
      names.add(savedQueueNameKey(name));
      return { id: row.id, name, entries: cleanEntries(row.entries), updatedAt: row.updatedAt };
    }).sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));
  };
  const write = (rows: SavedYouTubeQueue[]) => {
    // Persist before notifying so a quota failure never reports a successful save.
    storage.setItem(SAVED_YOUTUBE_QUEUES_KEY, JSON.stringify(rows));
    notify();
  };
  return {
    list, notify,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    save(name: string, entries: YouTubeEntry[], overwriteId?: string): SavedYouTubeQueue {
      const rows = list();
      const nextName = cleanName(name);
      const previous = overwriteId ? rows.find((row) => row.id === overwriteId) : undefined;
      if (overwriteId && !previous) throw new Error('Saved queue no longer exists');
      if (rows.some((row) => savedQueueNameKey(row.name) === savedQueueNameKey(nextName) && row.id !== overwriteId))
        throw new Error('Queue name already exists');
      if (!previous && rows.length >= 100) throw new Error('Saved queue limit reached');
      const record = { id: previous?.id ?? crypto.randomUUID(), name: nextName,
        entries: cleanEntries(entries), updatedAt: Date.now() };
      write([...rows.filter((row) => row.id !== record.id), record]);
      return record;
    },
    rename(id: string, name: string) {
      const rows = list();
      const record = rows.find((row) => row.id === id);
      if (!record) throw new Error('Saved queue no longer exists');
      const nextName = cleanName(name);
      if (rows.some((row) => row.id !== id && savedQueueNameKey(row.name) === savedQueueNameKey(nextName)))
        throw new Error('Queue name already exists');
      write(rows.map((row) => row.id === id ? { ...row, name: nextName, updatedAt: Date.now() } : row));
    },
    remove(id: string) { write(list().filter((row) => row.id !== id)); },
  };
}

export const savedYouTubeQueues = createSavedYouTubeQueues({
  getItem: (key) => localStorage.getItem(key),
  setItem: (key, value) => localStorage.setItem(key, value),
});
if (typeof window !== 'undefined') window.addEventListener('storage', (event) => {
  if (event.key === SAVED_YOUTUBE_QUEUES_KEY || event.key === null) savedYouTubeQueues.notify();
});
