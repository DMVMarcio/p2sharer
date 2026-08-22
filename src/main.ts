import { invoke } from '@tauri-apps/api/core';
import { AudioBridge } from './audio_bridge';
import { generateRandomRoomSlug, GroupRoomManager } from './group_room';
import { NativeVideoBridge } from './native_video_bridge';
import { soundEffects } from './sound_effects';
import {
  ChatMessage,
  MonitorSource,
  PeerInfo,
  ProcessItem,
  RoomSlotInfo,
  ScreenSourcesResponse,
  TurnConfig,
  WindowSource,
} from './types';

interface PeerAudioSinkState {
  audioCtx: AudioContext;
  source: MediaStreamAudioSourceNode | null;
  gainNode: GainNode;
  streamId: string;
  volume: number;
  isMuted: boolean;
}

const ICONS = {
  lock: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`,
  unlock: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>`,
  eye: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`,
  eyeOff: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`,
};

function initFrontendLogger() {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;

  const formatValue = (val: any, depth = 0): string => {
    if (val === null) return 'null';
    if (val === undefined) return 'undefined';
    if (typeof val === 'string') return val;
    if (typeof val === 'number' || typeof val === 'boolean' || typeof val === 'symbol' || typeof val === 'bigint') {
      return String(val);
    }
    if (typeof val === 'function') {
      return `[Function: ${val.name || 'anonymous'}]`;
    }

    if (val instanceof Error || (typeof val === 'object' && 'message' in val && 'name' in val)) {
      const name = val.name || 'Error';
      const msg = val.message || '';
      const stack = val.stack ? `\n  Stack: ${val.stack}` : '';
      const cause = (val as any).cause ? `\n  Cause: ${formatValue((val as any).cause, depth + 1)}` : '';
      const extraProps: Record<string, any> = {};
      for (const key of Object.getOwnPropertyNames(val)) {
        if (key !== 'name' && key !== 'message' && key !== 'stack') {
          try {
            extraProps[key] = (val as any)[key];
          } catch {}
        }
      }
      const extraStr = Object.keys(extraProps).length > 0 ? `\n  Details: ${JSON.stringify(extraProps, null, 2)}` : '';
      return `[${name}: ${msg}]${stack}${cause}${extraStr}`;
    }

    if (typeof val === 'object') {
      if (depth > 3) return '[Object]';
      try {
        const propNames = Object.getOwnPropertyNames(val);
        if (propNames.length === 0) {
          return String(val);
        }
        const plainObj: Record<string, any> = {};
        for (const k of propNames) {
          try {
            plainObj[k] = val[k];
          } catch {}
        }
        return JSON.stringify(plainObj, null, 2);
      } catch {
        return String(val);
      }
    }

    return String(val);
  };

  const formatArgs = (args: any[]) => args.map((a) => formatValue(a)).join(' ');

  console.log = (...args: any[]) => {
    originalLog(...args);
    invoke('write_frontend_log', {
      level: 'INFO',
      message: formatArgs(args),
      context: 'frontend',
    }).catch(() => {});
  };

  console.warn = (...args: any[]) => {
    originalWarn(...args);
    invoke('write_frontend_log', {
      level: 'WARN',
      message: formatArgs(args),
      context: 'frontend',
    }).catch(() => {});
  };

  console.error = (...args: any[]) => {
    originalError(...args);
    invoke('write_frontend_log', {
      level: 'ERROR',
      message: formatArgs(args),
      context: 'frontend',
    }).catch(() => {});
  };

  window.addEventListener('error', (event) => {
    const errorDetails = event.error
      ? formatValue(event.error)
      : `${event.message} at ${event.filename}:${event.lineno}:${event.colno}`;
    invoke('write_frontend_log', {
      level: 'ERROR',
      message: `Uncaught Exception: ${errorDetails}`,
      context: 'window.onerror',
    }).catch(() => {});
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason ? formatValue(event.reason) : 'Unknown promise rejection';
    invoke('write_frontend_log', {
      level: 'ERROR',
      message: `Unhandled Promise Rejection: ${reason}`,
      context: 'unhandledrejection',
    }).catch(() => {});
  });
}

class App {
  private username: string = '';
  private currentRoomCode: string = 'cyber-falcon-482';
  private currentRoomPassword: string = '';
  private isCreator: boolean = false;
  private isSharingScreen: boolean = false;

  private roomManager: GroupRoomManager | null = null;
  private nativeVideoBridge: NativeVideoBridge = new NativeVideoBridge();
  private audioBridge: AudioBridge = new AudioBridge();

  private audioProcesses: ProcessItem[] = [];
  private selectedFilterMode: 'exclude' | 'include' = 'exclude';
  private excludePids: Set<number> = new Set();
  private includePids: Set<number> = new Set();
  private excludeProcessNames: Set<string> = new Set();
  private includeProcessNames: Set<string> = new Set();

  // Multi-stream Dynamic Grid & Participant Slots State
  private roomSlots: RoomSlotInfo[] = [];
  private layoutMode: 'grid' | 'spotlight' = 'grid';
  private pinnedPeerId: string | null = null;
  private subscribedStreams: Set<string> = new Set();
  private cachedCards: Map<string, { el: HTMLElement; isVideo: boolean; streamId?: string }> = new Map();
  private peerAudioSinks: Map<string, PeerAudioSinkState> = new Map();
  private isSidebarCollapsed: boolean = false;
  private isSpotlightTrayCollapsed: boolean = false;

  // Stream Settings & Picker State
  private availableMonitors: MonitorSource[] = [];
  private availableWindows: WindowSource[] = [];
  private currentPickerTab: 'screens' | 'windows' = 'screens';
  private selectedSourceId: string = 'screen:0';

  private currentFps: number = 60;
  private currentBitrate: number = 25000;
  private currentResolution: { width: number; height: number; label: string } = { width: 1920, height: 1080, label: '1080p' };

  // Theme & Customization State
  private currentThemeMode: 'dark' | 'light' | 'system' = 'dark';
  private currentAccentColor: string = 'cyan';

