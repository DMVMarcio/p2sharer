import { invoke } from '@tauri-apps/api/core';
import { AudioBridge } from './audio_bridge';
import { GroupHostManager, GroupViewerManager } from './group_room';
import { NativeVideoBridge } from './native_video_bridge';
import {
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
  private isHost: boolean = false;
  private isSharingScreen: boolean = false;

  private groupHostManager: GroupHostManager | null = null;
  private groupViewerManager: GroupViewerManager | null = null;
  private nativeVideoBridge: NativeVideoBridge = new NativeVideoBridge();
  private audioBridge: AudioBridge = new AudioBridge();
  private activeLocalStream: MediaStream | null = null;

  private audioProcesses: ProcessItem[] = [];
  private selectedFilterMode: 'exclude' | 'include' = 'exclude';
  private selectedPids: Set<number> = new Set();

  // Custom Screen Picker State
  private availableMonitors: MonitorSource[] = [];
  private availableWindows: WindowSource[] = [];
  private selectedSourceId: string = 'screen:0';
  private selectedSourceName: string = 'Monitor Principal';

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

    // Home Actions
    document.getElementById('btn-create-room-direct')?.addEventListener('click', () => this.createRoomAsHost());
    document.getElementById('btn-start-join-flow')?.addEventListener('click', () => this.openJoinDialog());

    // Join Dialog Modal
    document.getElementById('btn-close-join-dialog')?.addEventListener('click', () => this.closeJoinDialog());
    document.getElementById('btn-cancel-join-dialog')?.addEventListener('click', () => this.closeJoinDialog());
    document.getElementById('btn-confirm-join-dialog')?.addEventListener('click', () => this.confirmJoinFromDialog());

    // Inside Room: Share Screen toggle
    document.getElementById('btn-toggle-share-screen')?.addEventListener('click', () => {
      if (this.isSharingScreen) {
        this.stopScreenSharing();
      } else {
        this.openScreenPickerModal();
      }
    });

    // Custom Screen Picker Modal
    document.getElementById('btn-close-screen-picker')?.addEventListener('click', () => this.closeScreenPickerModal());
    document.getElementById('btn-cancel-screen-picker')?.addEventListener('click', () => this.closeScreenPickerModal());
    document.getElementById('tab-source-screens')?.addEventListener('click', () => this.switchSourcePickerTab('screens'));
    document.getElementById('tab-source-windows')?.addEventListener('click', () => this.switchSourcePickerTab('windows'));
    document.getElementById('btn-confirm-start-stream')?.addEventListener('click', () => this.confirmStartScreenCapture());

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
    document.getElementById('room-code-pill')?.addEventListener('click', () => this.copyRoomCodeToClipboard());
    document.getElementById('btn-leave-room')?.addEventListener('click', () => this.leaveRoom());
    document.getElementById('btn-room-fullscreen')?.addEventListener('click', () => this.toggleFullscreen());
    document.getElementById('btn-unmute-room-audio')?.addEventListener('click', () => this.unmuteRoomAudio());

    // Sidebar Tabs
    document.getElementById('tab-chat')?.addEventListener('click', () => this.switchSidebarTab('chat'));
    document.getElementById('tab-peers')?.addEventListener('click', () => this.switchSidebarTab('peers'));

    // Chat Form
    document.getElementById('chat-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = document.getElementById('chat-input') as HTMLInputElement;
      const text = input.value.trim();
      if (!text) return;

      let msg: ChatMessage | null = null;
      if (this.isHost && this.groupHostManager) {
        msg = this.groupHostManager.sendChatMessage(text);
      } else if (this.groupViewerManager) {
        msg = this.groupViewerManager.sendChatMessage(text);
      }

      if (msg) {
        this.appendChatMessage(msg);
        input.value = '';
      }
    });
  }

  // --- CREATE ROOM (AS HOST / ROOM OWNER) ---
  private createRoomAsHost() {
    if (!this.username) {
      this.showUsernameModal();
      return;
    }

    this.isHost = true;
    this.generateRandomRoomCode();
    this.enterRoomUI();

    this.groupHostManager = new GroupHostManager(this.username, this.currentRoomCode);
    this.groupHostManager.join(
      (msg) => this.appendChatMessage(msg),
      (peers) => this.updatePeersList(peers)
    );

    this.showToast(`Sala "${this.currentRoomCode}" criada!`);
  }

  // --- JOIN ROOM DIALOG ---
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

    this.isHost = false;
    this.currentRoomCode = input.toUpperCase();
    this.closeJoinDialog();
    this.enterRoomUI();

    this.groupViewerManager = new GroupViewerManager(this.username, this.currentRoomCode);
    this.groupViewerManager.join(
      (stream) => {
        this.renderRemoteStream(stream);
      },
      () => {
        const video = document.getElementById('room-main-video') as HTMLVideoElement;
        const idleBox = document.getElementById('room-video-idle');
        const sharingStatus = document.getElementById('room-sharing-status-tag');
        const liveBadge = document.getElementById('room-live-badge');
        if (video) video.srcObject = null;
        if (idleBox) idleBox.classList.remove('hidden');
        if (sharingStatus) sharingStatus.textContent = 'Nenhuma transmissão no momento';
        if (liveBadge) {
          liveBadge.textContent = 'SALA ATIVA';
          liveBadge.classList.remove('streaming');
        }
      },
      (msg) => this.appendChatMessage(msg),
      (status) => {
        const statsBadge = document.getElementById('room-stats-badge');
        if (statsBadge) statsBadge.textContent = status;
      }
    );

    this.showToast(`Conectando à sala ${this.currentRoomCode}...`);
  }

  private enterRoomUI() {
    const displayRoomCode = document.getElementById('display-room-code');
    if (displayRoomCode) displayRoomCode.textContent = this.currentRoomCode;

    const idleBox = document.getElementById('room-video-idle');
    if (idleBox) idleBox.classList.remove('hidden');

    const video = document.getElementById('room-main-video') as HTMLVideoElement;
    if (video) video.srcObject = null;

    const chatContainer = document.getElementById('chat-messages-container');
    if (chatContainer) {
      chatContainer.innerHTML = `
        <div class="chat-system-msg">
          <span>Você entrou na sala <strong>${this.currentRoomCode}</strong>. Compartilhe o código para convidar amigos.</span>
        </div>
      `;
    }

    this.updateShareButtonUI(false);
    this.switchView('view-group-room');
  }

  // --- CUSTOM SCREEN & APPLICATION PICKER WITH LIVE THUMBNAILS ---
  private async openScreenPickerModal() {
    const modal = document.getElementById('modal-custom-screen-picker');
    modal?.classList.remove('hidden');
    await this.loadScreenSources();
  }

  private closeScreenPickerModal() {
    document.getElementById('modal-custom-screen-picker')?.classList.add('hidden');
  }

  private switchSourcePickerTab(tab: 'screens' | 'windows') {
    document.getElementById('tab-source-screens')?.classList.toggle('active', tab === 'screens');
    document.getElementById('tab-source-windows')?.classList.toggle('active', tab === 'windows');
    document.getElementById('pane-source-screens')?.classList.toggle('active', tab === 'screens');
    document.getElementById('pane-source-windows')?.classList.toggle('active', tab === 'windows');
  }

  private async loadScreenSources() {
    const screenGrid = document.getElementById('grid-screen-sources');
    const windowGrid = document.getElementById('grid-window-sources');
    if (screenGrid) screenGrid.innerHTML = '<div class="loading-state">Buscando monitores e gerando miniaturas...</div>';
    if (windowGrid) windowGrid.innerHTML = '<div class="loading-state">Buscando janelas e gerando miniaturas...</div>';

    try {
      const resp = await invoke<ScreenSourcesResponse>('list_screen_sources');
      this.availableMonitors = resp.monitors;
      this.availableWindows = resp.windows;
      this.renderScreenSources();
      this.renderWindowSources();
    } catch (err) {
      console.warn('Fallback screen sources:', err);
      this.availableMonitors = [
        { id: 'screen:0', name: 'Monitor 1 (Principal) - 1920x1080', width: 1920, height: 1080, is_primary: true, thumbnail: undefined },
      ];
      this.availableWindows = [
        { id: 'window:1', title: 'Discord', process_name: 'Discord.exe', pid: 10420, hwnd: 1, width: 1280, height: 720, thumbnail: undefined },
        { id: 'window:2', title: 'Google Chrome', process_name: 'chrome.exe', pid: 9812, hwnd: 2, width: 1920, height: 1080, thumbnail: undefined },
      ];
      this.renderScreenSources();
      this.renderWindowSources();
    }
  }

  private renderScreenSources() {
    const grid = document.getElementById('grid-screen-sources');
    if (!grid) return;

    if (this.availableMonitors.length === 0) {
      grid.innerHTML = '<div class="loading-state">Nenhum monitor detectado.</div>';
      return;
    }

    grid.innerHTML = '';
    this.availableMonitors.forEach((mon) => {
      const card = document.createElement('div');
      card.className = `source-card ${this.selectedSourceId === mon.id ? 'selected' : ''}`;

      const thumbHTML = mon.thumbnail
        ? `<img src="${mon.thumbnail}" class="source-thumbnail-img" alt="${mon.name}" />`
        : `<div class="source-placeholder-icon">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/></svg>
           </div>`;

      card.innerHTML = `
        ${mon.is_primary ? '<span class="source-badge-primary">Principal</span>' : ''}
        <div class="source-thumbnail-container">
          ${thumbHTML}
        </div>
        <div class="source-title" title="${mon.name}">${mon.name}</div>
        <div class="source-subtitle">${mon.width} x ${mon.height} Pixels</div>
      `;

      card.addEventListener('click', () => {
        document.querySelectorAll('#modal-custom-screen-picker .source-card').forEach((c) => c.classList.remove('selected'));
        card.classList.add('selected');
        this.selectedSourceId = mon.id;
        this.selectedSourceName = mon.name;
      });

      grid.appendChild(card);
    });
  }

  private renderWindowSources() {
    const grid = document.getElementById('grid-window-sources');
    if (!grid) return;

    if (this.availableWindows.length === 0) {
      grid.innerHTML = '<div class="loading-state">Nenhuma janela de aplicativo aberta detectada.</div>';
      return;
    }

    grid.innerHTML = '';
    this.availableWindows.forEach((win) => {
      const card = document.createElement('div');
      card.className = `source-card ${this.selectedSourceId === win.id ? 'selected' : ''}`;

      const thumbHTML = win.thumbnail
        ? `<img src="${win.thumbnail}" class="source-thumbnail-img" alt="${win.title}" />`
        : `<div class="source-placeholder-icon">
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect width="20" height="16" x="2" y="4" rx="2"/><line x1="2" x2="22" y1="9" y2="9"/><line x1="6" x2="6.01" y1="6.5" y2="6.5"/><line x1="10" x2="10.01" y1="6.5" y2="6.5"/></svg>
           </div>`;

      card.innerHTML = `
        <div class="source-thumbnail-container">
          ${thumbHTML}
        </div>
        <div class="source-title" title="${win.title}">${win.title}</div>
        <div class="source-subtitle">${win.process_name} (${win.width}x${win.height})</div>
      `;

      card.addEventListener('click', () => {
        document.querySelectorAll('#modal-custom-screen-picker .source-card').forEach((c) => c.classList.remove('selected'));
        card.classList.add('selected');
        this.selectedSourceId = win.id;
        this.selectedSourceName = win.title;
      });

      grid.appendChild(card);
    });
  }

  // --- START SCREEN CAPTURE (ZERO CHROME POPUPS) ---
  private async confirmStartScreenCapture() {
    const resValue = (document.getElementById('picker-select-resolution') as HTMLSelectElement).value;
    const fpsValue = parseInt((document.getElementById('picker-select-fps') as HTMLSelectElement).value, 10) || 60;

    let res = { width: 1920, height: 1080 };
    if (resValue === '4k') res = { width: 3840, height: 2160 };
    else if (resValue === '1440p') res = { width: 2560, height: 1440 };
    else if (resValue === '720p') res = { width: 1280, height: 720 };
    else if (resValue === '480p') res = { width: 854, height: 480 };

    this.closeScreenPickerModal();
    this.showToast('Iniciando captura direta...');

    try {
      // 1. Audio bridge listener
      const customAudioTrack = this.audioBridge.init((rmsLevel) => {
        const vuBar = document.getElementById('room-vu-meter');
        if (vuBar) {
          const percent = Math.min(100, Math.round(rmsLevel * 250));
          vuBar.style.width = `${percent}%`;
        }
      });
      await this.audioBridge.startListening();

      // 2. Native Canvas Video Capture (ZERO Chrome popups!)
      const videoStream = await this.nativeVideoBridge.startCapture(this.selectedSourceId, fpsValue, res);

      // 3. Assemble combined MediaStream
      const combinedStream = new MediaStream();
      videoStream.getVideoTracks().forEach((vt) => combinedStream.addTrack(vt));
      if (customAudioTrack) {
        combinedStream.addTrack(customAudioTrack);
      }

      this.activeLocalStream = combinedStream;
      this.isSharingScreen = true;

      // Render local preview on video element
      const video = document.getElementById('room-main-video') as HTMLVideoElement;
      const idleBox = document.getElementById('room-video-idle');
      if (video) {
        video.srcObject = combinedStream;
        video.muted = true;
        video.play();
      }
      if (idleBox) idleBox.classList.add('hidden');

      // Update room stream for connected peers
      if (this.groupHostManager) {
        this.groupHostManager.setStream(combinedStream);
      }

      // Update UI tags
      const sourceLabel = document.getElementById('active-source-label');
      const sharingStatus = document.getElementById('room-sharing-status-tag');
      const liveBadge = document.getElementById('room-live-badge');
      if (sourceLabel) sourceLabel.textContent = `${this.selectedSourceName} (${res.width}x${res.height} @ ${fpsValue}fps)`;
      if (sharingStatus) sharingStatus.textContent = `Você está transmitindo: ${this.selectedSourceName}`;
      if (liveBadge) {
        liveBadge.textContent = 'TRANSMITINDO';
        liveBadge.classList.add('streaming');
      }

      this.updateShareButtonUI(true);
      this.showToast('Transmissão ao vivo iniciada!');
    } catch (err: unknown) {
      console.error('Failed to start native capture:', err);
      const errMsg = err instanceof Error ? err.message : String(err);
      this.showToast(`Erro ao capturar tela: ${errMsg}`);
      this.stopScreenSharing();
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

    if (this.groupHostManager) {
      this.groupHostManager.setStream(null);
    }

    const video = document.getElementById('room-main-video') as HTMLVideoElement;
    const idleBox = document.getElementById('room-video-idle');
    if (video) video.srcObject = null;
    if (idleBox) idleBox.classList.remove('hidden');

    const sourceLabel = document.getElementById('active-source-label');
    const sharingStatus = document.getElementById('room-sharing-status-tag');
    const liveBadge = document.getElementById('room-live-badge');
    if (sourceLabel) sourceLabel.textContent = 'Nenhuma tela ativa';
    if (sharingStatus) sharingStatus.textContent = 'Nenhuma transmissão no momento';
    if (liveBadge) {
      liveBadge.textContent = 'SALA ATIVA';
      liveBadge.classList.remove('streaming');
    }

    this.updateShareButtonUI(false);
    this.showToast('Transmissão de tela encerrada.');
  }

  private updateShareButtonUI(isSharing: boolean) {
    const btn = document.getElementById('btn-toggle-share-screen');
    const label = document.getElementById('label-toggle-share');
    if (btn && label) {
      if (isSharing) {
        btn.className = 'btn btn-sm btn-danger';
        label.textContent = 'Parar Transmissão';
      } else {
        btn.className = 'btn btn-sm btn-accent';
        label.textContent = 'Compartilhar Tela';
      }
    }
  }

  // --- REMOTE STREAM RENDERING ---
  private renderRemoteStream(stream: MediaStream) {
    const video = document.getElementById('room-main-video') as HTMLVideoElement;
    const idleBox = document.getElementById('room-video-idle');
    const sharingStatus = document.getElementById('room-sharing-status-tag');
    const liveBadge = document.getElementById('room-live-badge');

    if (idleBox) idleBox.classList.add('hidden');
    if (video) {
      video.srcObject = stream;
      video.muted = false;
      video.play().catch(() => {
        document.getElementById('room-unmute-overlay')?.classList.remove('hidden');
      });
    }

    const hostName = this.groupViewerManager?.getHostName() || 'Apresentador';
    if (sharingStatus) sharingStatus.textContent = `Ao Vivo por: ${hostName}`;
    if (liveBadge) {
      liveBadge.textContent = 'AO VIVO';
      liveBadge.classList.add('streaming');
    }

    this.showToast(`Transmissão de ${hostName} recebida!`);
  }

  private unmuteRoomAudio() {
    const video = document.getElementById('room-main-video') as HTMLVideoElement;
    if (video) {
      video.muted = false;
      video.play();
    }
    document.getElementById('room-unmute-overlay')?.classList.add('hidden');
  }

  private toggleFullscreen() {
    const container = document.getElementById('room-video-container');
    if (!container) return;
    if (!document.fullscreenElement) {
      container.requestFullscreen();
    } else {
      document.exitFullscreen();
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
    if (this.groupHostManager) {
      this.groupHostManager.stop();
      this.groupHostManager = null;
    }
    if (this.groupViewerManager) {
      this.groupViewerManager.stop();
      this.groupViewerManager = null;
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
      container.innerHTML = '<div class="loading-state">Buscando programas em execução no Windows...</div>';
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
          label.textContent = 'Sistema Completo (Sem Filtros)';
        } else if (mode === 'exclude') {
          label.textContent = `Ignorando ${pids.length} app(s) (ex: Discord)`;
        } else {
          label.textContent = `Capturando apenas ${pids.length} app(s)`;
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
          <span style="font-size: 11px; color: var(--text-muted); display: block;">${this.isHost ? 'Criador da Sala' : 'Participante'}</span>
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
