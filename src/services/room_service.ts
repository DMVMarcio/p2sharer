import { invoke } from '@tauri-apps/api/core';
import { roomAppsService } from '../apps/room_apps_service.ts';
import { AudioBridge } from '../audio/audio_bridge.ts';
import { audioContextManager } from '../audio/audio_context_manager.ts';
import { stateStore } from '../core/state_store.ts';
import { mergeChatHistory } from '../core/chat_history.ts';
import { CHAT_FILE_CHUNK_BYTES, MAX_IMAGE_PREVIEW_BYTES } from '../core/chat_file_limits.ts';
import { verifyRoomInvite } from '../core/room_invite_validation.ts';
import { savedRooms } from '../core/saved_rooms.ts';
import type { ChatMessage, PeerInfo, RoomSlotInfo } from '../core/types.ts';
import { generateRandomRoomSlug, GroupRoomManager, type FileProgress, type FileRequest, type NativeChatFile } from '../p2p/group_room.ts';
import { soundEffects } from '../ui/sound_effects.ts';
import { NativeVideoBridge } from '../video/native_video_bridge.ts';
import { showToast } from '../hooks/useToast.ts';
import { pipService } from './pip_service.ts';

export interface ConnectingOverlayState {
  visible: boolean;
  roomCode: string;
  title: string;
  subtitle: string;
}

type Listener = () => void;

export class RoomService {
  private static instance: RoomService | null = null;

  public roomManager: GroupRoomManager | null = null;
  public pendingJoinInvite = '';
  public pendingJoinAsOwner = false;
  public nativeVideoBridge = new NativeVideoBridge();
  public audioBridge = new AudioBridge();

  public chatMessages: ChatMessage[] = [];
  public fileRequests: FileRequest[] = [];
  public fileProgress: Record<string, FileProgress> = {};
  public localFilePreviews: Record<string, string> = {};
  public imagePreviews: Record<string, string> = {};
  public savedDownloads: Record<string, string> = {};
  private imagePreviewBytes: Record<string, Uint8Array> = {};
  private transferRates = new Map<string, { at: number; bytes: number; speed: number }>();
  private transferRouteChecks = new Map<string, number>();
  private localSaveIds = new Set<string>();
  private cancelledLocalSaves = new Set<string>();
  public peers: PeerInfo[] = [];
  public roomStatusText: string = 'Sala Ativa';
  public connectingOverlay: ConnectingOverlayState = {
    visible: false,
    roomCode: '',
    title: 'Entrando na sala...',
    subtitle: 'Estabelecendo sinalização e túnel P2P criptografado...',
  };

  private listeners: Set<Listener> = new Set();
  private roomConnectingTimeout: ReturnType<typeof setTimeout> | null = null;
  private roomTransition: Promise<void> = Promise.resolve();

  public static getInstance(): RoomService {
    if (!RoomService.instance) {
      RoomService.instance = new RoomService();
    }
    return RoomService.instance;
  }

  constructor() {
    this.initFallbackHandler();
  }

