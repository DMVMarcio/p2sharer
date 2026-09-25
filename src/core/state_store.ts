import type { ResolutionConfig, RoomSlotInfo, ThemeMode, TurnConfig } from './types.ts';

export class StateStore {
  private static instance: StateStore | null = null;

  public username: string = '';
  public currentRoomCode: string = '';
  public currentRoomPassword: string = '';
  public isCreator: boolean = false;
  public isSharingScreen: boolean = false;

  public layoutMode: 'grid' | 'spotlight' = 'grid';
  public pinnedPeerId: string | null = null;
  public subscribedStreams: Set<string> = new Set();
  public roomSlots: RoomSlotInfo[] = [];

  public currentThemeMode: ThemeMode = 'dark';
  public currentAccentColor: string = 'cyan';

  public currentFps: number = 60;
  public currentBitrate: number = 25000;
  public currentResolution: ResolutionConfig = { width: 1920, height: 1080, label: '1080p' };

  public selectedFilterMode: 'exclude' | 'include' = 'exclude';
  public excludeProcessNames: Set<string> = new Set(['p2sharer', 'p2sharer.exe']);
  public includeProcessNames: Set<string> = new Set();
  public excludePids: Set<number> = new Set();
  public includePids: Set<number> = new Set();

  public isSidebarCollapsed: boolean = false;
  public isSpotlightTrayCollapsed: boolean = false;

  public version: number = 0;
  private listeners: Set<() => void> = new Set();

  public static getInstance(): StateStore {
    if (!StateStore.instance) {
      StateStore.instance = new StateStore();
    }
    return StateStore.instance;
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public notify(): void {
    this.version++;
    this.listeners.forEach((listener) => {
      try {
        listener();
      } catch (err) {
        console.error('Error in StateStore listener:', err);
      }
    });
  }

  public set(updater: (state: StateStore) => void): void {
    updater(this);
    this.notify();
  }

  constructor() {
    this.loadFromStorage();
  }

  public loadFromStorage(): void {
    if (typeof localStorage === 'undefined') return;
    this.username = localStorage.getItem('p2sharer_username') || '';
    this.currentThemeMode = (localStorage.getItem('p2sharer_theme_mode') as ThemeMode) || 'dark';
    this.currentAccentColor = localStorage.getItem('p2sharer_accent_color') || 'cyan';

    this.currentFps = parseInt(localStorage.getItem('p2sharer_default_fps') || '60', 10);
    this.currentBitrate = parseInt(localStorage.getItem('p2sharer_default_bitrate') || '25000', 10);

    const savedRes = localStorage.getItem('p2sharer_default_res') || '1080p';
    this.currentResolution = this.parseResolution(savedRes);

    this.selectedFilterMode = (localStorage.getItem('p2sharer_audio_filter_mode') as 'exclude' | 'include') || 'exclude';
    try {
      const savedExclude = JSON.parse(localStorage.getItem('p2sharer_audio_exclude_names') || '["p2sharer", "p2sharer.exe"]');
      if (Array.isArray(savedExclude)) {
        this.excludeProcessNames = new Set(savedExclude.map((n: string) => n.toLowerCase()));
      }
    } catch {
      this.excludeProcessNames = new Set(['p2sharer', 'p2sharer.exe']);
    }

    try {
      const savedInclude = JSON.parse(localStorage.getItem('p2sharer_audio_include_names') || '[]');
      if (Array.isArray(savedInclude)) {
        this.includeProcessNames = new Set(savedInclude.map((n: string) => n.toLowerCase()));
      }
    } catch {
      this.includeProcessNames = new Set();
    }
  }

  public parseResolution(resLabel: string): ResolutionConfig {
    if (resLabel === '4k') return { width: 3840, height: 2160, label: '4K' };
    if (resLabel === '1440p') return { width: 2560, height: 1440, label: '1440p' };
    if (resLabel === '720p') return { width: 1280, height: 720, label: '720p' };
    if (resLabel === '480p') return { width: 854, height: 480, label: '480p' };
    if (resLabel === '360p') return { width: 640, height: 360, label: '360p' };
    return { width: 1920, height: 1080, label: '1080p' };
  }

  public saveAudioFilterPresets(): void {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem('p2sharer_audio_filter_mode', this.selectedFilterMode);
    localStorage.setItem('p2sharer_audio_exclude_names', JSON.stringify(Array.from(this.excludeProcessNames)));
    localStorage.setItem('p2sharer_audio_include_names', JSON.stringify(Array.from(this.includeProcessNames)));
  }

  public getActiveFilterPids(): number[] {
    return Array.from(this.selectedFilterMode === 'exclude' ? this.excludePids : this.includePids);
  }

  public getActiveFilterNames(): string[] {
    return Array.from(this.selectedFilterMode === 'exclude' ? this.excludeProcessNames : this.includeProcessNames);
  }

  public getTurnConfig(): TurnConfig {
    if (typeof localStorage === 'undefined') {
      return { enabled: false, forceRelay: false };
    }
    const isTurnEnabled = localStorage.getItem('p2sharer_turn_enabled') === 'true';
    const rawTurnUrl = (localStorage.getItem('p2sharer_turn_url') || '').trim();
    let sanitizedTurnUrl: string | undefined = undefined;
    if (isTurnEnabled && rawTurnUrl) {
      sanitizedTurnUrl = (rawTurnUrl.startsWith('turn:') || rawTurnUrl.startsWith('turns:') || rawTurnUrl.startsWith('stun:'))
        ? rawTurnUrl
        : `turn:${rawTurnUrl}`;
    }

    return {
      enabled: isTurnEnabled && Boolean(sanitizedTurnUrl),
      url: isTurnEnabled ? sanitizedTurnUrl : undefined,
      username: isTurnEnabled ? (localStorage.getItem('p2sharer_turn_user') || undefined) : undefined,
      credential: isTurnEnabled ? (localStorage.getItem('p2sharer_turn_cred') || undefined) : undefined,
      forceRelay: isTurnEnabled && localStorage.getItem('p2sharer_turn_force_relay') === 'true',
    };
  }
}

export const stateStore = StateStore.getInstance();
