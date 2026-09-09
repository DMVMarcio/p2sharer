import { invoke } from '@tauri-apps/api/core';
import { AudioBridge } from './audio/audio_bridge';
import { audioContextManager } from './audio/audio_context_manager';
import { initFrontendLogger } from './core/logger';
import { stateStore } from './core/state_store';
import { ChatMessage, PeerInfo } from './core/types';
import { generateRandomRoomSlug, GroupRoomManager } from './p2p/group_room';
import { HudController } from './ui/hud_controller';
import { ModalController } from './ui/modal_controller';
import { soundEffects } from './ui/sound_effects';
import { NativeVideoBridge } from './video/native_video_bridge';
import { ViewerRenderer } from './video/viewer_renderer';

class App {
  private roomManager: GroupRoomManager | null = null;
  private nativeVideoBridge = new NativeVideoBridge();
  private audioBridge = new AudioBridge();
  private modalController: ModalController;
  private viewerRenderer: ViewerRenderer;
  private hudController = new HudController();

  private get groupRoomManager(): GroupRoomManager | null {
    return this.roomManager;
  }

  constructor() {
    this.modalController = new ModalController({
      onJoinRoom: (code, pass, isCreator) => this.joinRoom(code, pass, isCreator),
      onUpdateRoomPassword: (pass) => { if (this.roomManager) this.roomManager.updateRoomPassword(pass); },
      onStartCapture: (sourceId, fps, res, mouse) => this.startCapture(sourceId, fps, res, mouse),
    });
    this.viewerRenderer = new ViewerRenderer({
      onRequestStream: (peerId) => { if (this.roomManager) this.roomManager.requestStream(peerId); },
      onStopWatchingStream: (peerId) => { if (this.roomManager) this.roomManager.stopWatching(peerId); },
      getPeerPing: (peerId) => this.roomManager?.getPeerPing(peerId),
    });
    this.init();
  }

  private init(): void {
    initFrontendLogger();
    this.modalController.applyTheme(stateStore.currentThemeMode);
    this.modalController.applyAccent(stateStore.currentAccentColor);
    if (stateStore.username) this.modalController.updateUsernameDisplay();
    else this.modalController.showUsernameModal();
    this.modalController.bindModalEvents();
    this.bindEvents();
    this.nativeVideoBridge.onFallbackNeeded = (reason: string, fallbackStream?: MediaStream) => {
      this.modalController.showToast(`Captura alternada para GPU Direta (${reason})`);
      if (fallbackStream) {
        const isLive =
          fallbackStream.active ??
          fallbackStream.getVideoTracks().some((t) => t.readyState === 'live');
        if (isLive) {
          stateStore.isSharingScreen = true;
          const localSlot = stateStore.roomSlots.find((s) => s.isLocal);
          if (localSlot) {
            localSlot.stream = fallbackStream;
            localSlot.isStreaming = true;
          }
          this.viewerRenderer.renderRoomCards();
          if (this.groupRoomManager) {
            this.groupRoomManager.shareStream(
              fallbackStream,
              stateStore.currentBitrate * 1000,
              this.nativeVideoBridge.getCurrentFps()
            );
          }
          this.hudController.updateStatsHUD();
          const videoTrack = fallbackStream.getVideoTracks()[0];
          if (videoTrack) {
            videoTrack.onended = () => this.stopScreenSharing();
          }
        }
      }
    };
    stateStore.currentRoomCode = generateRandomRoomSlug();
  }

  private switchView(viewId: 'view-home' | 'view-group-room'): void {
    document.querySelectorAll('.view').forEach((el) => el.classList.remove('active'));
    document.getElementById(viewId)?.classList.add('active');
    document.getElementById('header-room-code-pill')?.classList.toggle('hidden', viewId !== 'view-group-room');
  }

