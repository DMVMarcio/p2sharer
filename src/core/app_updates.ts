import type { DownloadEvent } from '@tauri-apps/plugin-updater';

export interface AvailableUpdate {
  version: string;
  body?: string;
  download(onEvent: (event: DownloadEvent) => void): Promise<void>;
  install(): Promise<void>;
  close(): Promise<void>;
}

export interface UpdateState {
  status: 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'ready' | 'installing' | 'error';
  version: string | null;
  notes: string;
  progress: number | null;
  error: string | null;
  automatic: boolean;
  dialogOpen: boolean;
}

const preferenceKey = 'p2sharer_auto_updates';
export function automaticUpdateChecks(): boolean {
  try { return globalThis.localStorage?.getItem(preferenceKey) !== 'false'; }
  catch { return true; }
}

/** Owns a single updater resource; React consumes immutable snapshots. */
export class AppUpdateController {
  private dependencies: {
    check: () => Promise<AvailableUpdate | null>;
    prepareInstall: () => Promise<void>;
    restart: () => Promise<void>;
  };
  private state: UpdateState = { status: 'idle', version: null, notes: '', progress: null,
    error: null, automatic: automaticUpdateChecks(), dialogOpen: false };
  private listeners = new Set<() => void>();
  private update: AvailableUpdate | null = null;
  private busy = false;
  private automaticGeneration = 0;

  constructor(dependencies: {
    check: () => Promise<AvailableUpdate | null>;
    prepareInstall: () => Promise<void>;
    restart: () => Promise<void>;
  }) { this.dependencies = dependencies; }

  getSnapshot = (): UpdateState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private set(patch: Partial<UpdateState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach(listener => listener());
  }
  setAutomatic(enabled: boolean) {
    const previous = this.state.automatic;
    localStorage.setItem(preferenceKey, String(enabled));
    this.automaticGeneration++;
    this.set({ automatic: enabled });
    if (enabled && !previous) void this.check();
  }
  open = () => { this.set({ dialogOpen: true }); };
  close = () => { if (!this.busy) this.set({ dialogOpen: false }); };

  async check(manual = false): Promise<void> {
    if (manual) this.open();
    if (this.busy || (!manual && !this.state.automatic) || this.state.status === 'ready') return;
    this.busy = true;
    const generation = this.automaticGeneration;
    this.set({ status: 'checking', error: null });
    try {
      const result = await this.dependencies.check();
      if (!manual && generation !== this.automaticGeneration && !this.state.automatic) {
        await result?.close();
        this.set({ status: this.update ? 'available' : 'idle' });
        return;
      }
      await this.update?.close();
      this.update = result;
      this.set({ status: result ? 'available' : 'current', version: result?.version ?? null,
        notes: result?.body ?? '', progress: null });
    } catch {
      this.set({ status: 'error', error: 'Não foi possível procurar atualizações. Verifique sua conexão e tente novamente.' });
    } finally { this.busy = false; }
  }

  async download(): Promise<void> {
    if (this.busy || !this.update) return;
    this.busy = true;
    let downloaded = 0;
    let total: number | undefined;
    this.set({ status: 'downloading', error: null, progress: null });
    try {
      await this.update.download(event => {
        if (event.event === 'Started') { total = event.data.contentLength; downloaded = 0; }
        if (event.event === 'Progress') downloaded += event.data.chunkLength;
        this.set({ progress: total ? Math.min(100, Math.floor(downloaded / total * 100)) : null });
      });
      this.set({ status: 'ready', progress: 100 });
    } catch {
      this.set({ status: 'error', progress: null,
        error: 'Não foi possível baixar ou validar a atualização. Tente novamente.' });
    } finally { this.busy = false; }
  }

  async install(): Promise<void> {
    if (this.busy || !this.update || this.state.status !== 'ready') return;
    this.busy = true;
    this.set({ status: 'installing', error: null });
    try {
      await this.dependencies.prepareInstall();
      await this.update.install();
      await this.dependencies.restart();
    } catch {
      // Keep the verified download available for another installation attempt.
      this.set({ status: 'ready', error: 'Não foi possível instalar a atualização. Tente novamente.' });
    } finally { this.busy = false; }
  }
}
