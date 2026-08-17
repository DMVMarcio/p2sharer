import { invoke } from '@tauri-apps/api/core';
import { AudioBridge } from './audio_bridge';
import { GroupRoomManager } from './group_room';
import { NativeVideoBridge } from './native_video_bridge';
import {
  ActiveStreamInfo,
  ChatMessage,
  MonitorSource,
  PeerInfo,
  ProcessItem,
  ScreenSourcesResponse,
  WindowSource,
} from './types';

class App {
  private username: string = '';
  private currentRoomCode: string = 'P2P-ROOM';
  private isCreator: boolean = false;
  private isSharingScreen: boolean = false;

  private roomManager: GroupRoomManager | null = null;
  private nativeVideoBridge: NativeVideoBridge = new NativeVideoBridge();
  private audioBridge: AudioBridge = new AudioBridge();

  private audioProcesses: ProcessItem[] = [];
  private selectedFilterMode: 'exclude' | 'include' = 'exclude';
  private selectedPids: Set<number> = new Set();

  // Multi-stream Dynamic Grid State
  private activeStreams: ActiveStreamInfo[] = [];
  private layoutMode: 'grid' | 'spotlight' = 'grid';
  private pinnedPeerId: string | null = null;
  private isSidebarCollapsed: boolean = false;

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

  constructor() {
    this.init();
  }

  private async init() {
    this.setupThemeAndSettings();
    this.setupUsername();
    this.bindEvents();
    this.generateRandomRoomCode();
  }

  // --- THEME & SETTINGS INITIALIZATION ---
  private setupThemeAndSettings() {
    const savedTheme = (localStorage.getItem('p2sharer_theme_mode') as 'dark' | 'light' | 'system') || 'dark';
    const savedAccent = localStorage.getItem('p2sharer_accent_color') || 'cyan';
    const savedRes = localStorage.getItem('p2sharer_default_res') || '1080p';
    const savedFps = parseInt(localStorage.getItem('p2sharer_default_fps') || '60', 10);
    const savedBitrate = parseInt(localStorage.getItem('p2sharer_default_bitrate') || '25000', 10);
    const savedCursor = localStorage.getItem('p2sharer_default_cursor') !== 'false';

    this.currentThemeMode = savedTheme;
    this.currentAccentColor = savedAccent;
    this.currentFps = savedFps;
    this.currentBitrate = savedBitrate;

    this.applyTheme(this.currentThemeMode);
    this.applyAccent(this.currentAccentColor);

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
    const randomNum = Math.floor(1000 + Math.random() * 9000);
    this.currentRoomCode = `P2P-${randomNum}`;
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

    // Header Room Code Pill Copy
    document.getElementById('header-room-code-pill')?.addEventListener('click', () => this.copyRoomCodeToClipboard());

    // Home Actions
    document.getElementById('btn-create-room-direct')?.addEventListener('click', () => this.createRoomAsHost());
    document.getElementById('btn-start-join-flow')?.addEventListener('click', () => this.openJoinDialog());

    // Join Dialog Modal
    document.getElementById('btn-close-join-dialog')?.addEventListener('click', () => this.closeJoinDialog());
    document.getElementById('btn-cancel-join-dialog')?.addEventListener('click', () => this.closeJoinDialog());
    document.getElementById('btn-confirm-join-dialog')?.addEventListener('click', () => this.confirmJoinFromDialog());

    // Toggle Sidebar (Chat)
    document.getElementById('btn-toggle-sidebar')?.addEventListener('click', () => this.toggleSidebar());

    // Empty state stream start button
    document.getElementById('btn-empty-start-stream')?.addEventListener('click', () => this.openScreenPickerModal());

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
  }