  private joinRoom(code: string, pass: string, isCreator: boolean): void {
    stateStore.currentRoomCode = code;
    stateStore.currentRoomPassword = pass;
    stateStore.isCreator = isCreator;
    soundEffects.playUserJoin();
    const displayRoomCode = document.getElementById('display-room-code');
    if (displayRoomCode) displayRoomCode.textContent = code;
    this.modalController.updateRoomSecurityHeaderUI();
    stateStore.roomSlots = [{ peerId: 'local', senderName: stateStore.username, stream: null, isStreaming: false, isLocal: true, color: 'hsl(190, 65%, 45%)' }];
    this.viewerRenderer.renderRoomCards();
    const chatContainer = document.getElementById('chat-messages-container');
    if (chatContainer) chatContainer.innerHTML = `<div class="chat-welcome-notice"><span>Você entrou na sala <strong>${code}</strong>${pass ? ' (com senha)' : ''}. Compartilhe o código para convidar amigos.</span></div>`;
    this.updateShareButtonUI(false);
    this.switchView('view-group-room');
    this.modalController.showConnectingOverlay(code, isCreator ? 'Criando sala P2P...' : 'Entrando na sala...');

    if (this.roomManager) this.roomManager.leave();
    this.roomManager = new GroupRoomManager(stateStore.username, code, pass, isCreator, stateStore.getTurnConfig());

    this.hudController.start({
      getPeerStats: (pId) => (this.roomManager ? this.roomManager.getPeerStats(pId) : Promise.resolve(null)),
      getPeerPing: (pId) => this.roomManager?.getPeerPing(pId),
      getStreamWatchers: (pId) => (this.roomManager ? this.roomManager.getStreamWatchers(pId) : []),
      getSignalingStatus: () => this.roomManager?.getSignalingStatus(),
    });

    this.roomManager.join({
      onStreamsUpdate: () => {},
      onSlotsUpdate: (slots) => {
        stateStore.roomSlots = slots;
        this.viewerRenderer.renderRoomCards();
        this.hudController.updateStatsHUD();
        this.modalController.hideConnectingOverlay();
      },
      onChat: (msg) => this.appendChatMessage(msg),
      onChatHistory: (messages) => messages.forEach((m) => this.appendChatMessage(m)),
      onPeersUpdate: (peers) => { this.updatePeersList(peers); this.modalController.hideConnectingOverlay(); },
      onPeerJoined: (_peer, isInitial) => { if (!isInitial) soundEffects.playUserJoin(); },
      onPeerLeft: () => soundEffects.playUserLeave(),
      onStreamStarted: () => soundEffects.playScreenShareStart(),
      onStreamStopped: (peerId, _uname, isLocal) => {
        soundEffects.playScreenShareStop();
        if (!isLocal && stateStore.subscribedStreams.has(peerId)) {
          stateStore.subscribedStreams.delete(peerId);
          this.viewerRenderer.renderRoomCards();
        }
      },
      onWatchStarted: () => soundEffects.playWatchStreamStart(),
      onWatchStopped: () => soundEffects.playWatchStreamStop(),
      onStatusChange: (status) => {
        const statsBadge = document.getElementById('room-stats-badge');
        if (statsBadge) statsBadge.textContent = status;
        if (status.includes('Conectado') || status === 'Sala Ativa' || status === 'Ao Vivo') this.modalController.hideConnectingOverlay();
      },
      onPasswordChange: (newPassword, updatedBy) => {
        stateStore.currentRoomPassword = newPassword;
        this.modalController.updateRoomSecurityHeaderUI();
        this.modalController.showToast(`Senha atualizada por ${updatedBy}`);
      },
    });
  }

  private async startCapture(sourceId: string, fps: number, res: { width: number; height: number }, mouse: boolean): Promise<void> {
    try {
      this.modalController.showToast('Iniciando transmissão...');
      const videoStream = await this.nativeVideoBridge.startCapture(sourceId, fps, res, mouse, 75);
      const audioTrack = await this.audioBridge.startCapture(stateStore.selectedFilterMode, stateStore.getActiveFilterPids(), stateStore.getActiveFilterNames());
      if (audioTrack) videoStream.addTrack(audioTrack);
      videoStream.getVideoTracks()[0].onended = () => this.stopScreenSharing();
      stateStore.isSharingScreen = true;

      const localSlot = stateStore.roomSlots.find((s) => s.isLocal);
      if (localSlot) { localSlot.stream = videoStream; localSlot.isStreaming = true; }
      this.viewerRenderer.renderRoomCards();
      if (this.roomManager) this.roomManager.shareStream(videoStream, stateStore.currentBitrate * 1000, fps);

      this.updateShareButtonUI(true);
      this.hudController.updateStatsHUD();
      soundEffects.playScreenShareStart();
    } catch (err) { console.warn('Capture error:', err); }
  }

  private stopScreenSharing(): void {
    stateStore.isSharingScreen = false;
    this.nativeVideoBridge.stop();
    this.audioBridge.stop();
    invoke('stop_audio_capture').catch(() => {});
    if (this.roomManager) this.roomManager.stopStream();
    const localSlot = stateStore.roomSlots.find((s) => s.isLocal);
    if (localSlot) { localSlot.stream = null; localSlot.isStreaming = false; }
    this.viewerRenderer.renderRoomCards();
    this.updateShareButtonUI(false);
    this.hudController.updateStatsHUD();
    soundEffects.playScreenShareStop();
  }

  private async leaveRoom(): Promise<void> {
    soundEffects.playUserLeave();
    this.hudController.stop();
    if (stateStore.isSharingScreen) this.stopScreenSharing();
    if (this.roomManager) { await this.roomManager.leave(); this.roomManager = null; }
    audioContextManager.cleanup();
    stateStore.subscribedStreams.clear();
    this.viewerRenderer.clear();
    stateStore.roomSlots = [];
    this.switchView('view-home');
    this.modalController.showToast('Você saiu da sala.');
  }

