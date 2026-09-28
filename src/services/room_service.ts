import { invoke } from '@tauri-apps/api/core';
import { AudioBridge } from '../audio/audio_bridge.ts';
import { audioContextManager } from '../audio/audio_context_manager.ts';
import { stateStore } from '../core/state_store.ts';
import { mergeChatHistory } from '../core/chat_history.ts';
import type { ChatMessage, PeerInfo, RoomSlotInfo } from '../core/types.ts';
import { generateRandomRoomSlug, GroupRoomManager } from '../p2p/group_room.ts';
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
  public nativeVideoBridge = new NativeVideoBridge();
  public audioBridge = new AudioBridge();

  public chatMessages: ChatMessage[] = [];
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
    stateStore.set((s) => {
      s.currentRoomCode = code;
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

    this.chatMessages = [];
    this.peers = [];
    this.roomStatusText = 'Conectando à sala...';

    this.showConnecting(code, isCreator ? 'Criando sala P2P...' : 'Entrando na sala...');

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

    await manager.join({
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
        const name = peer.username.trim();
        if (!isInitial && name) {
          soundEffects.playUserJoin();
        }
      },
      onPeerLeft: (_peerId, username) => {
        if (this.roomManager !== manager) return;
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
        } else if (status.startsWith('Erro')) {
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
        this.notify();
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
      s.currentRoomPassword = '';
      s.layoutMode = 'grid';
      s.pinnedPeerId = null;
    });

    this.chatMessages = [];
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

  public updateRoomPassword(newPassword: string): boolean {
    if (!this.roomManager?.updateRoomPassword(newPassword)) return false;
    stateStore.set((s) => {
      s.currentRoomPassword = newPassword;
    });
    this.notify();
    return true;
  }

  public isRoomHost(): boolean {
    return this.roomManager?.isRoomHost() ?? false;
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