  // --- SETTINGS MODAL ---
  private openSettingsModal() {
    const modal = document.getElementById('modal-settings');
    const inputUsername = document.getElementById('settings-input-username') as HTMLInputElement;
    const selectRes = document.getElementById('settings-default-resolution') as HTMLSelectElement;
    const selectFps = document.getElementById('settings-default-fps') as HTMLSelectElement;
    const selectBitrate = document.getElementById('settings-default-bitrate') as HTMLSelectElement;
    const checkCursor = document.getElementById('settings-check-cursor') as HTMLInputElement;

    if (inputUsername) inputUsername.value = this.username;
    if (selectRes) selectRes.value = localStorage.getItem('p2sharer_default_res') || '1080p';
    if (selectFps) selectFps.value = localStorage.getItem('p2sharer_default_fps') || '60';
    if (selectBitrate) selectBitrate.value = localStorage.getItem('p2sharer_default_bitrate') || '25000';
    if (checkCursor) checkCursor.checked = localStorage.getItem('p2sharer_default_cursor') !== 'false';

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

    if (inputUsername && inputUsername.value.trim()) {
      this.username = inputUsername.value.trim();
      localStorage.setItem('p2sharer_username', this.username);
      this.updateUsernameDisplay();
    }

    if (selectRes) localStorage.setItem('p2sharer_default_res', selectRes.value);
    if (selectFps) localStorage.setItem('p2sharer_default_fps', selectFps.value);
    if (selectBitrate) localStorage.setItem('p2sharer_default_bitrate', selectBitrate.value);
    if (checkCursor) localStorage.setItem('p2sharer_default_cursor', checkCursor.checked.toString());

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

  // --- CREATE ROOM ---
  private createRoomAsHost() {
    if (!this.username) {
      this.showUsernameModal();
      return;
    }

    this.isCreator = true;
    this.generateRandomRoomCode();
    this.enterRoomUI();

    this.connectToRoom();
    this.showToast(`Sala "${this.currentRoomCode}" criada!`);
  }

  // --- JOIN ROOM ---
  private openJoinDialog() {
    if (!this.username) {
      this.showUsernameModal();
      return;
    }
    const modal = document.getElementById('modal-join-room-dialog');
    const input = document.getElementById('input-join-room-code-dialog') as HTMLInputElement;
    if (input) input.value = '';
    modal?.classList.remove('hidden');
    input?.focus();
  }

  private closeJoinDialog() {
    document.getElementById('modal-join-room-dialog')?.classList.add('hidden');
  }

  private confirmJoinFromDialog() {
    const input = (document.getElementById('input-join-room-code-dialog') as HTMLInputElement).value.trim();
    if (!input) {
      this.showToast('Digite o código da sala.');
      return;
    }

    this.isCreator = false;
    this.currentRoomCode = input.toUpperCase();
    this.closeJoinDialog();
    this.enterRoomUI();

    this.connectToRoom();
    this.showToast(`Conectando à sala ${this.currentRoomCode}...`);
  }

  private connectToRoom() {
    if (this.roomManager) {
      this.roomManager.leave();
    }

    this.roomManager = new GroupRoomManager(this.username, this.currentRoomCode, this.isCreator);
    this.roomManager.join({
      onStreamsUpdate: (streams) => {
        this.activeStreams = streams;
        this.renderStreams();
        this.updateStatsHUD();
      },
      onChat: (msg) => {
        this.appendChatMessage(msg);
      },
      onPeersUpdate: (peers) => {
        this.updatePeersList(peers);
      },
      onStatusChange: (status) => {
        const statsBadge = document.getElementById('room-stats-badge');
        if (statsBadge) statsBadge.textContent = status;
      },
    });
  }

  private enterRoomUI() {
    const displayRoomCode = document.getElementById('display-room-code');
    if (displayRoomCode) displayRoomCode.textContent = this.currentRoomCode;

    this.activeStreams = [];
    this.renderStreams();

    const chatContainer = document.getElementById('chat-messages-container');
    if (chatContainer) {
      chatContainer.innerHTML = `
        <div class="chat-welcome-notice">
          <span>Você entrou na sala <strong>${this.currentRoomCode}</strong>. Compartilhe o código para convidar amigos.</span>
        </div>
      `;
    }

    this.updateShareButtonUI(false);
    this.switchView('view-group-room');
  }

  // --- STATS HUD ---
  private updateStatsHUD() {
    const hud = document.getElementById('stream-hud-overlay');
    const resFpsText = document.getElementById('hud-res-fps-text');
    const bitrateText = document.getElementById('hud-bitrate-text');

    if (!hud) return;

    if (this.activeStreams.length === 0) {
      hud.style.display = 'none';
      return;
    }

    hud.style.display = 'block';
    if (resFpsText) resFpsText.textContent = `${this.currentResolution.label} ${this.currentFps} FPS`;
    if (bitrateText) bitrateText.textContent = `${(this.currentBitrate / 1000).toFixed(1)} Mbps`;
  }

  // --- DYNAMIC MULTI-STREAM RENDERER ---
  private renderStreams() {
    const wrapper = document.getElementById('streams-grid-wrapper');
    const emptyState = document.getElementById('room-empty-stream-state');
    const sharingTag = document.getElementById('room-sharing-status-tag');
    const liveBadge = document.getElementById('room-live-badge');

    if (!wrapper || !emptyState) return;

    if (this.activeStreams.length === 0) {
      wrapper.innerHTML = '';
      emptyState.classList.add('active');
      if (sharingTag) sharingTag.textContent = '0 telas';
      if (liveBadge) liveBadge.textContent = 'SALA ATIVA';
      return;
    }

    emptyState.classList.remove('active');
    if (sharingTag) sharingTag.textContent = `${this.activeStreams.length} ${this.activeStreams.length === 1 ? 'tela' : 'telas'}`;
    if (liveBadge) liveBadge.textContent = 'AO VIVO';

    // Auto-adjust layout
    if (this.pinnedPeerId && !this.activeStreams.some((s) => s.peerId === this.pinnedPeerId)) {
      this.pinnedPeerId = null;
      this.layoutMode = 'grid';
    }

    wrapper.className = `streams-grid-wrapper layout-${this.layoutMode}`;
    wrapper.innerHTML = '';

    const visibleStreams =
      this.layoutMode === 'spotlight' && this.pinnedPeerId
        ? this.activeStreams.filter((s) => s.peerId === this.pinnedPeerId)
        : this.activeStreams;

    visibleStreams.forEach((streamInfo) => {
      const card = document.createElement('div');
      card.className = `stream-card ${streamInfo.peerId === this.pinnedPeerId ? 'pinned' : ''}`;
      card.title = 'Clique para alternar entre modo destaque e grade';

      const video = document.createElement('video');
      video.autoplay = true;
      video.playsInline = true;
      video.srcObject = streamInfo.stream;

      if (streamInfo.isLocal) {
        video.muted = true; // Avoid feedback
      }

      const overlay = document.createElement('div');
      overlay.className = 'stream-card-overlay';
      overlay.innerHTML = `
        <span class="user-status-dot"></span>
        <span>${streamInfo.senderName}</span>
      `;

      card.appendChild(video);
      card.appendChild(overlay);

      card.addEventListener('click', () => {
        if (this.layoutMode === 'spotlight' && this.pinnedPeerId === streamInfo.peerId) {
          this.layoutMode = 'grid';
          this.pinnedPeerId = null;
        } else {
          this.layoutMode = 'spotlight';
          this.pinnedPeerId = streamInfo.peerId;
        }
        this.renderStreams();
      });

      wrapper.appendChild(card);
    });
  }

  // --- DISCORD-STYLE SCREEN & WINDOW PICKER ---
  private async openScreenPickerModal() {
    const modal = document.getElementById('modal-screen-picker');
    if (!modal) return;
    modal.classList.remove('hidden');

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
        customAudioTrack = this.audioBridge.init();
        await this.audioBridge.startListening();
      } catch (audioErr) {
        console.warn('Audio capture startup warning:', audioErr);
      }

      // 2. Start native Rust video capture (ZERO BROWSER POPUPS!)
      const videoStream = await this.nativeVideoBridge.startCapture(
        this.selectedSourceId,
        fpsValue,
        { width: res.width, height: res.height },
        mouseEnabled,
        70
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
    const dot = document.getElementById('stream-sharing-dot');
    const label = document.getElementById('label-share-screen');

    if (dot) {
      dot.classList.toggle('active', isSharing);
    }
    if (label) {
      label.textContent = isSharing ? 'Gerenciar' : 'Transmissão';
    }
  }

  // --- AUDIO FILTER MODAL ---
  private openAudioFilterModal() {
    const modal = document.getElementById('modal-audio-filter');
    if (!modal) return;
    modal.classList.remove('hidden');
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
      this.renderProcessCheckboxes();
    } catch (err) {
      console.error('Failed to list processes:', err);
      if (container) container.innerHTML = '<div class="loading-state">Erro ao carregar aplicativos.</div>';
    }
  }

