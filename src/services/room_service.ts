import { isMobileDevice } from '../core/platform.ts';
import { logDiagnostic } from '../core/logger.ts';
import { localizeError, t } from '../i18n/index.ts';
import { reconcilePinnedRoomSlot, streamOwner, streamSlotKey, type MediaKind, type StreamDescriptor } from "../core/media_streams.ts";
import { StreamPointerReceiver } from './stream_pointer_receiver.ts';
import { generateUserColor } from '../p2p/group_room.ts';
import { validStreamPointer, validStreamPointerState, type StreamPointerState, type StreamPointerPacket } from '../core/stream_pointer.ts';
import { RemoteControlHostManager } from './remote_control_receiver.ts';
import { profileImages } from '../core/profile_image.ts';
import {
  RemoteControlActivityTracker,
  type ControllerInputActivity,
  type GamepadInputActivity,
  type RemoteControllerOverlayItem,
} from '../core/remote_control_activity.ts';
import {
  loadRemoteControlHostDefaults,
  normalizeCursorShape,
  saveRemoteControlHostDefaults,
  type RemoteControlHostPacket,
  type RemoteControlRequest,
  type RemoteControlViewerState,
  type RemoteControllerInfo,
  type RemoteCursorImageAsset,
  type RemoteCursorSyncState,
  type RemoteInputEvent,
  type VirtualGamepadSlot,
} from '../core/remote_control.ts';
import { emitTo, listen } from '@tauri-apps/api/event';
import { streamPointerView } from './stream_pointer_view.ts';
import { invoke } from '../platform/commands.ts';
import { isTauri } from '@tauri-apps/api/core';
import { roomAppsService } from '../apps/room_apps_service.ts';
import { AudioBridge } from '../audio/audio_bridge.ts';
import { audioContextManager } from '../audio/audio_context_manager.ts';
import { voiceManager } from '../audio/voice_manager.ts';
import type { UserVoiceVolumePreference, VoicePeerState, VoicePreferences } from '../core/voice_preferences.ts';
import { stateStore } from '../core/state_store.ts';
import { shouldNotifyChat, shouldPlayChatSound } from '../core/chat_notifications.ts';
import { mergeChatHistory, nextChatOrder } from '../core/chat_history.ts';
import { CHAT_FILE_CHUNK_BYTES, MAX_IMAGE_PREVIEW_BYTES } from '../core/chat_file_limits.ts';
import { compareRoomInvites, parseRoomInvite } from '../core/room_invite.ts';
import { verifyRoomInvite } from '../core/room_invite_validation.ts';
import { savedRooms } from '../core/saved_rooms.ts';
import type { ChatMessage, PeerInfo, RoomSlotInfo } from '../core/types.ts';
import { generateRandomRoomSlug, GroupRoomManager, type RoomCallbacks, type FileProgress, type FileRequest, type NativeChatFile } from '../p2p/group_room.ts';
import { soundEffects } from '../ui/sound_effects.ts';
import { NativeVideoBridge } from '../video/native_video_bridge.ts';
import { MediaCoordinator } from '../p2p/media_coordinator.ts';
import { showToast } from '../hooks/useToast.ts';
import { modalManager } from '../hooks/useModal.ts';
import { profileStats } from '../core/profile_stats.ts';
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
  private roomPreview: GroupRoomManager | null = null;
  public pendingJoinInvite = '';
  public pendingJoinAsOwner = false;
  public pendingJoinPassword = '';
  public pendingJoinError = '';
  public joinDialogRevision = 0;
  public joinOutcome: 'idle' | 'connecting' | 'waiting' | 'admitted' | 'error' = 'idle';
  public joinError = '';
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
  public inVoice = false;
  public voiceMicMuted = false;
  public voiceDeafened = false;
  public isLocalSpeaking = false;
  public voiceInputLevelDb = -100;
  public voiceThresholdDb = -50;
  public voiceMicTestActive = false;
  public voiceTestGateOpen = false;
  public voicePreferences: VoicePreferences = voiceManager.getPreferences();
  public voicePeers: Record<string, VoicePeerState> = {};
  private remoteVoiceStates: Record<string, { inVoice: boolean; muted: boolean; deafened: boolean }> = {};
  private voiceJoinPromise: Promise<void> | null = null;
  public remoteControlRequests: RemoteControlRequest[] = [];
  public remoteControlElevationRequests: RemoteControlRequest[] = [];
  public remoteControllers: RemoteControllerInfo[] = [];
  public remoteControlHostBusy = false;
  public remoteControlHostPriorityEnabled = loadRemoteControlHostDefaults().hostPriorityEnabled;
  public remoteControlElevationBlocked = false;
  public remoteControlElevationReady = false;
  public remoteControlGamepadDriverAvailable = true;
  public remoteControlGamepadDriverInstallStage: 'idle' | 'downloading' | 'verifying' | 'installing' = 'idle';
  public remoteControlGamepadDriverNeedsReboot = false;
  public remoteControlVirtualGamepads: VirtualGamepadSlot[] = [];
  public remoteControlViewerStates: Record<string, RemoteControlViewerState> = {};
  public remoteCursorStates: Record<string, RemoteCursorSyncState> = {};
  public remoteCursorImages: Record<string, RemoteCursorImageAsset> = {};
  private hostCapturedCursorImages = new Map<
    string,
    { imageId: string; width: number; height: number; hotX: number; hotY: number; pngBase64: string }
  >();
  private peerSeenCursorImageIds = new Map<string, Set<string>>();
  public readonly remoteControlActivity = new RemoteControlActivityTracker();
  public roomStatusText: string = t("message.e56841de8c6f");
  public connectingOverlay: ConnectingOverlayState = {
    visible: false,
    roomCode: '',
    get title() { return t("message.ecec62501ea4"); },
    subtitle: t("message.4077d30835d4"),
  };

  private listeners: Set<Listener> = new Set();
  private beforeRoomJoinHooks = new Set<() => Promise<void>>();
  private roomConnectingTimeout: ReturnType<typeof setTimeout> | null = null;
  private roomTransition: Promise<void> = Promise.resolve();
  private remoteControlMoveQueues = new Map<
    string,
    {
      inFlight: boolean;
      pending: { sessionId: string | null; event: RemoteInputEvent } | null;
      promise?: Promise<{ accepted: boolean; hostBusy: boolean; elevationBlocked?: boolean }>;
    }
  >();

  public static getInstance(): RoomService {
    if (!RoomService.instance) {
      RoomService.instance = new RoomService();
    }
    return RoomService.instance;
  }

  constructor() {
    this.initFallbackHandler();
    this.syncVoiceSnapshot();
    voiceManager.subscribe(() => {
      this.syncVoiceSnapshot();
      this.notify();
    });
  }

  private syncVoiceSnapshot(): void {
    const snap = voiceManager.getSnapshot();
    this.inVoice = snap.inVoice;
    this.voiceMicMuted = snap.micMuted;
    this.voiceDeafened = snap.deafened;
    this.isLocalSpeaking = snap.isLocalSpeaking;
    this.voiceInputLevelDb = snap.inputLevelDb;
    this.voiceThresholdDb = snap.effectiveThresholdDb;
    this.voiceMicTestActive = snap.micTestActive;
    this.voiceTestGateOpen = snap.isTestGateOpen;
    this.voicePreferences = snap.preferences;
    const nextPeers: Record<string, VoicePeerState> = {};
    for (const [peerId, state] of Object.entries(this.remoteVoiceStates)) {
      nextPeers[peerId] = {
        peerId,
        inVoice: state.inVoice,
        muted: state.muted,
        deafened: state.deafened,
        speaking: Boolean(state.inVoice && !state.muted && !state.deafened && snap.remoteSpeaking[peerId]),
      };
    }
    this.voicePeers = nextPeers;
  }

  public subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public registerBeforeRoomJoin(hook: () => Promise<void>): () => void {
    this.beforeRoomJoinHooks.add(hook);
    return () => {
      this.beforeRoomJoinHooks.delete(hook);
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
      void listen<{
        hostBusy?: boolean;
        cursorShape?: string;
        elevationBlocked?: boolean;
        hostPriorityEnabled?: boolean;
      }>('remote-control-host-priority', ({ payload }) => {
        if (!payload) return;
        let dirty = false;
        if (typeof payload.hostPriorityEnabled === 'boolean' && payload.hostPriorityEnabled !== this.remoteControlHostPriorityEnabled) {
          this.remoteControlHostPriorityEnabled = payload.hostPriorityEnabled;
          dirty = true;
        }
        const elevBlocked = Boolean(payload.elevationBlocked);
        if (elevBlocked !== this.remoteControlElevationBlocked) {
          this.remoteControlElevationBlocked = elevBlocked;
          dirty = true;
        }
        this.remoteControlHost.setHostPriorityState(
          Boolean(payload.hostBusy),
          normalizeCursorShape(payload.cursorShape),
          elevBlocked,
        );
        if (dirty) this.notify();
      }).catch(console.warn);
      void listen<{ driverAvailable?: boolean; gamepads?: VirtualGamepadSlot[] }>(
        'remote-control-gamepads-changed',
        ({ payload }) => {
          if (!payload) return;
          this.remoteControlGamepadDriverAvailable = Boolean(payload.driverAvailable);
          if (this.remoteControlGamepadDriverAvailable) {
            this.remoteControlGamepadDriverNeedsReboot = false;
          }
          this.remoteControlVirtualGamepads = Array.isArray(payload.gamepads) ? payload.gamepads : [];
          this.notify();
        },
      ).catch(console.warn);
      void listen<{ stage?: string }>(
        'remote-control-gamepad-driver-install',
        ({ payload }) => {
          const stage = payload?.stage;
          if (
            stage === 'idle' ||
            stage === 'downloading' ||
            stage === 'verifying' ||
            stage === 'installing'
          ) {
            if (this.remoteControlGamepadDriverInstallStage !== stage) {
              this.remoteControlGamepadDriverInstallStage = stage;
              this.notify();
            }
          }
        },
      ).catch(console.warn);
      void listen('remote-control-gamepad-driver-needed', () => {
        if (!this.remoteControlGamepadDriverAvailable && this.remoteControlGamepadDriverInstallStage === 'idle') {
          showToast(t('remoteControl.vigemNeededToast'), 9000, 'warning', {
            dedupeKey: 'vigem-driver-needed',
            action: {
              label: t('remoteControl.vigemInstallAction'),
              onAction: () => {
                void this.installRemoteControlGamepadDriver();
              },
            },
          });
        }
      }).catch(console.warn);
      void invoke<{ driverAvailable: boolean; gamepads: VirtualGamepadSlot[] }>('get_remote_control_gamepads')
        .then((snap) => {
          if (!snap) return;
          this.remoteControlGamepadDriverAvailable = Boolean(snap.driverAvailable);
          this.remoteControlVirtualGamepads = Array.isArray(snap.gamepads) ? snap.gamepads : [];
          this.notify();
        })
        .catch(() => {});
      void invoke('set_remote_control_host_priority_enabled', {
        enabled: this.remoteControlHostPriorityEnabled,
      }).catch(() => {});
      void listen<{
        imageId?: string;
        width?: number;
        height?: number;
        hotX?: number;
        hotY?: number;
        pngBase64?: string;
      }>('remote-control-cursor-image', ({ payload }) => {
        if (
          !payload ||
          typeof payload.imageId !== 'string' ||
          !payload.imageId ||
          typeof payload.pngBase64 !== 'string' ||
          !payload.pngBase64 ||
          typeof payload.width !== 'number' ||
          typeof payload.height !== 'number'
        ) {
          return;
        }
        if (this.hostCapturedCursorImages.size >= 128 && !this.hostCapturedCursorImages.has(payload.imageId)) {
          const oldest = this.hostCapturedCursorImages.keys().next().value;
          if (oldest) this.hostCapturedCursorImages.delete(oldest);
        }
        const entry = {
          imageId: payload.imageId,
          width: payload.width,
          height: payload.height,
          hotX: typeof payload.hotX === 'number' ? payload.hotX : 0,
          hotY: typeof payload.hotY === 'number' ? payload.hotY : 0,
          pngBase64: payload.pngBase64,
        };
        this.hostCapturedCursorImages.set(payload.imageId, entry);
        this.sendCursorImageToUnseenWatchers(payload.imageId);
      }).catch(console.warn);
      void listen<{
        sessionId?: string;
        active?: boolean;
        visible?: boolean;
        x?: number;
        y?: number;
        cursorShape?: string;
        imageId?: string;
        mouseLocked?: boolean;
        hostBusy?: boolean;
        elevationBlocked?: boolean;
        actorControllerId?: string;
        embeddedInVideo?: boolean;
      }>('remote-control-cursor-sync', ({ payload }) => {
        if (!payload || !this.roomManager) return;
        const active = Boolean(payload.active);
        const rawActor = typeof payload.actorControllerId === 'string' ? payload.actorControllerId : '';
        const shape = normalizeCursorShape(payload.cursorShape);
        const imageId = typeof payload.imageId === 'string' ? payload.imageId : '';
        const mouseLocked = Boolean(payload.mouseLocked);
        if (active && imageId) {
          this.sendCursorImageToUnseenWatchers(imageId);
        }
        for (const [mediaId, capture] of this.localCaptures) {
          if (capture.kind !== 'screen') continue;
          if (active && payload.sessionId && capture.bridge?.sessionId !== payload.sessionId) continue;
          let actorPeerId = rawActor;
          if (!rawActor || rawActor === 'host') {
            actorPeerId = 'host';
          } else if (rawActor.endsWith(`:${mediaId}`)) {
            actorPeerId = rawActor.slice(0, -(mediaId.length + 1));
          } else {
            const sep = rawActor.lastIndexOf(':');
            actorPeerId = sep > 0 ? rawActor.slice(0, sep) : rawActor;
          }
          this.roomManager.broadcastRemoteControlCursorSync({
            type: 'cursorSync',
            mediaId,
            active,
            visible: Boolean(payload.visible),
            x: typeof payload.x === 'number' && Number.isFinite(payload.x) ? Math.max(0, Math.min(1, payload.x)) : 0,
            y: typeof payload.y === 'number' && Number.isFinite(payload.y) ? Math.max(0, Math.min(1, payload.y)) : 0,
            cursorShape: shape,
            imageId,
            mouseLocked,
            hostBusy: Boolean(payload.hostBusy),
            elevationBlocked: Boolean(payload.elevationBlocked),
            actorPeerId: actorPeerId.slice(0, 96),
            embeddedInVideo: Boolean(payload.embeddedInVideo),
          });
        }
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

  public async joinRoom(code: string, pass: string, isCreator: boolean,
    options: { waitForAdmission?: boolean; preview?: GroupRoomManager; signal?: AbortSignal; saveOnJoin?: boolean } = {}): Promise<void> {
    const transition = this.roomTransition.then(() => options.signal?.aborted ? undefined :
      this.joinRoomNow(code, pass, isCreator, options.waitForAdmission !== false, options.preview, options.signal, options.saveOnJoin === true));
    this.roomTransition = transition.catch((err) => {
      console.error('[RoomService] Room transition failed:', err);
    });
    return transition;
  }

  public hasActiveRoomPreview(): boolean {
    return Boolean(this.roomPreview);
  }

  public startRoomPreview(manager: GroupRoomManager, callbacks: RoomCallbacks, signal: AbortSignal): Promise<void> {
    const transition = this.roomTransition.then(async () => {
      if (signal.aborted) return;
      await Promise.allSettled([...this.beforeRoomJoinHooks].map((hook) => hook()));
      if (signal.aborted) return;
      if (this.roomPreview) await this.roomPreview.leave();
      if (signal.aborted) return;
      this.roomPreview = manager;
      await manager.join(callbacks, true);
    });
    this.roomTransition = transition.catch(error => console.warn('[Rooms] Discovery failed:', error));
    return transition;
  }

  public stopRoomPreview(manager: GroupRoomManager): Promise<void> {
    const transition = this.roomTransition.then(async () => {
      await manager.leave();
      if (this.roomPreview === manager) this.roomPreview = null;
    });
    this.roomTransition = transition.catch(error => console.warn('[Rooms] Discovery cleanup failed:', error));
    return transition;
  }

  private async joinRoomNow(code: string, pass: string, isCreator: boolean, waitForAdmission: boolean,
    preview?: GroupRoomManager, signal?: AbortSignal, saveOnJoin = false): Promise<void> {
    await Promise.allSettled([...this.beforeRoomJoinHooks].map((hook) => hook()));
    if (signal?.aborted) return;
    this.joinOutcome = 'connecting';
    this.joinError = '';
    this.remoteControlHost.clear();
    this.remoteControlViewerStates = {};
    this.remoteCursorStates = {};
    this.remoteCursorImages = {};
    this.hostCapturedCursorImages.clear();
    this.peerSeenCursorImageIds.clear();
    streamPointerView.clear();
    roomAppsService.reset();
    const parsed = await verifyRoomInvite(code);
    if (signal?.aborted) return;
    if (!parsed) {
      throw new Error(t("message.a07036fbd08c"));
    }
    if (!isTauri() && 'connection' in parsed && parsed.connection) throw new Error(t('web.desktopOnly'));
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
    stateStore.set((state) => {
      state.unreadChatMessages = 0;
      state.sidebarTab = 'chat';
      if (isMobileDevice()) {
        state.isSidebarCollapsed = true;
      }
    });
    this.fileRequests = [];
    this.fileProgress = {};
    this.transferRates.clear();
    this.transferRouteChecks.clear();
    this.savedDownloads = {};
    this.localFilePreviews = {};
    this.peers = [];
    stateStore.set(s => { s.peerNicknameStyles = {}; });
    this.roomStatusText = t("message.93b8343c85ed");

    this.showConnecting(parsed ? parsed.roomId.slice(0, 8) : code,
      isCreator ? t("message.5cdbf83a7ecb") : t("message.ecec62501ea4"));

    if (this.roomConnectingTimeout) {
      clearTimeout(this.roomConnectingTimeout);
    }
    // Dismiss the overlay, but keep searching and describe the actual state.
    this.roomConnectingTimeout = setTimeout(() => {
      if (!isCreator && this.joinOutcome === 'connecting') {
        if (this.roomManager && !this.roomManager.hasAdmission() && !this.roomManager.isAdmissionDenied?.()) {
          this.joinOutcome = 'waiting';
          this.roomStatusText = t('join.waiting');
        } else {
          this.roomStatusText = t("message.5ea38d33d5af");
          this.joinOutcome = 'error';
          this.joinError = t('join.timeout');
        }
      }
      this.hideConnecting();
      this.notify();
    }, isCreator ? 3000 : 12000);

    const reusable = preview && this.roomPreview === preview ? preview :
      this.roomManager?.canResumeRoom(code) ? this.roomManager : undefined;
    if (this.roomManager && this.roomManager !== reusable) {
      profileStats.setInCall(false);
      const oldManager = this.roomManager;
      this.stopScreenSharing();
      this.roomManager = null;
      try {
        await oldManager.leave();
      } catch (err) {
        console.warn('[RoomService] Error leaving previous room:', err);
      }
    }

    const manager = reusable ?? new GroupRoomManager(
      stateStore.username || t("message.f53bbaa05fae"),
      code,
      pass,
      isCreator,
      stateStore.getTurnConfig()
    );
    if (this.roomPreview === manager) this.roomPreview = null;
    if (signal?.aborted) { await manager.leave(); return; }
    this.roomManager = manager;
    voiceManager.enterRoomMuted();
    manager.setLocalVoiceState({ inVoice: true, muted: true, deafened: false }, null);
    this.syncVoiceSnapshot();
    roomAppsService.attach((event, target) => manager.sendAppEvent(event, target), manager.getLocalPeerId(),
      (action, instance) => {
        void manager.sendAppLifecycleNotice(action, instance.kind).catch((error) =>
          console.warn('[Chat] Failed to publish app notice:', error));
      }, action => {
        if (action === 'start') soundEffects.playAppStart();
        else soundEffects.playAppStop();
      }, () => manager.getRtcConfiguration(), actor => manager.canManageRoomApps(actor));

    const abort = () => { this.hideConnecting(); void manager.leave(); };
    signal?.addEventListener('abort', abort, { once: true });
    let pendingSaveOnAdmit = saveOnJoin;
    const persistSavedOnAdmission = () => {
      if (!pendingSaveOnAdmit || this.roomManager !== manager || !manager.hasAdmission()) return;
      pendingSaveOnAdmit = false;
      const currentInvite = manager.getInvite() || stateStore.currentRoomInvite || code;
      const currentParsed = parseRoomInvite(currentInvite) ?? parsed;
      void (async () => {
        const existing = await savedRooms.get(currentParsed.roomId);
        const existingInvite = existing ? parseRoomInvite(existing.invite) : null;
        if (existingInvite && existingInvite.rootKey !== currentParsed.rootKey) return;
        const versionOrder = existingInvite ? compareRoomInvites(currentParsed, existingInvite) : 1;
        const retainExistingInvite = versionOrder <= 0;
        const resolvedInviteText = retainExistingInvite ? existing!.invite : currentInvite;
        const resolvedParsed = parseRoomInvite(resolvedInviteText) ?? currentParsed;
        await savedRooms.put({
          ...existing,
          roomId: currentParsed.roomId,
          invite: resolvedInviteText,
          name: resolvedParsed.version !== 3 ? resolvedParsed.name : existing?.name ?? currentParsed.roomId.slice(0, 8),
          customName: existing?.customName,
          saved: true,
          owned: isCreator || Boolean(existing?.owned),
          protected: Boolean(pass || existing?.protected),
          password: pass || existing?.password,
        });
      })().catch((error) => console.warn('[Rooms] Failed to save room on entry:', error));
    };
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
        if (progress.status === 'error') showToast(t("message.fd2175809652"), 3500, 'error');
      },
      onSenderConsumerChange: (mediaId: string, consumerId: string, active: boolean) => {
        if (this.roomManager === manager) this.setCaptureConsumer(mediaId, consumerId, active);
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
      onRemoteControlClient: (packet, peerId) => {
        if (this.roomManager !== manager) return;
        this.remoteControlHost.receiveClientPacket(packet, peerId);
      },
      onRemoteControlHost: (packet, broadcasterId) => {
        if (this.roomManager !== manager) return;
        this.handleRemoteControlHostPacket(packet, broadcasterId);
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
        let viewerStatePruned = false;
        const nextViewerStates = { ...this.remoteControlViewerStates };
        for (const key of Object.keys(nextViewerStates)) {
          const matching = slots.find((slot) => slot.peerId === key);
          if (!matching || matching.pointerEligible === false || !matching.isStreaming) {
            delete nextViewerStates[key];
            viewerStatePruned = true;
          }
        }
        if (viewerStatePruned) this.remoteControlViewerStates = nextViewerStates;
        stateStore.set((s) => {
          s.pinnedPeerId = reconcilePinnedRoomSlot(s.pinnedPeerId, s.roomSlots, slots);
          s.roomSlots = slots;
          s.localPreviewStreams = Object.fromEntries(Object.entries(s.localPreviewStreams)
            .filter(([key]) => slots.some((slot) => slot.isLocal && slot.isStreaming && slot.peerId === key)));
          s.subscribedStreams = new Set([...s.subscribedStreams].filter((key) => currentKeys.has(key)));
          s.streamOverlays = Object.fromEntries(Object.entries(s.streamOverlays).filter(([target]) => currentKeys.has(target))
            .map(([target, keys]) => [target, keys.filter((key) => currentKeys.has(key))]));
        });
        if (manager.hasAdmission() && (isCreator || slots.some((slot) => !slot.isLocal))) this.hideConnecting();
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
        profileStats.setInCall(manager.hasAdmission());
        this.peers = peers;
        for (const peer of peers) {
          if (peer.publicKey) {
            voiceManager.refreshRemotePeerIdentity(peer.id, peer.publicKey, peer.username);
          }
        }
        stateStore.set(s => { s.peerNicknameStyles = Object.fromEntries(peers.filter(peer => peer.nicknameStyle).map(peer => [peer.id, peer.nicknameStyle!])); });
        if (manager.hasAdmission()) {
          persistSavedOnAdmission();
          if (isCreator || peers.some((peer) => peer.connectionState === 'connected')) this.hideConnecting();
        }
        this.notify();
      },
      onVoiceStateUpdate: (states) => {
        if (this.roomManager !== manager) return;
        this.remoteVoiceStates = states;
        this.syncVoiceSnapshot();
        this.notify();
      },
      onRemoteVoiceStream: (peerId, stream) => {
        if (this.roomManager !== manager) return;
        if (!stream || !voiceManager.inVoice) {
          voiceManager.detachRemoteVoice(peerId);
          return;
        }
        const peer = this.peers.find((p) => p.id === peerId);
        voiceManager.attachRemoteVoice(peerId, stream, peer?.publicKey, peer?.username);
      },
      onPeerJoined: (peer, isInitial) => {
        if (this.roomManager !== manager) return;
        roomAppsService.sendSync(peer.id);
        roomAppsService.requestSync(peer.id);
        const name = peer.username.trim();
        if (!isInitial && name) {
          soundEffects.playUserJoin();
        }
      },
      onPeerLeft: (_peerId, username) => {
        if (this.roomManager !== manager) return;
        voiceManager.detachRemoteVoice(_peerId);
        if (this.remoteVoiceStates[_peerId]) {
          const next = { ...this.remoteVoiceStates };
          delete next[_peerId];
          this.remoteVoiceStates = next;
          this.syncVoiceSnapshot();
        }
        this.fileRequests = this.fileRequests.filter((request) => request.peerId !== _peerId);
        this.remoteControlHost.forgetPeer(_peerId);
        this.peerSeenCursorImageIds.delete(_peerId);
        this.pruneRemoteControlViewerByOwner(_peerId);
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
        if (!isLocal) {
          this.stopRemoteControlViewer(peerId);
          if (stateStore.subscribedStreams.has(peerId)) {
            stateStore.set((s) => {
              s.subscribedStreams.delete(peerId);
            });
            this.notify();
          }
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
        const owner = streamOwner(broadcasterPeerId);
        if (owner === 'local' || owner === manager.getLocalPeerId()) {
          this.peerSeenCursorImageIds.delete(watcherPeerId);
          const slashIdx = broadcasterPeerId.indexOf('/');
          if (slashIdx >= 0) this.remoteControlHost.revokeController(watcherPeerId, broadcasterPeerId.slice(slashIdx + 1), 'revoked');
          else this.remoteControlHost.forgetPeer(watcherPeerId);
        }
        soundEffects.playWatchStreamStop();
      },
      onStatusChange: (status) => {
        if (this.roomManager !== manager || signal?.aborted) return;
        profileStats.setInCall(manager.hasAdmission());
        const wasWaiting = this.joinOutcome === 'waiting';
        this.roomStatusText = status;
        if (manager.hasAdmission()) {
          this.joinOutcome = 'admitted';
          persistSavedOnAdmission();
        }
        if (manager.hasAdmission() && (
          status.includes('Conectado') ||
          status === 'Sala Ativa' ||
          status === 'Ao Vivo' ||
          status.includes('P2P') ||
          status.includes('Participante')
        )) {
          this.hideConnecting();
        } else if (status.startsWith('Erro') || status.startsWith('Senha incorreta') || status === t('lan.connectFailed')) {
          this.joinOutcome = 'error';
          this.joinError = status;
          this.hideConnecting();
          if (wasWaiting && (!modalManager.getActive() || modalManager.getActive() === 'joinRoom')) {
            this.pendingJoinInvite = code;
            this.pendingJoinPassword = pass;
            this.pendingJoinAsOwner = isCreator;
            this.pendingJoinError = status;
            this.joinDialogRevision++;
            modalManager.open('joinRoom');
          } else if (this.pendingJoinInvite === '') showToast(status, 5000);
        }
        this.notify();
      },
      onPasswordChange: (newPassword, updatedBy) => {
        if (this.roomManager !== manager) return;
        stateStore.set((s) => {
          s.currentRoomPassword = newPassword;
        });
        showToast(t("message.6fef198fc542", { v0: updatedBy }), 3500, 'success');
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
    }, false, pass);
    signal?.removeEventListener('abort', abort);
    if (signal?.aborted) return;

    if (this.roomManager === manager) {
      profileStats.setInCall(manager.hasAdmission());
      if (manager.hasAdmission()) persistSavedOnAdmission();
    }

    if (!waitForAdmission && this.roomManager === manager && this.joinOutcome === 'connecting') {
      this.joinOutcome = 'waiting';
      this.roomStatusText = t('join.waiting');
      this.hideConnecting();
    } else if (waitForAdmission && !isCreator && this.roomManager === manager && this.joinOutcome === 'connecting' &&
        !manager.hasAdmission() && !manager.isAdmissionDenied?.() &&
        manager.hasVerifiedPreviewMembers?.() && !manager.hasAdmitterOnline?.()) {
      if (this.roomConnectingTimeout) clearTimeout(this.roomConnectingTimeout);
      this.roomConnectingTimeout = setTimeout(() => {
        if (this.roomManager === manager && this.joinOutcome === 'connecting' &&
            !manager.hasAdmission() && !manager.isAdmissionDenied?.()) {
          this.joinOutcome = 'waiting';
          this.roomStatusText = t('join.waiting');
          this.hideConnecting();
          this.notify();
        }
      }, 2500);
    }
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
        if (isTauri() && sessionId) await invoke('update_stream_pointer_overlay', { visuals, sessionId, drawingsIncluded });
      });
      this.pointerReceivers.set(mediaId, receiver);
    }
    return receiver;
  }

  private remoteControlHost = new RemoteControlHostManager({
    isHostSupported: () => isTauri() && !isMobileDevice(),
    getScreenStream: (mediaId) => {
      const entry = this.localCaptures.get(mediaId) ??
        (mediaId === 'default' ? Array.from(this.localCaptures.values()).find((capture) => capture.kind === 'screen') : undefined);
      if (!entry || entry.kind !== 'screen') return null;
      return { sessionId: entry.bridge?.sessionId, cursorCaptured: entry.mouse };
    },
    sendToPeer: (peerId, packet) => {
      this.roomManager?.sendRemoteControlHost(packet, peerId);
    },
    setMonitorActive: (active) => {
      const targetHint = active ? 'motion' : 'detail';
      for (const capture of this.localCaptures.values()) {
        if (capture.kind !== 'screen') continue;
        const track = capture.stream.getVideoTracks()[0];
        if (track && 'contentHint' in track) {
          track.contentHint = targetHint;
        }
      }
      if (!isTauri()) return;
      if (active) {
        void invoke('set_remote_control_host_priority_enabled', {
          enabled: this.remoteControlHostPriorityEnabled,
        }).catch(() => {});
      }
      return invoke('set_remote_control_active', { active });
    },
    applyInput: (controllerId, sessionId, event) => {
      if (!isTauri()) return Promise.resolve({ accepted: false, hostBusy: false, elevationBlocked: false });
      return this.dispatchCoalescedHostInput(controllerId, sessionId ?? null, event);
    },
    releaseInputs: (controllerId) => {
      if (!isTauri()) return;
      return invoke('release_remote_control_inputs', { controllerId: controllerId ?? null });
    },
    syncNativePeer: (peerId, mediaId, sessionId, authorized, mouseEnabled, keyboardEnabled, gamepadEnabled) => {
      if (!isTauri()) return;
      return invoke('set_remote_control_native_peer', {
        peerId,
        mediaId,
        sessionId: sessionId ?? null,
        authorized,
        mouseEnabled,
        keyboardEnabled,
        gamepadEnabled,
      });
    },
    ensureElevationReady: async () => {
      if (!isTauri()) return false;
      try {
        const ready = await invoke<boolean>('enable_remote_control_elevation');
        this.remoteControlElevationReady = Boolean(ready);
        this.notify();
        return Boolean(ready);
      } catch (err) {
        console.warn('[RemoteControl] enable_remote_control_elevation failed:', err);
        return false;
      }
    },
    setNativeControllerElevation: (peerId, mediaId, enabled) => {
      if (!isTauri()) return;
      return invoke('set_remote_control_controller_elevation', {
        controllerId: `${peerId}:${mediaId}`,
        enabled,
      });
    },
    getDefaultPermissions: () => {
      const defaults = loadRemoteControlHostDefaults();
      return {
        mouseEnabled: defaults.defaultMouseEnabled,
        keyboardEnabled: defaults.defaultKeyboardEnabled,
        gamepadEnabled: defaults.defaultGamepadEnabled,
      };
    },
    onInputActivity: (peerId, mediaId, event) => {
      this.remoteControlActivity.recordEvent(peerId, mediaId, event);
    },
    onActivityCleared: ({ peerId, mediaId, controllerKey }) => {
      if (controllerKey) this.remoteControlActivity.clearController(controllerKey);
      else if (peerId) this.remoteControlActivity.clearPeer(peerId);
      else if (mediaId) this.remoteControlActivity.clearMedia(mediaId);
      else this.remoteControlActivity.clear();
    },
    onChange: () => {
      this.remoteControlRequests = this.remoteControlHost.getRequests();
      this.remoteControlElevationRequests = this.remoteControlHost.getElevationRequests();
      this.remoteControllers = this.remoteControlHost.getControllers();
      this.remoteControlHostBusy = this.remoteControlHost.isHostBusy();
      this.remoteControlElevationBlocked = this.remoteControlHost.isElevationBlocked();
      if (isTauri() && (this.remoteControlElevationRequests.length > 0 || this.remoteControllers.length > 0)) {
        void this.refreshRemoteControlElevationReady();
      }
      this.notify();
    },
  });

  private dispatchCoalescedHostInput(
    controllerId: string,
    sessionId: string | null,
    event: RemoteInputEvent,
  ): Promise<{ accepted: boolean; hostBusy: boolean; elevationBlocked?: boolean }> {
    let slot = this.remoteControlMoveQueues.get(controllerId);
    if (!slot) {
      slot = { inFlight: false, pending: null };
      this.remoteControlMoveQueues.set(controllerId, slot);
    }

    if (event.kind !== 'mouseMove' && event.kind !== 'mouseDelta') {
      // Clear queued absolute moves on explicit buttons/wheels/releaseAll, and clear deltas on releaseAll.
      if (event.kind === 'releaseAll') {
        slot.pending = null;
      } else if (
        (event.kind === 'mouseButton' || event.kind === 'mouseWheel') &&
        slot.pending?.event.kind === 'mouseMove'
      ) {
        slot.pending = null;
      }
      return invoke<{ accepted: boolean; hostBusy: boolean; elevationBlocked?: boolean }>('apply_remote_control_input', {
        controllerId,
        sessionId,
        event,
      }).catch((err) => {
        console.warn('[RemoteControl] apply_remote_control_input failed:', err);
        return { accepted: false, hostBusy: false, elevationBlocked: false };
      });
    }

    if (slot.inFlight) {
      if (event.kind === 'mouseDelta' && slot.pending?.event.kind === 'mouseDelta') {
        slot.pending = {
          sessionId,
          event: {
            kind: 'mouseDelta',
            dx: slot.pending.event.dx + event.dx,
            dy: slot.pending.event.dy + event.dy,
          },
        };
      } else {
        slot.pending = { sessionId, event };
      }
      return slot.promise ?? Promise.resolve({ accepted: true, hostBusy: false });
    }

    const runMove = (
      nextSessionId: string | null,
      nextEvent: RemoteInputEvent,
    ): Promise<{ accepted: boolean; hostBusy: boolean; elevationBlocked?: boolean }> => {
      slot!.inFlight = true;
      const req = invoke<{ accepted: boolean; hostBusy: boolean; elevationBlocked?: boolean }>('apply_remote_control_input', {
        controllerId,
        sessionId: nextSessionId,
        event: nextEvent,
      })
        .catch((err) => {
          console.warn('[RemoteControl] apply_remote_control_input move failed:', err);
          return { accepted: false, hostBusy: false, elevationBlocked: false };
        })
        .finally(() => {
          const queued = slot!.pending;
          slot!.pending = null;
          if (queued) {
            void runMove(queued.sessionId, queued.event);
          } else {
            slot!.inFlight = false;
            slot!.promise = undefined;
            this.remoteControlMoveQueues.delete(controllerId);
          }
        });
      slot!.promise = req;
      return req;
    };

    return runMove(sessionId, event);
  }

  private pruneRemoteControlViewerByOwner(ownerPeerId: string): void {
    const next = { ...this.remoteControlViewerStates };
    let changed = false;
    let hadActive = false;
    for (const [key, state] of Object.entries(next)) {
      if (state.hostPeerId === ownerPeerId) {
        if (state.status === 'active') hadActive = true;
        delete next[key];
        changed = true;
      }
    }
    const nextCursors = { ...this.remoteCursorStates };
    let cursorChanged = false;
    for (const [key, state] of Object.entries(nextCursors)) {
      if (state.hostPeerId === ownerPeerId) {
        delete nextCursors[key];
        cursorChanged = true;
      }
    }
    if (cursorChanged) this.remoteCursorStates = nextCursors;
    if (hadActive) this.roomManager?.setRemoteControlLowLatency(ownerPeerId, false);
    if (changed) this.remoteControlViewerStates = next;
  }

  private sendCursorImageToUnseenWatchers(imageId: string): void {
    const asset = this.hostCapturedCursorImages.get(imageId);
    if (!asset || !this.roomManager) return;
    for (const [mediaId, capture] of this.localCaptures) {
      if (capture.kind !== 'screen') continue;
      const watchers = this.roomManager.getRemoteControlWatchers(mediaId);
      for (const peerId of watchers) {
        let seen = this.peerSeenCursorImageIds.get(peerId);
        if (!seen) {
          seen = new Set();
          this.peerSeenCursorImageIds.set(peerId, seen);
        }
        if (seen.has(imageId)) continue;
        seen.add(imageId);
        this.roomManager.sendRemoteControlHost(
          {
            type: 'cursorImage',
            mediaId,
            imageId: asset.imageId,
            width: asset.width,
            height: asset.height,
            hotX: asset.hotX,
            hotY: asset.hotY,
            pngBase64: asset.pngBase64,
          },
          peerId,
        );
      }
    }
  }

  private handleRemoteControlHostPacket(packet: RemoteControlHostPacket, broadcasterId: string): void {
    const slot = stateStore.roomSlots.find(
      (candidate) =>
        (candidate.ownerPeerId || candidate.peerId) === broadcasterId &&
        candidate.pointerEligible !== false &&
        (candidate.mediaId || 'default') === packet.mediaId,
    );

    if (packet.type === 'cursorImage') {
      if (!slot || !stateStore.subscribedStreams.has(slot.peerId)) return;
      const existing = this.remoteCursorImages[packet.imageId];
      if (existing) return;
      const nextImages: Record<string, RemoteCursorImageAsset> = { ...this.remoteCursorImages };
      const keys = Object.keys(nextImages);
      if (keys.length >= 128) {
        delete nextImages[keys[0]];
      }
      nextImages[packet.imageId] = {
        imageId: packet.imageId,
        width: packet.width,
        height: packet.height,
        hotX: packet.hotX,
        hotY: packet.hotY,
        dataUrl: `data:image/png;base64,${packet.pngBase64}`,
      };
      this.remoteCursorImages = nextImages;
      this.notify();
      return;
    }

    if (packet.type === 'cursorSync') {
      const targetKey = slot?.peerId;
      if (!packet.active) {
        let changed = false;
        const nextCursors = { ...this.remoteCursorStates };
        for (const [key, state] of Object.entries(nextCursors)) {
          if (state.hostPeerId === broadcasterId && state.mediaId === packet.mediaId) {
            delete nextCursors[key];
            changed = true;
          }
        }
        if (targetKey && nextCursors[targetKey]) {
          delete nextCursors[targetKey];
          changed = true;
        }
        if (changed) {
          this.remoteCursorStates = nextCursors;
          this.notify();
        }
        return;
      }
      if (!targetKey || !stateStore.subscribedStreams.has(targetKey)) return;
      this.remoteCursorStates = {
        ...this.remoteCursorStates,
        [targetKey]: {
          mediaId: packet.mediaId,
          hostPeerId: broadcasterId,
          active: true,
          visible: packet.visible,
          x: packet.x,
          y: packet.y,
          cursorShape: packet.cursorShape,
          imageId: packet.imageId ?? '',
          mouseLocked: Boolean(packet.mouseLocked),
          hostBusy: packet.hostBusy,
          elevationBlocked: Boolean(packet.elevationBlocked) && !this.remoteControlViewerStates[targetKey]?.adminEnabled,
          actorPeerId: packet.actorPeerId,
          embeddedInVideo: packet.embeddedInVideo,
          updatedAt: Date.now(),
        },
      };
      this.notify();
      return;
    }

    const existingEntry = slot
      ? [slot.peerId, this.remoteControlViewerStates[slot.peerId]] as const
      : Object.entries(this.remoteControlViewerStates).find(
          ([, value]) => value.hostPeerId === broadcasterId && value.mediaId === packet.mediaId,
        );
    const slotKey = existingEntry?.[0];
    const current = existingEntry?.[1];
    if (!slotKey || !current) return;

    if (packet.type === 'accept') {
      if (current.status !== 'pending' && current.status !== 'active') return;
      if (!stateStore.subscribedStreams.has(slotKey)) return;
      const adminEnabled = Boolean(packet.adminEnabled);
      this.remoteControlViewerStates = {
        ...this.remoteControlViewerStates,
        [slotKey]: {
          ...current,
          status: 'active',
          mouseEnabled: packet.mouseEnabled,
          keyboardEnabled: packet.keyboardEnabled,
          gamepadEnabled: packet.gamepadEnabled ?? true,
          adminEnabled,
          adminRequestPending: false,
          cursorCaptured: packet.cursorCaptured,
          hostBusy: packet.hostBusy,
          elevationBlocked: adminEnabled ? false : Boolean(packet.elevationBlocked),
          cursorShape: packet.cursorShape,
          fastBinary: Boolean(packet.fastBinary),
        },
      };
      this.roomManager?.setRemoteControlLowLatency(current.hostPeerId, true);
      showToast(t('remoteControl.accepted'), 2500, 'success');
      this.notify();
      return;
    }

    if (packet.type === 'state') {
      if (current.status !== 'active') return;
      const adminEnabled = Boolean(packet.adminEnabled);
      this.remoteControlViewerStates = {
        ...this.remoteControlViewerStates,
        [slotKey]: {
          ...current,
          mouseEnabled: packet.mouseEnabled,
          keyboardEnabled: packet.keyboardEnabled,
          gamepadEnabled: packet.gamepadEnabled ?? current.gamepadEnabled,
          adminEnabled,
          adminRequestPending: adminEnabled ? false : current.adminRequestPending,
          cursorCaptured: packet.cursorCaptured,
          hostBusy: packet.hostBusy,
          elevationBlocked: adminEnabled ? false : Boolean(packet.elevationBlocked),
          cursorShape: packet.cursorShape,
        },
      };
      this.notify();
      return;
    }

    if (packet.type === 'elevationDecline') {
      if (current.status !== 'active') return;
      this.remoteControlViewerStates = {
        ...this.remoteControlViewerStates,
        [slotKey]: {
          ...current,
          adminEnabled: false,
          adminRequestPending: false,
        },
      };
      showToast(
        packet.reason === 'unsupported' ? t('remoteControl.unsupportedHost') : t('remoteControl.adminDeclined'),
        3000,
        'info',
      );
      this.notify();
      return;
    }

    if (packet.type === 'gamepadRemoved') {
      if (typeof window !== 'undefined') {
        window.dispatchEvent(
          new CustomEvent('p2sharer:remote-gamepad-removed', {
            detail: { slotPeerId: slotKey, padIndex: packet.padIndex },
          }),
        );
      }
      return;
    }

    const next = { ...this.remoteControlViewerStates };
    delete next[slotKey];
    this.remoteControlViewerStates = next;
    if (current.status === 'active') {
      this.roomManager?.setRemoteControlLowLatency(current.hostPeerId, false);
    }
    if (packet.type === 'decline') {
      showToast(t('remoteControl.declined'), 3000, 'info');
    } else if (packet.type === 'revoke') {
      if (packet.reason === 'unsupported') showToast(t('remoteControl.unsupportedHost'), 3500, 'info');
      else if (packet.reason !== 'stream-ended') showToast(t('remoteControl.revoked'), 3000, 'info');
    }
    this.notify();
  }

  public toggleRemoteControlRequest(slotPeerId: string): void {
    const slot = stateStore.roomSlots.find((candidate) => candidate.peerId === slotPeerId);
    if (!slot || slot.isLocal || slot.pointerEligible === false || !stateStore.subscribedStreams.has(slotPeerId)) return;
    const current = this.remoteControlViewerStates[slotPeerId];
    const mediaId = slot.mediaId || 'default';
    const hostPeerId = streamOwner(slotPeerId);
    if (current?.status === 'pending') {
      const next = { ...this.remoteControlViewerStates };
      delete next[slotPeerId];
      this.remoteControlViewerStates = next;
      this.roomManager?.sendRemoteControlClient({ type: 'cancel', mediaId: current.mediaId }, current.hostPeerId);
      this.notify();
      return;
    }
    if (current?.status === 'active') {
      this.stopRemoteControlViewer(slotPeerId);
      return;
    }
    if ((slot.platform ?? 'desktop') !== 'desktop') {
      showToast(t('remoteControl.unsupportedHost'), 3500, 'info');
      return;
    }
    this.remoteControlViewerStates = {
      ...this.remoteControlViewerStates,
      [slotPeerId]: {
        mediaId,
        hostPeerId,
        status: 'pending',
        mouseEnabled: true,
        keyboardEnabled: true,
        gamepadEnabled: true,
        adminEnabled: false,
        adminRequestPending: false,
        cursorCaptured: true,
        hostBusy: false,
        elevationBlocked: false,
        cursorShape: 'default',
      },
    };
    this.roomManager?.sendRemoteControlClient({ type: 'request', mediaId }, hostPeerId);
    this.notify();
  }

  public stopRemoteControlViewer(slotPeerId: string): void {
    const current = this.remoteControlViewerStates[slotPeerId];
    if (!current) return;
    const next = { ...this.remoteControlViewerStates };
    delete next[slotPeerId];
    this.remoteControlViewerStates = next;
    if (current.status === 'active') {
      this.roomManager?.setRemoteControlLowLatency(current.hostPeerId, false);
    }
    this.roomManager?.sendRemoteControlClient(
      { type: current.status === 'pending' ? 'cancel' : 'release', mediaId: current.mediaId },
      current.hostPeerId,
    );
    this.notify();
  }

  public sendRemoteControlInput(slotPeerId: string, event: RemoteInputEvent): void {
    const current = this.remoteControlViewerStates[slotPeerId];
    if (!current || current.status !== 'active' || !stateStore.subscribedStreams.has(slotPeerId)) return;
    if (
      (event.kind === 'mouseMove' ||
        event.kind === 'mouseDelta' ||
        event.kind === 'mouseButton' ||
        event.kind === 'mouseWheel') &&
      !current.mouseEnabled
    ) {
      return;
    }
    if (event.kind === 'key' && !current.keyboardEnabled) {
      return;
    }
    if ((event.kind === 'gamepadState' || event.kind === 'gamepadDisconnect') && !current.gamepadEnabled) {
      return;
    }
    this.roomManager?.sendRemoteControlClient({ type: 'input', mediaId: current.mediaId, event }, current.hostPeerId);
  }

  public requestRemoteControlElevation(slotPeerId: string): void {
    const current = this.remoteControlViewerStates[slotPeerId];
    if (!current || current.status !== 'active' || current.adminEnabled || current.adminRequestPending) return;
    if (!stateStore.subscribedStreams.has(slotPeerId)) return;
    this.remoteControlViewerStates = {
      ...this.remoteControlViewerStates,
      [slotPeerId]: {
        ...current,
        adminRequestPending: true,
      },
    };
    this.roomManager?.sendRemoteControlClient({ type: 'requestElevation', mediaId: current.mediaId }, current.hostPeerId);
    this.notify();
  }

  public cancelRemoteControlElevation(slotPeerId: string): void {
    const current = this.remoteControlViewerStates[slotPeerId];
    if (!current || current.status !== 'active' || !current.adminRequestPending) return;
    this.remoteControlViewerStates = {
      ...this.remoteControlViewerStates,
      [slotPeerId]: {
        ...current,
        adminRequestPending: false,
      },
    };
    this.roomManager?.sendRemoteControlClient({ type: 'cancelElevation', mediaId: current.mediaId }, current.hostPeerId);
    this.notify();
  }

  public answerRemoteControlRequest(
    requestId: string,
    accept: boolean,
    permissions?: { mouseEnabled?: boolean; keyboardEnabled?: boolean; gamepadEnabled?: boolean },
  ): void {
    this.remoteControlHost.answerRequest(requestId, accept, permissions);
  }

  public async answerRemoteControlElevation(requestId: string, accept: boolean): Promise<boolean> {
    return this.remoteControlHost.answerElevationRequest(requestId, accept);
  }

  public async setRemoteControllerAdminPermission(
    peerId: string,
    mediaId: string,
    enabled: boolean,
  ): Promise<boolean> {
    return this.remoteControlHost.setControllerAdminPermission(peerId, mediaId, enabled);
  }

  public async refreshRemoteControlElevationReady(): Promise<boolean> {
    if (!isTauri()) return false;
    try {
      const ready = await invoke<boolean>('is_remote_control_elevation_ready');
      if (ready !== this.remoteControlElevationReady) {
        this.remoteControlElevationReady = Boolean(ready);
        this.notify();
      }
      return Boolean(ready);
    } catch {
      return this.remoteControlElevationReady;
    }
  }

  public setRemoteControllerPermissions(
    peerId: string,
    mediaId: string,
    patch: { mouseEnabled?: boolean; keyboardEnabled?: boolean; gamepadEnabled?: boolean },
  ): void {
    this.remoteControlHost.setControllerPermissions(peerId, mediaId, patch);
  }

  public revokeRemoteController(peerId: string, mediaId: string): void {
    this.remoteControlHost.revokeController(peerId, mediaId, 'revoked');
  }

  public async setRemoteControlHostPriorityEnabled(enabled: boolean): Promise<void> {
    this.remoteControlHostPriorityEnabled = enabled;
    const current = loadRemoteControlHostDefaults();
    saveRemoteControlHostDefaults({ ...current, hostPriorityEnabled: enabled });
    this.notify();
    if (!isTauri()) return;
    try {
      await invoke('set_remote_control_host_priority_enabled', { enabled });
    } catch (err) {
      console.warn('[RemoteControl] Failed to update host priority setting:', err);
    }
  }

  public async recheckRemoteControlGamepadDriver(): Promise<void> {
    if (!isTauri()) return;
    try {
      const snap = await invoke<{ driverAvailable: boolean; gamepads: VirtualGamepadSlot[] }>(
        'recheck_remote_control_gamepad_driver',
      );
      if (snap) {
        this.remoteControlGamepadDriverAvailable = Boolean(snap.driverAvailable);
        if (this.remoteControlGamepadDriverAvailable) {
          this.remoteControlGamepadDriverNeedsReboot = false;
        }
        this.remoteControlVirtualGamepads = Array.isArray(snap.gamepads) ? snap.gamepads : [];
        this.notify();
      }
    } catch (err) {
      console.warn('[Gamepad] Failed to probe ViGEmBus driver:', err);
    }
  }

  public async installRemoteControlGamepadDriver(): Promise<void> {
    if (!isTauri() || this.remoteControlGamepadDriverInstallStage !== 'idle') return;
    this.remoteControlGamepadDriverInstallStage = 'downloading';
    this.remoteControlGamepadDriverNeedsReboot = false;
    this.notify();
    try {
      const result = await invoke<{ status: string; driverAvailable: boolean }>(
        'install_remote_control_gamepad_driver',
      );
      if (result) {
        this.remoteControlGamepadDriverAvailable = Boolean(result.driverAvailable);
        if (result.status === 'installed' || result.status === 'already_installed') {
          this.remoteControlGamepadDriverNeedsReboot = false;
          showToast(t('remoteControl.vigemInstalledToast'), 3500, 'success');
        } else if (result.status === 'reboot_required') {
          this.remoteControlGamepadDriverNeedsReboot = true;
          showToast(t('remoteControl.vigemRebootToast'), 6000, 'info');
        } else if (result.status === 'cancelled') {
          showToast(t('remoteControl.vigemInstallCancelledToast'), 3500, 'info');
        }
      }
    } catch (err) {
      console.warn('[Gamepad] Failed to install ViGEmBus driver:', err);
      showToast(t('remoteControl.vigemInstallFailedToast'), 5000, 'error');
    } finally {
      this.remoteControlGamepadDriverInstallStage = 'idle';
      this.notify();
    }
  }

  public async reorderRemoteControlGamepads(orderedIds: string[]): Promise<void> {
    if (!isTauri() || orderedIds.length === 0) return;
    try {
      await invoke('reorder_remote_control_gamepads', { orderedIds });
    } catch (err) {
      console.warn('[Gamepad] Failed to reorder virtual gamepads:', err);
    }
  }

  public subscribeRemoteControlActivity(listener: () => void): () => void {
    return this.remoteControlActivity.subscribe(listener);
  }

  public getControllerInputActivity(peerId: string, mediaId: string): ControllerInputActivity {
    return this.remoteControlActivity.getControllerActivity(`${peerId}:${mediaId}`);
  }

  public getGamepadInputActivity(slotId: string): GamepadInputActivity {
    return this.remoteControlActivity.getGamepadActivity(slotId);
  }

  private buildOverlayItemForController(ctrl: RemoteControllerInfo, now: number): RemoteControllerOverlayItem {
    const peer = this.peers.find((item) => item.id === ctrl.peerId);
    const name = peer?.username || ctrl.peerId.slice(0, 6);
    const color = profileImages.color(ctrl.peerId) || generateUserColor(name);
    const activity = this.remoteControlActivity.getControllerActivity(`${ctrl.peerId}:${ctrl.mediaId}`, now);
    return {
      peerId: ctrl.peerId,
      name,
      color,
      avatarDataUrl: profileImages.url(ctrl.peerId) ?? null,
      mouseEnabled: ctrl.mouseEnabled,
      keyboardEnabled: ctrl.keyboardEnabled,
      gamepadEnabled: ctrl.gamepadEnabled,
      mouseActive: activity.mouseActive,
      keyboardActive: activity.keyboardActive,
      gamepadActive: activity.gamepadActive,
      mouseSeq: activity.mouseSeq,
      keyboardSeq: activity.keyboardSeq,
      gamepadSeq: activity.gamepadSeq,
    };
  }

  public getRemoteControlOverlayItemsForMedia(mediaId: string): RemoteControllerOverlayItem[] {
    const now = Date.now();
    return this.remoteControllers
      .filter((ctrl) => ctrl.mediaId === mediaId || ctrl.mediaId === 'default' || mediaId === 'default')
      .map((ctrl) => this.buildOverlayItemForController(ctrl, now));
  }

  public async disconnectRemoteControlGamepad(slot: {
    id: string;
    peerId: string;
    mediaId: string;
    padIndex: number;
  }): Promise<void> {
    if (!isTauri()) return;
    try {
      await invoke('disconnect_remote_control_gamepad', { id: slot.id });
      this.roomManager?.sendRemoteControlHost(
        { type: 'gamepadRemoved', mediaId: slot.mediaId, padIndex: slot.padIndex },
        slot.peerId,
      );
    } catch (err) {
      console.warn('[Gamepad] Failed to disconnect virtual gamepad:', err);
    }
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

  public prepareCaptureAudio(): void {
    if (!isTauri()) return;
    if (Array.from(this.localCaptures.values()).some((entry) => entry.kind === 'screen')) return;
    this.audioBridge.prepare();
  }

  public releaseUnusedCaptureAudio(): void {
    if (!isTauri()) return;
    if (Array.from(this.localCaptures.values()).some((entry) => entry.kind === 'screen')) return;
    this.audioBridge.stop();
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
        showToast(t("message.d1943a972148"), 3500, 'success');
        return;
      }
      const id = editingId || crypto.randomUUID();
      const bridge = prepared?.bridge || (isTauri() && kind === 'screen' ? new NativeVideoBridge(crypto.randomUUID()) : undefined);
      let stream: MediaStream | undefined;
      let acquiredAudio: MediaStreamTrack | null = null;
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
        const hasAudioTrack = kind === 'screen' && isTauri() &&
          !Array.from(this.localCaptures.values()).some((entry) => entry.kind === 'screen');
        if (!previous && hasAudioTrack) {
          acquiredAudio = await this.audioBridge.startCapture(stateStore.isAudioFilterFullAudio ? 'full' : stateStore.selectedFilterMode,
            stateStore.isAudioFilterFullAudio ? [] : stateStore.getActiveFilterPids(),
            stateStore.isAudioFilterFullAudio ? [] : stateStore.getActiveFilterNames(),
            stateStore.isAudioFilterFullAudio ? [] : stateStore.getActiveFilterSubKeys());
          if (acquiredAudio) stream.addTrack(acquiredAudio);
        }
        const descriptor: StreamDescriptor = { id, kind, get label() { return (label || (kind === 'camera' ? t("message.dafb61aca12d") :
          sourceId.startsWith('window:') ? t("message.28014ef35252") : t("message.2d31efc9c2ed"))).slice(0, 200); }, videoTrackId: track.id, fps, bitrate,
          hasAudio: previous ? previous.stream.getAudioTracks().length > 0 : Boolean(acquiredAudio || stream.getAudioTracks().length > 0) };
        const slotPreviewKey = streamSlotKey('local', id);
        const initialPreview = Boolean(
          stateStore.localPreviewStreams[slotPreviewKey] ??
          stateStore.localPreviewStreams[id] ??
          stateStore.localPreviewStreams['local'] ??
          (kind === 'camera')
        );
        let capture: { sourceId: string; kind: MediaKind; stream: MediaStream;
          bridge?: NativeVideoBridge; fps: number; resolution: { width: number; height: number }; mouse: boolean; quality: number; bitrate: number } | undefined;
        try {
          if (previous) {
            capture = { sourceId, kind, stream: previous.stream, bridge, fps, resolution: res, mouse, quality, bitrate };
            this.localCaptures.set(id, capture);
            bridge?.setConsumerActive('local-preview', initialPreview);
            await manager.replaceMediaTrack(id, track, descriptor);
            this.pointerReceivers.get(id)?.clear();
            this.pointerReceivers.delete(id);
            stream = previous.stream;
            manager.syncCaptureConsumers(id);
            if (prepared?.bridge) prepared.bridge.setConsumerActive('modal-preview', false);
            bridge?.requestKeyframe();
            const slot = stateStore.roomSlots.find((slot) => slot.isLocal && slot.mediaId === id);
            if (slot) pipService.updateStream(slot.peerId, stream);
          } else {
            capture = { sourceId, kind, stream, bridge, fps, resolution: res, mouse, quality, bitrate };
            this.localCaptures.set(id, capture);
            bridge?.setConsumerActive('local-preview', initialPreview);
            manager.shareStream(stream, bitrate * 1000, fps, descriptor);
            if (prepared?.bridge) prepared.bridge.setConsumerActive('modal-preview', false);
            bridge?.requestKeyframe();
          }
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
        } catch (innerError) {
          if (previous && this.localCaptures.get(id) === capture) {
            this.localCaptures.set(id, previous);
          } else if (!previous && capture && this.localCaptures.get(id) === capture) {
            this.localCaptures.delete(id);
          }
          throw innerError;
        }
      } catch (error) {
        if (!previous) {
          acquiredAudio?.stop();
          if (!Array.from(this.localCaptures.values()).some((entry) => entry.kind === 'screen')) {
            this.audioBridge.stop();
          }
        }
        if (bridge) await bridge.stopCapture();
        else if (stream && stream !== previous?.stream) stream.getTracks().forEach((track) => track.stop());
        showToast(t("message.5a1156df731c", { v0: localizeError(error) }), 3500, 'error');
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
    stateStore.set((state) => {
      state.isSharingScreen = Array.from(this.localCaptures.values()).some((entry) => entry.kind === 'screen');
      if (isMobileDevice()) {
        state.isSidebarCollapsed = true;
      }
    });
    const screen = Array.from(this.localCaptures.values()).find((entry) => entry.kind === 'screen');
    if (isTauri()) void invoke('select_pointer_capture', { sessionId: screen?.bridge?.sessionId || null }).catch(console.warn);
    for (const [id, entry] of this.localCaptures) {
      if (entry.kind === 'screen') this.remoteControlHost.notifyStreamUpdated(id);
    }
    this.notify();
  }

  public stopTransmission(id: string, notifyManager = true) {
    const entry = this.localCaptures.get(id);
    if (!entry) return;
    this.remoteControlHost.forgetMedia(id);
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
    this.remoteControlHost.clear();
    this.hostCapturedCursorImages.clear();
    this.peerSeenCursorImageIds.clear();
    this.roomManager?.stopStream();
    for (const id of [...this.localCaptures.keys()]) this.stopTransmission(id, false);
    this.pointerReceiver.clear();
    this.audioBridge.stop();
    this.syncCaptureState();
  }

  public editTransmission(id: string) {
    stateStore.set((state) => { state.editingStreamId = id; });
  }

  public setCaptureConsumer(key: string | MediaStream, consumerId: string, active: boolean): void {
    for (const [id, entry] of this.localCaptures) {
      if (key === 'local' || id === key || entry.stream === key || entry.sourceId === key) {
        entry.bridge?.setConsumerActive(consumerId, active);
      }
    }
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
    profileStats.setInCall(false);
    this.hideConnecting();
    const transition = this.roomTransition.then(() => this.leaveRoomNow());
    this.roomTransition = transition.catch((err) => {
      console.error('[RoomService] Room exit failed:', err);
    });
    return transition;
  }

  private async leaveRoomNow(): Promise<void> {
    if (this.roomPreview) {
      const preview = this.roomPreview;
      this.roomPreview = null;
      await preview.leave();
    }
    this.joinOutcome = 'idle';
    this.joinError = '';
    for (const viewerSlotPeerId of Object.keys(this.remoteControlViewerStates)) {
      this.stopRemoteControlViewer(viewerSlotPeerId);
    }
    this.pointerReceiver.clear();
    this.remoteControlHost.clear();
    this.remoteControlViewerStates = {};
    this.remoteControlElevationBlocked = false;
    this.remoteCursorStates = {};
    this.remoteCursorImages = {};
    this.hostCapturedCursorImages.clear();
    this.peerSeenCursorImageIds.clear();
    streamPointerView.clear();
    roomAppsService.reset();
    if (this.roomConnectingTimeout) {
      clearTimeout(this.roomConnectingTimeout);
      this.roomConnectingTimeout = null;
    }

    soundEffects.playUserLeave();

    this.leaveVoice(true);
    this.remoteVoiceStates = {};
    this.voicePeers = {};

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
    stateStore.set((state) => {
      state.unreadChatMessages = 0;
      state.sidebarTab = 'chat';
      if (isMobileDevice()) {
        state.isSidebarCollapsed = true;
      }
    });
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
    stateStore.set(s => { s.peerNicknameStyles = {}; });
    this.hideConnecting();
    showToast(t("message.b520e8324025"));
    this.notify();
  }

  public sendChatMessage(text: string, replyToId?: string): void {
    if (!text.trim() || !this.roomManager) return;
    void this.roomManager.sendChatMessage(text.trim(), replyToId).then(() => profileStats.messageSent()).catch((error) =>
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
    const nativeDirect = progress.nativeDirect ?? previous?.nativeDirect;
    const transportChanged = nativeDirect !== previous?.nativeDirect;
    if (transportChanged) this.transferRouteChecks.delete(progress.requestId);
    const entry: FileProgress = {
      ...previous, ...reported,
      nativeDirect,
      transport: transportChanged ? undefined : progress.transport ?? previous?.transport,
      fileName: progress.fileName ?? previous?.fileName ?? message?.file?.name ?? t("message.ba8a452f2f83"),
      peerName: progress.peerName ?? previous?.peerName ?? peer?.username ??
        (progress.direction === 'receive' ? message?.sender : undefined) ?? t("message.1e97ddf60a0f"),
      peerId: progress.peerId ?? previous?.peerId,
      previewOnly: progress.previewOnly ?? previous?.previewOnly,
      startedAt: previous?.startedAt ?? Date.now(),
      isImage: progress.isImage ?? previous?.isImage ?? message?.file?.isImage ?? false,
      bytesPerSecond,
      timings: nativeDirect ? undefined : progress.timings ?? previous?.timings,
    };
    this.fileProgress = { ...this.fileProgress, [entry.requestId]: entry };
    if (entry.status === 'complete' && previous?.status !== 'complete' && !this.localSaveIds.has(entry.requestId)) {
      profileStats.transferCompleted(entry.requestId, entry.direction, entry.total, Boolean(entry.previewOnly));
    }
    if (entry.status === 'active' && entry.peerId && this.roomManager) {
      const now = performance.now();
      const last = this.transferRouteChecks.get(entry.requestId);
      if (last === undefined || now - last >= 5000) {
        this.transferRouteChecks.set(entry.requestId, now);
        void this.roomManager.getFileTransportDiagnostics(entry.peerId, entry.requestId).then((stats) => {
          const current = this.fileProgress[entry.requestId];
          if (!stats || !current || current.status !== 'active' || current.peerId !== entry.peerId ||
              current.nativeDirect !== entry.nativeDirect) return;
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
    this.stopRemoteControlViewer(peerId);
    if (this.remoteCursorStates[peerId]) {
      const nextCursors = { ...this.remoteCursorStates };
      delete nextCursors[peerId];
      this.remoteCursorStates = nextCursors;
    }
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

  public getSelfPeerId(): string {
    return this.roomManager?.getLocalPeerId() ?? '';
  }

  public async joinVoice(): Promise<void> {
    if (voiceManager.inVoice) return;
    voiceManager.enterRoomMuted();
    this.roomManager?.setLocalVoiceState({ inVoice: true, muted: true, deafened: false }, null);
    this.syncVoiceSnapshot();
    this.notify();
  }

  public leaveVoice(_silent = false): void {
    this.voiceJoinPromise = null;
    this.roomManager?.setLocalVoiceState({ inVoice: false, muted: false, deafened: false }, null);
    voiceManager.leaveVoice();
    this.syncVoiceSnapshot();
    this.notify();
  }

  public toggleVoiceMute(): Promise<void> {
    if (!voiceManager.inVoice) return Promise.resolve();
    if (!voiceManager.micMuted) {
      const res = voiceManager.toggleMicMute();
      soundEffects.playVoiceMute();
      this.roomManager?.setLocalVoiceState({
        inVoice: true,
        muted: res.micMuted,
        deafened: res.deafened,
      });
      this.syncVoiceSnapshot();
      this.notify();
      return Promise.resolve();
    }

    if (this.voiceJoinPromise) return this.voiceJoinPromise;
    const manager = this.roomManager;
    const task = (async () => {
      try {
        const res = await voiceManager.activateMicAndUnmute();
        if (this.roomManager !== manager) {
          voiceManager.leaveVoice();
          return;
        }
        if (res.autoUndeafened) {
          soundEffects.playVoiceUndeafen();
        } else {
          soundEffects.playVoiceUnmute();
        }
        manager?.setLocalVoiceState(
          { inVoice: true, muted: res.micMuted, deafened: res.deafened },
          res.stream,
        );
      } catch (err) {
        const name = err instanceof DOMException ? err.name : '';
        const msg = name === 'NotAllowedError' || name === 'PermissionDeniedError'
          ? t('voice.micPermissionError')
          : t('voice.micUnavailableError');
        showToast(msg, 4500, 'error');
        logDiagnostic('ERROR', 'voice.mic', 'Failed to activate microphone on unmute', {
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        this.voiceJoinPromise = null;
        this.syncVoiceSnapshot();
        this.notify();
      }
    })();
    this.voiceJoinPromise = task;
    return task;
  }

  public toggleVoiceDeafen(): void {
    if (!voiceManager.inVoice) return;
    const res = voiceManager.toggleDeafen();
    if (res.deafened) {
      soundEffects.playVoiceDeafen();
    } else {
      soundEffects.playVoiceUndeafen();
    }
    this.roomManager?.setLocalVoiceState({
      inVoice: true,
      muted: res.micMuted,
      deafened: res.deafened,
    });
    this.syncVoiceSnapshot();
    this.notify();
  }

  public async applyVoicePreferences(prefs: VoicePreferences, persist = true): Promise<void> {
    await voiceManager.applyPreferences(prefs, persist);
    this.syncVoiceSnapshot();
    this.notify();
  }

  public setPeerVoiceVolume(
    peerId: string,
    volume: number,
    muted: boolean,
    publicKey?: string,
    username?: string,
  ): UserVoiceVolumePreference {
    const peer = this.peers.find((p) => p.id === peerId);
    const saved = voiceManager.setRemotePeerVolume(
      peerId,
      volume,
      muted,
      publicKey ?? peer?.publicKey,
      username ?? peer?.username,
    );
    this.syncVoiceSnapshot();
    this.notify();
    return saved;
  }

  public getPeerVoiceVolume(
    peerId: string,
    publicKey?: string,
    username?: string,
  ): UserVoiceVolumePreference {
    const peer = this.peers.find((p) => p.id === peerId);
    return voiceManager.getRemotePeerVolume(
      peerId,
      publicKey ?? peer?.publicKey,
      username ?? peer?.username,
    );
  }
}

export const roomService = RoomService.getInstance();
