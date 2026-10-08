import { localizeError, t } from '../i18n/index.ts';
import { reconcilePinnedRoomSlot, streamOwner, type MediaKind, type StreamDescriptor } from "../core/media_streams.ts";
import { StreamPointerReceiver } from './stream_pointer_receiver.ts';
import { generateUserColor } from '../p2p/group_room.ts';
import { validStreamPointer, validStreamPointerState, type StreamPointerState, type StreamPointerPacket } from '../core/stream_pointer.ts';
import { emitTo, listen } from '@tauri-apps/api/event';
import { streamPointerView } from './stream_pointer_view.ts';
import { invoke } from '@tauri-apps/api/core';
import { roomAppsService } from '../apps/room_apps_service.ts';
import { AudioBridge } from '../audio/audio_bridge.ts';
import { audioContextManager } from '../audio/audio_context_manager.ts';
import { stateStore } from '../core/state_store.ts';
import { shouldNotifyChat, shouldPlayChatSound } from '../core/chat_notifications.ts';
import { mergeChatHistory, nextChatOrder } from '../core/chat_history.ts';
import { CHAT_FILE_CHUNK_BYTES, MAX_IMAGE_PREVIEW_BYTES } from '../core/chat_file_limits.ts';
import { verifyRoomInvite } from '../core/room_invite_validation.ts';
import { savedRooms } from '../core/saved_rooms.ts';
import type { ChatMessage, PeerInfo, RoomSlotInfo } from '../core/types.ts';
import { generateRandomRoomSlug, GroupRoomManager, type FileProgress, type FileRequest, type NativeChatFile } from '../p2p/group_room.ts';
import { soundEffects } from '../ui/sound_effects.ts';
import { NativeVideoBridge } from '../video/native_video_bridge.ts';
import { MediaCoordinator } from '../p2p/media_coordinator.ts';
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
  public localCaptures = new Map<string, { sourceId: string; kind: MediaKind; stream: MediaStream;
    bridge?: NativeVideoBridge; fps: number; resolution: { width: number; height: number }; mouse: boolean; quality: number; bitrate: number }>();
  private captureTransition: Promise<void> = Promise.resolve();

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
  public roomStatusText: string = t("message.e56841de8c6f");
  public connectingOverlay: ConnectingOverlayState = {
    visible: false,
    roomCode: '',
    get title() { return t("message.ecec62501ea4"); },
    subtitle: t("message.4077d30835d4"),
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
    if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window && !new URLSearchParams(window.location.search).has('pip') && !new URLSearchParams(window.location.search).has('pointerOverlay')) {
      void listen<{ peerId: string; packet: StreamPointerPacket }>('stream-pointer-send', ({ payload }) => {
        if (payload && typeof payload.peerId === 'string') this.sendStreamPointer(payload.packet, payload.peerId);
      }).catch(console.warn);
      void listen<{ peerId: string }>('stream-pointer-ready', ({ payload }) => {
        if (payload && (payload.peerId === 'local' || stateStore.subscribedStreams.has(payload.peerId))) this.publishPointerView(payload.peerId, streamPointerView.state(payload.peerId));
      }).catch(console.warn);
    }
    this.nativeVideoBridge.onFallbackNeeded = (reason: string, fallbackStream?: MediaStream) => {
      if (fallbackStream) {
        showToast(t("message.fdd8098529f7", { v0: localizeError(reason) }));
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
          showToast(t("message.da9fa69dcc5d"));
        } else if (reason === 'window_not_found') {
          showToast(t("message.52272f3cb20b"));
          this.stopScreenSharing();
        } else {
          showToast(t("message.c74fa38e13bf", { v0: localizeError(reason) }));
        }
      }
    };
  }

  public showConnecting(roomCode: string, title = t("message.ecec62501ea4"), subtitle = t("message.4077d30835d4")): void {
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
    streamPointerView.clear();
    roomAppsService.reset();
    const parsed = await verifyRoomInvite(code);
    if (!parsed && typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
      throw new Error(t("message.a07036fbd08c"));
    }
    stateStore.set((s) => {
      s.currentRoomCode = parsed ? parsed.roomId.slice(0, 8) : code;
      s.currentRoomInvite = parsed ? code : '';
      s.currentRoomName = parsed && parsed.version !== 3 ? parsed.name : parsed?.roomId.slice(0, 8) ?? code;
      s.currentRoomPassword = pass;
      s.isCreator = isCreator;
      s.roomSlots = [
        {
          peerId: 'local',
          senderName: s.username || t("message.f53bbaa05fae"),
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
    stateStore.set((state) => { state.unreadChatMessages = 0; state.sidebarTab = 'chat'; });
    this.fileRequests = [];
    this.fileProgress = {};
    this.transferRates.clear();
    this.transferRouteChecks.clear();
    this.savedDownloads = {};
    this.localFilePreviews = {};
    this.peers = [];
    this.roomStatusText = t("message.93b8343c85ed");

    this.showConnecting(parsed ? parsed.roomId.slice(0, 8) : code,
      isCreator ? t("message.5cdbf83a7ecb") : t("message.ecec62501ea4"));

    if (this.roomConnectingTimeout) {
      clearTimeout(this.roomConnectingTimeout);
    }
    // Dismiss the overlay, but keep searching and describe the actual state.
    this.roomConnectingTimeout = setTimeout(() => {
      if (!isCreator && this.peers.every((peer) => peer.connectionState !== 'connected')) {
        this.roomStatusText = t("message.5ea38d33d5af");
      }
      this.hideConnecting();
      this.notify();
    }, isCreator ? 3000 : 12000);

    if (this.roomManager) {
      const oldManager = this.roomManager;
      this.stopScreenSharing();
      this.roomManager = null;
      try {
        await oldManager.leave();
      } catch (err) {
        console.warn('[RoomService] Error leaving previous room:', err);
      }
    }

    const manager = new GroupRoomManager(
      stateStore.username || t("message.f53bbaa05fae"),
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
        if (progress.status === 'error') showToast(t("message.fd2175809652"));
      },
      onStreamPointerState: (snapshot, broadcasterId) => {
        const slot = stateStore.roomSlots.find((slot) => (slot.ownerPeerId || slot.peerId) === broadcasterId && slot.pointerEligible !== false && (!snapshot.mediaId || slot.mediaId === snapshot.mediaId));
        if (this.roomManager === manager && slot && stateStore.subscribedStreams.has(slot.peerId)) this.publishPointerView(slot.peerId, snapshot);
      },
      onStreamPointer: (packet, peerId) => {
        if (this.roomManager !== manager) return;
        const peer = this.peers.find((p) => p.id === peerId);
        if (peer) this.getPointerReceiver(packet.mediaId).receive(packet, peerId, peer.username, generateUserColor(peer.username));
      },
      onAppEvent: (event, peerId) => {
        if (this.roomManager === manager) roomAppsService.receive(event, peerId);
      },
      onStreamsUpdate: () => {
        // Handled via onSlotsUpdate to prevent double notification cascades
      },
      onSlotsUpdate: (slots: RoomSlotInfo[]) => {
        if (this.roomManager !== manager) return;
        const currentKeys = new Set(slots.map((slot) => slot.peerId));
        for (const key of stateStore.subscribedStreams) if (!currentKeys.has(key)) audioContextManager.detachPeerAudio(key);
        for (const key of stateStore.activePipPeers) if (!currentKeys.has(key)) void pipService.restoreFromPip(key);
        stateStore.set((s) => {
          s.pinnedPeerId = reconcilePinnedRoomSlot(s.pinnedPeerId, s.roomSlots, slots);
          s.roomSlots = slots;
          s.localPreviewStreams = Object.fromEntries(Object.entries(s.localPreviewStreams)
            .filter(([key]) => slots.some((slot) => slot.isLocal && slot.isStreaming && slot.peerId === key)));
          s.subscribedStreams = new Set([...s.subscribedStreams].filter((key) => currentKeys.has(key)));
          s.streamOverlays = Object.fromEntries(Object.entries(s.streamOverlays).filter(([target]) => currentKeys.has(target))
            .map(([target, keys]) => [target, keys.filter((key) => currentKeys.has(key))]));
        });
        if (isCreator || slots.some((slot) => !slot.isLocal)) this.hideConnecting();
      },
      onChat: (msg: ChatMessage) => {
        if (this.roomManager !== manager) return;
        if (shouldNotifyChat(msg, this.chatMessages, manager.getLocalPeerId())) {
          if (shouldPlayChatSound(document.hasFocus() && !document.hidden, stateStore.isSidebarCollapsed, stateStore.sidebarTab)) {
            soundEffects.playMessage();
          }
          if (stateStore.isSidebarCollapsed || stateStore.sidebarTab !== 'chat') {
            stateStore.set((state) => { state.unreadChatMessages += 1; });
          }
        }
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
        this.pointerReceiver.forget(_peerId);
        for (const receiver of this.pointerReceivers.values()) receiver.forget(_peerId);
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
      onWatchStarted: () => {
        soundEffects.playWatchStreamStart();
        this.refreshStreamPointerPermissions();
      },
      onWatchStopped: (watcherPeerId, _name, broadcasterPeerId) => {
        if (broadcasterPeerId === 'local' || broadcasterPeerId === manager.getLocalPeerId()) this.pointerReceiver.forget(watcherPeerId);
        if (broadcasterPeerId === 'local' || broadcasterPeerId === manager.getLocalPeerId()) {
          for (const receiver of this.pointerReceivers.values()) receiver.forget(watcherPeerId);
        }
        soundEffects.playWatchStreamStop();
      },
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
        } else if (status.startsWith('Erro') || status.startsWith('Senha incorreta') || status === t('lan.connectFailed')) {
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
        showToast(t("message.6fef198fc542", { v0: updatedBy }));
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

  private pointerReceiver = new StreamPointerReceiver((snapshot) => {
    this.roomManager?.sendStreamPointerState(snapshot);
    const slot = stateStore.roomSlots.find((slot) => slot.isLocal && slot.pointerEligible !== false);
    this.publishPointerView(slot?.peerId || 'local', snapshot);
  });

  private pointerReceivers = new Map<string, StreamPointerReceiver>();

  private getPointerReceiver(mediaId?: string): StreamPointerReceiver {
    if (!mediaId) return this.pointerReceiver;
    let receiver = this.pointerReceivers.get(mediaId);
    if (!receiver) {
      receiver = new StreamPointerReceiver((snapshot) => {
        const state = { ...snapshot, mediaId };
        this.roomManager?.sendStreamPointerState(state);
        const slot = stateStore.roomSlots.find(slot => slot.isLocal && slot.mediaId === mediaId);
        if (slot) this.publishPointerView(slot.peerId, state);
      }, async (visuals, drawingsIncluded) => {
        const sessionId = this.localCaptures.get(mediaId)?.bridge?.sessionId;
        if (sessionId) await invoke('update_stream_pointer_overlay', { visuals, sessionId, drawingsIncluded });
      });
      this.pointerReceivers.set(mediaId, receiver);
    }
    return receiver;
  }

  public refreshStreamPointerPermissions(): void {
    this.pointerReceiver.refreshPermissions();
    for (const [id, entry] of this.localCaptures) if (entry.kind === 'screen') this.getPointerReceiver(id).refreshPermissions();
  }

  public refreshStreamPointerView(peerId: string): void {
    if (peerId !== 'local' && stateStore.subscribedStreams.has(peerId)) this.sendStreamPointer({ kind: 'sync' }, peerId);
    this.publishPointerView(peerId, streamPointerView.state(peerId));
  }

  private publishPointerView(peerId: string, snapshot: StreamPointerState): void {
    if (!validStreamPointerState(snapshot)) return;
    const identity = { localPeerId: this.roomManager?.getLocalPeerId() ?? '', name: stateStore.username, color: generateUserColor(stateStore.username) };
    streamPointerView.set(peerId, snapshot, identity);
    if (stateStore.activePipPeers.has(peerId)) {
      void emitTo(`pip-${peerId.replace(/[^a-zA-Z0-9_-]/g, '_')}`, 'stream-pointer-view', { peerId, snapshot, identity }).catch(console.warn);
    }
  }

  public sendStreamPointer(packet: StreamPointerPacket, peerId: string): void {
    const slot = stateStore.roomSlots.find((slot) => slot.peerId === peerId);
    if (validStreamPointer(packet) && slot?.pointerEligible !== false && stateStore.subscribedStreams.has(peerId)) {
      this.roomManager?.sendStreamPointer({ ...packet, mediaId: slot?.mediaId }, streamOwner(peerId));
    }
  }

  public startCapture(sourceId: string, fps: number, res: { width: number; height: number },
    mouse: boolean, quality = 90, label?: string,
    prepared?: { sourceId: string; stream: MediaStream; bridge?: NativeVideoBridge },
    bitrate = stateStore.currentBitrate): Promise<void> {
    const editingId = stateStore.editingStreamId;
    const captureStarted = performance.now();
    console.info('[RoomService] Capture transition requested', { sourceId, editingId, fps, resolution: res, bitrate,
      prepared: !!prepared, nativeSession: prepared?.bridge?.sessionId });
    const manager = this.roomManager;
    const task = this.captureTransition.then(async () => {
      if (!manager || manager !== this.roomManager) throw new Error(t("message.bf66db69d5a4"));
      if (prepared && prepared.sourceId !== sourceId) throw new Error(t("message.fd5594ea5b0a"));
      const previous = editingId ? this.localCaptures.get(editingId) : undefined;
      if (editingId && !previous) throw new Error(t("message.114345ccaf14"));
      if (!previous && this.localCaptures.size >= 16) throw new Error(t("message.00499022bcb0"));
      const kind: MediaKind = sourceId.startsWith('camera:') ? 'camera' : 'screen';
      if (previous && kind !== previous.kind) throw new Error(t("message.eae4d3abfdf0"));
      if (previous && kind === 'camera' && sourceId === previous.sourceId && !prepared) {
        await previous.stream.getVideoTracks()[0].applyConstraints({ width: { ideal: res.width }, height: { ideal: res.height },
          frameRate: { ideal: fps, max: fps } });
        manager.updateMediaSettings(editingId!, fps, bitrate);
        Object.assign(previous, { fps, bitrate, resolution: res, quality, mouse });
        this.syncCaptureState();
        console.info('[RoomService] Camera edit applied', { sourceId, mediaId: editingId, settings: previous.stream.getVideoTracks()[0].getSettings(), elapsedMs: Math.round(performance.now() - captureStarted) });
        showToast(t("message.d1943a972148"));
        return;
      }
      const id = editingId || crypto.randomUUID();
      const bridge = prepared?.bridge || (kind === 'screen' ? new NativeVideoBridge(crypto.randomUUID()) : undefined);
      let stream: MediaStream | undefined;
      try {
        if (!this.localCaptures.size) await MediaCoordinator.prepareCodecPreferences(res.width, res.height, fps, bitrate * 1000);
        stream = prepared?.stream || (bridge ? await bridge.startCapture(sourceId, fps, res, mouse, quality) :
          await navigator.mediaDevices.getUserMedia({ audio: false, video: {
            ...(sourceId.slice(7) ? { deviceId: { exact: sourceId.slice(7) } } : {}),
            width: { ideal: res.width }, height: { ideal: res.height }, frameRate: { ideal: fps, max: fps },
          } }));
        if (manager !== this.roomManager) throw new Error(t("message.bf66db69d5a4"));
        const track = stream.getVideoTracks()[0];
        if (!track || track.readyState === 'ended') throw new Error(t("message.06ca1dffe31a"));
        // Keep the capture bridge's track container separate from the broadcast container.
        // Live replacement mutates only the latter; disposing the old bridge must not stop the new track.
        if (!previous) stream = new MediaStream(stream.getTracks());
        track.contentHint = kind === 'camera' ? 'motion' : 'detail';
        const descriptor: StreamDescriptor = { id, kind, get label() { return (label || (kind === 'camera' ? t("message.dafb61aca12d") :
          sourceId.startsWith('window:') ? t("message.28014ef35252") : t("message.2d31efc9c2ed"))).slice(0, 200); }, videoTrackId: track.id, fps, bitrate };
        if (previous) {
          await manager.replaceMediaTrack(id, track, descriptor);
          this.pointerReceivers.get(id)?.clear();
          this.pointerReceivers.delete(id);
          stream = previous.stream;
          const slot = stateStore.roomSlots.find((slot) => slot.isLocal && slot.mediaId === id);
          if (slot) pipService.updateStream(slot.peerId, stream);
        } else {
          if (kind === 'screen' && !Array.from(this.localCaptures.values()).some((entry) => entry.kind === 'screen')) {
            const audio = await this.audioBridge.startCapture(stateStore.isAudioFilterFullAudio ? 'full' : stateStore.selectedFilterMode,
              stateStore.isAudioFilterFullAudio ? [] : stateStore.getActiveFilterPids(),
              stateStore.isAudioFilterFullAudio ? [] : stateStore.getActiveFilterNames());
            if (audio) stream.addTrack(audio);
          }
          manager.shareStream(stream, bitrate * 1000, fps, descriptor);
        }
        const capture = { sourceId, kind, stream, bridge, fps, resolution: res, mouse, quality, bitrate };
        this.localCaptures.set(id, capture);
        track.onended = () => { if (this.localCaptures.get(id) === capture) this.stopTransmission(id); };
        if (bridge) bridge.onFallbackNeeded = () => {
          if (this.localCaptures.get(id) === capture) { showToast(t("message.e018f7492e19")); this.stopTransmission(id); }
        };
        if (previous?.bridge) await previous.bridge.stopCapture();
        if (previous && !previous.bridge) previous.stream.getVideoTracks().filter((item) => item !== track).forEach((item) => item.stop());
        this.syncCaptureState();
        console.info('[RoomService] Capture published', { sourceId, mediaId: id, kind,
          nativeSession: bridge?.sessionId, settings: track.getSettings(), elapsedMs: Math.round(performance.now() - captureStarted) });
        showToast(previous ? t("message.d1943a972148") : t("message.3c3d7ea79d61"));
      } catch (error) {
        if (bridge) await bridge.stopCapture();
        else if (stream && stream !== previous?.stream) stream.getTracks().forEach((track) => track.stop());
        showToast(t("message.5a1156df731c", { v0: localizeError(error) }));
        throw error;
      }
    });
    this.captureTransition = task.catch(async (error) => {
      console.error('[RoomService] Capture transition failed', { sourceId, editingId, fps, resolution: res, bitrate,
        nativeSession: prepared?.bridge?.sessionId, elapsedMs: Math.round(performance.now() - captureStarted), error });
      if (prepared?.bridge) await prepared.bridge.stopCapture();
      else prepared?.stream.getTracks().forEach((track) => track.stop());
    });
    return task;
  }

  private syncCaptureState() {
    stateStore.set((state) => { state.isSharingScreen = Array.from(this.localCaptures.values()).some((entry) => entry.kind === 'screen'); });
    const screen = Array.from(this.localCaptures.values()).find((entry) => entry.kind === 'screen');
    void invoke('select_pointer_capture', { sessionId: screen?.bridge?.sessionId || null }).catch(console.warn);
    this.notify();
  }

  public stopTransmission(id: string, notifyManager = true) {
    const entry = this.localCaptures.get(id);
    if (!entry) return;
    this.pointerReceivers.get(id)?.clear();
    this.pointerReceivers.delete(id);
    this.localCaptures.delete(id);
    if (notifyManager) this.roomManager?.stopStream(id);
    if (entry.bridge) void entry.bridge.stopCapture();
    else entry.stream.getTracks().forEach((track) => track.stop());
    if (!Array.from(this.localCaptures.values()).some((capture) => capture.kind === 'screen')) {
      this.audioBridge.stop();
      this.pointerReceiver.clear();
    }
    this.syncCaptureState();
  }

  public stopScreenSharing(): void {
    this.roomManager?.stopStream();
    for (const id of [...this.localCaptures.keys()]) this.stopTransmission(id, false);
    this.pointerReceiver.clear();
    this.audioBridge.stop();
    this.syncCaptureState();
  }

  public editTransmission(id: string) {
    stateStore.set((state) => { state.editingStreamId = id; });
  }

  public overlayStream(key: string) {
    const target = stateStore.pinnedPeerId || stateStore.roomSlots[0]?.peerId;
    if (stateStore.layoutMode !== 'spotlight' || !target || target === key) return;
    if (!stateStore.roomSlots.find((slot) => slot.peerId === target)?.isStreaming) return;
    if (!stateStore.roomSlots.find((slot) => slot.peerId === key)?.isLocal) this.requestStream(key);
    stateStore.set((state) => { state.streamOverlays = { ...state.streamOverlays,
      [target]: [...new Set([...(state.streamOverlays[target] || []), key])] }; });
  }

  public removeOverlay(target: string, key: string) {
    stateStore.set((state) => {
      state.streamOverlays = { ...state.streamOverlays, [target]: (state.streamOverlays[target] || []).filter((id) => id !== key) };
      state.dismissedAutoOverlays = { ...state.dismissedAutoOverlays, [target]: [...new Set([...(state.dismissedAutoOverlays[target] || []), key])] };
    });
  }

  public async leaveRoom(): Promise<void> {
    const transition = this.roomTransition.then(() => this.leaveRoomNow());
    this.roomTransition = transition.catch((err) => {
      console.error('[RoomService] Room exit failed:', err);
    });
    return transition;
  }

  private async leaveRoomNow(): Promise<void> {
    this.pointerReceiver.clear();
    streamPointerView.clear();
    roomAppsService.reset();
    if (this.roomConnectingTimeout) {
      clearTimeout(this.roomConnectingTimeout);
      this.roomConnectingTimeout = null;
    }

    soundEffects.playUserLeave();

    this.stopScreenSharing();

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
      s.streamOverlays = {};
      s.dismissedAutoOverlays = {};
      s.overlayPositions = {};
      s.editingStreamId = null;
      s.roomSlots = [];
      s.localPreviewStreams = {};
      s.currentRoomCode = generateRandomRoomSlug();
      s.currentRoomInvite = '';
      s.currentRoomName = '';
      s.currentRoomPassword = '';
      s.layoutMode = 'grid';
      s.pinnedPeerId = null;
    });

    this.chatMessages = [];
    stateStore.set((state) => { state.unreadChatMessages = 0; state.sidebarTab = 'chat'; });
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
    showToast(t("message.b520e8324025"));
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

  public async requestFile(messageId: string, saveAs: boolean): Promise<string | null> {
    if (!this.roomManager) throw new Error('Room unavailable');
    if (this.imagePreviewBytes[messageId]) return this.saveLocalImage(messageId, saveAs);
    const source = await this.roomManager.getOwnImageSource(messageId);
    if (source) return this.saveLocalImage(messageId, saveAs, source);
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
      fileName: progress.fileName ?? previous?.fileName ?? message?.file?.name ?? t("message.ba8a452f2f83"),
      peerName: progress.peerName ?? previous?.peerName ?? peer?.username ??
        (progress.direction === 'receive' ? message?.sender : undefined) ?? t("message.1e97ddf60a0f"),
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
        void this.roomManager.getFileTransportDiagnostics(entry.peerId).then((stats) => {
          const current = this.fileProgress[entry.requestId];
          if (!stats || !current || current.status !== 'active' || current.peerId !== entry.peerId) return;
          const previous = current.transport;
          const transport = { ...stats.transport };
          const currentBytes = current.direction === 'send' ? transport.pairBytesSent : transport.pairBytesReceived;
          const previousBytes = current.direction === 'send' ? previous?.pairBytesSent : previous?.pairBytesReceived;
          const elapsedMs = transport.pairTimestamp !== undefined && previous?.pairTimestamp !== undefined ?
            transport.pairTimestamp - previous.pairTimestamp : 0;
          if (currentBytes !== undefined && previousBytes !== undefined && currentBytes >= previousBytes && elapsedMs > 0) {
            transport.pairBytesPerSecond = (currentBytes - previousBytes) * 1000 / elapsedMs;
          }
          this.fileProgress = { ...this.fileProgress, [entry.requestId]: {
            ...current, connectionType: stats.connectionType, rttMs: stats.rttMs, transport } };
          this.notify();
        });
      }
    } else if (entry.status !== 'pending') this.transferRouteChecks.delete(entry.requestId);
    if (entry.status === 'complete' && entry.preview) {
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

  private async saveLocalImage(messageId: string, saveAs: boolean, source?: NativeChatFile): Promise<string | null> {
    const message = this.chatMessages.find((item) => item.id === messageId && !item.deletedAt);
    const bytes = this.imagePreviewBytes[messageId];
    if (!message?.file?.isImage || (!bytes && !source)) throw new Error('Image source unavailable');
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
      if (!source && bytes.length !== message.file.size) throw new Error('Preview size mismatch');
      for (let offset = 0; offset < message.file.size; offset += CHAT_FILE_CHUNK_BYTES) {
        if (this.cancelledLocalSaves.has(requestId)) throw new Error('Download cancelled');
        let data: string;
        if (source) data = await invoke<string>('read_chat_file_chunk', { id: source.id,
          offset, length: Math.min(CHAT_FILE_CHUNK_BYTES, message.file.size - offset) });
        else {
          const chunk = bytes.subarray(offset, offset + CHAT_FILE_CHUNK_BYTES);
          let binary = '';
          for (const byte of chunk) binary += String.fromCharCode(byte);
          data = btoa(binary);
        }
        if (this.cancelledLocalSaves.has(requestId)) throw new Error('Download cancelled');
        written = await invoke<number>('write_chat_download_chunk', { id: requestId,
          offset, data });
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
      logicalOrder: nextChatOrder(this.chatMessages),
      sender: t("message.f150afd3c599"),
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
    this.publishPointerView(peerId, { kind: 'state', sentAt: Date.now(), visuals: [] });
    audioContextManager.detachPeerAudio(peerId);
    stateStore.set((s) => {
      s.subscribedStreams.delete(peerId);
      for (const target of Object.keys(s.streamOverlays)) s.streamOverlays[target] = s.streamOverlays[target].filter((key) => key !== peerId);
      for (const slot of s.roomSlots) if (slot.mediaKind === 'screen') {
        s.dismissedAutoOverlays[slot.peerId] = [...new Set([...(s.dismissedAutoOverlays[slot.peerId] || []), peerId])];
      }
    });
    if (this.roomManager) {
      this.roomManager.stopWatching(peerId);
    }
    this.notify();
  }

  public getPeerPing(peerId: string): number | null | undefined {
    return this.roomManager?.getPeerPing(streamOwner(peerId));
  }
}

export const roomService = RoomService.getInstance();
