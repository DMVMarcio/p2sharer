import { invoke } from '@tauri-apps/api/core';
import { AudioBridge } from '../audio/audio_bridge';
import { audioContextManager } from '../audio/audio_context_manager';
import { stateStore } from '../core/state_store';
import { ChatMessage, PeerInfo, RoomSlotInfo } from '../core/types';
import { generateRandomRoomSlug, GroupRoomManager } from '../p2p/group_room';
import { HudController } from '../ui/hud_controller';
import { soundEffects } from '../ui/sound_effects';
import { NativeVideoBridge } from '../video/native_video_bridge';
import { showToast } from '../hooks/useToast';

export interface ConnectingOverlayState {
  visible: boolean;
  roomCode: string;
  title: string;
  subtitle: string;
}

type Listener = () => void;

class RoomService {
  private static instance: RoomService | null = null;

  public roomManager: GroupRoomManager | null = null;
  public nativeVideoBridge = new NativeVideoBridge();
  public audioBridge = new AudioBridge();
  public hudController = new HudController();

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
      showToast(`Captura alternada para GPU Direta (${reason})`);
      if (fallbackStream) {
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
          this.hudController.updateStatsHUD();
          const videoTrack = fallbackStream.getVideoTracks()[0];
          if (videoTrack) {
            videoTrack.onended = () => this.stopScreenSharing();
          }
          this.notify();
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
    this.connectingOverlay.visible = false;
    this.notify();
  }

  public joinRoom(code: string, pass: string, isCreator: boolean): void {
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

    this.chatMessages = [
      {
        id: `sys_${Date.now()}`,
        sender: 'Sistema',
        text: `Você entrou na sala "${code}"${pass ? ' (com senha)' : ''}. Compartilhe o código para convidar amigos.`,
        timestamp: Date.now(),
      },
    ];
    this.peers = [];
    this.roomStatusText = 'Conectando à sala...';

    this.showConnecting(code, isCreator ? 'Criando sala P2P...' : 'Entrando na sala...');

    if (this.roomConnectingTimeout) {
      clearTimeout(this.roomConnectingTimeout);
    }
    // Defensive fallback: dismiss overlay after 1.2s for creator or 2.5s for joiner
    this.roomConnectingTimeout = setTimeout(() => {
      this.hideConnecting();
    }, isCreator ? 1200 : 2500);

    if (this.roomManager) {
      this.roomManager.leave();
    }

    this.roomManager = new GroupRoomManager(
      stateStore.username || 'Usuário',
      code,
      pass,
      isCreator,
      stateStore.getTurnConfig()
    );

    this.hudController.start({
      getPeerStats: (pId) => (this.roomManager ? this.roomManager.getPeerStats(pId) : Promise.resolve(null)),
      getPeerPing: (pId) => this.roomManager?.getPeerPing(pId),
      getStreamWatchers: (pId) => (this.roomManager ? this.roomManager.getStreamWatchers(pId) : []),
      getSignalingStatus: () => this.roomManager?.getSignalingStatus(),
    });

    this.roomManager.join({
      onStreamsUpdate: () => {
        this.notify();
      },
      onSlotsUpdate: (slots: RoomSlotInfo[]) => {
        stateStore.set((s) => {
          s.roomSlots = slots;
        });
        this.hudController.updateStatsHUD();
        this.hideConnecting();
        this.notify();
      },
      onChat: (msg: ChatMessage) => {
        this.chatMessages.push(msg);
        this.notify();
      },
      onChatHistory: (messages: ChatMessage[]) => {
        this.chatMessages.push(...messages);
        this.notify();
      },
      onPeersUpdate: (peers: PeerInfo[]) => {
        this.peers = peers;
        this.hideConnecting();
        this.notify();
      },
      onPeerJoined: (_peer, isInitial) => {
        if (!isInitial) soundEffects.playUserJoin();
      },
      onPeerLeft: () => soundEffects.playUserLeave(),
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
    mouse: boolean
  ): Promise<void> {
    try {
      showToast('Iniciando transmissão...');
      let videoStream: MediaStream;

      if (sourceId === 'gpu_direct') {
        videoStream = await this.nativeVideoBridge.startDisplayMediaCapture(fps, res, mouse);
      } else {
        videoStream = await this.nativeVideoBridge.startCapture(sourceId, fps, res, mouse, 75);
      }

      const audioTrack = await this.audioBridge.startCapture(
        stateStore.selectedFilterMode,
        stateStore.getActiveFilterPids(),
        stateStore.getActiveFilterNames()
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

      this.hudController.updateStatsHUD();
      soundEffects.playScreenShareStart();
      this.notify();
    } catch (err) {
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

    this.nativeVideoBridge.stop();
    this.audioBridge.stop();
    invoke('stop_audio_capture').catch(() => {});

    if (this.roomManager) {
      this.roomManager.stopStream();
    }

    this.hudController.updateStatsHUD();
    soundEffects.playScreenShareStop();
    this.notify();
  }

  public async leaveRoom(): Promise<void> {
    if (this.roomConnectingTimeout) {
      clearTimeout(this.roomConnectingTimeout);
      this.roomConnectingTimeout = null;
    }

    soundEffects.playUserLeave();
    this.hudController.stop();

    if (stateStore.isSharingScreen) {
      this.stopScreenSharing();
    }

    if (this.roomManager) {
      await this.roomManager.leave();
      this.roomManager = null;
    }

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

  public sendChatMessage(text: string): void {
    if (!text.trim() || !this.roomManager) return;
    const msg = this.roomManager.sendChatMessage(text.trim());
    this.chatMessages.push(msg);
    this.notify();
  }

  public updateRoomPassword(newPassword: string): void {
    stateStore.set((s) => {
      s.currentRoomPassword = newPassword;
    });
    if (this.roomManager) {
      this.roomManager.updateRoomPassword(newPassword);
    }
    this.notify();
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
