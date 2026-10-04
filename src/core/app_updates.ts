import { t } from '../i18n/index.ts';
import type { DownloadEvent } from '@tauri-apps/plugin-updater';

export interface AvailableUpdate {
  version: string;
  currentVersion?: string;
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
  includePrereleases: boolean;
  returnToStable: boolean;
  dialogOpen: boolean;
}

const preferenceKey = 'p2sharer_auto_updates';
const previewPreferenceKey = 'p2sharer_beta_updates';
export function betaUpdateChecks(): boolean {
  try { return globalThis.localStorage?.getItem(previewPreferenceKey) === 'true'; }
  catch { return false; }
}
export function automaticUpdateChecks(): boolean {
  try { return globalThis.localStorage?.getItem(preferenceKey) !== 'false'; }
  catch { return true; }
}

/** Owns a single updater resource; React consumes immutable snapshots. */
export class AppUpdateController {
  private dependencies: {
    check: (includePrereleases: boolean) => Promise<AvailableUpdate | null>;
    prepareInstall: () => Promise<void>;
    restart: () => Promise<void>;
  };
  private state: UpdateState = { status: 'idle', version: null, notes: '', progress: null,
    error: null, automatic: automaticUpdateChecks(), includePrereleases: betaUpdateChecks(), returnToStable: false, dialogOpen: false };
  private listeners = new Set<() => void>();
  private update: AvailableUpdate | null = null;
  private busy = false;
  private checking = false;
  private automaticGeneration = 0;
  private channelGeneration = 0;
  private recheck: boolean | null = null;

  constructor(dependencies: {
    check: (includePrereleases: boolean) => Promise<AvailableUpdate | null>;
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
    this.setPreferences(enabled, this.state.includePrereleases);
  }
  setPreferences(enabled: boolean, includePrereleases: boolean) {
    const channelChanged = includePrereleases !== this.state.includePrereleases;
    // A downloaded installer cannot be changed while downloading or installing.
    if (channelChanged && this.busy && !this.checking) return;
    const previous = this.state.automatic;
    localStorage.setItem(preferenceKey, String(enabled));
    localStorage.setItem(previewPreferenceKey, String(includePrereleases));
    this.automaticGeneration++;
    if (channelChanged) {
      this.channelGeneration++;
      this.recheck = null;
      const previousUpdate = this.update;
      this.update = null;
      void previousUpdate?.close().catch(() => {});
      this.set({ status: 'idle', version: null, notes: '', progress: null, error: null, returnToStable: false });
    }
    this.set({ automatic: enabled, includePrereleases });
    const returnToStable = channelChanged && !includePrereleases;
    if (returnToStable || (enabled && (!previous || channelChanged))) {
      if (this.busy) this.recheck = returnToStable;
      else void this.check(returnToStable);
    }
  }
  open = () => { this.set({ dialogOpen: true }); };
  close = () => { if (!this.busy) this.set({ dialogOpen: false }); };

  async check(manual = false): Promise<void> {
    if (manual) this.open();
    if (this.busy || (!manual && !this.state.automatic) || this.state.status === 'ready') return;
    this.busy = true;
    this.checking = true;
    const generation = this.automaticGeneration;
    const channel = this.channelGeneration;
    this.set({ status: 'checking', error: null });
    try {
      const result = await this.dependencies.check(this.state.includePrereleases);
      if (channel !== this.channelGeneration || (!manual && generation !== this.automaticGeneration && !this.state.automatic)) {
        await result?.close();
        this.set({ status: this.update ? 'available' : 'idle' });
        return;
      }
      const previousUpdate = this.update;
      this.update = null;
      await previousUpdate?.close().catch(() => {});
      if (channel !== this.channelGeneration) {
        await result?.close();
        return;
      }
      this.update = result;
      this.set({ status: result ? 'available' : 'current', version: result?.version ?? null,
        notes: result?.body ?? '', progress: null,
        returnToStable: !this.state.includePrereleases && !!result?.currentVersion?.split('+')[0].includes('-') });
    } catch {
      if (channel === this.channelGeneration) {
        this.set({ status: 'error', error: t("message.94a3bbaf45de") });
      }
    } finally {
      this.busy = false;
      this.checking = false;
      const recheck = this.recheck;
      this.recheck = null;
      if (recheck !== null) void this.check(recheck);
    }
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
        error: t("message.39190aefd928") });
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
      this.set({ status: 'ready', error: t("message.0d3fe36ea8ce") });
    } finally { this.busy = false; }
  }
}
