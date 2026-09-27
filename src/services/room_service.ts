import { invoke } from '@tauri-apps/api/core';
import { AudioBridge } from '../audio/audio_bridge';
import { audioContextManager } from '../audio/audio_context_manager';
import { stateStore } from '../core/state_store';
import { ChatMessage, PeerInfo, RoomSlotInfo } from '../core/types';
import { generateRandomRoomSlug, GroupRoomManager } from '../p2p/group_room';
import { soundEffects } from '../ui/sound_effects';
import { NativeVideoBridge } from '../video/native_video_bridge';
import { showToast } from '../hooks/useToast';
import { telemetryService } from './telemetry_service';

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
    // Defensive fallback: dismiss overlay after 3.0s for creator or 8.0s for joiner
    this.roomConnectingTimeout = setTimeout(() => {
      this.hideConnecting();
    }, isCreator ? 3000 : 8000);

    if (this.roomManager) {
      const oldManager = this.roomManager;
      this.roomManager = null;
      try {
        await oldManager.leave();
      } catch (err) {
        console.warn('[RoomService] Error leaving previous room:', err);
      }
    }

    this.roomManager = new GroupRoomManager(
      stateStore.username || 'Usuário',
      code,
      pass,
      isCreator,
      stateStore.getTurnConfig()
    );

    this.roomManager.join({
      onStreamsUpdate: () => {
        // Handled via onSlotsUpdate to prevent double notification cascades
      },
      onSlotsUpdate: (slots: RoomSlotInfo[]) => {
        stateStore.set((s) => {
          s.roomSlots = slots;
        });
        this.hideConnecting();
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
      telemetryService.logEvent('CAPTURE', 'startCapture solicitado', {
        sourceId,
        fps,
        res,
        mouse,
      });

      const chosenSource = !sourceId ? 'screen:0' : sourceId;
      const videoStream = await this.nativeVideoBridge.startCapture(chosenSource, fps, res, mouse, 75);

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

      telemetryService.logEvent('CAPTURE', 'Transmissão de tela iniciada com sucesso');
      soundEffects.playScreenShareStart();
      this.notify();
    } catch (err: unknown) {
      const errName = err && typeof err === 'object' && 'name' in err ? (err as { name: string }).name : '';
      if (errName === 'NotAllowedError' || errName === 'AbortError') {
        telemetryService.logEvent('CAPTURE', 'Compartilhamento cancelado pelo usuário');
        showToast('Compartilhamento cancelado');
        return;
      }
      telemetryService.logEvent('CAPTURE', `Erro ao iniciar captura: ${err}`);
      console.warn('Capture error:', err);
      showToast(`Erro ao iniciar captura: ${err}`);
    }
  }

  public stopScreenSharing(): void {
    telemetryService.logEvent('CAPTURE', 'stopScreenSharing chamado: iniciando desligamento');

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

    telemetryService.logEvent('CAPTURE', 'Transmissão de tela parada e recursos liberados');
    soundEffects.playScreenShareStop();
    this.notify();
  }

  public async leaveRoom(): Promise<void> {
    telemetryService.logEvent('ROOM', 'leaveRoom executado');
    if (this.roomConnectingTimeout) {
      clearTimeout(this.roomConnectingTimeout);
      this.roomConnectingTimeout = null;
    }

    soundEffects.playUserLeave();

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