  public subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    this.listeners.forEach((l) => {
      try {
        l();
      } catch (err) {
        console.error('Error in RoomService listener:', err);
      }
    });
  }

  private initFallbackHandler(): void {
    this.nativeVideoBridge.onFallbackNeeded = (reason: string, fallbackStream?: MediaStream) => {
      if (fallbackStream) {
        showToast(`Transmissão alternada (${reason})`);
        const isLive =
          fallbackStream.active ??
          fallbackStream.getVideoTracks().some((t) => t.readyState === 'live');
        if (isLive) {
          stateStore.set((s) => {
            s.isSharingScreen = true;
            const localSlot = s.roomSlots.find((slot) => slot.isLocal);
            if (localSlot) {
              localSlot.stream = fallbackStream;
              localSlot.isStreaming = true;
            }
          });
          if (this.roomManager) {
            this.roomManager.shareStream(
              fallbackStream,
              stateStore.currentBitrate * 1000,
              this.nativeVideoBridge.getCurrentFps()
            );
          }
          const videoTrack = fallbackStream.getVideoTracks()[0];
          if (videoTrack) {
            videoTrack.onended = () => this.stopScreenSharing();
          }
          this.notify();
        }
      } else {
        if (reason === 'window_minimized') {
          showToast('Aviso: A janela transmitida foi minimizada.');
        } else if (reason === 'window_not_found') {
          showToast('A janela transmitida foi fechada.');
          this.stopScreenSharing();
        } else {
          showToast(`Alerta de captura: ${reason}`);
        }
      }
    };
  }

  public showConnecting(roomCode: string, title = 'Entrando na sala...', subtitle = 'Estabelecendo sinalização e túnel P2P criptografado...'): void {
    this.connectingOverlay = {
      visible: true,
      roomCode,
      title,
      subtitle,
    };
    this.notify();
  }

  public hideConnecting(): void {
    if (this.roomConnectingTimeout) {
      clearTimeout(this.roomConnectingTimeout);
      this.roomConnectingTimeout = null;
    }
    if (this.connectingOverlay.visible) {
      this.connectingOverlay.visible = false;
      this.notify();
    }
  }

  public async joinRoom(code: string, pass: string, isCreator: boolean): Promise<void> {
    const transition = this.roomTransition.then(() => this.joinRoomNow(code, pass, isCreator));
    this.roomTransition = transition.catch((err) => {
      console.error('[RoomService] Room transition failed:', err);
    });
    return transition;
  }

  private async joinRoomNow(code: string, pass: string, isCreator: boolean): Promise<void> {
    roomAppsService.reset();
    const parsed = await verifyRoomInvite(code);
    if (!parsed && typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
      throw new Error('Um convite autenticado é necessário para entrar na sala');
    }
    stateStore.set((s) => {
      s.currentRoomCode = parsed ? parsed.roomId.slice(0, 8) : code;
      s.currentRoomInvite = parsed ? code : '';
      s.currentRoomName = parsed?.version === 4 ? parsed.name : parsed?.roomId.slice(0, 8) ?? code;
      s.currentRoomPassword = pass;
      s.isCreator = isCreator;
      s.roomSlots = [
        {
          peerId: 'local',
          senderName: s.username || 'Usuário',
          stream: null,
          isStreaming: false,
          isLocal: true,
          color: 'hsl(190, 65%, 45%)',
        },
      ];
    });

    soundEffects.playUserJoin();

    this.clearImagePreviews();
    this.chatMessages = [];
    this.fileRequests = [];
    this.fileProgress = {};
    this.transferRates.clear();
    this.transferRouteChecks.clear();
    this.savedDownloads = {};
    this.localFilePreviews = {};
    this.peers = [];
    this.roomStatusText = 'Conectando à sala...';

    this.showConnecting(parsed ? parsed.roomId.slice(0, 8) : code,
      isCreator ? 'Criando sala P2P...' : 'Entrando na sala...');

    if (this.roomConnectingTimeout) {
      clearTimeout(this.roomConnectingTimeout);
    }
    // Dismiss the overlay, but keep searching and describe the actual state.
    this.roomConnectingTimeout = setTimeout(() => {
      if (!isCreator && this.peers.every((peer) => peer.connectionState !== 'connected')) {
        this.roomStatusText = 'Ainda procurando participantes...';
      }
      this.hideConnecting();
      this.notify();
    }, isCreator ? 3000 : 12000);

    if (this.roomManager) {
      const oldManager = this.roomManager;
      this.roomManager = null;
      try {
        await oldManager.leave();
      } catch (err) {
        console.warn('[RoomService] Error leaving previous room:', err);
      }
    }

    const manager = new GroupRoomManager(
      stateStore.username || 'Usuário',
      code,
      pass,
      isCreator,
      stateStore.getTurnConfig()
    );
    this.roomManager = manager;
    roomAppsService.attach((event, target) => manager.sendAppEvent(event, target), manager.getLocalPeerId(),
      (action, instance) => {
        void manager.sendAppLifecycleNotice(action, instance.kind).catch((error) =>
          console.warn('[Chat] Failed to publish app notice:', error));
      });

    await manager.join({
      onFileRequestCancelled: (requestId) => {
        if (this.roomManager !== manager) return;
        this.fileRequests = this.fileRequests.filter((request) => request.requestId !== requestId);
        this.notify();
      },
      onFileRequest: (request) => {
        if (this.roomManager !== manager) return;
        this.fileRequests = [...this.fileRequests, request];
        this.notify();
      },
      onFileProgress: (progress) => {
        if (this.roomManager !== manager) return;
        this.recordFileProgress(progress);
        if (progress.status === 'error') showToast('Não foi possível concluir a transferência do arquivo.');
      },
      onAppEvent: (event, peerId) => {
        if (this.roomManager === manager) roomAppsService.receive(event, peerId);
      },
      onStreamsUpdate: () => {
        // Handled via onSlotsUpdate to prevent double notification cascades
      },
      onSlotsUpdate: (slots: RoomSlotInfo[]) => {
        if (this.roomManager !== manager) return;
        stateStore.set((s) => {
          s.roomSlots = slots;
        });
        if (isCreator || slots.some((slot) => !slot.isLocal)) this.hideConnecting();
      },
      onChat: (msg: ChatMessage) => {
        if (this.roomManager !== manager) return;
        this.chatMessages = mergeChatHistory(this.chatMessages, [msg]);
        if (msg.deletedAt && msg.file) {
          this.fileRequests = this.fileRequests.filter((request) => request.messageId !== msg.id);
          const preview = this.imagePreviews[msg.id];
          if (preview?.startsWith('blob:')) URL.revokeObjectURL(preview);
          delete this.imagePreviews[msg.id];
          delete this.imagePreviewBytes[msg.id];
        }
        this.notify();
      },
      onChatHistory: (messages: ChatMessage[]) => {
        if (this.roomManager !== manager) return;
        this.chatMessages = mergeChatHistory(this.chatMessages, messages);
        this.notify();
      },
      onPeersUpdate: (peers: PeerInfo[]) => {
        if (this.roomManager !== manager) return;
        this.peers = peers;
        if (isCreator || peers.some((peer) => peer.connectionState === 'connected')) this.hideConnecting();
        this.notify();
      },
      onPeerJoined: (peer, isInitial) => {
        if (this.roomManager !== manager) return;
        roomAppsService.sendSync(peer.id);
        roomAppsService.requestSync();
        const name = peer.username.trim();
        if (!isInitial && name) {
          soundEffects.playUserJoin();
        }
      },
      onPeerLeft: (_peerId, username) => {
        if (this.roomManager !== manager) return;
        this.fileRequests = this.fileRequests.filter((request) => request.peerId !== _peerId);
        this.notify();
        roomAppsService.forgetPeer(_peerId);
        const name = username.trim();
        if (!name) return;
        soundEffects.playUserLeave();
      },
      onStreamStarted: () => soundEffects.playScreenShareStart(),
      onStreamStopped: (peerId, _uname, isLocal) => {
        soundEffects.playScreenShareStop();
        if (!isLocal && stateStore.subscribedStreams.has(peerId)) {
          stateStore.set((s) => {
            s.subscribedStreams.delete(peerId);
          });
          this.notify();
        }
      },
      onWatchStarted: () => soundEffects.playWatchStreamStart(),
      onWatchStopped: () => soundEffects.playWatchStreamStop(),
      onStatusChange: (status) => {
        if (this.roomManager !== manager) return;
        this.roomStatusText = status;
        if (
          status.includes('Conectado') ||
          status === 'Sala Ativa' ||
          status === 'Ao Vivo' ||
          status.includes('P2P') ||
          status.includes('Participante')
        ) {
          this.hideConnecting();
        } else if (status.startsWith('Erro') || status.startsWith('Senha incorreta')) {
          this.hideConnecting();
          showToast(status, 5000);
        }
        this.notify();
      },
      onPasswordChange: (newPassword, updatedBy) => {
        if (this.roomManager !== manager) return;
        stateStore.set((s) => {
          s.currentRoomPassword = newPassword;
        });
        showToast(`Senha atualizada por ${updatedBy}`);
        if (parsed) {
          void savedRooms.get(parsed.roomId).then((record) => {
            if (record) return savedRooms.put({ ...record, protected: Boolean(newPassword),
              password: record.password !== undefined ? newPassword : undefined });
          }).catch((error) => console.warn('[Rooms] Failed to refresh saved password:', error));
        }
        this.notify();
      },
      onHostChange: (isLocalHost) => {
        if (this.roomManager !== manager) return;
        stateStore.set((s) => { s.isCreator = isLocalHost; });
        this.notify();
      },
      onInviteChange: (invite, name) => {
        if (this.roomManager !== manager) return;
        stateStore.set((s) => {
          s.currentRoomInvite = invite;
          s.currentRoomName = name;
        });
      },
    });

    this.notify();
  }

  public async startCapture(
    sourceId: string,
    fps: number,
    res: { width: number; height: number },
    mouse: boolean,
    quality?: number
  ): Promise<void> {
    try {
      showToast('Iniciando transmissão...');

      const chosenSource = !sourceId ? 'screen:0' : sourceId;
      const targetQuality = quality ?? stateStore.currentQuality ?? 90;
      const videoStream = await this.nativeVideoBridge.startCapture(chosenSource, fps, res, mouse, targetQuality);

      const audioMode = stateStore.isAudioFilterFullAudio ? 'full' : stateStore.selectedFilterMode;
      const audioPids = stateStore.isAudioFilterFullAudio ? [] : stateStore.getActiveFilterPids();
      const audioNames = stateStore.isAudioFilterFullAudio ? [] : stateStore.getActiveFilterNames();

      const audioTrack = await this.audioBridge.startCapture(
        audioMode,
        audioPids,
        audioNames
      );

      if (audioTrack) {
        videoStream.addTrack(audioTrack);
      }

      const videoTrack = videoStream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.onended = () => this.stopScreenSharing();
      }

      stateStore.set((s) => {
        s.isSharingScreen = true;
        const localSlot = s.roomSlots.find((slot) => slot.isLocal);
        if (localSlot) {
          localSlot.stream = videoStream;
          localSlot.isStreaming = true;
        }
      });

      if (this.roomManager) {
        this.roomManager.shareStream(videoStream, stateStore.currentBitrate * 1000, fps);
      }

      soundEffects.playScreenShareStart();
      this.notify();
    } catch (err: unknown) {
      const errName = err && typeof err === 'object' && 'name' in err ? (err as { name: string }).name : '';
      if (errName === 'NotAllowedError' || errName === 'AbortError') {
        showToast('Compartilhamento cancelado');
        return;
      }
      console.warn('Capture error:', err);
      showToast(`Erro ao iniciar captura: ${err}`);
    }
  }

  public stopScreenSharing(): void {
    stateStore.set((s) => {
      s.isSharingScreen = false;
      const localSlot = s.roomSlots.find((slot) => slot.isLocal);
      if (localSlot) {
        localSlot.stream = null;
        localSlot.isStreaming = false;
      }
    });

    if (this.roomManager) {
      this.roomManager.stopStream();
    }

    this.nativeVideoBridge.stop();
    this.audioBridge.stop();
    invoke('stop_audio_capture').catch(() => {});

    soundEffects.playScreenShareStop();
    this.notify();
  }

  public async leaveRoom(): Promise<void> {
    const transition = this.roomTransition.then(() => this.leaveRoomNow());
    this.roomTransition = transition.catch((err) => {
      console.error('[RoomService] Room exit failed:', err);
    });
    return transition;
  }

  private async leaveRoomNow(): Promise<void> {
    roomAppsService.reset();
    if (this.roomConnectingTimeout) {
      clearTimeout(this.roomConnectingTimeout);
      this.roomConnectingTimeout = null;
    }

    soundEffects.playUserLeave();

    if (stateStore.isSharingScreen) {
      this.stopScreenSharing();
    }

    if (this.roomManager) {
      const oldManager = this.roomManager;
      this.roomManager = null;
      await oldManager.leave();
    }

    try {
      await pipService.closeAllPipWindows();
    } catch {}

    audioContextManager.cleanup();

    stateStore.set((s) => {
      s.subscribedStreams.clear();
      s.roomSlots = [];
      s.currentRoomCode = generateRandomRoomSlug();
      s.currentRoomInvite = '';
      s.currentRoomName = '';
      s.currentRoomPassword = '';
      s.layoutMode = 'grid';
      s.pinnedPeerId = null;
    });

    this.chatMessages = [];
    this.fileRequests = [];
    this.fileProgress = {};
    this.transferRates.clear();
    this.transferRouteChecks.clear();
    this.savedDownloads = {};
    this.localFilePreviews = {};
    this.clearImagePreviews();
    this.localSaveIds.clear();
    this.cancelledLocalSaves.clear();
    this.peers = [];
    this.hideConnecting();
    showToast('Você saiu da sala.');
    this.notify();
  }

  public sendChatMessage(text: string, replyToId?: string): void {
    if (!text.trim() || !this.roomManager) return;
    void this.roomManager.sendChatMessage(text.trim(), replyToId).catch((error) =>
      console.warn('[Chat] Failed to sign or send message:', error));
  }

  public async offerFile(file: NativeChatFile, name: string, autoAccept: boolean): Promise<void> {
    if (!this.roomManager) throw new Error('Room unavailable');
    const message = await this.roomManager.offerFile(file, name, autoAccept);
    if (message.file?.isImage && file.size <= MAX_IMAGE_PREVIEW_BYTES) {
      try {
        const data = await invoke<string>('read_chat_image_preview', { id: file.id });
        const extension = file.name.split('.').pop()?.toLowerCase();
        const mime = extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' :
          extension === 'png' ? 'image/png' : extension === 'gif' ? 'image/gif' :
          extension === 'webp' ? 'image/webp' : 'image/bmp';
        this.localFilePreviews = { ...this.localFilePreviews, [message.id]: `data:${mime};base64,${data}` };
        this.notify();
      } catch {}
    }
  }

  public requestFile(messageId: string, saveAs: boolean): Promise<string | null> {
    if (!this.roomManager) throw new Error('Room unavailable');
    if (this.imagePreviewBytes[messageId]) return this.saveCachedImage(messageId, saveAs);
    return this.roomManager.requestFile(messageId, saveAs);
  }

  public requestFilePreview(messageId: string): Promise<void> {
    if (!this.roomManager) throw new Error('Room unavailable');
    return this.roomManager.requestFilePreview(messageId);
  }

  private recordFileProgress(progress: FileProgress): void {
    const { previewBytes, ...reported } = progress;
    const previous = this.fileProgress[progress.requestId];
    const message = this.chatMessages.find((item) => item.id === progress.messageId);
    const peer = this.peers.find((item) => item.id === progress.peerId);
    let bytesPerSecond = previous?.bytesPerSecond ?? 0;
    if (progress.status === 'active') {
      const now = performance.now();
      const sample = this.transferRates.get(progress.requestId);
      if (!sample) this.transferRates.set(progress.requestId, { at: now, bytes: progress.bytes, speed: 0 });
      else if (now - sample.at >= 100 && progress.bytes >= sample.bytes) {
        const instant = (progress.bytes - sample.bytes) * 1000 / (now - sample.at);
        bytesPerSecond = sample.speed ? sample.speed * 0.65 + instant * 0.35 : instant;
        this.transferRates.set(progress.requestId, { at: now, bytes: progress.bytes, speed: bytesPerSecond });
      }
    } else if (progress.status !== 'pending') this.transferRates.delete(progress.requestId);
    const entry: FileProgress = {
      ...previous, ...reported,
      fileName: progress.fileName ?? previous?.fileName ?? message?.file?.name ?? 'Arquivo',
      peerName: progress.peerName ?? previous?.peerName ?? peer?.username ??
        (progress.direction === 'receive' ? message?.sender : undefined) ?? 'Participante',
      peerId: progress.peerId ?? previous?.peerId,
      previewOnly: progress.previewOnly ?? previous?.previewOnly,
      startedAt: previous?.startedAt ?? Date.now(),
      isImage: progress.isImage ?? previous?.isImage ?? message?.file?.isImage ?? false,
      bytesPerSecond,
      timings: progress.timings ?? previous?.timings,
    };
    this.fileProgress = { ...this.fileProgress, [entry.requestId]: entry };
    if (entry.status === 'active' && entry.peerId && this.roomManager) {
      const now = performance.now();
      const last = this.transferRouteChecks.get(entry.requestId);
      if (last === undefined || now - last >= 5000) {
        this.transferRouteChecks.set(entry.requestId, now);
        void this.roomManager.getPeerStats(entry.peerId).then((stats) => {
          const current = this.fileProgress[entry.requestId];
          if (!stats || !current || current.status !== 'active' || current.peerId !== entry.peerId) return;
          this.fileProgress = { ...this.fileProgress, [entry.requestId]: {
            ...current, connectionType: stats.connectionType, rttMs: stats.pingMs } };
          this.notify();
        });
      }
    } else if (entry.status !== 'pending') this.transferRouteChecks.delete(entry.requestId);
    if (entry.status === 'complete' && entry.previewOnly && entry.preview) {
      this.imagePreviews = { ...this.imagePreviews, [entry.messageId]: entry.preview };
      if (previewBytes) this.imagePreviewBytes[entry.messageId] = previewBytes;
    }
    if (entry.status === 'complete' && entry.direction === 'receive' && entry.saved) {
      this.savedDownloads = { ...this.savedDownloads, [entry.messageId]: entry.requestId };
    }
    this.notify();
  }

  private clearImagePreviews(): void {
    for (const preview of Object.values(this.imagePreviews)) {
      if (preview.startsWith('blob:')) URL.revokeObjectURL(preview);
    }
    this.imagePreviews = {};
    this.imagePreviewBytes = {};
  }

  public dismissFileProgress(requestId: string): void {
    if (!this.fileProgress[requestId]) return;
    const next = { ...this.fileProgress };
    delete next[requestId];
    this.fileProgress = next;
    this.notify();
  }

  private async saveCachedImage(messageId: string, saveAs: boolean): Promise<string | null> {
    const message = this.chatMessages.find((item) => item.id === messageId && !item.deletedAt);
    const bytes = this.imagePreviewBytes[messageId];
    if (!message?.file?.isImage || !bytes) throw new Error('Image preview unavailable');
    const requestId = crypto.randomUUID();
    const selected = await invoke<boolean>('choose_chat_download', { id: requestId,
      name: message.file.name, size: message.file.size, hash: message.file.sha256, saveAs });
    if (!selected) return null;
    this.localSaveIds.add(requestId);
    let written = 0;
    this.recordFileProgress({ requestId, messageId, direction: 'receive', bytes: 0,
      total: message.file.size, status: 'active', fileName: message.file.name,
      peerName: message.sender });
    try {
      if (bytes.length !== message.file.size) throw new Error('Preview size mismatch');
      for (let offset = 0; offset < bytes.length; offset += CHAT_FILE_CHUNK_BYTES) {
        if (this.cancelledLocalSaves.has(requestId)) throw new Error('Download cancelled');
        const chunk = bytes.subarray(offset, offset + CHAT_FILE_CHUNK_BYTES);
        let binary = '';
        for (const byte of chunk) binary += String.fromCharCode(byte);
        written = await invoke<number>('write_chat_download_chunk', { id: requestId,
          offset, data: btoa(binary) });
        this.recordFileProgress({ requestId, messageId, direction: 'receive', bytes: written,
          total: message.file.size, status: 'active' });
      }
      if (this.cancelledLocalSaves.has(requestId)) throw new Error('Download cancelled');
      await invoke('finish_chat_download', { id: requestId });
      this.recordFileProgress({ requestId, messageId, direction: 'receive', bytes: message.file.size,
        total: message.file.size, status: 'complete', saved: true });
      return requestId;
    } catch (error) {
      await invoke('cancel_chat_download', { id: requestId });
      const cancelled = this.cancelledLocalSaves.has(requestId);
      this.recordFileProgress({ requestId, messageId, direction: 'receive', bytes: written,
        total: message.file.size, status: cancelled ? 'cancelled' : 'error' });
      if (cancelled) return null;
      throw error;
    } finally {
      this.localSaveIds.delete(requestId);
      this.cancelledLocalSaves.delete(requestId);
    }
  }

  public async answerFileRequest(requestId: string, accept: boolean): Promise<void> {
    this.fileRequests = this.fileRequests.filter((request) => request.requestId !== requestId);
    this.notify();
    await this.roomManager?.answerFileRequest(requestId, accept);
  }

  public cancelFileTransfer(requestId: string): Promise<void> {
    if (this.localSaveIds.has(requestId)) {
      this.cancelledLocalSaves.add(requestId);
      return Promise.resolve();
    }
    return this.roomManager?.cancelFileTransfer(requestId) ?? Promise.resolve();
  }

  public async revealSavedFile(messageId: string, requestId: string): Promise<void> {
    try { await invoke('reveal_chat_download', { id: requestId }); }
    catch (error) {
      if (this.savedDownloads[messageId] === requestId) {
        const next = { ...this.savedDownloads };
        delete next[messageId];
        this.savedDownloads = next;
        this.notify();
      }
      throw error;
    }
  }

  public editChatMessage(id: string, text: string): Promise<boolean> {
    return this.roomManager?.editChatMessage(id, text) ?? Promise.resolve(false);
  }

  public deleteChatMessage(id: string): Promise<boolean> {
    return this.roomManager?.deleteChatMessage(id) ?? Promise.resolve(false);
  }

  public addSystemChatMessage(text: string, systemType: 'join' | 'leave' | 'info' | 'generic' = 'generic'): void {
    if (this.roomManager) {
      void this.roomManager.sendSystemMessage(text, systemType).catch((error) =>
        console.warn('[Chat] Failed to sign or send system notice:', error));
      return;
    }
    const msg: ChatMessage = {
      id: `sys_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      sender: 'Sistema',
      text,
      timestamp: Date.now(),
      isSystem: true,
      systemType,
    };
    this.chatMessages.push(msg);
    this.notify();
  }

  public async updateRoomPassword(newPassword: string): Promise<boolean> {
    if (!this.roomManager || !await this.roomManager.updateRoomPassword(newPassword)) return false;
    stateStore.set((s) => {
      s.currentRoomPassword = newPassword;
    });
    this.notify();
    return true;
  }

  public isRoomHost(): boolean {
    return this.roomManager?.isRoomHost() ?? false;
  }

  public getCurrentInvite(): string { return this.roomManager?.getInvite() ?? ''; }

  public updateRoomName(name: string): Promise<boolean> {
    return this.roomManager?.updateRoomName(name) ?? Promise.resolve(false);
  }

  public transferOwnership(peerId: string): Promise<boolean> {
    return this.roomManager?.transferOwnership(peerId) ?? Promise.resolve(false);
  }

  public setAdministrator(peerId: string, enabled: boolean): Promise<boolean> {
    return this.roomManager?.setAdministrator(peerId, enabled) ?? Promise.resolve(false);
  }

  public isRoomAdmin(): boolean { return this.roomManager?.isRoomAdmin() ?? false; }

  public kickPeer(peerId: string): Promise<boolean> {
    return this.roomManager?.kickPeer(peerId) ?? Promise.resolve(false);
  }

  public requestStream(peerId: string): void {
    stateStore.set((s) => {
      s.subscribedStreams.add(peerId);
    });
    if (this.roomManager) {
      this.roomManager.requestStream(peerId);
    }
    this.notify();
  }

  public stopWatchingStream(peerId: string): void {
    audioContextManager.detachPeerAudio(peerId);
    stateStore.set((s) => {
      s.subscribedStreams.delete(peerId);
    });
    if (this.roomManager) {
      this.roomManager.stopWatching(peerId);
    }
    this.notify();
  }

  public getPeerPing(peerId: string): number | null | undefined {
    return this.roomManager?.getPeerPing(peerId);
  }
}

export const roomService = RoomService.getInstance();
