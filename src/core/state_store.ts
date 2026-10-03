import { streamDrawingLimit, STREAM_DRAWING_MAX } from './stream_pointer.ts';
import type { ResolutionConfig, RoomSlotInfo, StreamFilterMode, ThemeMode, TurnConfig } from './types.ts';
import { parseTurnUrls } from '../p2p/ice_config.ts';

export class StateStore {
  private static instance: StateStore | null = null;

  public username: string = '';
  public currentRoomCode: string = '';
  public currentRoomInvite: string = '';
  public currentRoomName: string = '';
  public currentRoomPassword: string = '';
  public isCreator: boolean = false;
  public isSharingScreen: boolean = false;
  public allowParticipantCursors = true;
  public allowParticipantPings = true;
  public allowParticipantDrawings = true;
  public participantDrawingLimit = STREAM_DRAWING_MAX;

  public layoutMode: 'grid' | 'spotlight' = 'grid';
  public pinnedPeerId: string | null = null;
  public subscribedStreams: Set<string> = new Set();
  public localPreviewStreams: Record<string, boolean> = {};
  public activePipPeers: Set<string> = new Set();
  public roomSlots: RoomSlotInfo[] = [];
  public editingStreamId: string | null = null;
  public streamOverlays: Record<string, string[]> = {};
  public dismissedAutoOverlays: Record<string, string[]> = {};
  public overlayPositions: Record<string, import('./media_streams').OverlayPosition> = {};
  public streamFilter: StreamFilterMode = 'all';

  public currentThemeMode: ThemeMode = 'dark';
  public currentAccentColor: string = 'cyan';

  public currentFps: number = 60;
  public currentBitrate: number = 15000;
  public currentQuality: number = 90;
  public currentResolution: ResolutionConfig = { width: 1920, height: 1080, label: '1080p' };

  public isAudioFilterFullAudio: boolean = false;
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

  public isPeerInPip(peerId: string): boolean {
    return this.activePipPeers.has(peerId);
  }

  public setPeerPipActive(peerId: string, active: boolean): void {
    if (active) {
      this.activePipPeers.add(peerId);
    } else {
      this.activePipPeers.delete(peerId);
    }
    this.notify();
  }

  constructor() {
    this.loadFromStorage();
  }

  public loadFromStorage(): void {
    if (typeof localStorage === 'undefined') return;
    this.allowParticipantCursors = localStorage.getItem('p2sharer_participant_cursors') !== 'false';
    this.participantDrawingLimit = streamDrawingLimit(Number(localStorage.getItem('p2sharer_drawing_limit') ?? STREAM_DRAWING_MAX));
    this.allowParticipantDrawings = localStorage.getItem('p2sharer_participant_drawings') !== 'false';
    this.allowParticipantPings = localStorage.getItem('p2sharer_participant_pings') !== 'false';
    this.username = localStorage.getItem('p2sharer_username') || '';
    this.currentThemeMode = (localStorage.getItem('p2sharer_theme_mode') as ThemeMode) || 'dark';
    this.currentAccentColor = localStorage.getItem('p2sharer_accent_color') || 'cyan';

    this.currentFps = parseInt(localStorage.getItem('p2sharer_default_fps') || '60', 10);
    this.currentBitrate = parseInt(localStorage.getItem('p2sharer_default_bitrate') || '15000', 10);
    this.currentQuality = parseInt(localStorage.getItem('p2sharer_default_quality') || '90', 10);
    if (isNaN(this.currentQuality) || this.currentQuality < 50 || this.currentQuality > 100) {
      this.currentQuality = 90;
    }

    const savedRes = localStorage.getItem('p2sharer_default_res') || '1080p';
    this.currentResolution = this.parseResolution(savedRes);

    this.isAudioFilterFullAudio = localStorage.getItem('p2sharer_audio_filter_full') === 'true';
    this.selectedFilterMode = (localStorage.getItem('p2sharer_audio_filter_mode') as 'exclude' | 'include') || 'exclude';
    const rawExclude = localStorage.getItem('p2sharer_audio_exclude_names');
    if (rawExclude !== null) {
      try {
        const savedExclude = JSON.parse(rawExclude);
        if (Array.isArray(savedExclude)) {
          this.excludeProcessNames = new Set(savedExclude.map((n: string) => n.toLowerCase()));
        } else {
          this.excludeProcessNames = new Set(['p2sharer', 'p2sharer.exe']);
        }
      } catch {
        this.excludeProcessNames = new Set(['p2sharer', 'p2sharer.exe']);
      }
    } else {
      this.excludeProcessNames = new Set();
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

  public getDefaultBitrateForResolution(resLabel: string): number {
    switch (resLabel.toLowerCase()) {
      case '4k':
        return 35000;
      case '1440p':
        return 25000;
      case '1080p':
        return 15000;
      case '720p':
        return 8000;
      case '480p':
        return 3000;
      case '360p':
        return 1000;
      default:
        return 15000;
    }
  }

  public parseResolution(resLabel: string): ResolutionConfig {
    const dimensions = /^(\d{2,5})x(\d{2,5})$/.exec(resLabel);
    if (dimensions && Number(dimensions[1]) <= 16384 && Number(dimensions[2]) <= 16384) {
      return { width: Number(dimensions[1]), height: Number(dimensions[2]), label: resLabel };
    }
    if (resLabel === '4k') return { width: 3840, height: 2160, label: '4K' };
    if (resLabel === '1440p') return { width: 2560, height: 1440, label: '1440p' };
    if (resLabel === '720p') return { width: 1280, height: 720, label: '720p' };
    if (resLabel === '480p') return { width: 854, height: 480, label: '480p' };
    if (resLabel === '360p') return { width: 640, height: 360, label: '360p' };
    return { width: 1920, height: 1080, label: '1080p' };
  }

  public saveAudioFilterPresets(): void {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem('p2sharer_audio_filter_full', String(this.isAudioFilterFullAudio));
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
    const rawTurnUrl = parseTurnUrls(localStorage.getItem('p2sharer_turn_url') || '').join('\n');

    return {
      enabled: isTurnEnabled && Boolean(rawTurnUrl),
      url: isTurnEnabled ? rawTurnUrl : undefined,
      username: isTurnEnabled ? (localStorage.getItem('p2sharer_turn_user') || undefined) : undefined,
      credential: isTurnEnabled ? (localStorage.getItem('p2sharer_turn_cred') || undefined) : undefined,
      forceRelay: isTurnEnabled && localStorage.getItem('p2sharer_turn_force_relay') === 'true',
    };
  }
}

export const stateStore = StateStore.getInstance();