  private liveStatsTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.init();
  }

  private async init() {
    initFrontendLogger();
    this.setupThemeAndSettings();
    this.setupUsername();
    this.bindEvents();
    this.generateRandomRoomCode();
  }

  // --- THEME & SETTINGS INITIALIZATION ---
  private setupThemeAndSettings() {
    const savedTheme = (localStorage.getItem('p2sharer_theme_mode') as 'dark' | 'light' | 'system') || 'dark';
    const savedAccent = localStorage.getItem('p2sharer_accent_color') || 'cyan';

    this.currentThemeMode = savedTheme;
    this.currentAccentColor = savedAccent;

    this.applyTheme(this.currentThemeMode);
    this.applyAccent(this.currentAccentColor);
    this.syncPickerModalDefaults();
    this.initAudioFilterSettings();
  }

  public syncPickerModalDefaults() {
    const savedRes = localStorage.getItem('p2sharer_default_res') || '1080p';
    const savedFps = parseInt(localStorage.getItem('p2sharer_default_fps') || '60', 10);
    const savedBitrate = parseInt(localStorage.getItem('p2sharer_default_bitrate') || '25000', 10);
    const savedCursor = localStorage.getItem('p2sharer_default_cursor') !== 'false';

    this.currentFps = savedFps;
    this.currentBitrate = savedBitrate;

    let res = { width: 1920, height: 1080, label: '1080p' };
    if (savedRes === '4k') res = { width: 3840, height: 2160, label: '4K' };
    else if (savedRes === '1440p') res = { width: 2560, height: 1440, label: '1440p' };
    else if (savedRes === '720p') res = { width: 1280, height: 720, label: '720p' };
    else if (savedRes === '480p') res = { width: 854, height: 480, label: '480p' };
    else if (savedRes === '360p') res = { width: 640, height: 360, label: '360p' };
    this.currentResolution = res;

    // Apply defaults to modal dropdowns
    const modalRes = document.getElementById('modal-select-resolution') as HTMLSelectElement;
    const modalFps = document.getElementById('modal-select-fps') as HTMLSelectElement;
    const modalBitrate = document.getElementById('modal-select-bitrate') as HTMLSelectElement;
    const modalCursor = document.getElementById('modal-check-cursor') as HTMLInputElement;

    if (modalRes) modalRes.value = savedRes;
    if (modalFps) modalFps.value = savedFps.toString();
    if (modalBitrate) modalBitrate.value = savedBitrate.toString();
    if (modalCursor) modalCursor.checked = savedCursor;
  }

  private initAudioFilterSettings() {
    const savedMode = (localStorage.getItem('p2sharer_audio_filter_mode') as 'exclude' | 'include') || 'exclude';
    this.selectedFilterMode = savedMode;

    const savedExcludeRaw = localStorage.getItem('p2sharer_audio_exclude_names');
    if (savedExcludeRaw) {
      try {
        const savedExclude = JSON.parse(savedExcludeRaw);
        if (Array.isArray(savedExclude)) {
          this.excludeProcessNames = new Set(savedExclude.map((n: string) => n.toLowerCase()));
        }
      } catch {
        this.excludeProcessNames = new Set(['p2sharer', 'p2sharer.exe']);
      }
    } else {
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

    const radio = document.querySelector(`input[name="audio-filter-mode"][value="${savedMode}"]`) as HTMLInputElement;
    if (radio) radio.checked = true;

    // Pre-populate process list and map PIDs immediately on start
    this.loadProcessList().catch(() => {});
  }

  private saveAudioFilterPresets() {
    localStorage.setItem('p2sharer_audio_filter_mode', this.selectedFilterMode);
    localStorage.setItem('p2sharer_audio_exclude_names', JSON.stringify(Array.from(this.excludeProcessNames)));
    localStorage.setItem('p2sharer_audio_include_names', JSON.stringify(Array.from(this.includeProcessNames)));
  }

  private getActiveFilterPids(): number[] {
    return Array.from(this.selectedFilterMode === 'exclude' ? this.excludePids : this.includePids);
  }

  private getActiveFilterNames(): string[] {
    return Array.from(this.selectedFilterMode === 'exclude' ? this.excludeProcessNames : this.includeProcessNames);
  }


  private applyTheme(mode: 'dark' | 'light' | 'system') {
    this.currentThemeMode = mode;
    let effectiveTheme = mode;
    if (mode === 'system') {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      effectiveTheme = prefersDark ? 'dark' : 'light';
    }
    document.documentElement.setAttribute('data-theme', effectiveTheme);
    localStorage.setItem('p2sharer_theme_mode', mode);

    // Update settings pills UI
    document.querySelectorAll('.theme-mode-pills .pill-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-theme-mode') === mode);
    });
  }

  private applyAccent(accent: string) {
    this.currentAccentColor = accent;
    document.documentElement.setAttribute('data-accent', accent);
    localStorage.setItem('p2sharer_accent_color', accent);

    // Update settings swatches UI
    document.querySelectorAll('.accent-swatch').forEach((swatch) => {
      swatch.classList.toggle('active', swatch.getAttribute('data-accent') === accent);
    });
  }

  private generateRandomRoomCode() {
    this.currentRoomCode = generateRandomRoomSlug();
  }

  // --- USERNAME SETUP ---
  private setupUsername() {
    const saved = localStorage.getItem('p2sharer_username');
    if (saved && saved.trim()) {
      this.username = saved.trim();
      this.updateUsernameDisplay();
    } else {
      this.showUsernameModal();
    }
  }

  private updateUsernameDisplay() {
    const displayEl = document.getElementById('current-username-display');
    if (displayEl) displayEl.textContent = this.username || 'Usuário';
  }

  private showUsernameModal() {
    const modal = document.getElementById('modal-username');
    const input = document.getElementById('input-username') as HTMLInputElement;
    if (modal && input) {
      input.value = this.username || `User_${Math.floor(1000 + Math.random() * 9000)}`;
      modal.classList.remove('hidden');
      input.focus();
    }
  }

  // --- VIEW NAVIGATION ---
  private switchView(viewId: 'view-home' | 'view-group-room') {
    document.querySelectorAll('.view').forEach((el) => el.classList.remove('active'));
    const target = document.getElementById(viewId);
    if (target) target.classList.add('active');

    const headerPill = document.getElementById('header-room-code-pill');
    if (headerPill) {
      headerPill.classList.toggle('hidden', viewId !== 'view-group-room');
    }
  }

  // --- TOAST NOTIFICATIONS ---
  private showToast(message: string, durationMs = 3500) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
      toast.remove();
    }, durationMs);
  }

  // --- EVENT BINDINGS ---
  private bindEvents() {
    // Settings Button & Modal
    document.getElementById('btn-open-settings')?.addEventListener('click', () => this.openSettingsModal());
    document.getElementById('btn-close-settings')?.addEventListener('click', () => this.closeSettingsModal());
    document.getElementById('btn-cancel-settings')?.addEventListener('click', () => this.closeSettingsModal());
    document.getElementById('btn-save-settings')?.addEventListener('click', () => this.saveSettingsFromModal());

    // Settings Vertical Tabs Navigation
    document.querySelectorAll('.settings-nav-item').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const targetTab = (e.currentTarget as HTMLElement).getAttribute('data-settings-tab');
        if (!targetTab) return;

        document.querySelectorAll('.settings-nav-item').forEach((b) => b.classList.remove('active'));
        document.querySelectorAll('.settings-tab-pane').forEach((p) => p.classList.remove('active'));

        (e.currentTarget as HTMLElement).classList.add('active');
        const pane = document.getElementById(`settings-pane-${targetTab}`);
        if (pane) pane.classList.add('active');
      });
    });

    // Diagnostics & Execution Logs Actions
    document.getElementById('btn-open-latest-log')?.addEventListener('click', async () => {
      try {
        await invoke('open_latest_log');
      } catch (err: any) {
        this.showToast(`Erro ao abrir o log: ${err}`);
      }
    });

    document.getElementById('btn-open-log-folder')?.addEventListener('click', async () => {
      try {
        await invoke('open_log_folder');
      } catch (err: any) {
        this.showToast(`Erro ao abrir a pasta: ${err}`);
      }
    });

    // Theme Mode Selection
    document.querySelectorAll('.theme-mode-pills .pill-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const mode = (e.currentTarget as HTMLElement).getAttribute('data-theme-mode') as 'dark' | 'light' | 'system';
        if (mode) this.applyTheme(mode);
      });
    });

    // Accent Color Swatches
    document.querySelectorAll('.accent-swatch').forEach((swatch) => {
      swatch.addEventListener('click', (e) => {
        const accent = (e.currentTarget as HTMLElement).getAttribute('data-accent');
        if (accent) this.applyAccent(accent);
      });
    });

    // Sound Effects Settings Controls
    const checkSfx = document.getElementById('settings-check-sfx-enabled') as HTMLInputElement;
    const sliderSfx = document.getElementById('settings-slider-sfx-volume') as HTMLInputElement;
    const labelSfx = document.getElementById('settings-sfx-volume-label');

    checkSfx?.addEventListener('change', () => {
      soundEffects.setEnabled(checkSfx.checked);
    });

    sliderSfx?.addEventListener('input', () => {
      const vol = parseInt(sliderSfx.value, 10);
      soundEffects.setVolume(vol / 100);
      if (labelSfx) labelSfx.textContent = `${vol}%`;
    });

    document.getElementById('btn-test-sfx-join')?.addEventListener('click', () => soundEffects.playUserJoin());
    document.getElementById('btn-test-sfx-stream-start')?.addEventListener('click', () => soundEffects.playScreenShareStart());
    document.getElementById('btn-test-sfx-watch-start')?.addEventListener('click', () => soundEffects.playWatchStreamStart());
    document.getElementById('btn-test-sfx-watch-stop')?.addEventListener('click', () => soundEffects.playWatchStreamStop());

    // TURN config toggle in settings
    document.getElementById('settings-enable-turn')?.addEventListener('change', (e) => {
      const isChecked = (e.target as HTMLInputElement).checked;
      const fields = document.getElementById('turn-config-fields');
      if (fields) fields.style.display = isChecked ? 'flex' : 'none';
    });

    // Username modal & pill
    document.getElementById('user-pill')?.addEventListener('click', () => this.openSettingsModal());
    document.getElementById('btn-save-username')?.addEventListener('click', () => {
      const input = document.getElementById('input-username') as HTMLInputElement;
      const val = input.value.trim();
      if (!val) {
        this.showToast('Por favor, digite um nome válido.');
        return;
      }
      this.username = val;
      localStorage.setItem('p2sharer_username', this.username);
      this.updateUsernameDisplay();
      document.getElementById('modal-username')?.classList.add('hidden');
      this.showToast(`Nome salvo: ${this.username}`);
    });

    // Room Header Badges & Actions
    document.getElementById('header-room-code-pill')?.addEventListener('click', () => this.copyRoomCodeToClipboard());
    document.getElementById('btn-open-room-security')?.addEventListener('click', () => this.openRoomSecurityModal());

    // Create Room Modal Actions
    document.getElementById('btn-create-room-direct')?.addEventListener('click', () => this.openCreateRoomDialog());
    document.getElementById('btn-close-create-dialog')?.addEventListener('click', () => this.closeCreateRoomDialog());
    document.getElementById('btn-cancel-create-dialog')?.addEventListener('click', () => this.closeCreateRoomDialog());
    document.getElementById('btn-regen-room-code')?.addEventListener('click', () => this.regenCreateRoomCode());
    document.getElementById('btn-confirm-create-dialog')?.addEventListener('click', () => this.confirmCreateRoomFromDialog());

    // Join Room Modal Actions
    document.getElementById('btn-start-join-flow')?.addEventListener('click', () => this.openJoinDialog());
    document.getElementById('btn-close-join-dialog')?.addEventListener('click', () => this.closeJoinDialog());
    document.getElementById('btn-cancel-join-dialog')?.addEventListener('click', () => this.closeJoinDialog());
    document.getElementById('btn-confirm-join-dialog')?.addEventListener('click', () => this.confirmJoinFromDialog());

    // Room Security Modal Actions
    document.getElementById('btn-close-room-security')?.addEventListener('click', () => this.closeRoomSecurityModal());
    document.getElementById('btn-cancel-room-security')?.addEventListener('click', () => this.closeRoomSecurityModal());
    document.getElementById('btn-save-room-security')?.addEventListener('click', () => this.saveRoomSecurityPassword());

    // Password Visibility Toggles
    document.getElementById('btn-toggle-create-password-visibility')?.addEventListener('click', () => {
      this.togglePasswordVisibility('input-create-room-password-dialog', 'icon-create-pass-toggle');
    });
    document.getElementById('btn-toggle-join-password-visibility')?.addEventListener('click', () => {
      this.togglePasswordVisibility('input-join-room-password-dialog', 'icon-join-pass-toggle');
    });
    document.getElementById('btn-toggle-security-password-visibility')?.addEventListener('click', () => {
      this.togglePasswordVisibility('input-room-security-password', 'icon-sec-pass-toggle');
    });

    // Cancel Connecting Button
    document.getElementById('btn-cancel-connecting')?.addEventListener('click', () => {
      this.hideConnectingOverlay();
      this.leaveRoom();
    });

    // Toggle Sidebar (Chat)
    document.getElementById('btn-toggle-sidebar')?.addEventListener('click', () => this.toggleSidebar());

    // Spotlight bottom tray toggle
    document.getElementById('btn-toggle-spotlight-tray')?.addEventListener('click', () => this.toggleSpotlightTray());

    // Transmission Button (Opens Discord-style picker or stops active stream)
    document.getElementById('btn-toggle-share-screen')?.addEventListener('click', () => {
      if (this.isSharingScreen) {
        this.stopScreenSharing();
      } else {
        this.openScreenPickerModal();
      }
    });

    // Screen Picker Modal Tabs & Buttons
    document.getElementById('btn-close-screen-picker')?.addEventListener('click', () => this.closeScreenPickerModal());
    document.getElementById('btn-cancel-picker')?.addEventListener('click', () => this.closeScreenPickerModal());
    document.getElementById('btn-confirm-picker')?.addEventListener('click', () => this.startSelectedCapture());

    document.getElementById('picker-tab-screens')?.addEventListener('click', () => this.switchPickerTab('screens'));
    document.getElementById('picker-tab-windows')?.addEventListener('click', () => this.switchPickerTab('windows'));

    // Audio Filter Modal
    document.getElementById('btn-open-audio-filter')?.addEventListener('click', () => this.openAudioFilterModal());
    document.getElementById('btn-close-audio-modal')?.addEventListener('click', () => this.closeAudioFilterModal());
    document.getElementById('btn-cancel-audio-filter')?.addEventListener('click', () => this.closeAudioFilterModal());
    document.getElementById('btn-refresh-processes')?.addEventListener('click', () => this.loadProcessList());
    document.getElementById('btn-apply-audio-filter')?.addEventListener('click', () => this.applyAudioFilters());
    document.getElementById('input-search-process')?.addEventListener('input', (e) => {
      const search = (e.target as HTMLInputElement).value.toLowerCase();
      this.renderProcessCheckboxes(search);
    });

    document.querySelectorAll('input[name="audio-filter-mode"]').forEach((r) => {
      r.addEventListener('change', (e) => {
        this.selectedFilterMode = (e.target as HTMLInputElement).value as 'exclude' | 'include';
        this.saveAudioFilterPresets();
        const search = (document.getElementById('input-search-process') as HTMLInputElement)?.value.toLowerCase() || '';
        this.renderProcessCheckboxes(search);
      });
    });

    // Room Topbar Controls
    document.getElementById('btn-leave-room')?.addEventListener('click', () => this.leaveRoom());
    document.getElementById('btn-room-fullscreen')?.addEventListener('click', () => this.toggleFullscreen());

    // Sidebar Tabs
    document.getElementById('tab-btn-chat')?.addEventListener('click', () => this.switchSidebarTab('chat'));
    document.getElementById('tab-btn-participants')?.addEventListener('click', () => this.switchSidebarTab('participants'));

    // Chat Form
    document.getElementById('chat-input-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = document.getElementById('chat-input-field') as HTMLInputElement;
      const text = input.value.trim();
      if (!text) return;

      if (this.roomManager) {
        const msg = this.roomManager.sendChatMessage(text);
        this.appendChatMessage(msg);
        input.value = '';
      }
    });

    // Window Unload (Auto-leave room on close / refresh)
    window.addEventListener('beforeunload', () => {
      this.leaveRoom();
    });
  }

  // --- SETTINGS MODAL ---
  private openSettingsModal() {
    const modal = document.getElementById('modal-settings');
    const inputUsername = document.getElementById('settings-input-username') as HTMLInputElement;
    const selectRes = document.getElementById('settings-default-resolution') as HTMLSelectElement;
    const selectFps = document.getElementById('settings-default-fps') as HTMLSelectElement;
    const selectBitrate = document.getElementById('settings-default-bitrate') as HTMLSelectElement;
    const checkCursor = document.getElementById('settings-check-cursor') as HTMLInputElement;

    const checkTurn = document.getElementById('settings-enable-turn') as HTMLInputElement;
    const inputTurnUrl = document.getElementById('settings-turn-url') as HTMLInputElement;
    const inputTurnUser = document.getElementById('settings-turn-username') as HTMLInputElement;
    const inputTurnCred = document.getElementById('settings-turn-credential') as HTMLInputElement;
    const checkTurnRelay = document.getElementById('settings-turn-force-relay') as HTMLInputElement;
    const turnFields = document.getElementById('turn-config-fields');

    if (inputUsername) inputUsername.value = this.username;
    if (selectRes) selectRes.value = localStorage.getItem('p2sharer_default_res') || '1080p';
    if (selectFps) selectFps.value = localStorage.getItem('p2sharer_default_fps') || '60';
    if (selectBitrate) selectBitrate.value = localStorage.getItem('p2sharer_default_bitrate') || '25000';
    if (checkCursor) checkCursor.checked = localStorage.getItem('p2sharer_default_cursor') !== 'false';

    const turnEnabled = localStorage.getItem('p2sharer_turn_enabled') === 'true';
    if (checkTurn) checkTurn.checked = turnEnabled;
    if (inputTurnUrl) inputTurnUrl.value = localStorage.getItem('p2sharer_turn_url') || '';
    if (inputTurnUser) inputTurnUser.value = localStorage.getItem('p2sharer_turn_user') || '';
    if (inputTurnCred) inputTurnCred.value = localStorage.getItem('p2sharer_turn_cred') || '';
    if (checkTurnRelay) checkTurnRelay.checked = localStorage.getItem('p2sharer_turn_force_relay') === 'true';
    if (turnFields) turnFields.style.display = turnEnabled ? 'flex' : 'none';

    // Populate Sound Effects Settings
    const checkSfx = document.getElementById('settings-check-sfx-enabled') as HTMLInputElement;
    const sliderSfx = document.getElementById('settings-slider-sfx-volume') as HTMLInputElement;
    const labelSfx = document.getElementById('settings-sfx-volume-label');
    if (checkSfx) checkSfx.checked = soundEffects.getEnabled();
    const currentVolPercent = Math.round(soundEffects.getVolume() * 100);
    if (sliderSfx) sliderSfx.value = currentVolPercent.toString();
    if (labelSfx) labelSfx.textContent = `${currentVolPercent}%`;

    // Load Log Path
    invoke<string>('get_log_file_path')
      .then((path) => {
        const pathEl = document.getElementById('settings-log-path-text');
        if (pathEl) pathEl.textContent = path;
      })
      .catch(() => {});

    modal?.classList.remove('hidden');
  }

  private closeSettingsModal() {
    document.getElementById('modal-settings')?.classList.add('hidden');
  }

  private saveSettingsFromModal() {
    const inputUsername = document.getElementById('settings-input-username') as HTMLInputElement;
    const selectRes = document.getElementById('settings-default-resolution') as HTMLSelectElement;
    const selectFps = document.getElementById('settings-default-fps') as HTMLSelectElement;
    const selectBitrate = document.getElementById('settings-default-bitrate') as HTMLSelectElement;
    const checkCursor = document.getElementById('settings-check-cursor') as HTMLInputElement;

    const checkTurn = document.getElementById('settings-enable-turn') as HTMLInputElement;
    const inputTurnUrl = document.getElementById('settings-turn-url') as HTMLInputElement;
    const inputTurnUser = document.getElementById('settings-turn-username') as HTMLInputElement;
    const inputTurnCred = document.getElementById('settings-turn-credential') as HTMLInputElement;
    const checkTurnRelay = document.getElementById('settings-turn-force-relay') as HTMLInputElement;

    const checkSfx = document.getElementById('settings-check-sfx-enabled') as HTMLInputElement;
    const sliderSfx = document.getElementById('settings-slider-sfx-volume') as HTMLInputElement;

    if (checkSfx) soundEffects.setEnabled(checkSfx.checked);
    if (sliderSfx) soundEffects.setVolume(parseInt(sliderSfx.value, 10) / 100);

    if (inputUsername && inputUsername.value.trim()) {
      this.username = inputUsername.value.trim();
      localStorage.setItem('p2sharer_username', this.username);
      this.updateUsernameDisplay();
    }

    if (selectRes) localStorage.setItem('p2sharer_default_res', selectRes.value);
    if (selectFps) localStorage.setItem('p2sharer_default_fps', selectFps.value);
    if (selectBitrate) localStorage.setItem('p2sharer_default_bitrate', selectBitrate.value);
    if (checkCursor) localStorage.setItem('p2sharer_default_cursor', checkCursor.checked.toString());

    const isTurnChecked = checkTurn?.checked === true;
    localStorage.setItem('p2sharer_turn_enabled', isTurnChecked ? 'true' : 'false');
    
    if (inputTurnUrl) {
      let turnUrlVal = inputTurnUrl.value.trim();
      if (turnUrlVal && !turnUrlVal.startsWith('turn:') && !turnUrlVal.startsWith('turns:') && !turnUrlVal.startsWith('stun:')) {
        turnUrlVal = `turn:${turnUrlVal}`;
        inputTurnUrl.value = turnUrlVal;
      }
      localStorage.setItem('p2sharer_turn_url', turnUrlVal);
    }
    if (inputTurnUser) localStorage.setItem('p2sharer_turn_user', inputTurnUser.value.trim());
    if (inputTurnCred) localStorage.setItem('p2sharer_turn_cred', inputTurnCred.value.trim());
    if (checkTurnRelay) localStorage.setItem('p2sharer_turn_force_relay', checkTurnRelay.checked ? 'true' : 'false');

    this.syncPickerModalDefaults();
    this.closeSettingsModal();
    this.showToast('Configurações salvas com sucesso!');
  }

  // --- TOGGLE SIDEBAR (CHAT) ---
  private toggleSidebar() {
    this.isSidebarCollapsed = !this.isSidebarCollapsed;
    const sidebar = document.getElementById('room-sidebar');
    const label = document.getElementById('label-toggle-sidebar');
    if (sidebar) {
      sidebar.classList.toggle('collapsed', this.isSidebarCollapsed);
    }
    if (label) {
      label.textContent = this.isSidebarCollapsed ? 'Abrir' : 'Chat';
    }
  }

  // --- TOGGLE SPOTLIGHT BOTTOM TRAY ---
  private toggleSpotlightTray() {
    this.isSpotlightTrayCollapsed = !this.isSpotlightTrayCollapsed;
    const tray = document.getElementById('spotlight-tray-container');
    if (tray) {
      tray.classList.toggle('collapsed', this.isSpotlightTrayCollapsed);
    }
  }

  // --- CREATE ROOM ---
  private openCreateRoomDialog() {
    if (!this.username) {
      this.showUsernameModal();
      return;
    }
    const modal = document.getElementById('modal-create-room-dialog');
    const codeInput = document.getElementById('input-create-room-code-dialog') as HTMLInputElement;
    const passInput = document.getElementById('input-create-room-password-dialog') as HTMLInputElement;

    if (codeInput) codeInput.value = generateRandomRoomSlug();
    if (passInput) passInput.value = '';

    modal?.classList.remove('hidden');
    codeInput?.focus();
  }

  private closeCreateRoomDialog() {
    document.getElementById('modal-create-room-dialog')?.classList.add('hidden');
  }

  private regenCreateRoomCode() {
    const codeInput = document.getElementById('input-create-room-code-dialog') as HTMLInputElement;
    if (codeInput) codeInput.value = generateRandomRoomSlug();
  }

  private confirmCreateRoomFromDialog() {
    const codeInput = (document.getElementById('input-create-room-code-dialog') as HTMLInputElement).value.trim();
    const passInput = (document.getElementById('input-create-room-password-dialog') as HTMLInputElement).value.trim();

    this.currentRoomCode = codeInput || generateRandomRoomSlug();
    this.currentRoomPassword = passInput;
    this.isCreator = true;

    this.closeCreateRoomDialog();
    this.enterRoomUI();
    this.connectToRoom();

    if (this.currentRoomPassword) {
      this.showToast(`Sala "${this.currentRoomCode}" criada com proteção por senha!`);
    } else {
      this.showToast(`Sala "${this.currentRoomCode}" criada!`);
    }
  }

  // --- JOIN ROOM ---
  private openJoinDialog() {
    if (!this.username) {
      this.showUsernameModal();
      return;
    }
    const modal = document.getElementById('modal-join-room-dialog');
    const codeInput = document.getElementById('input-join-room-code-dialog') as HTMLInputElement;
    const passInput = document.getElementById('input-join-room-password-dialog') as HTMLInputElement;

    if (codeInput) codeInput.value = '';
    if (passInput) passInput.value = '';

    modal?.classList.remove('hidden');
    codeInput?.focus();
  }

  private closeJoinDialog() {
    document.getElementById('modal-join-room-dialog')?.classList.add('hidden');
  }

  private confirmJoinFromDialog() {
    const codeInput = (document.getElementById('input-join-room-code-dialog') as HTMLInputElement).value.trim();
    const passInput = (document.getElementById('input-join-room-password-dialog') as HTMLInputElement).value.trim();

    if (!codeInput) {
      this.showToast('Por favor, digite o código da sala.');
      return;
    }

    this.isCreator = false;
    this.currentRoomCode = codeInput;
    this.currentRoomPassword = passInput;

    this.closeJoinDialog();
    this.enterRoomUI();
    this.connectToRoom();
    this.showToast(`Conectando à sala ${this.currentRoomCode}...`);
  }

  // --- ROOM SECURITY & PASSWORD MANAGER ---
  private openRoomSecurityModal() {
    const modal = document.getElementById('modal-room-security');
    const codeEl = document.getElementById('sec-modal-room-code');
    const statusEl = document.getElementById('sec-modal-current-status');
    const passInput = document.getElementById('input-room-security-password') as HTMLInputElement;

    if (codeEl) codeEl.textContent = this.currentRoomCode;
    if (statusEl) {
      statusEl.innerHTML = this.currentRoomPassword
        ? `${ICONS.lock} <span>Protegida por Senha ("${this.currentRoomPassword}")</span>`
        : `${ICONS.unlock} <span>Pública (Sem Senha)</span>`;
    }
    if (passInput) passInput.value = this.currentRoomPassword;

    modal?.classList.remove('hidden');
    passInput?.focus();
  }

  private closeRoomSecurityModal() {
    document.getElementById('modal-room-security')?.classList.add('hidden');
  }

  private saveRoomSecurityPassword() {
    const passInput = (document.getElementById('input-room-security-password') as HTMLInputElement).value.trim();
    const oldPassword = this.currentRoomPassword;
    this.currentRoomPassword = passInput;

    if (this.roomManager) {
      this.roomManager.updateRoomPassword(passInput);
    }

    this.updateRoomSecurityHeaderUI();
    this.closeRoomSecurityModal();

    if (passInput) {
      this.showToast(`Senha da sala alterada para "${passInput}" e sincronizada com todos!`, 4000);
    } else if (oldPassword && !passInput) {
      this.showToast('Senha removida: a sala agora é pública.', 4000);
    } else {
      this.showToast('Configurações de segurança da sala salvas.');
    }
  }

  // --- PASSWORD VISIBILITY TOGGLE ---
  private togglePasswordVisibility(inputId: string, iconId: string) {
    const input = document.getElementById(inputId) as HTMLInputElement;
    const icon = document.getElementById(iconId);
    if (!input) return;

    if (input.type === 'password') {
      input.type = 'text';
      if (icon) icon.innerHTML = ICONS.eyeOff;
    } else {
      input.type = 'password';
      if (icon) icon.innerHTML = ICONS.eye;
    }
  }

  private updateRoomSecurityHeaderUI() {
    const codeEl = document.getElementById('display-room-code');
    const lockEl = document.getElementById('header-room-lock-icon');
    const pillEl = document.getElementById('header-room-code-pill');

    if (codeEl) codeEl.textContent = this.currentRoomCode;
    if (lockEl) {
      lockEl.innerHTML = this.currentRoomPassword ? ICONS.lock : ICONS.unlock;
      lockEl.title = this.currentRoomPassword
        ? `Protegida por Senha: ${this.currentRoomPassword}`
        : 'Sala Pública (Sem Senha)';
    }
    if (pillEl) {
      pillEl.title = this.currentRoomPassword
        ? `Clique para copiar o código e senha da sala (${this.currentRoomCode})`
        : `Clique para copiar o código da sala (${this.currentRoomCode})`;
    }
  }

  private showConnectingOverlay(roomCode: string, title = 'Entrando na sala...', subtitle = 'Estabelecendo sinalização e túnel P2P criptografado...') {
    const overlay = document.getElementById('connecting-overlay');
    const titleEl = document.getElementById('connecting-title');
    const subEl = document.getElementById('connecting-subtitle');
    const codeEl = document.getElementById('connecting-room-code');

    if (titleEl) titleEl.textContent = title;
    if (subEl) subEl.textContent = subtitle;
    if (codeEl) codeEl.textContent = `SALA: ${roomCode}${this.currentRoomPassword ? ' (Protegida)' : ''}`;
    if (overlay) overlay.classList.remove('hidden');
  }

  private hideConnectingOverlay() {
    const overlay = document.getElementById('connecting-overlay');
    if (overlay) overlay.classList.add('hidden');
  }

  private connectToRoom() {
    if (this.roomManager) {
      this.roomManager.leave();
    }

    let hasLoadedPeers = false;
    let fallbackTimeout: ReturnType<typeof setTimeout> | null = null;

    if (this.isCreator) {
      this.showConnectingOverlay(
        this.currentRoomCode,
        'Criando sala P2P...',
        'Iniciando canal de transmissão e nó mestre...'
      );
    } else {
      this.showConnectingOverlay(
        this.currentRoomCode,
        'Entrando na sala...',
        'Localizando apresentador e participantes...'
      );

      // Fallback: If room is empty or takes longer than 3.5s, reveal the room anyway
      fallbackTimeout = setTimeout(() => {
        if (!hasLoadedPeers) {
          hasLoadedPeers = true;
          this.hideConnectingOverlay();
        }
      }, 3500);
    }

    const isTurnEnabled = localStorage.getItem('p2sharer_turn_enabled') === 'true';
    const rawTurnUrl = (localStorage.getItem('p2sharer_turn_url') || '').trim();
    let sanitizedTurnUrl: string | undefined = undefined;
    if (isTurnEnabled && rawTurnUrl) {
      sanitizedTurnUrl = (rawTurnUrl.startsWith('turn:') || rawTurnUrl.startsWith('turns:') || rawTurnUrl.startsWith('stun:'))
        ? rawTurnUrl
        : `turn:${rawTurnUrl}`;
    }

    const turnConfig: TurnConfig = {
      enabled: isTurnEnabled && Boolean(sanitizedTurnUrl),
      url: isTurnEnabled ? sanitizedTurnUrl : undefined,
      username: isTurnEnabled ? (localStorage.getItem('p2sharer_turn_user') || undefined) : undefined,
      credential: isTurnEnabled ? (localStorage.getItem('p2sharer_turn_cred') || undefined) : undefined,
      forceRelay: isTurnEnabled && localStorage.getItem('p2sharer_turn_force_relay') === 'true',
    };

    this.roomManager = new GroupRoomManager(
      this.username,
      this.currentRoomCode,
      this.currentRoomPassword,
      this.isCreator,
      turnConfig
    );

    this.roomManager.join({
      onStreamsUpdate: () => {},
      onSlotsUpdate: (slots) => {
        this.roomSlots = slots;
        this.renderRoomCards();
        this.updateStatsHUD();

        // When joining, dismiss loading screen as soon as other participants are loaded
        if (!this.isCreator && slots.length > 1 && !hasLoadedPeers) {
          hasLoadedPeers = true;
          if (fallbackTimeout) clearTimeout(fallbackTimeout);
          setTimeout(() => {
            this.hideConnectingOverlay();
          }, 350);
        }
      },
      onChat: (msg) => {
        this.appendChatMessage(msg);
      },
      onChatHistory: (messages) => {
        this.renderChatHistory(messages);
      },
      onPeersUpdate: (peers) => {
        this.updatePeersList(peers);
        if (!this.isCreator && peers.length > 0 && !hasLoadedPeers) {
          hasLoadedPeers = true;
          if (fallbackTimeout) clearTimeout(fallbackTimeout);
          setTimeout(() => {
            this.hideConnectingOverlay();
          }, 350);
        }
      },
      onPeerJoined: (_peer, isInitial) => {
        if (!isInitial) {
          soundEffects.playUserJoin();
        }
      },
      onPeerLeft: (_peerId, _username) => {
        soundEffects.playUserLeave();
      },
      onStreamStarted: (_peerId, _username, _isLocal) => {
        soundEffects.playScreenShareStart();
      },
      onStreamStopped: (peerId, _username, isLocal) => {
        soundEffects.playScreenShareStop();
        if (!isLocal && this.subscribedStreams.has(peerId)) {
          this.subscribedStreams.delete(peerId);
          this.renderRoomCards();
        }
      },
      onWatchStarted: (watcherPeerId, _watcherName, broadcasterPeerId) => {
        const isWatchingThisStream = this.subscribedStreams.has(broadcasterPeerId);
        const isMyStream = broadcasterPeerId === 'local' || this.isSharingScreen;
        if (isWatchingThisStream || isMyStream || watcherPeerId === 'local') {
          soundEffects.playWatchStreamStart();
        }
      },
      onWatchStopped: (watcherPeerId, _watcherName, broadcasterPeerId) => {
        const isWatchingThisStream = this.subscribedStreams.has(broadcasterPeerId);
        const isMyStream = broadcasterPeerId === 'local' || this.isSharingScreen;
        if (isWatchingThisStream || isMyStream || watcherPeerId === 'local') {
          soundEffects.playWatchStreamStop();
        }
      },
      onStatusChange: (status) => {
        const statsBadge = document.getElementById('room-stats-badge');
        if (statsBadge) statsBadge.textContent = status;

        if (status === 'Sala Ativa' || status.includes('Conectado') || status === 'Ao Vivo') {
          if (fallbackTimeout) clearTimeout(fallbackTimeout);
          setTimeout(() => {
            this.hideConnectingOverlay();
          }, 350);
        }
      },
      onPasswordChange: (newPassword, updatedBy) => {
        this.currentRoomPassword = newPassword;
        this.updateRoomSecurityHeaderUI();
        if (newPassword) {
          this.showToast(`A senha da sala foi atualizada por ${updatedBy}: "${newPassword}"`, 5000);
        } else {
          this.showToast(`A sala agora é pública (sem senha) - atualizado por ${updatedBy}`, 5000);
        }
      },
    });
  }

  private enterRoomUI() {
    soundEffects.playUserJoin();
    const displayRoomCode = document.getElementById('display-room-code');
    if (displayRoomCode) displayRoomCode.textContent = this.currentRoomCode;

    this.updateRoomSecurityHeaderUI();

    this.roomSlots = [
      {
        peerId: 'local',
        senderName: this.username,
        stream: null,
        isStreaming: false,
        isLocal: true,
        color: 'hsl(190, 65%, 45%)',
      },
    ];
    this.renderRoomCards();

    const chatContainer = document.getElementById('chat-messages-container');
    if (chatContainer) {
      chatContainer.innerHTML = `
        <div class="chat-welcome-notice">
          <span>Você entrou na sala <strong>${this.currentRoomCode}</strong>${
        this.currentRoomPassword ? ' (com senha)' : ''
      }. Compartilhe o código para convidar amigos.</span>
        </div>
      `;
    }

    this.updateShareButtonUI(false);
    this.startLiveStatsTracker();
    this.switchView('view-group-room');
  }

  // --- LIVE STATS TRACKER (FPS, RESOLUTION, PING & WATCHERS) ---
  private startLiveStatsTracker() {
    this.stopLiveStatsTracker();
    this.liveStatsTimer = setInterval(async () => {
      await this.updateLiveStreamStats();
    }, 1500);
    // Initial run
    setTimeout(() => this.updateLiveStreamStats(), 200);
  }

  private stopLiveStatsTracker() {
    if (this.liveStatsTimer) {
      clearInterval(this.liveStatsTimer);
      this.liveStatsTimer = null;
    }
  }

  private async updateLiveStreamStats() {
    const streamCards = document.querySelectorAll<HTMLElement>('.stream-card');
    if (streamCards.length === 0) {
      const hud = document.getElementById('stream-hud-overlay');
      if (hud) hud.style.display = 'none';
      return;
    }

    for (const card of Array.from(streamCards)) {
      const peerId = card.getAttribute('data-peer-id');
      if (!peerId) continue;

      const video = card.querySelector('video');
      const qualityEl = card.querySelector('.stat-quality-text');
      const pingEl = card.querySelector('.stat-ping-text');
      const pingDot = card.querySelector('.stat-ping-dot');
      const watchersEl = card.querySelector('.stat-watchers-text');
      const isLocal = peerId === 'local';

      // 1. Resolution / Quality Label
      let qualityLabel = isLocal ? this.currentResolution.label : '1080p';
      if (video && video.videoHeight > 0) {
        const h = video.videoHeight;
        if (h >= 2000) qualityLabel = '4K';
        else if (h >= 1400) qualityLabel = '1440p';
        else if (h >= 1000) qualityLabel = '1080p';
        else if (h >= 700) qualityLabel = '720p';
        else if (h >= 450) qualityLabel = '480p';
        else if (h >= 300) qualityLabel = '360p';
        else qualityLabel = `${h}p`;
      }

      // 2. Fetch live stats
      const stats = isLocal ? null : await this.roomManager?.getPeerStats(peerId);
      const fps = stats?.fps ?? (isLocal ? this.currentFps : video && video.videoHeight > 0 ? 60 : 30);
      const ping = isLocal ? 0 : (stats?.pingMs ?? this.roomManager?.getPeerPing(peerId) ?? null);

      if (qualityEl) {
        qualityEl.textContent = `${qualityLabel} ${fps} FPS`;
      }

      if (pingEl) {
        if (isLocal) {
          pingEl.textContent = 'Local';
        } else {
          pingEl.textContent = ping !== null ? `${ping} ms` : '-- ms';
          if (pingDot && ping !== null) {
            pingDot.className = `stat-ping-dot ${ping < 80 ? 'ping-good' : ping < 180 ? 'ping-medium' : 'ping-poor'}`;
          }
        }
      }

      // 3. Watchers
      const watchers = this.roomManager?.getStreamWatchers(peerId) || [];
      const count = watchers.length;
      if (watchersEl) {
        watchersEl.textContent = count === 1 ? '1 assistindo' : `${count} assistindo`;
        const tooltip = count > 0 ? `Assistindo: ${watchers.map((w) => w.username).join(', ')}` : 'Ninguém assistindo no momento';
        watchersEl.parentElement?.setAttribute('title', tooltip);
      }

      // 4. Update Floating HUD overlay (spotlight / pinned stream)
      if (card.classList.contains('featured') || streamCards.length === 1) {
        const hud = document.getElementById('stream-hud-overlay');
        const resFpsText = document.getElementById('hud-res-fps-text');
        const bitrateText = document.getElementById('hud-bitrate-text');
        const pingTextEl = document.getElementById('hud-ping-text');
        const watchersTextEl = document.getElementById('hud-watchers-text');

        if (hud) hud.style.display = 'block';
        if (resFpsText) resFpsText.textContent = `${qualityLabel} ${fps} FPS`;
        if (bitrateText) {
          const bitrateVal = stats?.bitrateKbps ? (stats.bitrateKbps / 1000).toFixed(1) : (this.currentBitrate / 1000).toFixed(1);
          bitrateText.textContent = `${bitrateVal} Mbps`;
        }
        if (pingTextEl) {
          pingTextEl.textContent = isLocal ? '0 ms (Local)' : ping !== null ? `${ping} ms` : '-- ms';
        }
        if (watchersTextEl) {
          watchersTextEl.textContent = `👁️ ${count} assistindo`;
          const tooltip = count > 0 ? `Assistindo: ${watchers.map((w) => w.username).join(', ')}` : 'Nenhum espectador';
          watchersTextEl.setAttribute('title', tooltip);
        }
      }
    }
  }

  // --- STATS HUD ---
  private updateStatsHUD() {
    const hud = document.getElementById('stream-hud-overlay');
    const resFpsText = document.getElementById('hud-res-fps-text');
    const bitrateText = document.getElementById('hud-bitrate-text');
    const pingTextEl = document.getElementById('hud-ping-text');
    const watchersTextEl = document.getElementById('hud-watchers-text');

    if (!hud) return;

    const streamingSlots = this.roomSlots.filter((s) => s.isStreaming);

    if (streamingSlots.length === 0) {
      hud.style.display = 'none';
      return;
    }

    hud.style.display = 'block';
    if (resFpsText) resFpsText.textContent = `${this.currentResolution.label} ${this.currentFps} FPS`;
    if (bitrateText) bitrateText.textContent = `${(this.currentBitrate / 1000).toFixed(1)} Mbps`;
    if (pingTextEl) pingTextEl.textContent = this.isSharingScreen ? '0 ms' : '15 ms';
    if (watchersTextEl) {
      const localWatchers = this.roomManager?.getStreamWatchers('local') || [];
      watchersTextEl.textContent = `👁️ ${localWatchers.length} assistindo`;
    }
  }

  // --- ROOM CARDS RENDERER (AVATARS + SCREENS) ---
  private renderRoomCards() {
    const gridWrapper = document.getElementById('streams-grid-wrapper');
    const spotlightStage = document.getElementById('spotlight-stage');
    const featuredArea = document.getElementById('spotlight-featured-area');
    const trayStrip = document.getElementById('spotlight-tray-strip');
    const sharingTag = document.getElementById('room-sharing-status-tag');
    const liveBadge = document.getElementById('room-live-badge');

    if (!gridWrapper || !spotlightStage || !featuredArea || !trayStrip) return;

    const totalCount = this.roomSlots.length;
    const streamingCount = this.roomSlots.filter((s) => s.isStreaming).length;

    if (sharingTag) {
      sharingTag.textContent = `${totalCount} ${totalCount === 1 ? 'pessoa' : 'pessoas'} (${streamingCount} ao vivo)`;
    }
    if (liveBadge) {
      liveBadge.textContent = streamingCount > 0 ? 'AO VIVO' : 'SALA ATIVA';
    }

    // Auto-adjust spotlight if the pinned person left
    if (this.pinnedPeerId && !this.roomSlots.some((s) => s.peerId === this.pinnedPeerId)) {
      this.pinnedPeerId = null;
      this.layoutMode = 'grid';
    }

    // Prune stale cached cards for peers who left
    const currentPeerIds = new Set(this.roomSlots.map((s) => s.peerId));
    this.cachedCards.forEach((_, key) => {
      const peerId = key.split(':')[0];
      if (!currentPeerIds.has(peerId)) {
        this.cachedCards.delete(key);
        this.detachPeerAudio(peerId);
      }
    });

    if (this.layoutMode === 'grid') {
      gridWrapper.classList.remove('hidden');
      spotlightStage.classList.add('hidden');
      gridWrapper.innerHTML = '';

      this.roomSlots.forEach((slot) => {
        const card = this.getOrCreateCard(slot, false);
        card.onclick = () => {
          this.pinnedPeerId = slot.peerId;
          this.layoutMode = 'spotlight';
          this.renderRoomCards();
        };
        gridWrapper.appendChild(card);
      });
    } else {
      // Spotlight Mode
      gridWrapper.classList.add('hidden');
      spotlightStage.classList.remove('hidden');
      featuredArea.innerHTML = '';
      trayStrip.innerHTML = '';

      const featuredSlot = this.roomSlots.find((s) => s.peerId === this.pinnedPeerId) || this.roomSlots[0];
      if (featuredSlot) {
        const bigCard = this.getOrCreateCard(featuredSlot, true);
        bigCard.onclick = () => {
          // Clicking the featured card switches back to Grid mode
          this.layoutMode = 'grid';
          this.pinnedPeerId = null;
          this.renderRoomCards();
        };
        featuredArea.appendChild(bigCard);
      }

      // Populate bottom tray with all other participants
      const otherSlots = this.roomSlots.filter((s) => s.peerId !== featuredSlot?.peerId);
      otherSlots.forEach((slot) => {
        const miniCard = this.getOrCreateCard(slot, false);
        miniCard.onclick = () => {
          this.pinnedPeerId = slot.peerId;
          this.renderRoomCards();
        };
        trayStrip.appendChild(miniCard);
      });
    }
  }

  private getOrCreateCard(slot: RoomSlotInfo, isFeatured: boolean): HTMLElement {
    const isSubscribed = this.subscribedStreams.has(slot.peerId);
    const shouldBeVideo =
      (slot.isLocal && slot.isStreaming && Boolean(slot.stream)) ||
      (!slot.isLocal && slot.isStreaming && isSubscribed && Boolean(slot.stream));

    const streamId = slot.stream?.id;
    const cacheKey = `${slot.peerId}:${isFeatured ? 'feat' : 'norm'}`;
    const cached = this.cachedCards.get(cacheKey);

    if (cached && cached.isVideo === shouldBeVideo && cached.streamId === streamId) {
      // Re-use existing DOM element without resetting the <video> tag
      const label = cached.el.querySelector('.participant-avatar-label, .stream-card-overlay span:nth-child(2)');
      if (label && label.textContent !== slot.senderName) {
        label.textContent = slot.senderName;
      }
      const videoEl = cached.el.querySelector('video');
      if (videoEl && slot.stream && (videoEl.srcObject !== slot.stream || videoEl.paused)) {
        videoEl.srcObject = slot.stream;
        videoEl.play().catch(() => {});
      }
      return cached.el;
    }

    // Create fresh element and save to cache
    const el = this.createCardElement(slot, isFeatured);
    this.cachedCards.set(cacheKey, { el, isVideo: shouldBeVideo, streamId });
    return el;
  }

  private renderChatHistory(messages: ChatMessage[]) {
    const chatContainer = document.getElementById('chat-messages-container');
    if (!chatContainer) return;

    chatContainer.innerHTML = `
      <div class="chat-welcome-notice">
        <span>Você entrou na sala <strong>${this.currentRoomCode}</strong>. Histórico recuperado via P2P.</span>
      </div>
    `;

    messages.forEach((msg) => {
      this.appendChatMessage(msg);
    });
  }

  private attachPeerAudio(peerId: string, stream: MediaStream): PeerAudioSinkState {
    let state = this.peerAudioSinks.get(peerId);
    if (!state) {
      const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const audioCtx = new AudioContextClass();
      const gainNode = audioCtx.createGain();
      gainNode.gain.value = 1.0;
      gainNode.connect(audioCtx.destination);
      state = {
        audioCtx,
        source: null,
        gainNode,
        streamId: '',
        volume: 100,
        isMuted: false,
      };
      this.peerAudioSinks.set(peerId, state);
    }

    if (state.audioCtx.state === 'suspended') {
      state.audioCtx.resume().catch(() => {});
    }

    if (state.streamId !== stream.id || !state.source) {
      if (state.source) {
        try {
          state.source.disconnect();
        } catch {}
      }
      try {
        state.source = state.audioCtx.createMediaStreamSource(stream);
        state.source.connect(state.gainNode);
        state.streamId = stream.id;
      } catch (err) {
        console.warn('Failed to connect media stream source for peer:', peerId, err);
      }
    }

    state.gainNode.gain.value = state.isMuted ? 0 : state.volume / 100;
    return state;
  }

  private detachPeerAudio(peerId: string) {
    const state = this.peerAudioSinks.get(peerId);
    if (state) {
      if (state.source) {
        try { state.source.disconnect(); } catch {}
      }
      try { state.gainNode.disconnect(); } catch {}
      if (state.audioCtx.state !== 'closed') {
        state.audioCtx.close().catch(() => {});
      }
      this.peerAudioSinks.delete(peerId);
    }
  }

  private setPeerVolume(peerId: string, volume: number, isMuted?: boolean) {
    const state = this.peerAudioSinks.get(peerId);
    if (state) {
      state.volume = Math.max(0, Math.min(100, volume));
      if (isMuted !== undefined) {
        state.isMuted = isMuted;
      }
      state.gainNode.gain.value = state.isMuted ? 0 : state.volume / 100;
      if (state.audioCtx.state === 'suspended' && !state.isMuted && state.volume > 0) {
        state.audioCtx.resume().catch(() => {});
      }
    }
  }

  private getPeerVolumeState(peerId: string): { volume: number; isMuted: boolean } {
    const state = this.peerAudioSinks.get(peerId);
    if (state) {
      return { volume: state.volume, isMuted: state.isMuted };
    }
    return { volume: 100, isMuted: false };
  }

  private createCardElement(slot: RoomSlotInfo, isFeatured: boolean): HTMLElement {
    const isSubscribed = this.subscribedStreams.has(slot.peerId);

    if (slot.isLocal) {
      if (slot.isStreaming && slot.stream) {
        // 1. Local live stream
        const card = document.createElement('div');
        card.className = `stream-card ${isFeatured ? 'featured' : ''}`;
        card.setAttribute('data-peer-id', 'local');
        card.title = isFeatured ? 'Clique para voltar à grade' : 'Clique para destacar sua transmissão';

        const video = document.createElement('video');
        video.autoplay = true;
        video.playsInline = true;
        video.srcObject = slot.stream;
        video.muted = true;

        const watchers = slot.watchers || [];
        const watchersCount = watchers.length;
        const watchersTooltip = watchersCount > 0
          ? `Assistindo sua transmissão: ${watchers.map((w) => w.username).join(', ')}`
          : 'Ninguém assistindo no momento';

        const statsHud = document.createElement('div');
        statsHud.className = 'stream-card-stats-hud';
        statsHud.innerHTML = `
          <span class="stat-badge stat-badge-quality" title="Qualidade e FPS da sua transmissão">
            <span class="stat-badge-dot"></span>
            <span class="stat-quality-text">${this.currentResolution.label} ${this.currentFps} FPS</span>
          </span>
          <span class="stat-badge stat-badge-watchers" title="${watchersTooltip}">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            <span class="stat-watchers-text">${watchersCount === 1 ? '1 assistindo' : `${watchersCount} assistindo`}</span>
          </span>
        `;

        const overlay = document.createElement('div');
        overlay.className = 'stream-card-overlay';
        overlay.innerHTML = `
          <span class="user-status-dot"></span>
          <span>${slot.senderName}</span>
          <span class="badge-you">VOCÊ</span>
        `;

        card.appendChild(video);
        card.appendChild(statsHud);
        card.appendChild(overlay);
        return card;
      } else {
        // Local avatar (not streaming)
        const card = document.createElement('div');
        card.className = `participant-card ${isFeatured ? 'featured' : ''}`;
        card.style.setProperty('--user-color', slot.color);
        card.title = isFeatured ? 'Clique para voltar à grade' : 'Clique para destacar seu card';

        card.innerHTML = `
          <div class="participant-avatar-badge">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>
            </svg>
          </div>
          <div class="participant-name-row">
            <span class="participant-avatar-label">${slot.senderName}</span>
            <span class="badge-you">VOCÊ</span>
          </div>
          <div class="participant-status-text">Você não está transmitindo</div>
        `;
        return card;
      }
    }

    // Remote peer
    if (slot.isStreaming) {
      if (isSubscribed && slot.stream) {
        // Remote streaming & Watching
        const card = document.createElement('div');
        card.className = `stream-card ${isFeatured ? 'featured' : ''}`;
        card.setAttribute('data-peer-id', slot.peerId);
        card.title = isFeatured ? 'Clique para voltar à grade' : 'Clique para destacar esta transmissão';

        const video = document.createElement('video');
        video.autoplay = true;
        video.playsInline = true;
        video.srcObject = slot.stream;
        video.muted = true; // Crucial: Mute HTML video tag completely to prevent duplicate/raw audio output

        // Connect to unified AudioContext and GainNode for this peer
        this.attachPeerAudio(slot.peerId, slot.stream);
        const currentAudioState = this.getPeerVolumeState(slot.peerId);

        const watchers = slot.watchers || [];
        const watchersCount = watchers.length;
        const watchersTooltip = watchersCount > 0
          ? `Pessoas assistindo: ${watchers.map((w) => w.username).join(', ')}`
          : 'Ninguém assistindo no momento';

        const pingVal = this.roomManager?.getPeerPing(slot.peerId);
        const pingText = pingVal !== null && pingVal !== undefined ? `${pingVal} ms` : '15 ms';
        const pingClass = (pingVal ?? 15) < 80 ? 'ping-good' : (pingVal ?? 15) < 180 ? 'ping-medium' : 'ping-poor';

        const statsHud = document.createElement('div');
        statsHud.className = 'stream-card-stats-hud';
        statsHud.innerHTML = `
          <span class="stat-badge stat-badge-quality" title="Qualidade e FPS recebidos">
            <span class="stat-badge-dot"></span>
            <span class="stat-quality-text">1080p 60 FPS</span>
          </span>
          <span class="stat-badge stat-badge-ping" title="Latência WebRTC com o transmissor (Ping)">
            <span class="stat-ping-dot ${pingClass}"></span>
            <span class="stat-ping-text">${pingText}</span>
          </span>
          <span class="stat-badge stat-badge-watchers" title="${watchersTooltip}">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            <span class="stat-watchers-text">${watchersCount === 1 ? '1 assistindo' : `${watchersCount} assistindo`}</span>
          </span>
        `;

        const overlay = document.createElement('div');
        overlay.className = 'stream-card-overlay';
        overlay.innerHTML = `
          <span class="user-status-dot"></span>
          <span>${slot.senderName}</span>
        `;

        const stopBtn = document.createElement('button');
        stopBtn.className = 'btn-stop-watch-stream';
        stopBtn.title = 'Parar de assistir esta transmissão';
        stopBtn.textContent = 'Parar de Assistir';
        stopBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.detachPeerAudio(slot.peerId);
          this.subscribedStreams.delete(slot.peerId);
          this.roomManager?.stopWatchingStream(slot.peerId);
          this.renderRoomCards();
        });

        // Interactive volume control with hover slider
        const volumeWrapper = document.createElement('div');
        volumeWrapper.className = 'stream-volume-controller';
        volumeWrapper.title = 'Controle de Volume da Transmissão';
        volumeWrapper.addEventListener('click', (e) => e.stopPropagation());

        const volumeBtn = document.createElement('button');
        volumeBtn.className = 'btn-stream-volume';
        volumeBtn.title = 'Mutar / Desmutar';

        const updateVolumeIcon = (vol: number, isMuted: boolean) => {
          if (isMuted || vol === 0) {
            volumeBtn.innerHTML = `
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                <line x1="23" x2="17" y1="9" y2="15"/><line x1="17" x2="23" y1="9" y2="15"/>
              </svg>
            `;
          } else if (vol < 50) {
            volumeBtn.innerHTML = `
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
              </svg>
            `;
          } else {
            volumeBtn.innerHTML = `
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
                <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
              </svg>
            `;
          }
        };

        updateVolumeIcon(currentAudioState.volume, currentAudioState.isMuted);

        const sliderBox = document.createElement('div');
        sliderBox.className = 'stream-volume-slider-box';

        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = '0';
        slider.max = '100';
        slider.value = currentAudioState.isMuted ? '0' : currentAudioState.volume.toString();
        slider.className = 'stream-volume-range';

        const volumePercent = document.createElement('span');
        volumePercent.className = 'stream-volume-percent';
        volumePercent.textContent = `${slider.value}%`;

        let lastVolume = currentAudioState.volume || 100;

        slider.addEventListener('input', (e) => {
          e.stopPropagation();
          const val = parseInt(slider.value, 10);
          this.setPeerVolume(slot.peerId, val, val === 0);
          if (val > 0) lastVolume = val;
          volumePercent.textContent = `${val}%`;
          updateVolumeIcon(val, val === 0);
        });

        volumeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const st = this.getPeerVolumeState(slot.peerId);
          if (st.isMuted || st.volume === 0) {
            const targetVol = lastVolume || 100;
            this.setPeerVolume(slot.peerId, targetVol, false);
            slider.value = targetVol.toString();
            volumePercent.textContent = `${targetVol}%`;
            updateVolumeIcon(targetVol, false);
          } else {
            lastVolume = st.volume || 100;
            this.setPeerVolume(slot.peerId, 0, true);
            slider.value = '0';
            volumePercent.textContent = '0%';
            updateVolumeIcon(0, true);
          }
        });

        sliderBox.appendChild(slider);
        sliderBox.appendChild(volumePercent);
        volumeWrapper.appendChild(volumeBtn);
        volumeWrapper.appendChild(sliderBox);

        card.appendChild(video);
        card.appendChild(statsHud);
        card.appendChild(overlay);
        card.appendChild(stopBtn);
        card.appendChild(volumeWrapper);
        return card;
      } else if (isSubscribed && !slot.stream) {
        // Remote streaming & Subscribed but waiting for stream tracks
        const card = document.createElement('div');
        card.className = `participant-card ${isFeatured ? 'featured' : ''}`;
        card.style.setProperty('--user-color', slot.color);

        card.innerHTML = `
          <div class="participant-avatar-badge">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>
            </svg>
          </div>
          <div class="participant-name-row">
            <span class="participant-avatar-label">${slot.senderName}</span>
          </div>
          <div class="participant-status-text" style="color: var(--accent-color);">Conectando transmissão...</div>
        `;

        // Request stream from peer
        this.roomManager?.requestStreamFromPeer(slot.peerId);
        return card;
      } else {
        // Remote streaming & NOT yet watching (Discord-style avatar + "Assistir Transmissão" button)
        const card = document.createElement('div');
        card.className = `participant-card ${isFeatured ? 'featured' : ''}`;
        card.style.setProperty('--user-color', slot.color);
        card.title = isFeatured ? 'Clique para voltar à grade' : 'Clique para destacar este participante';

        const watchers = slot.watchers || [];
        const watchersCount = watchers.length;
        const watchersTooltip = watchersCount > 0
          ? `Assistindo: ${watchers.map((w) => w.username).join(', ')}`
          : '';

        card.innerHTML = `
          <span class="badge-live-stream">
            <span class="badge-live-dot"></span>AO VIVO
          </span>
          ${
            watchersCount > 0
              ? `
          <span class="badge-live-watchers" title="${watchersTooltip}">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            <span>${watchersCount} assistindo</span>
          </span>
          `
              : ''
          }
          <div class="participant-avatar-badge">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>
            </svg>
          </div>
          <div class="participant-name-row">
            <span class="participant-avatar-label">${slot.senderName}</span>
          </div>
          <div class="participant-action-row">
            <button class="btn-watch-stream" data-peer="${slot.peerId}">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                <polygon points="5 3 19 12 5 21 5 3"/>
              </svg>
              <span>Assistir Transmissão</span>
            </button>
          </div>
        `;

        const watchBtn = card.querySelector('.btn-watch-stream');
        watchBtn?.addEventListener('click', (e) => {
          e.stopPropagation();
          this.subscribedStreams.add(slot.peerId);
          this.roomManager?.requestStreamFromPeer(slot.peerId);
          this.roomManager?.startWatchingStream(slot.peerId);
          this.renderRoomCards();
        });

        return card;
      }
    } else {
      // Remote participant NOT streaming
      const card = document.createElement('div');
      card.className = `participant-card ${isFeatured ? 'featured' : ''}`;
      card.style.setProperty('--user-color', slot.color);
      card.title = isFeatured ? 'Clique para voltar à grade' : 'Clique para destacar este participante';

      card.innerHTML = `
        <div class="participant-avatar-badge">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>
          </svg>
        </div>
        <div class="participant-name-row">
          <span class="participant-avatar-label">${slot.senderName}</span>
        </div>
        <div class="participant-status-text">Sem transmissão</div>
      `;

      return card;
    }
  }

  // --- DISCORD-STYLE SCREEN & WINDOW PICKER ---
  private async openScreenPickerModal() {
    const modal = document.getElementById('modal-screen-picker');
    if (!modal) return;
    modal.classList.remove('hidden');

    this.syncPickerModalDefaults();

    this.currentPickerTab = 'screens';
    this.selectedSourceId = 'screen:0';
    this.updatePickerTabUI();

    await this.loadScreenSources();
  }

  private closeScreenPickerModal() {
    document.getElementById('modal-screen-picker')?.classList.add('hidden');
  }

  private switchPickerTab(tab: 'screens' | 'windows') {
    this.currentPickerTab = tab;
    this.updatePickerTabUI();
    this.renderSourceCards();
  }

  private updatePickerTabUI() {
    document.getElementById('picker-tab-screens')?.classList.toggle('active', this.currentPickerTab === 'screens');
    document.getElementById('picker-tab-windows')?.classList.toggle('active', this.currentPickerTab === 'windows');
  }

  private async loadScreenSources() {
    const container = document.getElementById('picker-sources-container');
    if (container) container.innerHTML = '<div class="loading-state">Detectando telas e janelas ativas...</div>';

    try {
      const resp = await invoke<ScreenSourcesResponse>('list_screen_sources');
      this.availableMonitors = resp.monitors || [];
      this.availableWindows = resp.windows || [];

      if (this.availableMonitors.length > 0) {
        this.selectedSourceId = this.availableMonitors[0].id;
      } else if (this.availableWindows.length > 0) {
        this.selectedSourceId = this.availableWindows[0].id;
      }

      this.renderSourceCards();
    } catch (err) {
      console.error('Failed to list screen sources:', err);
      if (container) container.innerHTML = '<div class="loading-state">Erro ao detectar telas.</div>';
    }
  }

  private renderSourceCards() {
    const container = document.getElementById('picker-sources-container');
    if (!container) return;
    container.innerHTML = '';

    if (this.currentPickerTab === 'screens') {
      if (this.availableMonitors.length === 0) {
        container.innerHTML = '<div class="loading-state">Nenhum monitor detectado.</div>';
        return;
      }

      this.availableMonitors.forEach((mon) => {
        const isSelected = this.selectedSourceId === mon.id;
        const card = document.createElement('div');
        card.className = `source-card ${isSelected ? 'selected' : ''}`;
        card.innerHTML = `
          <div class="source-card-thumb">
            ${mon.thumbnail ? `<img src="${mon.thumbnail}" alt="${mon.name}" />` : '<div class="source-card-thumb-placeholder">Monitor</div>'}
          </div>
          <div class="source-card-info">
            <div class="source-card-title">${mon.name}</div>
            <div class="source-card-subtitle">${mon.width}x${mon.height}</div>
          </div>
        `;
        card.addEventListener('click', () => {
          this.selectedSourceId = mon.id;
          this.renderSourceCards();
        });
        container.appendChild(card);
      });
    } else {
      if (this.availableWindows.length === 0) {
        container.innerHTML = '<div class="loading-state">Nenhuma janela aberta encontrada.</div>';
        return;
      }

      this.availableWindows.forEach((win) => {
        const isSelected = this.selectedSourceId === win.id;
        const card = document.createElement('div');
        card.className = `source-card ${isSelected ? 'selected' : ''}`;
        card.innerHTML = `
          <div class="source-card-thumb">
            ${win.thumbnail ? `<img src="${win.thumbnail}" alt="${win.title}" />` : '<div class="source-card-thumb-placeholder">Janela</div>'}
          </div>
          <div class="source-card-info">
            <div class="source-card-title">${win.title || win.process_name}</div>
            <div class="source-card-subtitle">${win.process_name}</div>
          </div>
        `;
        card.addEventListener('click', () => {
          this.selectedSourceId = win.id;
          this.renderSourceCards();
        });
        container.appendChild(card);
      });
    }
  }

  private async startSelectedCapture() {
    this.closeScreenPickerModal();

    const resValue = (document.getElementById('modal-select-resolution') as HTMLSelectElement)?.value || '1080p';
    const fpsValue = parseInt((document.getElementById('modal-select-fps') as HTMLSelectElement)?.value, 10) || 60;
    const bitrateValue = parseInt((document.getElementById('modal-select-bitrate') as HTMLSelectElement)?.value, 10) || 25000;
    const mouseEnabled = (document.getElementById('modal-check-cursor') as HTMLInputElement)?.checked ?? true;

    let res = { width: 1920, height: 1080, label: '1080p' };
    if (resValue === '4k') res = { width: 3840, height: 2160, label: '4K' };
    else if (resValue === '1440p') res = { width: 2560, height: 1440, label: '1440p' };
    else if (resValue === '720p') res = { width: 1280, height: 720, label: '720p' };
    else if (resValue === '480p') res = { width: 854, height: 480, label: '480p' };
    else if (resValue === '360p') res = { width: 640, height: 360, label: '360p' };

    this.currentResolution = res;
    this.currentFps = fpsValue;
    this.currentBitrate = bitrateValue;

    try {
      this.showToast('Iniciando transmissão...');

      // 1. Start audio capture (Process-filtered WASAPI loopback)
      let customAudioTrack: MediaStreamTrack | null = null;
      try {
        const activePids = this.getActiveFilterPids();
        const activeNames = this.getActiveFilterNames();
        customAudioTrack = await this.audioBridge.startCapture(
          this.selectedFilterMode,
          activePids,
          activeNames
        );
      } catch (audioErr) {
        console.warn('Audio capture startup warning:', audioErr);
      }

      // 2. Start native Rust video capture (ZERO BROWSER POPUPS!)
      const videoStream = await this.nativeVideoBridge.startCapture(
        this.selectedSourceId,
        fpsValue,
        { width: res.width, height: res.height },
        mouseEnabled,
        85
      );

      // Listen for when capture ends
      videoStream.getVideoTracks()[0].onended = () => {
        this.stopScreenSharing();
      };

      // 3. Assemble combined MediaStream
      const combinedStream = new MediaStream();
      videoStream.getVideoTracks().forEach((vt) => {
        if ('contentHint' in vt) {
          vt.contentHint = 'motion';
        }
        combinedStream.addTrack(vt);
      });
      if (customAudioTrack) {
        combinedStream.addTrack(customAudioTrack);
      }

      this.isSharingScreen = true;

      // Broadcast stream to everyone in the room
      if (this.roomManager) {
        this.roomManager.shareStream(combinedStream, bitrateValue * 1000, fpsValue);
      }

      this.updateShareButtonUI(true);
      this.updateStatsHUD();
      this.showToast('Transmissão iniciada em alta velocidade!');
    } catch (err: unknown) {
      console.warn('Screen selection cancelled or failed:', err);
    }
  }

  private stopScreenSharing() {
    this.isSharingScreen = false;
    this.nativeVideoBridge.stop();
    this.audioBridge.stop();
    invoke('stop_audio_capture').catch(() => {});

    if (this.roomManager) {
      this.roomManager.stopStream();
    }

    this.updateShareButtonUI(false);
    this.updateStatsHUD();
    this.showToast('Transmissão encerrada.');
  }

  private updateShareButtonUI(isSharing: boolean) {
    const btn = document.getElementById('btn-toggle-share-screen');
    const dot = document.getElementById('stream-sharing-dot');
    const label = document.getElementById('label-share-screen');

    if (dot) {
      dot.classList.toggle('active', isSharing);
    }
    if (label) {
      label.textContent = isSharing ? 'Parar Transmissão' : 'Transmissão';
    }
    if (btn) {
      if (isSharing) {
        btn.classList.remove('btn-outline');
        btn.classList.add('btn-danger');
        btn.title = 'Parar compartilhamento de tela';
      } else {
        btn.classList.remove('btn-danger');
        btn.classList.add('btn-outline');
        btn.title = 'Compartilhar Tela ou Janela';
      }
    }
  }

  // --- AUDIO FILTER MODAL ---
  private openAudioFilterModal() {
    const modal = document.getElementById('modal-audio-filter');
    if (!modal) return;
    modal.classList.remove('hidden');

    const radio = document.querySelector(`input[name="audio-filter-mode"][value="${this.selectedFilterMode}"]`) as HTMLInputElement;
    if (radio) radio.checked = true;

    this.loadProcessList();
  }

  private closeAudioFilterModal() {
    document.getElementById('modal-audio-filter')?.classList.add('hidden');
  }

  private async loadProcessList() {
    const container = document.getElementById('process-checkboxes-container');
    if (container) container.innerHTML = '<div class="loading-state">Atualizando lista de aplicativos...</div>';

    try {
      this.audioProcesses = await invoke<ProcessItem[]>('list_audio_processes');

      this.excludePids.clear();
      this.includePids.clear();

      this.audioProcesses.forEach((p) => {
        const nameLower = p.name.toLowerCase();
        if (this.excludeProcessNames.has(nameLower)) {
          this.excludePids.add(p.pid);
        }
        if (this.includeProcessNames.has(nameLower)) {
          this.includePids.add(p.pid);
        }
      });

      const searchInput = document.getElementById('input-search-process') as HTMLInputElement;
      const search = searchInput ? searchInput.value.toLowerCase() : '';
      this.renderProcessCheckboxes(search);
    } catch (err) {
      console.error('Failed to list processes:', err);
      if (container) container.innerHTML = '<div class="loading-state">Erro ao carregar aplicativos.</div>';
    }
  }

  private renderProcessCheckboxes(filterText = '') {
    const container = document.getElementById('process-checkboxes-container');
    if (!container) return;

    const isExclude = this.selectedFilterMode === 'exclude';
    const activePids = isExclude ? this.excludePids : this.includePids;
    const activeNames = isExclude ? this.excludeProcessNames : this.includeProcessNames;

    const filtered = this.audioProcesses.filter(
      (p) =>
        p.name.toLowerCase().includes(filterText) ||
        (p.window_title && p.window_title.toLowerCase().includes(filterText)) ||
        p.pid.toString().includes(filterText)
    );

    if (filtered.length === 0) {
      container.innerHTML = '<div class="loading-state">Nenhum aplicativo correspondente.</div>';
      return;
    }

    container.innerHTML = '';
    filtered.forEach((p) => {
      const nameLower = p.name.toLowerCase();
      const label = document.createElement('label');
      label.className = 'process-item-label';
      const isChecked = activePids.has(p.pid) || activeNames.has(nameLower);

      label.innerHTML = `
        <input type="checkbox" value="${p.pid}" ${isChecked ? 'checked' : ''} />
        <span class="process-name">${p.name}</span>
        ${p.window_title ? `<span class="process-title">(${p.window_title})</span>` : ''}
        <span class="process-pid">PID: ${p.pid}</span>
      `;

      const checkbox = label.querySelector('input');
      checkbox?.addEventListener('change', (e) => {
        const target = e.target as HTMLInputElement;
        if (target.checked) {
          activeNames.add(nameLower);
          this.audioProcesses.forEach((other) => {
            if (other.name.toLowerCase() === nameLower) {
              activePids.add(other.pid);
            }
          });
        } else {
          activeNames.delete(nameLower);
          this.audioProcesses.forEach((other) => {
            if (other.name.toLowerCase() === nameLower) {
              activePids.delete(other.pid);
            }
          });
        }
        this.saveAudioFilterPresets();
      });

      container.appendChild(label);
    });
  }

  private async applyAudioFilters() {
    const pidsArray = this.getActiveFilterPids();
    const namesArray = this.getActiveFilterNames();
    this.saveAudioFilterPresets();

    try {
      await invoke('start_audio_capture', {
        config: {
          mode: this.selectedFilterMode,
          target_pids: pidsArray,
          target_names: namesArray,
          sample_rate: 48000,
        },
      });
      this.closeAudioFilterModal();
      const count = namesArray.length || pidsArray.length;
      const msg =
        this.selectedFilterMode === 'exclude'
          ? `Filtro aplicado: Silenciando ${count} aplicativo(s)`
          : `Filtro aplicado: Transmitindo apenas ${count} aplicativo(s)`;
      this.showToast(msg);
    } catch (err) {
      console.error('Error applying audio filter:', err);
      this.showToast('Erro ao aplicar filtros de áudio.');
    }
  }

  // --- SIDEBAR & CHAT ---
  private switchSidebarTab(tab: 'chat' | 'participants') {
    document.getElementById('tab-btn-chat')?.classList.toggle('active', tab === 'chat');
    document.getElementById('tab-btn-participants')?.classList.toggle('active', tab === 'participants');

    document.getElementById('tab-content-chat')?.classList.toggle('active', tab === 'chat');
    document.getElementById('tab-content-participants')?.classList.toggle('active', tab === 'participants');
  }

  private appendChatMessage(msg: ChatMessage) {
    const container = document.getElementById('chat-messages-container');
    if (!container) return;

    const timeStr = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const msgEl = document.createElement('div');
    msgEl.className = 'chat-msg';
    msgEl.innerHTML = `
      <div class="chat-msg-header">
        <span class="chat-msg-sender">${msg.sender}</span>
        <span class="chat-msg-time">${timeStr}</span>
      </div>
      <div class="chat-msg-bubble">${msg.text}</div>
    `;

    container.appendChild(msgEl);
    container.scrollTop = container.scrollHeight;
  }

  private updatePeersList(peers: PeerInfo[]) {
    const countEl = document.getElementById('count-participants');
    if (countEl) countEl.textContent = (peers.length + 1).toString();

    const listEl = document.getElementById('participants-list');
    if (!listEl) return;

    listEl.innerHTML = `
      <div class="participant-item">
        <div style="display: flex; align-items: center; gap: 6px;">
          <span>${this.username}</span>
          <span class="badge-you">VOCÊ</span>
        </div>
        <span class="user-status-dot"></span>
      </div>
    `;

    peers.forEach((p) => {
      const item = document.createElement('div');
      item.className = 'participant-item';
      item.innerHTML = `
        <span>${p.username}</span>
        <span class="user-status-dot"></span>
      `;
      listEl.appendChild(item);
    });
  }

  // --- FULLSCREEN ---
  private toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  }

  // --- COPY ROOM CODE ---
  private copyRoomCodeToClipboard() {
    let copyText = this.currentRoomCode;
    let toastMsg = `Código "${this.currentRoomCode}" copiado para a área de transferência!`;

    if (this.currentRoomPassword) {
      copyText = `Sala: ${this.currentRoomCode} | Senha: ${this.currentRoomPassword}`;
      toastMsg = `Código "${this.currentRoomCode}" e senha copiados!`;
    }

    navigator.clipboard
      .writeText(copyText)
      .then(() => this.showToast(toastMsg))
      .catch(() => this.showToast(`Código da sala: ${this.currentRoomCode}`));
  }

  // --- LEAVE ROOM ---
  private async leaveRoom() {
    soundEffects.playUserLeave();
    this.stopLiveStatsTracker();
    if (this.isSharingScreen) {
      this.stopScreenSharing();
    }
    if (this.roomManager) {
      await this.roomManager.leave();
      this.roomManager = null;
    }
    this.peerAudioSinks.forEach((_, pId) => this.detachPeerAudio(pId));
    this.peerAudioSinks.clear();
    this.subscribedStreams.clear();
    this.cachedCards.clear();
    this.roomSlots = [];
    this.switchView('view-home');
    this.showToast('Você saiu da sala.');
  }
}

// Instantiate App
new App();