  private renderProcessCheckboxes(filterText = '') {
    const container = document.getElementById('process-checkboxes-container');
    if (!container) return;

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
      const label = document.createElement('label');
      label.className = 'process-item-label';
      const isChecked = this.selectedPids.has(p.pid);

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
          this.selectedPids.add(p.pid);
        } else {
          this.selectedPids.delete(p.pid);
        }
      });

      container.appendChild(label);
    });
  }

  private async applyAudioFilters() {
    const pidsArray = Array.from(this.selectedPids);
    try {
      await invoke('start_audio_capture', {
        filterMode: this.selectedFilterMode,
        targetPids: pidsArray,
      });
      this.closeAudioFilterModal();
      this.showToast('Filtros de áudio aplicados com sucesso!');
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
        <span>${this.username} (Você)</span>
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
    navigator.clipboard
      .writeText(this.currentRoomCode)
      .then(() => this.showToast(`Código "${this.currentRoomCode}" copiado!`))
      .catch(() => this.showToast(`Código da sala: ${this.currentRoomCode}`));
  }

  // --- LEAVE ROOM ---
  private leaveRoom() {
    if (this.isSharingScreen) {
      this.stopScreenSharing();
    }
    if (this.roomManager) {
      this.roomManager.leave();
      this.roomManager = null;
    }
    this.activeStreams = [];
    this.switchView('view-home');
    this.showToast('Você saiu da sala.');
  }
}

// Instantiate App
new App();