  private updateShareButtonUI(isSharing: boolean): void {
    document.getElementById('stream-sharing-dot')?.classList.toggle('active', isSharing);
    const label = document.getElementById('label-share-screen');
    if (label) label.textContent = isSharing ? 'Parar Transmissão' : 'Transmissão';
    const btn = document.getElementById('btn-toggle-share-screen');
    btn?.classList.toggle('btn-danger', isSharing);
    btn?.classList.toggle('btn-outline', !isSharing);
  }

  private appendChatMessage(msg: ChatMessage): void {
    const container = document.getElementById('chat-messages-container');
    if (!container) return;
    const timeStr = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const msgEl = document.createElement('div');
    msgEl.className = 'chat-msg';
    msgEl.innerHTML = `<div class="chat-msg-header"><span class="chat-msg-sender">${msg.sender}</span><span class="chat-msg-time">${timeStr}</span></div><div class="chat-msg-bubble">${msg.text}</div>`;
    container.appendChild(msgEl);
    container.scrollTop = container.scrollHeight;
  }

  private updatePeersList(peers: PeerInfo[]): void {
    const countEl = document.getElementById('count-participants');
    if (countEl) countEl.textContent = (peers.length + 1).toString();
    const listEl = document.getElementById('participants-list');
    if (!listEl) return;
    listEl.innerHTML = `<div class="participant-item"><div style="display:flex;align-items:center;gap:6px;"><span>${stateStore.username}</span><span class="badge-you">VOCÊ</span></div><span class="user-status-dot"></span></div>`;
    peers.forEach((p) => {
      const item = document.createElement('div');
      item.className = 'participant-item';
      item.innerHTML = `<span>${p.username}</span><span class="user-status-dot"></span>`;
      listEl.appendChild(item);
    });
  }

  private bindEvents(): void {
    document.getElementById('header-room-code-pill')?.addEventListener('click', () => {
      const copyText = stateStore.currentRoomPassword ? `Sala: ${stateStore.currentRoomCode} | Senha: ${stateStore.currentRoomPassword}` : stateStore.currentRoomCode;
      navigator.clipboard.writeText(copyText).then(() => this.modalController.showToast('Código copiado!')).catch(() => {});
    });
    document.getElementById('btn-toggle-share-screen')?.addEventListener('click', () => {
      if (stateStore.isSharingScreen) this.stopScreenSharing();
      else this.modalController.openScreenPickerModal();
    });
    document.getElementById('btn-cancel-connecting')?.addEventListener('click', () => {
      this.modalController.hideConnectingOverlay();
      this.leaveRoom();
    });
    document.getElementById('btn-leave-room')?.addEventListener('click', () => this.leaveRoom());
    document.getElementById('btn-room-fullscreen')?.addEventListener('click', () => {
      if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
      else document.exitFullscreen().catch(() => {});
    });
    document.getElementById('btn-toggle-sidebar')?.addEventListener('click', () => {
      stateStore.isSidebarCollapsed = !stateStore.isSidebarCollapsed;
      document.getElementById('room-sidebar')?.classList.toggle('collapsed', stateStore.isSidebarCollapsed);
      const label = document.getElementById('label-toggle-sidebar');
      if (label) label.textContent = stateStore.isSidebarCollapsed ? 'Abrir' : 'Chat';
    });
    document.getElementById('btn-toggle-spotlight-tray')?.addEventListener('click', () => {
      stateStore.isSpotlightTrayCollapsed = !stateStore.isSpotlightTrayCollapsed;
      document.getElementById('spotlight-tray-container')?.classList.toggle('collapsed', stateStore.isSpotlightTrayCollapsed);
    });
    const switchTab = (tab: 'chat' | 'participants') => {
      document.getElementById('tab-btn-chat')?.classList.toggle('active', tab === 'chat');
      document.getElementById('tab-btn-participants')?.classList.toggle('active', tab === 'participants');
      document.getElementById('tab-content-chat')?.classList.toggle('active', tab === 'chat');
      document.getElementById('tab-content-participants')?.classList.toggle('active', tab === 'participants');
    };
    document.getElementById('tab-btn-chat')?.addEventListener('click', () => switchTab('chat'));
    document.getElementById('tab-btn-participants')?.addEventListener('click', () => switchTab('participants'));
    document.getElementById('chat-input-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = document.getElementById('chat-input-field') as HTMLInputElement;
      const text = input?.value.trim();
      if (text && this.roomManager) {
        const msg = this.roomManager.sendChatMessage(text);
        this.appendChatMessage(msg);
        input.value = '';
      }
    });
    window.addEventListener('beforeunload', () => {
      if (stateStore.isSharingScreen) this.stopScreenSharing();
      if (this.roomManager) this.roomManager.leave();
    });
  }
}

new App();
