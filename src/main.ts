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
  private activeLocalStream: MediaStream | null = null;

  private audioProcesses: ProcessItem[] = [];
  private selectedFilterMode: 'exclude' | 'include' = 'exclude';
  private selectedPids: Set<number> = new Set();

  // Multi-stream Dynamic Grid State
  private activeStreams: ActiveStreamInfo[] = [];
  private layoutMode: 'grid' | 'spotlight' = 'grid';
  private pinnedPeerId: string | null = null;
  private streamVolumes: Map<string, { volume: number; muted: boolean }> = new Map();
  private isSidebarCollapsed: boolean = false;

  // Stream Settings & Picker State
  private availableMonitors: MonitorSource[] = [];
  private availableWindows: WindowSource[] = [];
  private currentPickerTab: 'screens' | 'windows' = 'screens';
  private selectedSourceId: string = 'screen:0';

  private currentFps: number = 60;
  private currentBitrate: number = 25000;
  private currentResolution: { width: number; height: number; label: string } = { width: 1920, height: 1080, label: '1080p' };

  constructor() {
    this.init();
  }

  private async init() {
    this.setupUsername();
    this.bindEvents();
    this.generateRandomRoomCode();
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
    const myPeerName = document.getElementById('my-peer-name');
    if (displayEl) displayEl.textContent = this.username || 'Usuário';
    if (myPeerName) myPeerName.textContent = `${this.username || 'Você'} (Você)`;
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
    // Username pill
    document.getElementById('user-pill')?.addEventListener('click', () => this.showUsernameModal());
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

    // Transmission Button (Opens Discord-style picker or stops active stream)
    document.getElementById('btn-toggle-share-screen')?.addEventListener('click', () => {
      if (this.isSharingScreen) {
        this.stopScreenSharing();
      } else {
        this.openScreenPickerModal();
      }
    });

    // Screen Picker Modal Tabs & Buttons
    document.getElementById('btn-close-picker-modal')?.addEventListener('click', () => this.closeScreenPickerModal());
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
    document.getElementById('btn-floating-exit-fs')?.addEventListener('click', () => this.exitFullscreen());

    // Fullscreen change listener to sync UI buttons
    document.addEventListener('fullscreenchange', () => {
      const isFs = Boolean(document.fullscreenElement);
      const floatBtn = document.getElementById('btn-floating-exit-fs');
      if (floatBtn) {
        floatBtn.classList.toggle('hidden', !isFs);
      }
    });

    // Sidebar Tabs
    document.getElementById('tab-chat')?.addEventListener('click', () => this.switchSidebarTab('chat'));
    document.getElementById('tab-peers')?.addEventListener('click', () => this.switchSidebarTab('peers'));

    // Chat Form
    document.getElementById('chat-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = document.getElementById('chat-input') as HTMLInputElement;
      const text = input.value.trim();
      if (!text) return;

      if (this.roomManager) {
        const msg = this.roomManager.sendChatMessage(text);
        this.appendChatMessage(msg);
        input.value = '';
      }
    });
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
        <div class="chat-system-msg">
          <span>Você entrou na sala <strong>${this.currentRoomCode}</strong>. Compartilhe o código acima.</span>
        </div>
      `;
    }

    this.updateShareButtonUI(false);
    this.switchView('view-group-room');
  }

  // --- STATS HUD ---
  private updateStatsHUD() {
    const hud = document.getElementById('stream-stats-floating');
    const resEl = document.getElementById('hud-stat-resolution');
    const fpsEl = document.getElementById('hud-stat-fps');
    const bitrateEl = document.getElementById('hud-stat-bitrate');

    if (!hud) return;

    if (this.activeStreams.length === 0) {
      hud.style.display = 'none';
      return;
    }

    hud.style.display = 'flex';
    if (resEl) resEl.textContent = this.currentResolution.label;
    if (fpsEl) fpsEl.textContent = `${this.currentFps} FPS`;
    if (bitrateEl) bitrateEl.textContent = `${(this.currentBitrate / 1000).toFixed(1)} Mbps`;
  }

  // --- DYNAMIC MULTI-STREAM RENDERER ---
  private renderStreams() {
    const wrapper = document.getElementById('streams-grid-wrapper');
    const idleBox = document.getElementById('room-video-idle');
    const sharingTag = document.getElementById('room-sharing-status-tag');
    const liveBadge = document.getElementById('room-live-badge');

    if (!wrapper || !idleBox) return;

    if (this.activeStreams.length === 0) {
      wrapper.classList.remove('active');
      wrapper.innerHTML = '';
      idleBox.classList.remove('hidden');
      if (sharingTag) sharingTag.textContent = '0 telas';
      if (liveBadge) {
        liveBadge.textContent = 'SALA ATIVA';
        liveBadge.classList.remove('streaming');
      }
      this.updateStatsHUD();
      return;
    }

    idleBox.classList.add('hidden');
    wrapper.classList.add('active');

    // Update status bar
    const count = this.activeStreams.length;
    if (sharingTag) sharingTag.textContent = `${count} ${count === 1 ? 'tela' : 'telas'}`;
    if (liveBadge) {
      liveBadge.textContent = 'AO VIVO';
      liveBadge.classList.add('streaming');
    }

    // Determine spotlight pinned stream
    if (!this.pinnedPeerId || !this.activeStreams.some((s) => s.peerId === this.pinnedPeerId)) {
      this.pinnedPeerId = this.activeStreams[0].peerId;
    }

    this.updateStatsHUD();

    wrapper.className = `streams-grid-wrapper active ${this.layoutMode === 'grid' ? 'layout-grid' : 'layout-spotlight'}`;
    wrapper.innerHTML = '';

    if (this.layoutMode === 'spotlight') {
      const pinnedItem = this.activeStreams.find((s) => s.peerId === this.pinnedPeerId) || this.activeStreams[0];
      const otherItems = this.activeStreams.filter((s) => s.peerId !== pinnedItem.peerId);

      // 1. Pinned large stream card
      const mainCard = this.createStreamCard(pinnedItem, true);
      wrapper.appendChild(mainCard);

      // 2. Horizontal strip for other streams
      if (otherItems.length > 0) {
        const strip = document.createElement('div');
        strip.className = 'spotlight-strip';
        otherItems.forEach((item) => {
          strip.appendChild(this.createStreamCard(item, false));
        });
        wrapper.appendChild(strip);
      }
    } else {
      // Grid view
      this.activeStreams.forEach((item) => {
        wrapper.appendChild(this.createStreamCard(item, item.peerId === this.pinnedPeerId));
      });
    }
  }

  private createStreamCard(item: ActiveStreamInfo, isPinned: boolean): HTMLElement {
    const card = document.createElement('div');
    card.className = `stream-card ${isPinned ? 'pinned' : ''}`;
    card.id = `stream-card-${item.peerId}`;

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.srcObject = item.stream;

    // Get volume settings for this stream
    if (!this.streamVolumes.has(item.peerId)) {
      this.streamVolumes.set(item.peerId, { volume: item.isLocal ? 0 : 1, muted: item.isLocal });
    }
    const volState = this.streamVolumes.get(item.peerId)!;

    video.muted = volState.muted;
    video.volume = volState.volume;
    video.play().catch(() => {});

    // Card Header (Title & Pin/Fullscreen buttons)
    const header = document.createElement('div');
    header.className = 'stream-card-header';
    header.innerHTML = `
      <div class="stream-card-title">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/></svg>
        <span>${item.senderName}</span>
      </div>
      <div class="stream-card-tools">
        <button class="stream-card-btn btn-pin-stream" title="${isPinned && this.layoutMode === 'spotlight' ? 'Voltar para Grade' : 'Destacar tela'}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 17v4"/><path d="M5 17h14"/><path d="m15 2-3 3-3-3"/></svg>
        </button>
        <button class="stream-card-btn btn-fs-stream" title="Tela cheia">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" x2="14" y1="3" y2="10"/><line x1="3" x2="10" y1="21" y2="14"/></svg>
        </button>
      </div>
    `;

    // Card Footer (Volume slider & Mute button)
    const footer = document.createElement('div');
    footer.className = 'stream-card-footer';
    footer.innerHTML = `
      <button class="stream-mute-btn ${volState.muted ? 'muted' : ''}" title="${volState.muted ? 'Desmutar' : 'Silenciar'}">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
      </button>
      <input type="range" class="stream-volume-slider" min="0" max="1" step="0.02" value="${volState.muted ? 0 : volState.volume}" title="Volume: ${Math.round(volState.volume * 100)}%" />
    `;

    // Clicking anywhere on the card toggles spotlight <-> grid
    card.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('.stream-card-footer') || target.closest('.stream-card-tools')) {
        return;
      }
      if (this.layoutMode === 'spotlight' && this.pinnedPeerId === item.peerId) {
        this.layoutMode = 'grid';
      } else {
        this.pinnedPeerId = item.peerId;
        this.layoutMode = 'spotlight';
      }
      this.renderStreams();
    });

    // Bind Pin Button
    header.querySelector('.btn-pin-stream')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.layoutMode === 'spotlight' && this.pinnedPeerId === item.peerId) {
        this.layoutMode = 'grid';
      } else {
        this.pinnedPeerId = item.peerId;
        this.layoutMode = 'spotlight';
      }
      this.renderStreams();
    });

    // Bind Fullscreen Button
    header.querySelector('.btn-fs-stream')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!document.fullscreenElement) {
        card.requestFullscreen().catch(() => {});
      } else {
        document.exitFullscreen().catch(() => {});
      }
    });

    // Bind Volume Slider
    const volSlider = footer.querySelector('.stream-volume-slider') as HTMLInputElement;
    const muteBtn = footer.querySelector('.stream-mute-btn') as HTMLButtonElement;

    volSlider?.addEventListener('input', (e) => {
      e.stopPropagation();
      const val = parseFloat((e.target as HTMLInputElement).value);
      volState.volume = val;
      volState.muted = val === 0;
      video.volume = val;
      video.muted = volState.muted;
      muteBtn.classList.toggle('muted', volState.muted);
      volSlider.title = `Volume: ${Math.round(val * 100)}%`;
    });

    // Bind Mute Toggle Button
    muteBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      volState.muted = !volState.muted;
      video.muted = volState.muted;
      muteBtn.classList.toggle('muted', volState.muted);
      if (volState.muted) {
        volSlider.value = '0';
      } else {
        volSlider.value = String(volState.volume || 1);
        video.volume = volState.volume || 1;
      }
    });

    card.appendChild(video);
    card.appendChild(header);
    card.appendChild(footer);

    return card;
  }

  // --- DISCORD-STYLE SCREEN / WINDOW PICKER MODAL ---
  private async openScreenPickerModal() {
    const modal = document.getElementById('modal-screen-picker');
    modal?.classList.remove('hidden');
    await this.refreshScreenSources();
  }

  private closeScreenPickerModal() {
    document.getElementById('modal-screen-picker')?.classList.add('hidden');
  }

  private switchPickerTab(tab: 'screens' | 'windows') {
    this.currentPickerTab = tab;
    document.getElementById('picker-tab-screens')?.classList.toggle('active', tab === 'screens');
    document.getElementById('picker-tab-windows')?.classList.toggle('active', tab === 'windows');
    this.renderSourceCards();
  }

  private async refreshScreenSources() {
    const container = document.getElementById('source-cards-container');
    if (container) {
      container.innerHTML = '<div class="loading-state">Capturando miniaturas das telas e janelas...</div>';
    }

    try {
      const res = await invoke<ScreenSourcesResponse>('list_screen_sources');
      this.availableMonitors = res.monitors || [];
      this.availableWindows = res.windows || [];

      if (this.availableMonitors.length > 0 && !this.selectedSourceId) {
        this.selectedSourceId = this.availableMonitors[0].id;
      }

      this.renderSourceCards();
    } catch (err) {
      console.warn('Fallback loading screen sources:', err);
      this.availableMonitors = [
        { id: 'screen:0', name: 'Monitor 1 (Principal)', width: 1920, height: 1080, is_primary: true, thumbnail: undefined },
      ];
      this.renderSourceCards();
    }
  }

  private renderSourceCards() {
    const container = document.getElementById('source-cards-container');
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

    this.currentFps = fpsValue;
    this.currentBitrate = bitrateValue;
    this.currentResolution = res;

    // Sync bottom quick select controls as well
    const qRes = document.getElementById('quick-select-resolution') as HTMLSelectElement;
    const qFps = document.getElementById('quick-select-fps') as HTMLSelectElement;
    const qBit = document.getElementById('quick-select-bitrate') as HTMLSelectElement;
    if (qRes) qRes.value = resValue;
    if (qFps) qFps.value = String(fpsValue);
    if (qBit) qBit.value = String(bitrateValue);

    try {
      // 1. Audio bridge listener
      const customAudioTrack = this.audioBridge.init();
      await this.audioBridge.startListening();

      // 2. Direct GPU Hardware Capture
      const videoStream = await this.nativeVideoBridge.startCapture(
        this.selectedSourceId,
        fpsValue,
        res,
        mouseEnabled,
        92
      );

      // Listen for when the user clicks native "Parar de compartilhar"
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

      this.activeLocalStream = combinedStream;
      this.isSharingScreen = true;

      // Broadcast stream to everyone in the room
      if (this.roomManager) {
        this.roomManager.shareStream(combinedStream);
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

    if (this.activeLocalStream) {
      this.activeLocalStream.getTracks().forEach((t) => t.stop());
      this.activeLocalStream = null;
    }

    if (this.roomManager) {
      this.roomManager.stopStream();
    }

    this.updateShareButtonUI(false);
    this.updateStatsHUD();
    this.showToast('Sua transmissão de tela foi encerrada.');
  }

  private updateShareButtonUI(isSharing: boolean) {
    const dot = document.getElementById('stream-sharing-dot');
    const label = document.getElementById('label-share-screen');
    if (dot) {
      dot.classList.toggle('active', isSharing);
    }
    if (label) {
      label.textContent = isSharing ? 'Parar' : 'Transmissão';
    }
  }

  private toggleFullscreen() {
    const container = document.getElementById('room-video-container');
    if (!container) return;
    if (!document.fullscreenElement) {
      container.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  }

  private exitFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
  }

  private copyRoomCodeToClipboard() {
    navigator.clipboard.writeText(this.currentRoomCode);
    this.showToast(`Código da sala "${this.currentRoomCode}" copiado para a área de transferência!`);
  }

  private leaveRoom() {
    if (this.isSharingScreen) {
      this.stopScreenSharing();
    }
    if (this.roomManager) {
      this.roomManager.leave();
      this.roomManager = null;
    }

    this.switchView('view-home');
    this.showToast('Você saiu da sala.');
  }

  // --- AUDIO FILTER & WASAPI PROCESS LIST ---
  private async openAudioFilterModal() {
    document.getElementById('modal-audio-filter')?.classList.remove('hidden');
    await this.loadProcessList();
  }

  private closeAudioFilterModal() {
    document.getElementById('modal-audio-filter')?.classList.add('hidden');
  }

  private async loadProcessList() {
    const container = document.getElementById('process-checkboxes-container');
    if (container) {
      container.innerHTML = '<div class="loading-state">Buscando programas no Windows...</div>';
    }

    try {
      const processes = await invoke<ProcessItem[]>('list_audio_processes');
      this.audioProcesses = processes;
      this.renderProcessCheckboxes();
    } catch (err) {
      console.warn('Process fallback:', err);
      this.audioProcesses = [
        { pid: 10420, name: 'Discord.exe', window_title: 'Discord - #geral', is_likely_chat_or_voice: true },
        { pid: 14880, name: 'Spotify.exe', window_title: 'Spotify Premium', is_likely_chat_or_voice: false },
        { pid: 9812, name: 'chrome.exe', window_title: 'YouTube - Google Chrome', is_likely_chat_or_voice: false },
      ];
      this.renderProcessCheckboxes();
    }
  }

  private renderProcessCheckboxes(searchTerm = '') {
    const container = document.getElementById('process-checkboxes-container');
    if (!container) return;

    const filtered = this.audioProcesses.filter((p) => {
      const matchName = p.name.toLowerCase().includes(searchTerm);
      const matchTitle = (p.window_title || '').toLowerCase().includes(searchTerm);
      return matchName || matchTitle;
    });

    if (filtered.length === 0) {
      container.innerHTML = '<div class="loading-state">Nenhum processo encontrado.</div>';
      return;
    }

    container.innerHTML = '';
    filtered.forEach((proc) => {
      const row = document.createElement('div');
      row.className = 'process-row';
      const isChecked = this.selectedPids.has(proc.pid);

      row.innerHTML = `
        <div class="process-row-info">
          <input type="checkbox" data-pid="${proc.pid}" ${isChecked ? 'checked' : ''} />
          <div>
            <strong>${proc.name}</strong>
            ${proc.window_title ? `<span style="color: var(--text-muted); margin-left: 8px;">(${proc.window_title})</span>` : ''}
          </div>
          ${proc.is_likely_chat_or_voice ? '<span class="voice-badge">Voz / Chat</span>' : ''}
        </div>
        <span style="color: var(--text-muted); font-size: 11px;">PID: ${proc.pid}</span>
      `;

      row.querySelector('input')?.addEventListener('change', (e) => {
        const checked = (e.target as HTMLInputElement).checked;
        if (checked) {
          this.selectedPids.add(proc.pid);
        } else {
          this.selectedPids.delete(proc.pid);
        }
      });

      container.appendChild(row);
    });
  }

  private async applyAudioFilters() {
    const pids = Array.from(this.selectedPids);
    const mode = this.selectedFilterMode;

    try {
      await invoke('start_audio_capture', {
        config: {
          mode,
          target_pids: pids,
          sample_rate: 48000,
        },
      });

      const label = document.getElementById('active-audio-mode-label');
      if (label) {
        if (pids.length === 0) {
          label.textContent = 'Áudio: Sistema Completo';
        } else if (mode === 'exclude') {
          label.textContent = `Áudio: Ignorando ${pids.length} app(s)`;
        } else {
          label.textContent = `Áudio: Capturando ${pids.length} app(s)`;
        }
      }

      this.closeAudioFilterModal();
      this.showToast('Filtros de áudio aplicados!');
    } catch {
      this.closeAudioFilterModal();
    }
  }

  // --- SIDEBAR & CHAT ---
  private switchSidebarTab(tab: 'chat' | 'peers') {
    document.getElementById('tab-chat')?.classList.toggle('active', tab === 'chat');
    document.getElementById('tab-peers')?.classList.toggle('active', tab === 'peers');
    document.getElementById('pane-chat')?.classList.toggle('active', tab === 'chat');
    document.getElementById('pane-peers')?.classList.toggle('active', tab === 'peers');
  }

  private updatePeersList(peers: PeerInfo[]) {
    const countEl = document.getElementById('peer-count');
    if (countEl) countEl.textContent = String(peers.length + 1);

    const listEl = document.getElementById('peer-list-container');
    if (!listEl) return;

    listEl.innerHTML = `
      <div class="peer-item">
        <div>
          <span class="peer-name">${this.username} (Você)</span>
          <span style="font-size: 11px; color: var(--text-muted); display: block;">${this.isCreator ? 'Criador da Sala' : 'Participante'}</span>
        </div>
        <span class="peer-status">● Online</span>
      </div>
    `;

    peers.forEach((p) => {
      const item = document.createElement('div');
      item.className = 'peer-item';
      item.innerHTML = `
        <div>
          <span class="peer-name">${p.username}</span>
          <span style="font-size: 11px; color: var(--text-muted); display: block;">ID: ${p.id.slice(0, 6)}</span>
        </div>
        <span class="peer-status">● Online</span>
      `;
      listEl.appendChild(item);
    });
  }

  private appendChatMessage(msg: ChatMessage) {
    const container = document.getElementById('chat-messages-container');
    if (!container) return;

    const timeStr = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    if (msg.isSystem) {
      const div = document.createElement('div');
      div.className = 'chat-system-msg';
      div.innerHTML = `<span>${msg.text}</span>`;
      container.appendChild(div);
    } else {
      const div = document.createElement('div');
      div.className = 'chat-msg';
      div.innerHTML = `
        <div class="chat-msg-header">
          <span class="chat-sender ${msg.isHost ? 'host' : ''}">${msg.sender} ${msg.isHost ? '(Host)' : ''}</span>
          <span class="chat-time">${timeStr}</span>
        </div>
        <div class="chat-bubble">${this.escapeHTML(msg.text)}</div>
      `;
      container.appendChild(div);
    }

    container.scrollTop = container.scrollHeight;
  }

  private escapeHTML(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}

// Start application when DOM is ready
window.addEventListener('DOMContentLoaded', () => {
  new App();
});
