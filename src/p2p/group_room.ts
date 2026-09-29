import { selfId } from '@trystero-p2p/core';
import { invoke } from '@tauri-apps/api/core';
import type { AppWireEvent } from '../apps/types.ts';
import { getRoomApp } from '../apps/registry.ts';
import { chatHistoryChanged, chatRevision, chatRevisionKey, mergeChatHistory } from '../core/chat_history.ts';
import { CHAT_FILE_CHUNK_BYTES, CHAT_FILE_IN_FLIGHT_CHUNKS, MAX_IMAGE_PREVIEW_BYTES } from '../core/chat_file_limits.ts';
import { decodeFileBase64, decodeSignedFileChunk, encodeFileBase64, encodeSignedFileChunk,
  fileChunkSignatureData, hashFileChunk } from '../core/chat_file_wire.ts';
import { PeerAuthenticator } from '../core/peer_auth.ts';
import { selectedIcePair, selectedIceRoute, type IceStat } from '../core/ice_route.ts';
import { RoomAuthority, type AdminAdmission, type AuthorityTransfer, type HostCommand } from '../core/room_authority.ts';
import { compareRoomInvites, formatRoomInvite, parseRoomInvite, signRoomInvite, validRoomName,
  type NamedRoomInvite } from '../core/room_invite.ts';
import { isAuthorityChainPrefix, verifyRoomInvite } from '../core/room_invite_validation.ts';
import { savedRoomCustomName, savedRooms } from '../core/saved_rooms.ts';
import { latestAdminCommand, roomStateFingerprint } from '../core/room_state_sync.ts';
import type {
  ActiveStreamInfo,
  ChatMessage,
  PeerInfo,
  PeerStatsInfo,
  RoomSlotInfo,
  SignalingStatus,
  SignalingTransport,
  StreamRequestPayload,
  StreamStatusPayload,
  StreamWatcher,
  TransportStatusInfo,
  TurnConfig,
} from '../core/types.ts';
import {
  buildRtcConfiguration,
  createJoinErrorHandler,
} from './ice_config.ts';
import { createFileOptimizedPeerConnection, ensureFileDataChannelWindow,
  type FileOptimizedConnection } from './file_data_channel.ts';
import { MediaCoordinator } from './media_coordinator.ts';
import { PeerTracker } from './peer_tracker.ts';
import { signalingManager } from './signaling_manager.ts';

const APP_ID = 'p2sharer-multi-stream-v5';

const ADJECTIVES = [
  'cyber', 'neon', 'rapid', 'swift', 'cosmic', 'hyper', 'solar', 'lunar',
  'mystic', 'sonic', 'ultra', 'mega', 'royal', 'epic', 'prime', 'iron',
  'silver', 'golden', 'shadow', 'crystal', 'astro', 'blaze', 'storm', 'vortex',
  'quantum', 'echo', 'alpha', 'nova', 'turbo', 'ninja', 'pixel', 'phantom',
];

const NOUNS = [
  'falcon', 'tiger', 'wolf', 'eagle', 'hawk', 'panther', 'fox', 'dragon',
  'phoenix', 'bear', 'shark', 'cobra', 'viper', 'lion', 'lynx', 'titan',
  'nomad', 'runner', 'driver', 'spark', 'storm', 'pulse', 'byte', 'core',
  'matrix', 'drift', 'horizon', 'forge', 'nexus', 'rover', 'shield', 'vortex',
];

export function generateRandomRoomSlug(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  const num = Math.floor(100 + Math.random() * 900);
  return `${adj}-${noun}-${num}`;
}

export async function computeSignalingRoomId(roomId: string, password = ''): Promise<string> {
  const cleanRoom = roomId.trim().toLowerCase();
  const cleanPass = password.trim();
  if (!cleanPass) {
    return `public-${cleanRoom}`;
  }
  const data = new TextEncoder().encode(`p2sharer-auth:${cleanRoom}:${cleanPass}`);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('').substring(0, 16);
  return `sec-${cleanRoom}-${hashHex}`;
}

export function generateUserColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash % 360);
  return `hsl(${hue}, 65%, 45%)`;
}

export interface RoomCallbacks {
  onFileRequest?: (request: FileRequest) => void;
  onFileRequestCancelled?: (requestId: string) => void;
  onFileProgress?: (transfer: FileProgress) => void;
  onAppEvent?: (event: AppWireEvent, peerId: string) => void;
  onStreamsUpdate: (streams: ActiveStreamInfo[]) => void;
  onSlotsUpdate: (slots: RoomSlotInfo[]) => void;
  onChat: (msg: ChatMessage) => void;
  onChatHistory: (messages: ChatMessage[]) => void;
  onPeersUpdate: (peers: PeerInfo[]) => void;
  onStatusChange: (status: string) => void;
  onPasswordChange?: (newPassword: string, updatedBy: string) => void;
  onHostChange?: (isLocalHost: boolean) => void;
  onInviteChange?: (invite: string, name: string) => void;
  onPeerJoined?: (peer: PeerInfo, isInitial: boolean) => void;
  onPeerLeft?: (peerId: string, username: string) => void;
  onStreamStarted?: (peerId: string, username: string, isLocal: boolean) => void;
  onStreamStopped?: (peerId: string, username: string, isLocal: boolean) => void;
  onWatchStarted?: (watcherPeerId: string, watcherName: string, broadcasterPeerId: string) => void;
  onWatchStopped?: (watcherPeerId: string, watcherName: string, broadcasterPeerId: string) => void;
}

export interface NativeChatFile { id: string; name: string; path: string; size: number; hash: string; isImage: boolean }
export interface FileRequest { requestId: string; messageId: string; peerId: string; peerName: string; path: string; name: string; preview: boolean }
export interface FileTimings { readMs: number; prepareMs: number; wireMs: number; verifyMs: number; writeMs: number; ackMs: number }
export interface FileTransportDiagnostics { protocol?: string; localCandidateType?: string; remoteCandidateType?: string; queuedBytes?: number; queueLimitBytes?: number; pairBytesSent?: number; pairBytesReceived?: number; pairTimestamp?: number; pairBytesPerSecond?: number; availableOutgoingBitsPerSecond?: number; packetsDiscardedOnSend?: number }
export interface FileProgress { requestId: string; messageId: string; direction: 'send' | 'receive'; bytes: number; total: number; status: 'pending' | 'active' | 'complete' | 'cancelled' | 'error'; error?: string; preview?: string; previewBytes?: Uint8Array; saved?: boolean; previewOnly?: boolean; peerId?: string; fileName?: string; peerName?: string; startedAt?: number; isImage?: boolean; bytesPerSecond?: number; connectionType?: string; rttMs?: number | null; timings?: FileTimings; transport?: FileTransportDiagnostics }
type FilePacket = { kind: 'request' | 'accept' | 'deny' | 'ack' | 'cancel'; requestId: string; messageId: string; offset?: number; preview?: boolean; signature: string };
type FileSession = { messageId: string; peerId: string; peerName?: string; sourceId?: string; offset: number; sentOffset?: number; sending?: boolean; receiving?: boolean; pendingChunks?: Map<number, Uint8Array>; total: number; direction: 'send' | 'receive'; preview?: boolean; chunks?: Uint8Array[]; timings: FileTimings };

function newFileTimings(): FileTimings {
  return { readMs: 0, prepareMs: 0, wireMs: 0, verifyMs: 0, writeMs: 0, ackMs: 0 };
}

interface PeerExchangeItem {
  peerId: string;
  username: string;
  isStreaming: boolean;
  isCreator: boolean;
  joinedAt: number;
}

export class GroupRoomManager {
  private username: string;
  private roomId: string;
  private password: string = '';
  private isCreator: boolean;
  private myJoinedAt: number = Date.now();
  private turnConfig: TurnConfig | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private room: any = null;
  private localStream: MediaStream | null = null;

  // Single source of truth for peer states and verified connections
  private peerTracker = new PeerTracker();
  private remoteStreams: Map<string, MediaStream> = new Map(); // peerId -> stream
  private chatHistory: ChatMessage[] = [];
  private fileSources = new Map<string, { file: NativeChatFile; autoAcceptUntil: number }>();
  private fileSessions = new Map<string, FileSession>();
  private pendingFileRequests = new Map<string, FileRequest>();
  private requestedImagePreviews = new Set<string>();
  private revokedFileMessages = new Set<string>();
  private fileAction: any = null;
  private seenChatRevisions: Set<string> = new Set();
  private chatAuth: PeerAuthenticator | null = null;
  private authority: RoomAuthority | null = null;
  private invite: string | null = null;
  private roomName: string;
  private snapshot: NamedRoomInvite | null = null;
  private rootKey: string | null = null;
  private admittedPeers = new Map<string, string>();
  private bannedKeys = new Set<string>();
  private pendingChallenges = new Map<string, string>();
  private admissionHistory: HostCommand[] = [];
  private adminAdmissions = new Map<string, AdminAdmission>();
  private latestPasswordCommand = -1;
  private passwordCommandEpoch = -1;
  private lastAuthoritySummary = 0;
  private localAdmitted = false;
  private guestInOwnedRoom = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private identityAction: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private authorityAction: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private admissionAction: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private inviteAction: any = null;

  // Trystero action references
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private chatAction: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private historyAction: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private presenceAction: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private streamStatusAction: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private streamReqAction: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private leaveAction: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private passwordAction: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private pexAction: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private meshRelayAction: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private watchAction: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private pingAction: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private pongAction: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private appAction: any = null;

  private lastPeerStats: Map<string, { bytesReceived: number; timestamp: number }> = new Map();
  private lastLocalStats: { bytesSent: number; timestamp: number } | null = null;
  private peerStatsCache: Map<string, { stats: PeerStatsInfo; timestamp: number }> = new Map();
  private localStatsCache: { stats: PeerStatsInfo; timestamp: number } | null = null;
  private initialJoinComplete: boolean = false;
  private callbacks: RoomCallbacks | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastStreamsHash: string = '';
  private lastBroadcasterStreamIds: Map<string, string> = new Map();
  private lastStreamRecoveryRequests: Map<string, number> = new Map();
  private lastBridgeAttempts: Map<string, number> = new Map();
  private rumorIntermediaries: Map<string, string> = new Map();
  private announcedPeerNames: Map<string, string> = new Map();
  private initialRosterReceived: boolean = false;
  private existingAtJoinIds: Set<string> = new Set();
  private pendingJoinNotices: Map<string, PeerInfo> = new Map();
  private lastRumorReannounceTime: number = 0;
  private currentTargetBitrate: number = 25000000;
  private currentTargetFps: number = 60;
  private signalingTopic: string = '';
  private rtcConfig: RTCConfiguration | null = null;

  constructor(username: string, roomId: string, password = '', isCreator = false, turnConfig?: TurnConfig) {
    this.username = username;
    const parsedInvite = parseRoomInvite(roomId);
    this.roomId = parsedInvite?.roomId ?? roomId.trim();
    this.invite = parsedInvite ? roomId.trim() : null;
    this.roomName = parsedInvite?.version === 4 ? parsedInvite.name : this.roomId.slice(0, 8);
    this.rootKey = parsedInvite?.rootKey ?? null;
    this.password = password.trim();
    this.isCreator = isCreator;
    this.myJoinedAt = Date.now();
    this.turnConfig = turnConfig || null;

    // Register signaling manager failover handler
    signalingManager.setRoomReconnectionHandler(async (newTransport, previousTransport) => {
      console.log(
        `[GroupRoomManager] Handling signaling failover: ${previousTransport} -> ${newTransport}`
      );
      if (this.callbacks) {
        this.callbacks.onStatusChange(`Sinalização alternada para ${newTransport.toUpperCase()}`);
      }
      await this.reconnectOnNewTransport();
    });
  }

  public getDisplayRoomId(): string {
    return this.roomId;
  }

  public getLocalPeerId(): string { return selfId; }

  public sendAppEvent(event: AppWireEvent, target?: string): void {
    if (!this.appAction || (this.authority && !this.localAdmitted)) return;
    if (target) {
      const key = this.chatAuth?.getKnownKey(target);
      if (this.peerTracker.isVerified(target) &&
          (!this.authority || (key && this.admittedPeers.get(target) === key)))
        void this.appAction.send(event, { target });
    } else {
      this.sendRoomAction(this.appAction, event);
    }
  }

  public getInvite(): string | null { return this.invite; }
  public getRoomName(): string { return this.roomName; }

  public getPassword(): string {
    return this.password;
  }

  public getSignalingStatus(): SignalingStatus {
    return signalingManager.getStatus();
  }

  public getDetailedTransportStatus(): TransportStatusInfo {
    return signalingManager.getDetailedStatus();
  }

  public async switchSignalingTransport(transport: SignalingTransport): Promise<boolean> {
    return signalingManager.switchTransport(transport);
  }

  public isRoomHost(): boolean {
    return this.authority ? this.authority.isLocalHost() : this.peerTracker.isHost(selfId, this.myJoinedAt, this.isCreator);
  }

  public isRoomAdmin(): boolean {
    return Boolean(this.chatAuth && this.hasAdminGrant(this.chatAuth.publicKey));
  }

  public isPeerAdmin(peerId: string): boolean {
    const key = this.chatAuth?.getKnownKey(peerId);
    return Boolean(key && this.hasAdminGrant(key));
  }

  private hasAdminGrant(key: string): boolean {
    if (!this.authority || this.bannedKeys.has(key)) return false;
    const latest = latestAdminCommand(this.admissionHistory, this.authority.epoch, key);
    if (this.snapshot?.epoch === this.authority.epoch &&
        (!latest || latest.sequence <= this.snapshot.revision)) {
      return this.snapshot.adminKeys.includes(key);
    }
    return latest?.kind === 'admin';
  }

  private adminGrant(key: string): HostCommand | undefined {
    if (!this.authority || !this.hasAdminGrant(key)) return undefined;
    return this.admissionHistory.filter((command) => command.epoch === this.authority?.epoch &&
      command.kind === 'admin' && command.targetKey === key)
      .sort((left, right) => right.sequence - left.sequence)[0];
  }

  private retainAdmissionHistory(): void {
    const latestRoles = new Map<string, HostCommand>();
    for (const command of this.admissionHistory) {
      if ((command.kind !== 'admin' && command.kind !== 'revoke-admin') || !command.targetKey) continue;
      const key = `${command.epoch}:${command.targetKey}`;
      if ((latestRoles.get(key)?.sequence ?? -1) < command.sequence) latestRoles.set(key, command);
    }
    const roles = [...latestRoles.values()].sort((left, right) => left.sequence - right.sequence).slice(-200);
    const otherLimit = 200 - roles.length;
    const others = otherLimit > 0 ? this.admissionHistory.filter((command) =>
      command.kind !== 'admin' && command.kind !== 'revoke-admin').slice(-otherLimit) : [];
    this.admissionHistory = [...roles, ...others];
  }

  private reportPeerJoined(peer: PeerInfo): void {
    if (!this.isCreator && !this.initialRosterReceived) {
      this.pendingJoinNotices.set(peer.id, peer);
      return;
    }
    this.callbacks?.onPeerJoined?.(peer, !this.isCreator && this.existingAtJoinIds.has(peer.id));
  }

  private getPeersPayload(): PeerExchangeItem[] {
    const list: PeerExchangeItem[] = [
      {
        peerId: selfId,
        username: this.username,
        isStreaming: Boolean(this.localStream),
        isCreator: this.isCreator,
        joinedAt: this.myJoinedAt,
      },
    ];

    const verifiedPeers = this.peerTracker.getVerifiedPeers().filter((peer) =>
      !this.authority || this.isAdmittedPeer(peer.id));
    verifiedPeers.forEach((p) => {
      list.push({
        peerId: p.id,
        username: p.username,
        isStreaming: this.peerTracker.isStreaming(p.id),
        isCreator: this.peerTracker.isPeerCreator(p.id),
        joinedAt: this.peerTracker.getJoinedAt(p.id) || Date.now(),
      });
    });

    return list;
  }

  private admittedTargets(): string[] {
    return Array.from(this.peerTracker.directConnectedPeers).filter((peerId) =>
      !this.authority || (this.localAdmitted && this.isAdmittedPeer(peerId)));
  }

  private isAdmittedPeer(peerId: string): boolean {
    const key = this.chatAuth?.getKnownKey(peerId);
    return Boolean(this.peerTracker.isVerified(peerId) && key && !this.bannedKeys.has(key) &&
      this.admittedPeers.get(peerId) === key);
  }

  // Trystero broadcasts to every connected edge, including peers awaiting admission.
  // Room content must be addressed only to established members.
  private sendRoomAction(action: { send: (data: unknown, options?: { target: string }) => unknown } | null,
    data: unknown): void {
    if (!action) return;
    if (!this.authority) {
      void action.send(data);
      return;
    }
    for (const peerId of this.admittedTargets()) void action.send(data, { target: peerId });
  }

  public async join(callbacks: RoomCallbacks) {
    this.callbacks = callbacks;
    callbacks.onStatusChange('Conectando...');
    console.log(
      `[P2P] Joining room ${this.roomId} (Password Protected: ${Boolean(this.password)}) as ${
        this.username
      } (Self ID: ${selfId})`
    );

    this.rtcConfig = buildRtcConfiguration(this.turnConfig);

    signalingManager.setRoomReconnectionHandler(async () => {
      await this.reconnectOnNewTransport();
    });

    try {
      const saved = this.invite ? await savedRooms.get(this.roomId) : undefined;
      const incomingInvite = this.invite ? await verifyRoomInvite(this.invite) : null;
      if (this.invite && !incomingInvite) throw new Error('Room invitation signature is invalid');
      if (saved && parseRoomInvite(saved.invite)?.rootKey !== this.rootKey) {
        throw new Error('Room identifier is pinned to another creator key');
      }
      const savedInvite = saved ? await verifyRoomInvite(saved.invite) : null;
      const preferredInvite = incomingInvite && savedInvite &&
        compareRoomInvites(savedInvite, incomingInvite) > 0 ? savedInvite : incomingInvite;
      if (preferredInvite?.version === 4) {
        this.invite = formatRoomInvite(preferredInvite);
        this.snapshot = preferredInvite;
        this.roomName = preferredInvite.name;
      } else if (saved) {
        this.roomName = saved.name;
      }
      this.guestInOwnedRoom = Boolean(saved?.owned && !this.isCreator);
      this.chatAuth = await PeerAuthenticator.create(this.roomId, selfId,
        this.guestInOwnedRoom ? undefined : saved?.identity);
      if (this.rootKey) {
        this.authority = new RoomAuthority(this.roomId, this.rootKey, this.chatAuth);
        if (this.snapshot && !await this.authority.importChain(this.snapshot.authorityChain)) {
          throw new Error('Invitation authority chain is invalid');
        }
        if (saved?.authorityChain && !await this.authority.importChain(saved.authorityChain)) {
          throw new Error('Saved room authority chain is invalid');
        }
        if (this.snapshot) this.authority.observeRevision(this.snapshot.revision);
        if (this.isCreator && !this.authority.isLocalHost()) throw new Error('Creator key does not match invitation');
        this.isCreator = this.authority.isLocalHost();
        this.localAdmitted = this.authority.isLocalHost();
        if (saved?.hostCommands) {
          for (const command of saved.hostCommands) await this.acceptHostCommand(command);
        }
        if (this.isRoomAdmin()) this.localAdmitted = true;
        if (!this.guestInOwnedRoom) await savedRooms.put({
          roomId: this.roomId, invite: this.invite!, name: this.roomName,
          customName: saved ? savedRoomCustomName(saved) : undefined,
          saved: saved?.saved ?? this.isCreator, owned: this.isCreator,
          protected: saved?.protected ?? Boolean(this.password),
          password: saved?.password, identity: this.chatAuth.exportIdentity(),
          authorityChain: this.authority.history(),
          hostCommands: this.admissionHistory,
        });
      }
      this.signalingTopic = this.invite ? `public-${this.roomId}` : await computeSignalingRoomId(this.roomId, this.password);
      console.log(`[P2P] Computed signaling topic: "${this.signalingTopic}"`);

      this.setupRoomInstance();
      if (this.isCreator && (!this.snapshot || this.snapshot.epoch < this.authority!.epoch)) {
        await this.publishSnapshot(this.roomName);
      }
      this.callbacks?.onInviteChange?.(this.invite ?? '', this.roomName);
      if (this.isCreator) {
        await this.sendSystemMessage(`Sala criada: ${this.roomName}`, 'info', undefined, this.roomId);
      }
      await this.sendSystemMessage(`${this.username} entrou`, 'join', this.username);
      this.notifyStreamsUpdate();
      this.notifyPeersUpdate();
      callbacks.onStatusChange(this.isCreator ? 'Sala Ativa' : 'Procurando Participantes...');
    } catch (err) {
      console.error('[P2P] Fatal room join error:', err);
      callbacks.onStatusChange('Erro ao conectar na sala');
    }
  }

  private setupRoomInstance(): void {
    const joinErrorHandler = createJoinErrorHandler((formattedMsg, details) => {
      console.warn(`[P2P/ICE Diagnostics] ${formattedMsg}`, details);
      if (this.callbacks && this.peerTracker.directConnectedPeers.size === 0) {
        this.callbacks.onStatusChange(formattedMsg);
      }
    });

    this.room = signalingManager.joinRoom(
      {
        appId: APP_ID,
        rtcConfig: this.rtcConfig,
        rtcPolyfill: createFileOptimizedPeerConnection(),
        // WebRTC is a full mesh: every participant must advertise so two
        // joiners can establish their own direct edge, not only reach the creator.
        passive: false,
      },
      this.signalingTopic,
      {
        onJoinError: joinErrorHandler,
      }
    );

    this.bindRoomActions();
    this.bindRoomListeners();
    this.startHeartbeatLoop();

    // Proactive rendezvous beacons on room join:
    // Repeatedly broadcast presence on MQTT brokers at rapid intervals so existing peers in the room
    // discover us immediately without waiting for 5.3s Trystero ticks.
    [100, 400, 1000, 2200].forEach((delay) => {
      setTimeout(() => {
        if (this.room && this.signalingTopic) {
          signalingManager.reannounce(this.signalingTopic);
        }
      }, delay);
    });
  }

  private async reconnectOnNewTransport(): Promise<void> {
    if (!this.callbacks || !this.signalingTopic) return;

    console.log('[P2P] Re-establishing room bindings on new transport...');
    // Replacing the Trystero room closes its old WebRTC channels. Old-room
    // onPeerLeave callbacks are ignored, so explicitly retire those edges.
    Array.from(this.peerTracker.directConnectedPeers).forEach((peerId) => this.removePeer(peerId));
    this.initialRosterReceived = false;
    this.existingAtJoinIds.clear();
    this.pendingJoinNotices.clear();
    this.setupRoomInstance();

    // Re-announce presence and PEX
    if (this.presenceAction) {
      this.sendRoomAction(this.presenceAction, {
        username: this.username,
        isCreator: this.isCreator,
        isStreaming: Boolean(this.localStream),
        joinedAt: this.myJoinedAt,
      });
    }

    // Re-announce active stream if currently sharing
    if (this.localStream && this.streamStatusAction) {
      const payload = MediaCoordinator.buildStreamStatusPayload(this.localStream, true, this.username);
      this.sendRoomAction(this.streamStatusAction, payload);

      const verified = Array.from(this.peerTracker.directConnectedPeers);
      if (verified.length > 0) {
        verified.forEach((pId) => this.sendStreamToPeer(pId));
      }
    }

    this.notifyPeersUpdate();
    this.notifyStreamsUpdate();
  }

  private isConsistentChatClaim(message: ChatMessage): boolean {
    if (message.systemRoom && message.systemRoom !== this.roomId) return false;
    const knownName = this.announcedPeerNames.has(message.authorId || '')
      ? this.peerTracker.getUsername(message.authorId || '') : undefined;
    if (message.isHost && !this.peerTracker.isPeerCreator(message.authorId || '')) return false;
    if (!knownName) return false;
    if (!message.isSystem) return message.sender === knownName && !message.systemType &&
      !message.systemActor && !message.systemRoom && !message.systemAppKind;
    if (message.sender !== 'Sistema' || message.revision !== 0 || message.editedAt || message.deletedAt) return false;
    if (message.systemRoom) return message.systemType === 'info' &&
      (this.rootKey ? message.authorKey === this.rootKey :
        this.peerTracker.isPeerCreator(message.authorId || '')) &&
      message.text.startsWith('Sala criada: ') && message.text.length <= 95 &&
      !message.systemActor && !message.systemAppKind;
    if (message.systemActor !== knownName) return false;
    if (message.systemType === 'app-start' || message.systemType === 'app-stop') {
      const app = message.systemAppKind && getRoomApp(message.systemAppKind);
      return Boolean(app && message.text === (message.systemType === 'app-start'
        ? `${knownName} iniciou ${app.label}` : `${knownName} encerrou ${app.label}`));
    }
    if (message.systemAppKind) return false;
    const expected: Partial<Record<NonNullable<ChatMessage['systemType']>, string>> = {
      join: `${knownName} entrou`,
      leave: `${knownName} saiu`,
      'stream-start': `${knownName} iniciou uma transmissão`,
      'stream-stop': `${knownName} parou de transmitir`,
    };
    if (message.systemType === 'info') return this.peerTracker.getHostPeerId(selfId, this.myJoinedAt, this.isCreator) === message.authorId &&
      message.text === `Senha alterada por ${knownName}`;
    if (!message.systemType || !expected[message.systemType]) return false;
    return message.text === expected[message.systemType];
  }

  private canTrackRumor(peerId: string): boolean {
    return this.peerTracker.isVerified(peerId) ||
      this.peerTracker.getPendingRumors().includes(peerId) ||
      this.peerTracker.getPendingRumors().length < 64;
  }

  private syncHostRole(): void {
    if (!this.authority || !this.chatAuth) return;
    this.isCreator = this.authority.isLocalHost();
    const host = this.peerTracker.getVerifiedPeers().find((peer) =>
      this.chatAuth?.getKnownKey(peer.id) === this.authority?.currentKey);
    if (host) this.admittedPeers.set(host.id, this.authority.currentKey);
    this.peerTracker.setAuthenticatedHost(host?.id ?? null);
    this.callbacks?.onHostChange?.(this.isCreator);
    if (this.invite && (!this.guestInOwnedRoom || this.authority.isLocalHost())) {
      void savedRooms.get(this.roomId).then((record) => {
        if (record && this.authority && this.chatAuth) {
          if (this.authority.isLocalHost()) this.guestInOwnedRoom = false;
          return savedRooms.put({ ...record, invite: this.invite ?? record.invite,
            name: this.roomName, owned: this.authority.isLocalHost(),
            identity: this.authority.isLocalHost() ? this.chatAuth.exportIdentity() : record.identity,
            authorityChain: this.authority.history() });
        }
      }).catch((error) => console.warn('[Rooms] Failed to persist host transition:', error));
    }
    this.notifyPeersUpdate();
  }

  private announceToPeer(peerId: string): void {
    if (!this.room || !this.peerTracker.isVerified(peerId)) return;
    if (this.authority && (!this.localAdmitted || !this.isAdmittedPeer(peerId))) return;
    this.presenceAction?.send({
      username: this.username, isCreator: this.isRoomHost(),
      isStreaming: Boolean(this.localStream), joinedAt: this.myJoinedAt,
    }, { target: peerId });
    this.pexAction?.send({ peers: this.getPeersPayload() }, { target: peerId });
    this.historyAction?.send({ history: this.chatHistory }, { target: peerId });
    this.historyAction?.send({ request: true }, { target: peerId });
    if (this.localStream) this.sendStreamToPeer(peerId);
  }

  private applyAdmittedPeer(peerId: string, key: string): void {
    if (this.bannedKeys.has(key)) return;
    this.admittedPeers.set(peerId, key);
    if (peerId === selfId) {
      this.localAdmitted = true;
      this.callbacks?.onStatusChange(this.turnConfig?.forceRelay
        ? 'P2P (Relay Seguro)'
        : `P2P Conectado (${signalingManager.getActiveTransport().toUpperCase()})`);
    }
    if (this.chatAuth?.getKnownKey(peerId) === key && peerId !== selfId) this.announceToPeer(peerId);
    this.notifyPeersUpdate();
    void this.sendAuthoritySummary(peerId === selfId ? undefined : peerId).catch((error) =>
      console.warn('[Rooms] Initial authority reconciliation failed:', error));
  }

  private removeKickedPeer(peerId: string, key: string): void {
    this.bannedKeys.add(key);
    this.admittedPeers.delete(peerId);
    if (peerId === selfId && this.chatAuth?.publicKey === key) {
      this.localAdmitted = false;
      this.callbacks?.onStatusChange('Você foi removido da sala');
      void this.leave();
      return;
    }
    const connection = this.room?.getPeers?.()?.[peerId] as RTCPeerConnection | undefined;
    connection?.close();
    this.removePeer(peerId);
  }

  private async issueAdmission(peerId: string): Promise<void> {
    if (!this.authority?.isLocalHost() || !this.chatAuth) return;
    const key = this.chatAuth.getKnownKey(peerId);
    if (!key || this.bannedKeys.has(key) || this.admissionHistory.some((item) =>
      item.epoch === this.authority?.epoch && item.kind === 'admit' && item.targetPeerId === peerId && item.targetKey === key)) return;
    const command = await this.authority.makeCommand('admit', { targetPeerId: peerId, targetKey: key });
    this.admissionHistory.push(command);
    this.retainAdmissionHistory();
    await this.persistHostCommands();
    this.applyAdmittedPeer(peerId, key);
    await this.admissionAction?.send({ kind: 'command', command });
    await this.admissionAction?.send({ kind: 'sync', commands: this.admissionHistory }, { target: peerId });
  }

  private async issueAdminAdmission(peerId: string): Promise<void> {
    if (!this.authority || !this.chatAuth || !this.localAdmitted) return;
    const key = peerId === selfId ? this.chatAuth.publicKey : this.chatAuth.getKnownKey(peerId);
    const grant = this.adminGrant(this.chatAuth.publicKey);
    if (!key || !grant || this.bannedKeys.has(key)) return;
    const admission = await this.authority.signAdminAdmission(peerId, key, grant);
    this.adminAdmissions.set(peerId, admission);
    if (peerId !== selfId) this.applyAdmittedPeer(peerId, key);
    await this.admissionAction?.send({ kind: 'admin-admit', admission });
    await this.admissionAction?.send({ kind: 'sync', commands: this.admissionHistory }, { target: peerId });
  }

  private async acceptAdminAdmission(admission: AdminAdmission): Promise<void> {
    if (!this.authority || !this.chatAuth || !await this.authority.verifyAdminAdmission(admission) ||
        this.bannedKeys.has(admission.adminKey) || this.bannedKeys.has(admission.targetKey)) return;
    const knownGrant = this.admissionHistory.some((command) => command.epoch === admission.epoch &&
      command.sequence === admission.grant.sequence);
    if (!knownGrant) await this.acceptHostCommand(admission.grant);
    if (this.adminGrant(admission.adminKey)?.sequence !== admission.grant.sequence) return;
    const targetKey = admission.targetPeerId === selfId
      ? this.chatAuth.publicKey : this.chatAuth.getKnownKey(admission.targetPeerId);
    if (!targetKey) {
      this.adminAdmissions.set(admission.targetPeerId, admission);
      return;
    }
    if (targetKey !== admission.targetKey) return;
    this.adminAdmissions.set(admission.targetPeerId, admission);
    this.applyAdmittedPeer(admission.targetPeerId, admission.targetKey);
  }

  private async persistHostCommands(): Promise<void> {
    if (!this.invite || !this.authority) return;
    const record = await savedRooms.get(this.roomId);
    if (record) await savedRooms.put({ ...record, hostCommands: this.admissionHistory.slice(-200) });
  }

  private async persistRememberedPassword(): Promise<void> {
    if (!this.invite) return;
    const record = await savedRooms.get(this.roomId);
    if (record?.password !== undefined) await savedRooms.put({ ...record, password: this.password });
  }

  private async persistSnapshot(): Promise<void> {
    if (!this.invite) return;
    const record = await savedRooms.get(this.roomId);
    if (record) await savedRooms.put({ ...record, invite: this.invite, name: this.roomName,
      customName: savedRoomCustomName(record) });
    this.callbacks?.onInviteChange?.(this.invite, this.roomName);
  }

  private activeAdminKeys(): string[] {
    if (!this.authority) return [];
    const keys = new Set<string>();
    for (const command of this.admissionHistory) {
      if (command.epoch === this.authority.epoch && command.targetKey &&
          (command.kind === 'admin' || command.kind === 'revoke-admin')) keys.add(command.targetKey);
    }
    if (this.snapshot?.epoch === this.authority.epoch) {
      for (const key of this.snapshot.adminKeys) keys.add(key);
    }
    return [...keys].filter((key) => this.hasAdminGrant(key)).sort();
  }

  private async publishSnapshot(name: string): Promise<boolean> {
    if (!this.authority?.isLocalHost() || !this.chatAuth || !this.rootKey ||
        !validRoomName(name)) return false;
    const revision = this.authority.nextSnapshotRevision();
    const snapshot = await signRoomInvite({
      version: 4, roomId: this.roomId, rootKey: this.rootKey, name,
      epoch: this.authority.epoch, revision, adminKeys: this.activeAdminKeys(),
      authorityChain: this.authority.history(),
    }, this.chatAuth);
    this.snapshot = snapshot;
    this.roomName = name;
    this.invite = formatRoomInvite(snapshot);
    await this.persistSnapshot();
    this.sendRoomAction(this.inviteAction, { invite: this.invite });
    this.notifyPeersUpdate();
    return true;
  }

  private async acceptSnapshot(value: string): Promise<void> {
    if (!this.authority || !this.rootKey || typeof value !== 'string' || value.length > 30010) return;
    const candidate = await verifyRoomInvite(value);
    if (!candidate || candidate.version !== 4 || candidate.roomId !== this.roomId ||
        candidate.rootKey !== this.rootKey) return;
    if (this.snapshot && compareRoomInvites(candidate, this.snapshot) <= 0) return;
    const knownChain = this.authority.history();
    if (candidate.epoch < this.authority.epoch ||
        !isAuthorityChainPrefix(knownChain, candidate.authorityChain)) return;
    if (!await this.authority.importChain(candidate.authorityChain)) return;
    this.authority.observeRevision(candidate.revision);
    this.snapshot = candidate;
    this.invite = value;
    this.roomName = candidate.name;
    if (this.isRoomAdmin() && !this.localAdmitted) {
      this.localAdmitted = true;
      await this.issueAdminAdmission(selfId);
    }
    this.syncHostRole();
    await this.persistSnapshot();
    this.notifyPeersUpdate();
  }

  public async updateRoomName(name: string): Promise<boolean> {
    return this.publishSnapshot(name.trim());
  }

  private async sendAuthoritySummary(peerId?: string): Promise<void> {
    if (!this.authority || !this.localAdmitted || !this.admissionAction) return;
    const targets = peerId ? [peerId] : this.admittedTargets();
    const fingerprint = await roomStateFingerprint(this.authority.epoch, this.admissionHistory);
    for (const target of targets) {
      const key = this.chatAuth?.getKnownKey(target);
      if (!key || this.admittedPeers.get(target) !== key) continue;
      await this.admissionAction.send({ kind: 'summary', epoch: this.authority.epoch, fingerprint },
        { target });
      if (this.snapshot && this.invite) {
        await this.inviteAction?.send({ invite: this.invite }, { target });
      }
    }
  }

  private async acceptHostCommand(command: HostCommand): Promise<void> {
    if (!this.authority || !await this.authority.verifyCommand(command)) return;
    if (!this.admissionHistory.some((item) => item.epoch === command.epoch && item.sequence === command.sequence)) {
      this.admissionHistory.push(command);
      this.retainAdmissionHistory();
      void this.persistHostCommands();
    }
    if (command.kind === 'admit' && command.targetPeerId && command.targetKey) {
      this.applyAdmittedPeer(command.targetPeerId, command.targetKey);
      if (command.targetPeerId === selfId) {
        for (const peerId of this.peerTracker.directConnectedPeers) {
          if (this.admittedPeers.has(peerId)) this.announceToPeer(peerId);
        }
      }
    } else if (command.kind === 'kick' && command.targetPeerId && command.targetKey) {
      this.removeKickedPeer(command.targetPeerId, command.targetKey);
    } else if (command.kind === 'admin' && command.targetKey) {
      if (command.targetKey === this.chatAuth?.publicKey && this.isRoomAdmin()) {
        this.localAdmitted = true;
        this.callbacks?.onStatusChange('Administrador conectado');
      }
      this.notifyPeersUpdate();
    } else if (command.kind === 'revoke-admin' && command.targetKey) {
      if (!this.hasAdminGrant(command.targetKey)) {
        for (const [peerId, admission] of this.adminAdmissions) {
          if (admission.adminKey === command.targetKey) this.adminAdmissions.delete(peerId);
        }
      }
      this.notifyPeersUpdate();
    } else if (command.kind === 'password' && typeof command.password === 'string' &&
               (command.epoch > this.passwordCommandEpoch ||
                (command.epoch === this.passwordCommandEpoch &&
                 command.sequence > this.latestPasswordCommand))) {
      this.passwordCommandEpoch = command.epoch;
      this.latestPasswordCommand = command.sequence;
      this.password = command.password;
      void this.persistRememberedPassword();
      this.callbacks?.onPasswordChange?.(this.password, 'Anfitrião');
    }
  }

  private bindRoomActions(): void {
    if (!this.room) return;
    const boundRoom = this.room;

    this.appAction = this.room.makeAction('room_apps');
    this.appAction.onMessage = (event: AppWireEvent, meta: { peerId: string }) => {
      if (!event || typeof event !== 'object' || JSON.stringify(event).length > 4_000_000) return;
      this.callbacks?.onAppEvent?.(event, meta.peerId);
    };

    this.inviteAction = this.room.makeAction('room_invite_sync');
    this.inviteAction.onMessage = async (data: { invite?: string }, meta: { peerId: string }) => {
      if (!data || typeof data.invite !== 'string' || !this.chatAuth?.getKnownKey(meta.peerId)) return;
      await this.acceptSnapshot(data.invite);
    };

    this.identityAction = this.room.makeAction('peer_identity');
    this.identityAction.onMessage = async (data: {
      kind?: string; nonce?: string; key?: string; signature?: string;
    }, meta: { peerId: string }) => {
      if (!this.chatAuth || !data || typeof data.nonce !== 'string' ||
          !/^[0-9a-f-]{20,50}$/.test(data.nonce)) return;
      if (data.kind === 'challenge') {
        const signature = await this.chatAuth.signControl('identity', [this.roomId, selfId, data.nonce]);
        if (this.room === boundRoom) await this.identityAction.send({
          kind: 'proof', nonce: data.nonce, key: this.chatAuth.publicKey, signature,
        }, { target: meta.peerId });
      } else if (data.kind === 'proof' && data.key && data.signature &&
                 this.pendingChallenges.get(meta.peerId) === data.nonce &&
                 !this.bannedKeys.has(data.key) &&
                 await this.chatAuth.verifyControl('identity',
                   [this.roomId, meta.peerId, data.nonce], data.signature, data.key)) {
        if (this.room !== boundRoom || !this.chatAuth.pinDirect(meta.peerId, data.key)) return;
        this.pendingChallenges.delete(meta.peerId);
        if (this.invite && this.snapshot) {
          await this.inviteAction?.send({ invite: this.invite }, { target: meta.peerId });
        }
        this.syncHostRole();
        if (this.authority?.isPeerHost(meta.peerId)) {
          this.admittedPeers.set(meta.peerId, data.key);
        }
        const pendingAdminAdmission = this.adminAdmissions.get(meta.peerId);
        if (pendingAdminAdmission) await this.acceptAdminAdmission(pendingAdminAdmission);
        if (this.isRoomAdmin()) {
          for (const admission of this.adminAdmissions.values()) {
            await this.admissionAction?.send({ kind: 'admin-admit', admission }, { target: meta.peerId });
          }
        }
        if (this.admittedPeers.get(meta.peerId) === data.key) this.announceToPeer(meta.peerId);
        if (this.admittedPeers.get(meta.peerId) === data.key) {
          await this.sendAuthoritySummary(meta.peerId);
        }
        if (this.authority?.isPeerHost(meta.peerId) || this.isPeerAdmin(meta.peerId)) {
          await this.admissionAction?.send({ kind: 'request', password: this.password }, { target: meta.peerId });
        } else if (this.authority?.isLocalHost() || this.isRoomAdmin()) {
          if (this.isRoomAdmin()) await this.issueAdminAdmission(selfId);
          await this.admissionAction?.send({ kind: 'prompt' }, { target: meta.peerId });
        } else {
          await this.admissionAction?.send({ kind: 'admin-hello-request' }, { target: meta.peerId });
        }
      }
    };

    this.authorityAction = this.room.makeAction('room_authority');
    this.authorityAction.onMessage = async (data: {
      kind?: string; chain?: AuthorityTransfer[];
      proposal?: Omit<AuthorityTransfer, 'nextSignature'>; transfer?: AuthorityTransfer;
    }, meta: { peerId: string }) => {
      if (!this.authority || !data) return;
      if (data.kind === 'request') {
        await this.authorityAction.send({ kind: 'chain', chain: this.authority.history() }, { target: meta.peerId });
      } else if (data.kind === 'chain' && data.chain && await this.authority.importChain(data.chain)) {
        if (this.room !== boundRoom) return;
        this.syncHostRole();
        await this.admissionAction?.send({ kind: 'sync-request' }, { target: meta.peerId });
        for (const peerId of this.peerTracker.directConnectedPeers) {
          if (this.authority.isPeerHost(peerId) || this.isPeerAdmin(peerId)) {
            await this.admissionAction?.send({ kind: 'request', password: this.password }, { target: peerId });
          }
        }
      } else if (data.kind === 'offer' && data.proposal?.nextPeerId === selfId) {
        try {
          const transfer = await this.authority.acceptTransfer(data.proposal);
          if (this.room === boundRoom) await this.authorityAction.send({ kind: 'commit', transfer });
        } catch {}
      } else if (data.kind === 'commit' && data.transfer) {
        if (await this.authority.applyTransfer(data.transfer) && this.room === boundRoom) {
          this.syncHostRole();
          if (this.isRoomHost()) {
            await this.authorityAction.send({ kind: 'chain', chain: this.authority.history() });
            await this.publishSnapshot(this.roomName);
            for (const peerId of this.peerTracker.directConnectedPeers) await this.issueAdmission(peerId);
          }
        }
      }
    };

    this.admissionAction = this.room.makeAction('room_admission');
    this.admissionAction.onMessage = async (data: {
      kind?: string; password?: string; command?: HostCommand; commands?: HostCommand[];
      admission?: AdminAdmission; epoch?: number; fingerprint?: string;
    }, meta: { peerId: string }) => {
      if (!this.authority || !this.chatAuth || !data) return;
      const senderKey = this.chatAuth.getKnownKey(meta.peerId);
      const trustedStateSender = Boolean(senderKey &&
        (this.authority.isPeerHost(meta.peerId) || this.isPeerAdmin(meta.peerId) ||
         (this.localAdmitted && this.admittedPeers.get(meta.peerId) === senderKey)));
      if (data.kind === 'request' && (this.authority.isLocalHost() || this.isRoomAdmin())) {
        const key = this.chatAuth.getKnownKey(meta.peerId);
        const returningMember = Boolean(key && !this.bannedKeys.has(key) &&
          this.admissionHistory.some((command) => command.kind === 'admit' && command.targetKey === key));
        if (key && (data.password === this.password || returningMember)) {
          if (this.authority.isLocalHost()) await this.issueAdmission(meta.peerId);
          else await this.issueAdminAdmission(meta.peerId);
        } else if (key) {
          await this.admissionAction.send({ kind: 'denied' }, { target: meta.peerId });
        }
      } else if (data.kind === 'prompt' && (this.authority.isPeerHost(meta.peerId) || this.isPeerAdmin(meta.peerId))) {
        await this.admissionAction.send({ kind: 'request', password: this.password }, { target: meta.peerId });
      } else if (data.kind === 'admin-hello-request' && this.isRoomAdmin()) {
        await this.issueAdminAdmission(selfId);
      } else if (data.kind === 'sync-request' && this.localAdmitted && senderKey &&
                  this.admittedPeers.get(meta.peerId) === senderKey) {
        await this.admissionAction.send({ kind: 'sync', commands: this.admissionHistory }, { target: meta.peerId });
      } else if (data.kind === 'summary' && trustedStateSender && this.localAdmitted &&
                 Number.isSafeInteger(data.epoch) && typeof data.fingerprint === 'string' &&
                 /^[0-9a-f]{64}$/.test(data.fingerprint)) {
        const localFingerprint = await roomStateFingerprint(this.authority.epoch, this.admissionHistory);
        if (data.epoch !== this.authority.epoch || data.fingerprint !== localFingerprint) {
          await this.authorityAction?.send({ kind: 'chain', chain: this.authority.history() },
            { target: meta.peerId });
          await this.admissionAction.send({ kind: 'sync', commands: this.admissionHistory },
            { target: meta.peerId });
        }
      } else if (data.kind === 'sync' && trustedStateSender &&
                 Array.isArray(data.commands) && data.commands.length <= 200) {
        for (const command of data.commands) await this.acceptHostCommand(command);
      } else if (data.kind === 'command' && data.command) {
        await this.acceptHostCommand(data.command);
      } else if (data.kind === 'admin-admit' && data.admission &&
                 data.admission.adminKey === this.chatAuth.getKnownKey(meta.peerId)) {
        await this.acceptAdminAdmission(data.admission);
        if (data.admission.targetPeerId === meta.peerId && this.isPeerAdmin(meta.peerId)) {
          await this.admissionAction.send({ kind: 'request', password: this.password }, { target: meta.peerId });
        }
      } else if (data.kind === 'denied' &&
                 (this.authority.isPeerHost(meta.peerId) || this.isPeerAdmin(meta.peerId))) {
        this.callbacks?.onStatusChange('Senha incorreta para esta sala');
      }
    };

    // 0. Setup Live Room Password Sync Action
    this.passwordAction = this.room.makeAction('room_password_sync');
    this.passwordAction.onMessage = (data: { newPassword?: string }, meta: { peerId: string }) => {
      if (this.authority) return;
      if (meta.peerId !== this.peerTracker.getHostPeerId(selfId, this.myJoinedAt, this.isCreator)) return;
      if (data && typeof data.newPassword === 'string' && data.newPassword.length <= 128) {
        this.password = data.newPassword.trim();
        if (this.callbacks?.onPasswordChange) {
          this.callbacks.onPasswordChange(this.password, this.peerTracker.getUsername(meta.peerId) || 'Participante');
        }
      }
    };

    // 1. Setup Chat Action with In-Mesh Forwarding & Deduplication
    this.chatAction = this.room.makeAction('chat');
    this.chatAction.onMessage = async (msg: ChatMessage, meta: { peerId: string }) => {
      if (!this.chatAuth || !await this.chatAuth.verify(msg, meta.peerId)) return;
      if (this.room !== boundRoom) return;
      if (!this.isConsistentChatClaim(msg)) return;
      const revisionKey = chatRevisionKey(msg);
      if (this.seenChatRevisions.has(revisionKey)) return;
      const merged = mergeChatHistory(this.chatHistory, [msg]);
      if (!chatHistoryChanged(this.chatHistory, merged)) return;
      this.seenChatRevisions.add(revisionKey);
      this.chatHistory = merged;
      if (msg.deletedAt && msg.file) {
        for (const [requestId, session] of this.fileSessions) {
          if (session.messageId === msg.id) void this.cancelFileTransfer(requestId);
        }
      }
      if (this.callbacks) {
        this.callbacks.onChat(msg);
      }

      // Mesh forward to guarantee 100% room delivery across mesh
      try {
        this.sendRoomAction(this.chatAction, msg);
      } catch {}
    };

    this.fileAction = this.room.makeAction('chat_file_v2');
    this.fileAction.onMessage = (packet: FilePacket | Uint8Array, meta: { peerId: string }) => {
      if (packet instanceof Uint8Array) void this.handleFileChunkWire(packet, meta.peerId);
      else void this.handleFilePacket(packet, meta.peerId);
    };

    // 2. Setup Chat History Sync Action (P2P pull from host / peers)
    this.historyAction = this.room.makeAction('history_sync');
    this.historyAction.onMessage = async (
      data: { request?: boolean; history?: ChatMessage[] },
      meta: { peerId: string }
    ) => {
      const peerId = meta.peerId;
      if (data?.request === true) {
        this.historyAction.send({ history: this.chatHistory }, { target: peerId });
      } else if (Array.isArray(data?.history) && data.history.length > 0 && data.history.length <= 1000) {
        const verified: ChatMessage[] = [];
        for (const message of data.history) {
          if (this.chatAuth && await this.chatAuth.verify(message, peerId) &&
              this.isConsistentChatClaim(message)) verified.push(message);
        }
        if (this.room !== boundRoom) return;
        const merged = mergeChatHistory(this.chatHistory, verified);
        if (chatHistoryChanged(this.chatHistory, merged)) {
          merged.forEach((m) => this.seenChatRevisions.add(chatRevisionKey(m)));
          this.chatHistory = merged;
          if (this.callbacks) {
            this.callbacks.onChatHistory(this.chatHistory);
          }
        }
      }
    };

    // 3. Setup Presence Action (Exchange usernames, host status & broadcast stream state)
    this.presenceAction = this.room.makeAction('presence');
    this.presenceAction.onMessage = (
      data: { username: string; isCreator?: boolean; isStreaming?: boolean; joinedAt?: number },
      meta: { peerId: string }
    ) => {
      const peerId = meta.peerId;
      if (!data || typeof data.username !== 'string' || data.username.length > 80 ||
          (data.joinedAt !== undefined && !Number.isFinite(data.joinedAt)) ||
          (data.isCreator !== undefined && typeof data.isCreator !== 'boolean') ||
          (data.isStreaming !== undefined && typeof data.isStreaming !== 'boolean')) return;
      this.peerTracker.touchPeer(peerId);

      const suppliedName = typeof data.username === 'string' ? data.username.trim() : '';
      if (suppliedName && this.peerTracker.getVerifiedPeers().some((peer) =>
        peer.id !== peerId && peer.username.toLocaleLowerCase() === suppliedName.toLocaleLowerCase())) return;
      const newName = suppliedName || this.peerTracker.getUsername(peerId) || `Usuário (${peerId.slice(0, 4)})`;
      this.peerTracker.addPeer(peerId, newName,
        this.authority ? this.authority.isPeerHost(peerId) : Boolean(data.isCreator), data.joinedAt);

      if (suppliedName) {
        const alreadyAnnounced = this.announcedPeerNames.has(peerId);
        this.announcedPeerNames.set(peerId, suppliedName);
        if (!alreadyAnnounced) {
          this.reportPeerJoined({
            id: peerId,
            username: suppliedName,
            connectionState: 'connected',
            joinedAt: this.peerTracker.getJoinedAt(peerId) || Date.now(),
            isCreator: this.authority ? this.authority.isPeerHost(peerId) : Boolean(data.isCreator),
          });
          // A signed history may arrive before the sender's role/name presence.
          // Retry after identity metadata is pinned so claims can be validated.
          try { this.historyAction?.send({ request: true }, { target: peerId }); } catch {}
        }
      }

      const wasStreaming = this.peerTracker.isStreaming(peerId);
      if (data.isStreaming) {
        this.peerTracker.setStreaming(peerId, true);
        if (!wasStreaming && this.initialJoinComplete) {
          this.callbacks?.onStreamStarted?.(peerId, newName, false);
        }
      } else if (data.isStreaming === false) {
        this.peerTracker.setStreaming(peerId, false);
        if (this.remoteStreams.has(peerId)) {
          this.remoteStreams.delete(peerId);
        }
        if (wasStreaming) {
          this.callbacks?.onStreamStopped?.(peerId, newName, false);
          this.cleanupStreamWatchers(peerId, newName);
        }
      }

      // If I am currently streaming, push stream to this peer on presence
      if (this.localStream) {
        this.sendStreamToPeer(peerId);
      }

      // Proactive stream request for joining existing sessions:
      // If this peer is broadcasting and we do not have their stream yet, request it!
      if (data.isStreaming && !this.remoteStreams.has(peerId)) {
        this.requestStreamFromPeer(peerId);
      }

      this.notifyPeersUpdate();
      this.notifyStreamsUpdate();
      this.callbacks?.onStatusChange(
        this.turnConfig?.forceRelay
          ? 'P2P (Relay Seguro)'
          : `P2P Conectado (${signalingManager.getActiveTransport().toUpperCase()})`
      );
    };

    // 4. Setup Stream Status Action (Screen share toggle bug fix & stream recovery protocol)
    this.streamStatusAction = this.room.makeAction('stream_status');
    this.streamStatusAction.onMessage = (data: StreamStatusPayload, meta: { peerId: string }) => {
      if (!data || typeof data.isStreaming !== 'boolean' ||
          (data.streamId !== undefined && (typeof data.streamId !== 'string' || data.streamId.length > 100))) return;
      const peerId = meta.peerId;
      this.peerTracker.touchPeer(peerId);

      const senderName = this.peerTracker.getUsername(peerId) || `Participante (${peerId.slice(0, 4)})`;
      const wasStreaming = this.peerTracker.isStreaming(peerId);

      if (data.isStreaming) {
        this.peerTracker.setStreaming(peerId, true);
        if (!wasStreaming) {
          this.callbacks?.onStreamStarted?.(peerId, senderName, false);
        }

        // STREAM RECOVERY PROTOCOL:
        // If viewer has no active stream, or its track ended, or streamId changed on toggle, request stream!
        const currentStream = this.remoteStreams.get(peerId);
        const lastKnownStreamId = this.lastBroadcasterStreamIds.get(peerId);
        if (MediaCoordinator.shouldRequestStreamRecovery(currentStream, data, lastKnownStreamId)) {
          const now = Date.now();
          const lastReqTime = this.lastStreamRecoveryRequests.get(peerId) || 0;
          if (now - lastReqTime > 8000) {
            this.lastStreamRecoveryRequests.set(peerId, now);
            if (data.streamId) {
              this.lastBroadcasterStreamIds.set(peerId, data.streamId);
            }
            console.log(
              `[P2P/Recovery] Triggering stream recovery request for broadcaster ${peerId} (streamId: ${data.streamId})`
            );
            if (this.streamReqAction) {
              const reqPayload: StreamRequestPayload = {
                request: true,
                broadcasterId: peerId,
                requesterId: selfId,
                reason: 'stream_resumed',
              };
              this.streamReqAction.send(reqPayload, { target: peerId });
            }
          }
        } else if (data.streamId) {
          this.lastBroadcasterStreamIds.set(peerId, data.streamId);
        }
      } else {
        this.peerTracker.setStreaming(peerId, false);
        if (this.remoteStreams.has(peerId)) {
          this.remoteStreams.delete(peerId);
        }
        if (wasStreaming) {
          this.callbacks?.onStreamStopped?.(peerId, senderName, false);
          this.cleanupStreamWatchers(peerId, senderName);
        }
      }
      this.notifyStreamsUpdate();
    };

    // 4.5. Setup Live Watch Status Action (Tracks who is watching whose screen share)
    this.watchAction = this.room.makeAction('watch_status');
    this.watchAction.onMessage = (
      data: { broadcasterId?: string; isWatching?: boolean; watcherName?: string },
      meta: { peerId: string }
    ) => {
      const watcherPeerId = meta.peerId;
      if (!data || typeof data.isWatching !== 'boolean') return;
      const watcherName = this.peerTracker.getUsername(watcherPeerId) || `Participante (${watcherPeerId.slice(0, 4)})`;
      const broadcasterId = data.broadcasterId;
      if (typeof broadcasterId !== 'string' ||
          (broadcasterId !== selfId && !this.peerTracker.isVerified(broadcasterId))) return;

      const currentWatchers = this.peerTracker.getWatchers(broadcasterId);
      const isAlreadyWatching = currentWatchers.some((w) => w.peerId === watcherPeerId);

      if (data.isWatching) {
        if (!isAlreadyWatching) {
          this.peerTracker.addWatcher(broadcasterId, watcherPeerId, watcherName);
          this.callbacks?.onWatchStarted?.(watcherPeerId, watcherName, broadcasterId);
          this.notifyStreamsUpdate();
        }
      } else {
        if (isAlreadyWatching) {
          this.peerTracker.removeWatcher(broadcasterId, watcherPeerId);
          this.callbacks?.onWatchStopped?.(watcherPeerId, watcherName, broadcasterId);
          this.notifyStreamsUpdate();
        }
      }
    };

    // 5. Setup On-Demand Stream Request Action (Stream Recovery Protocol Receiver)
    this.streamReqAction = this.room.makeAction('stream_req');
    this.streamReqAction.onMessage = (data: { request?: boolean; broadcasterId?: string; requesterId?: string }, meta: { peerId: string }) => {
      if (!data || data.request !== true || (data.broadcasterId && data.broadcasterId !== selfId) ||
          (data.requesterId && data.requesterId !== meta.peerId)) return;
      const requesterId = meta.peerId;
      this.peerTracker.touchPeer(requesterId);

      console.log(`[P2P] Received stream request from peer ${requesterId}`);
      if (this.localStream) {
        this.sendStreamToPeer(requesterId);
      }
    };

    // 6. Setup Explicit Peer Leave Action (Instant ghost peer elimination)
    this.leaveAction = this.room.makeAction('peer_leave');
    this.leaveAction.onMessage = (data: { peerId?: string } | unknown, meta: { peerId: string }) => {
      const payloadPid = (data as { peerId?: string })?.peerId;
      if (payloadPid && payloadPid !== meta.peerId) return;
      const targetPid = meta.peerId;
      console.log(`[P2P] Received explicit leave notice for peer ${targetPid}`);
      this.removePeer(targetPid);
    };

    // 7. Setup Peer Exchange (PEX) - Distinguishes verified direct peers from unverified gossip rumors
    this.pexAction = this.room.makeAction('peer_exchange');
    this.pexAction.onMessage = (data: { peers?: PeerExchangeItem[] }, meta: { peerId: string }) => {
      if (!data || !Array.isArray(data.peers) || data.peers.length > 32) return;
      this.peerTracker.touchPeer(meta.peerId);

      if (!this.isCreator) {
        this.existingAtJoinIds.add(meta.peerId);
        data.peers.forEach((peer) => {
          if (typeof peer?.peerId === 'string' && peer.peerId.length <= 80) this.existingAtJoinIds.add(peer.peerId);
        });
        if (!this.initialRosterReceived) {
          this.initialRosterReceived = true;
          this.pendingJoinNotices.forEach((peer) => {
            this.existingAtJoinIds.add(peer.id);
            this.callbacks?.onPeerJoined?.(peer, true);
          });
          this.pendingJoinNotices.clear();
        }
      }

      let hasNewRumors = false;
      data.peers.forEach((p) => {
        if (p && typeof p.peerId === 'string' && p.peerId.length > 0 && p.peerId.length <= 80 &&
            p.peerId !== selfId && this.canTrackRumor(p.peerId)) {
          const isDirect = this.peerTracker.isVerified(p.peerId);
          if (isDirect) return;
          if (!isDirect) {
            this.rumorIntermediaries.set(p.peerId, meta.peerId);
            hasNewRumors = true;
          }
          this.peerTracker.receivePeerExchange(p.peerId, false,
            typeof p.username === 'string' ? p.username.slice(0, 80) : undefined);

          // If peer is not yet directly connected to us, bridge via intermediary peer
          if (!isDirect && !this.peerTracker.isVerified(p.peerId)) {
            this.bridgeIndirectPeer(p.peerId, meta.peerId, p.username);
          }
        }
      });

      if (hasNewRumors) {
        this.notifyPeersUpdate();
        this.notifyStreamsUpdate();
      }
    };

    // 8. Setup In-Mesh Signaling Relay (Forwarding messages between unbridged peers)
    this.meshRelayAction = this.room.makeAction('mesh_relay');
    this.meshRelayAction.onMessage = (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data: { target: string; origin: string; kind: string; payload: any },
      meta: { peerId: string }
    ) => {
      if (!data || typeof data.origin !== 'string' || !data.origin || data.origin.length > 80 ||
          typeof data.target !== 'string' || data.target.length > 80) return;
      if (data.origin === selfId || !this.canTrackRumor(data.origin)) return;
      this.peerTracker.touchPeer(meta.peerId);

      if (data.target === selfId || data.target === 'all') {
        if (data.kind === 'mesh_hello') {
          console.log(`[P2P/Mesh] Received mesh_hello from indirect peer ${data.origin}`);
          const p = data.payload || {};
          this.rumorIntermediaries.set(data.origin, meta.peerId);
          this.peerTracker.receivePeerExchange(data.origin, false, typeof p.username === 'string' ? p.username.slice(0, 80) : undefined);

          // Reply with mesh_ack back through the intermediary
          if (this.meshRelayAction) {
            try {
              this.meshRelayAction.send(
                {
                  target: data.origin,
                  origin: selfId,
                  kind: 'mesh_ack',
                  payload: {
                    username: this.username,
                    isCreator: this.isCreator,
                    joinedAt: this.myJoinedAt,
                    isStreaming: Boolean(this.localStream),
                  },
                },
                { target: meta.peerId }
              );
            } catch {}
          }

          // Force signaling re-announcement on the broker to immediately pair the indirect peers!
          if (this.signalingTopic) {
            signalingManager.reannounce(this.signalingTopic, data.origin);
          }
        } else if (data.kind === 'mesh_ack') {
          console.log(`[P2P/Mesh] Received mesh_ack from indirect peer ${data.origin}`);
          const p = data.payload || {};
          this.rumorIntermediaries.set(data.origin, meta.peerId);
          this.peerTracker.receivePeerExchange(data.origin, false, typeof p.username === 'string' ? p.username.slice(0, 80) : undefined);

          // Force signaling re-announcement on the broker
          if (this.signalingTopic) {
            signalingManager.reannounce(this.signalingTopic, data.origin);
          }
        } else if (data.kind === 'stream_req' && data.origin === meta.peerId && this.localStream) {
          this.sendStreamToPeer(data.origin);
        }
      } else if (data.target && this.peerTracker.hasPeer(data.target)) {
        try {
          this.meshRelayAction.send(data, { target: data.target });
        } catch {}
      }
    };

    // 8.5. Setup Ping / Pong for latency & connection health
    this.pingAction = this.room.makeAction('peer_ping');
    this.pongAction = this.room.makeAction('peer_pong');

    this.pingAction.onMessage = (data: { t: number }, meta: { peerId: string }) => {
      if (Number.isFinite(data?.t) && Math.abs(Date.now() - data.t) < 30000 && this.pongAction) {
        try {
          this.pongAction.send({ t: data.t }, { target: meta.peerId });
        } catch {}
      }
    };

    this.pongAction.onMessage = (data: { t: number }, meta: { peerId: string }) => {
      if (Number.isFinite(data?.t) && Math.abs(Date.now() - data.t) < 30000) {
        const ping = Math.max(1, Date.now() - data.t);
        this.peerTracker.setPing(meta.peerId, ping);
      }
    };

    // Trystero delivers action handlers asynchronously. A queued message from
    // the previous transport must not mutate the replacement room's state.
    [
      this.passwordAction, this.chatAction, this.historyAction, this.presenceAction,
      this.streamStatusAction, this.streamReqAction, this.leaveAction,
      this.pexAction, this.meshRelayAction, this.watchAction,
      this.pingAction, this.pongAction, this.identityAction,
      this.authorityAction, this.admissionAction, this.inviteAction,
      this.appAction, this.fileAction,
    ].forEach((action) => {
      if (!action?.onMessage) return;
      const handler = action.onMessage;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      action.onMessage = (...args: any[]) => {
        if (this.room !== boundRoom) return;
        if (!this.peerTracker.isVerified(args[1]?.peerId)) return;
        if (this.authority && ![this.identityAction, this.authorityAction, this.admissionAction,
          this.inviteAction].includes(action)) {
          const peerId = args[1]?.peerId;
          if (!this.localAdmitted || !this.chatAuth?.getKnownKey(peerId) ||
              this.admittedPeers.get(peerId) !== this.chatAuth.getKnownKey(peerId)) return;
        }
        return handler(...args);
      };
    });
  }

  private bindRoomListeners(): void {
    if (!this.room) return;
    const boundRoom = this.room;

    // 9. Direct WebRTC Peer Lifecycle Listeners
    this.room.onPeerJoin = (peerId: string) => {
      if (this.room !== boundRoom) return;
      console.log(`[P2P] Direct WebRTC peer connection active: ${peerId}`);

      // Verify and record direct WebRTC connection
      this.peerTracker.receivePeerExchange(peerId, true);
      this.rumorIntermediaries.delete(peerId);
      signalingManager.setPeerConnected(peerId);

      // Instantly acknowledge peer on signaling broker to ensure both directions are open
      if (this.signalingTopic) {
        signalingManager.reannounce(this.signalingTopic, peerId);
      }

      if (this.authority) {
        const nonce = crypto.randomUUID();
        this.pendingChallenges.set(peerId, nonce);
        this.identityAction?.send({ kind: 'challenge', nonce }, { target: peerId });
        this.authorityAction?.send({ kind: 'request' }, { target: peerId });
        this.admissionAction?.send({ kind: 'sync-request' }, { target: peerId });
        this.notifyPeersUpdate();
        return;
      }

      // Send presence immediately to new peer
      if (this.presenceAction) {
        this.presenceAction.send(
          {
            username: this.username,
            isCreator: this.isCreator,
            isStreaming: Boolean(this.localStream),
            joinedAt: this.myJoinedAt,
          },
          { target: peerId }
        );
      }

      // Share known peers via PEX immediately to bridge mesh
      if (this.pexAction) {
        this.pexAction.send({ peers: this.getPeersPayload() }, { target: peerId });
      }

      // A room may connect after the initial timed request. Exchange both
      // directions so the newcomer and existing peers recover missed events.
      if (this.historyAction) {
        this.historyAction.send({ history: this.chatHistory }, { target: peerId });
        this.historyAction.send({ request: true }, { target: peerId });
      }

      // If I am already sharing a stream, broadcast it to the new peer with burst bitrate
      if (this.localStream) {
        this.sendStreamToPeer(peerId);
      }

      this.notifyPeersUpdate();
      this.notifyStreamsUpdate();
      this.callbacks?.onStatusChange(
        this.turnConfig?.forceRelay
          ? 'P2P (Relay Seguro)'
          : `P2P Conectado (${signalingManager.getActiveTransport().toUpperCase()})`
      );
    };

    this.room.onPeerLeave = (peerId: string) => {
      if (this.room !== boundRoom) return;
      console.log(`[P2P] Peer left room: ${peerId}`);
      this.removePeer(peerId);
    };

    // 10. Incoming Stream Listener
    this.room.onPeerStream = (stream: MediaStream, peerId: string) => {
      if (this.room !== boundRoom) return;
      if (!this.peerTracker.isVerified(peerId)) return;
      if (this.authority && (!this.localAdmitted || !this.isAdmittedPeer(peerId))) return;
      console.log(`[P2P] Received stream from peer: ${peerId}`);
      this.peerTracker.touchPeer(peerId);
      this.peerTracker.setStreaming(peerId, true);
      this.remoteStreams.set(peerId, stream);
      this.lastStreamRecoveryRequests.delete(peerId);
      this.watchStream(peerId);

      // Listen to track state so if host stops, remote stream clears cleanly
      stream.getTracks().forEach((track) => {
        track.onended = () => {
          console.log(`[P2P] Track ended for peer: ${peerId}`);
          if (this.remoteStreams.get(peerId)?.id === stream.id) {
            this.remoteStreams.delete(peerId);
            this.notifyStreamsUpdate();
          }
        };
      });

      // Eliminate video receiver jitter buffer delay for true real-time P2P while protecting audio NetEQ
      try {
        const peers = this.room?.getPeers?.() || {};
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const peerObj: any = peers[peerId];
        const pc: RTCPeerConnection = peerObj?.connection || peerObj?.pc || peerObj;
        if (pc) {
          MediaCoordinator.tuneReceiverJitterBuffer(pc);
        }
      } catch {}

      this.notifyStreamsUpdate();
      this.callbacks?.onStatusChange('Ao Vivo');
    };
  }

  private startHeartbeatLoop(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);

    // Continuous presence heartbeat, PEX sync & Ghost Peer Pruner (every 2.0s)
    this.heartbeatTimer = setInterval(() => {
      if (!this.room) return;

      // Broadcast presence
      if (this.presenceAction) {
        this.sendRoomAction(this.presenceAction, {
          username: this.username,
          isCreator: this.isCreator,
          isStreaming: Boolean(this.localStream),
          joinedAt: this.myJoinedAt,
        });
      }

      // Broadcast PEX to bridge any disconnected pairs in the mesh
      if (this.pexAction) {
        this.sendRoomAction(this.pexAction, { peers: this.getPeersPayload() });
      }

      // Ping all active verified peers for live latency calculation
      if (this.pingAction) {
        this.peerTracker.directConnectedPeers.forEach((pid) => {
          try {
            if (!this.authority || this.admittedTargets().includes(pid)) {
              this.pingAction.send({ t: Date.now() }, { target: pid });
            }
          } catch {}
        });
      }

      // Refresh keyframes periodically (every 2.0s) during active broadcast to maintain crystal clarity and prevent QP lock
      if (this.localStream) {
        const peers = this.room?.getPeers?.() || {};
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        Object.values(peers).forEach((peerObj: any) => {
          const pc: RTCPeerConnection = peerObj?.connection || peerObj?.pc || peerObj;
          if (pc) {
            MediaCoordinator.requestKeyFrame(pc);
          }
        });
      }

      // Continuous presence re-announcement on broker until direct peers connect or if rumors exist
      const hasNoDirectPeers = this.peerTracker.directConnectedPeers.size === 0;
      const rumors = this.peerTracker.getPendingRumors();
      const now = Date.now();
      if (this.authority && now - this.lastAuthoritySummary >= 20_000) {
        this.lastAuthoritySummary = now;
        void this.sendAuthoritySummary().catch((error) =>
          console.warn('[Rooms] Authority reconciliation failed:', error));
      }
      if (
        (hasNoDirectPeers || rumors.length > 0) &&
        this.signalingTopic &&
        now - this.lastRumorReannounceTime > 2500
      ) {
        this.lastRumorReannounceTime = now;
        signalingManager.reannounce(this.signalingTopic);
        rumors.forEach((rId) => {
          const intermediary = this.rumorIntermediaries.get(rId);
          if (intermediary && this.peerTracker.isVerified(intermediary)) {
            this.bridgeIndirectPeer(rId, intermediary, this.peerTracker.getRumorUsername(rId));
          }
          signalingManager.reannounce(this.signalingTopic, rId);
        });
      }

      // Prune ghost peers that missed heartbeats, but ONLY if their WebRTC connection is not active
      const activePeers = this.room?.getPeers?.() || {};
      const staleCandidateIds = this.peerTracker.getStalePeerIds(25000);
      if (staleCandidateIds.length > 0) {
        staleCandidateIds.forEach((p) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const peerObj: any = activePeers[p];
          const pc: RTCPeerConnection = peerObj?.connection || peerObj?.pc || peerObj;
          if (pc && (pc.connectionState === 'connected' || pc.iceConnectionState === 'connected')) {
            // WebRTC channel is physically alive - refresh touch so it isn't dropped falsely
            this.peerTracker.touchPeer(p);
            return;
          }

          console.log(`[P2P] Pruning ghost peer due to timeout and disconnected WebRTC channel: ${p}`);
          this.removePeer(p);
        });
      }
    }, 2000);

    // Initial broadcast and request history from room
    setTimeout(() => {
      this.initialJoinComplete = true;
      if (this.historyAction) {
        this.sendRoomAction(this.historyAction, { request: true });
      }
      if (this.presenceAction) {
        this.sendRoomAction(this.presenceAction, {
          username: this.username,
          isCreator: this.isCreator,
          isStreaming: Boolean(this.localStream),
          joinedAt: this.myJoinedAt,
        });
      }
    }, 400);
  }

  private removePeer(peerId: string) {
    for (const [requestId, session] of this.fileSessions) {
      if (session.peerId !== peerId) continue;
      this.fileSessions.delete(requestId);
      if (session.preview) this.requestedImagePreviews.delete(session.messageId);
      if (session.direction === 'receive' && !session.preview) void invoke('cancel_chat_download', { id: requestId });
      this.emitFileProgress(requestId, 'cancelled', session.offset, session.messageId, session.direction, session.total);
    }
    for (const [requestId, request] of this.pendingFileRequests) {
      if (request.peerId === peerId) this.removePendingFileRequest(requestId);
    }
    const announcedName = this.announcedPeerNames.get(peerId);
    this.announcedPeerNames.delete(peerId);
    this.pendingJoinNotices.delete(peerId);
    this.existingAtJoinIds.delete(peerId);
    this.peerTracker.removePeer(peerId);

    signalingManager.setPeerDisconnected(peerId);

    if (this.remoteStreams.has(peerId)) {
      this.remoteStreams.delete(peerId);
    }
    this.lastPeerStats.delete(peerId);
    this.peerStatsCache.delete(peerId);
    this.lastBroadcasterStreamIds.delete(peerId);
    this.lastStreamRecoveryRequests.delete(peerId);
    this.lastBridgeAttempts.delete(peerId);
    this.rumorIntermediaries.delete(peerId);

    if (announcedName) {
      this.callbacks?.onPeerLeft?.(peerId, announcedName);
    }

    this.notifyPeersUpdate();
    this.notifyStreamsUpdate();
  }

  private cleanupStreamWatchers(broadcasterId: string, _broadcasterName: string) {
    const watchers = this.peerTracker.getWatchers(broadcasterId);
    watchers.forEach((w) => {
      this.peerTracker.removeWatcher(broadcasterId, w.peerId);
      this.callbacks?.onWatchStopped?.(w.peerId, w.username, broadcasterId);
    });
    this.notifyStreamsUpdate();
  }

  private bridgeIndirectPeer(targetPeerId: string, intermediaryPeerId: string, targetUsername?: string): void {
    if (
      !targetPeerId ||
      targetPeerId === selfId ||
      targetPeerId === this.username ||
      targetPeerId === 'local' ||
      this.peerTracker.isVerified(targetPeerId)
    ) {
      return;
    }

    const now = Date.now();
    const lastAttempt = this.lastBridgeAttempts.get(targetPeerId) || 0;
    if (now - lastAttempt < 2500) {
      return;
    }
    this.lastBridgeAttempts.set(targetPeerId, now);

    console.log(`[P2P/Mesh] Bridging indirect peer ${targetPeerId} via intermediary ${intermediaryPeerId}`);

    // Proactively re-announce on signaling broker targeting the indirect peer
    if (this.signalingTopic) {
      signalingManager.reannounce(this.signalingTopic, targetPeerId);
    }

    if (this.meshRelayAction) {
      try {
        this.meshRelayAction.send(
          {
            target: targetPeerId,
            origin: selfId,
            kind: 'mesh_hello',
            payload: {
              username: this.username,
              isCreator: this.isCreator,
              joinedAt: this.myJoinedAt,
              isStreaming: Boolean(this.localStream),
              targetUsername,
            },
          },
          { target: intermediaryPeerId }
        );
      } catch (err) {
        console.warn(`[P2P/Mesh] Failed to send mesh_hello to ${targetPeerId}:`, err);
      }
    }
  }

  public watchStream(broadcasterId: string) {
    if (broadcasterId === 'local' || broadcasterId === selfId) return;
    const currentWatchers = this.peerTracker.getWatchers(broadcasterId);
    const alreadyWatching = currentWatchers.some((w) => w.peerId === selfId);
    if (alreadyWatching) return;

    this.peerTracker.addWatcher(broadcasterId, selfId, this.username);

    if (this.watchAction) {
      try {
        this.sendRoomAction(this.watchAction, {
          broadcasterId,
          isWatching: true,
          watcherName: this.username,
        });
      } catch {}
    }

    this.callbacks?.onWatchStarted?.(selfId, this.username, broadcasterId);
    this.notifyStreamsUpdate();
  }

  public stopWatchingStream(broadcasterId: string) {
    const currentWatchers = this.peerTracker.getWatchers(broadcasterId);
    const wasWatching = currentWatchers.some((w) => w.peerId === selfId);
    if (!wasWatching) return;

    this.peerTracker.removeWatcher(broadcasterId, selfId);

    if (this.watchAction) {
      try {
        this.sendRoomAction(this.watchAction, {
          broadcasterId,
          isWatching: false,
          watcherName: this.username,
        });
      } catch {}
    }

    this.callbacks?.onWatchStopped?.(selfId, this.username, broadcasterId);
    this.notifyStreamsUpdate();
  }

  public requestStreamFromPeer(peerId: string) {
    if (peerId === 'local') return;
    console.log(`[P2P] Requesting live stream from peer ${peerId}`);
    if (this.streamReqAction) {
      const payload: StreamRequestPayload = {
        request: true,
        broadcasterId: peerId,
        requesterId: selfId,
        reason: 'initial_join',
      };
      this.streamReqAction.send(payload, { target: peerId });
    }
    if (this.meshRelayAction) {
      this.sendRoomAction(this.meshRelayAction, {
        target: peerId,
        origin: selfId,
        kind: 'stream_req',
        payload: { request: true },
      });
    }
  }

  /**
   * Targeted Stream Dispatch strictly passing `{ target: peerId }` to eliminate transceiver leaks.
   */
  public sendStreamToPeer(peerId: string) {
    if (!this.localStream || !this.room || !this.peerTracker.isVerified(peerId)) return;
    if (this.authority && (!this.localAdmitted || !this.isAdmittedPeer(peerId))) return;
    try {
      const peers = this.room.getPeers?.() || {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const peerObj: any = peers[peerId];
      const pc: RTCPeerConnection = peerObj?.connection || peerObj?.pc || peerObj;

      if (pc) {
        MediaCoordinator.patchPeerConnectionSdp(pc);
        MediaCoordinator.configureCodecPreferences(pc);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (typeof pc.addEventListener === 'function' && !(pc as any).__p2_stable_listener_attached) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (pc as any).__p2_stable_listener_attached = true;
          pc.addEventListener('signalingstatechange', () => {
            if (pc.signalingState === 'stable') {
              MediaCoordinator.applySenderBitrate(pc, this.currentTargetBitrate, this.currentTargetFps);
              MediaCoordinator.requestKeyFrame(pc);
            }
          });
        }
      }

      // Targeted addStream dispatch passing `{ target: peerId }` object option
      MediaCoordinator.targetedAddStream(this.room, this.localStream, peerId);

      [0, 30, 80, 150, 300, 600, 1200, 2000].forEach((delay) => {
        setTimeout(() => this.boostSenders(this.currentTargetBitrate, this.currentTargetFps), delay);
      });
    } catch (err) {
      console.warn('[P2P] Error sending stream to peer, fallback:', err);
      try {
        MediaCoordinator.targetedAddStream(this.room, this.localStream, peerId);
      } catch {}
    }
  }

  public shareStream(stream: MediaStream, targetBitrateBps: number = 25000000, targetFps: number = 60) {
    const wasStreaming = Boolean(this.localStream);
    this.localStream = stream;
    this.currentTargetBitrate = targetBitrateBps;
    this.currentTargetFps = targetFps;

    this.callbacks?.onStreamStarted?.('local', this.username, true);
    if (!wasStreaming && stream && this.room) {
      void this.sendSystemMessage(`${this.username} iniciou uma transmissão`, 'stream-start', this.username)
        .catch((error) => console.warn('[Chat] Failed to publish stream notice:', error));
    }

    if (this.room && stream) {
      try {
        const verifiedPeers = Array.from(this.peerTracker.directConnectedPeers);
        if (verifiedPeers.length > 0) {
          verifiedPeers.forEach((pId) => this.sendStreamToPeer(pId));
        } else {
          if (!this.authority) MediaCoordinator.broadcastStream(this.room, stream);
        }
        [0, 30, 80, 150, 300, 600, 1200, 2000].forEach((delay) => {
          setTimeout(() => this.boostSenders(targetBitrateBps, targetFps), delay);
        });
      } catch (err) {
        console.warn('[P2P] Error adding broadcast stream:', err);
      }

      // Screen share toggle protocol: emit stream_status with streamId
      if (this.streamStatusAction) {
        const payload = MediaCoordinator.buildStreamStatusPayload(stream, true, this.username);
        this.sendRoomAction(this.streamStatusAction, payload);
      }

      this.notifyStreamsUpdate();
    }
  }

  public boostSenders(maxBitrateBps: number = 25000000, maxFps: number = 60) {
    try {
      const peers = this.room?.getPeers?.() || {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      Object.values(peers).forEach((peerObj: any) => {
        const pc: RTCPeerConnection = peerObj?.connection || peerObj?.pc || peerObj;
        if (pc) {
          MediaCoordinator.patchPeerConnectionSdp(pc);
          MediaCoordinator.configureCodecPreferences(pc);
          MediaCoordinator.applySenderBitrate(pc, maxBitrateBps, maxFps);
          MediaCoordinator.requestKeyFrame(pc);
        }
      });
    } catch {}
  }

  public stopStream() {
    const wasStreaming = Boolean(this.localStream);
    const streamToStop = this.localStream;
    this.localStream = null;
    this.lastLocalStats = null;

    if (this.room) {
      if (streamToStop) {
        try {
          this.room.removeStream(streamToStop);
        } catch (err) {
          console.warn('[P2P] Error removing stream:', err);
        }
      }

      // Explicitly tear down all WebRTC senders and inactivate transceivers so Chromium/WebView2
      // immediately calls encoder_->Release(), shutting down the GPU NVENC hardware pipeline!
      try {
        const peers = this.room.getPeers?.() || {};
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        Object.values(peers).forEach((peerObj: any) => {
          const pc: RTCPeerConnection = peerObj?.connection || peerObj?.pc || peerObj;
          if (pc) {
            if (typeof pc.getSenders === 'function') {
              pc.getSenders().forEach((sender) => {
                try {
                  if (sender.track) {
                    sender.track.stop();
                  }
                  if (typeof sender.replaceTrack === 'function') {
                    sender.replaceTrack(null).catch(() => {});
                  }
                  pc.removeTrack(sender);
                } catch {}
              });
            }

            if (typeof pc.getTransceivers === 'function') {
              pc.getTransceivers().forEach((transceiver) => {
                try {
                  if (transceiver.sender && typeof transceiver.sender.replaceTrack === 'function') {
                    transceiver.sender.replaceTrack(null).catch(() => {});
                  }
                  if (transceiver.direction === 'sendonly') {
                    transceiver.direction = 'inactive';
                  } else if (transceiver.direction === 'sendrecv') {
                    transceiver.direction = 'recvonly';
                  }
                } catch {}
              });
            }
          }
        });
      } catch (err) {
        console.warn('[P2P] Error releasing peer transceivers:', err);
      }
    }

    if (streamToStop) {
      try {
        streamToStop.getTracks().forEach((track) => {
          try {
            track.stop();
          } catch {}
        });
      } catch {}
    }

    // Screen share toggle protocol: emit stream_status with isStreaming: false
    if (this.streamStatusAction) {
      const payload = MediaCoordinator.buildStreamStatusPayload(null, false, this.username);
      this.sendRoomAction(this.streamStatusAction, payload);
    }

    if (wasStreaming) {
      if (this.room) {
        void this.sendSystemMessage(`${this.username} parou de transmitir`, 'stream-stop', this.username)
          .catch((error) => console.warn('[Chat] Failed to publish stream notice:', error));
      }
      this.callbacks?.onStreamStopped?.('local', this.username, true);
      this.cleanupStreamWatchers('local', this.username);
      this.cleanupStreamWatchers(selfId, this.username);
    }

    this.notifyStreamsUpdate();
  }

  public getAllActiveStreams(): ActiveStreamInfo[] {
    const list: ActiveStreamInfo[] = [];

    // Local stream (if sharing)
    if (this.localStream) {
      list.push({
        peerId: 'local',
        senderName: this.username,
        stream: this.localStream,
        isLocal: true,
      });
    }

    // Remote streams from verified peers
    this.remoteStreams.forEach((stream, peerId) => {
      const senderName = this.peerTracker.getUsername(peerId) || `Participante (${peerId.slice(0, 4)})`;
      list.push({
        peerId,
        senderName,
        stream,
        isLocal: false,
      });
    });

    return list;
  }

  public getAllRoomSlots(): RoomSlotInfo[] {
    const list: RoomSlotInfo[] = [];

    // 1. Local slot (Always present)
    list.push({
      peerId: 'local',
      senderName: this.username,
      stream: this.localStream,
      isStreaming: Boolean(this.localStream),
      isLocal: true,
      color: generateUserColor(this.username),
      watchers: this.getStreamWatchers('local'),
    });

    // Keep indirect peers visible while their own WebRTC edge is negotiated.
    // A rumor never receives media or watcher controls until directly verified.
    this.peerTracker.getAllRoomPeers().forEach((peer) => {
      const peerId = peer.id;
      const isDirect = peer.connectionState === 'connected';
      const uname = peer.username;
      const stream = isDirect ? this.remoteStreams.get(peerId) || null : null;
      const isBroadcasting = isDirect && (this.peerTracker.isStreaming(peerId) || Boolean(stream));
      list.push({
        peerId,
        senderName: uname,
        stream,
        isStreaming: isBroadcasting,
        isLocal: false,
        color: generateUserColor(uname),
        connectionState: peer.connectionState,
        watchers: isDirect ? this.getStreamWatchers(peerId) : [],
      });
    });

    return list;
  }

  public getStreamWatchers(broadcasterId: string): StreamWatcher[] {
    const result: StreamWatcher[] = [];
    const targetKeys = [broadcasterId];
    if (broadcasterId === 'local') targetKeys.push(selfId);
    if (broadcasterId === selfId) targetKeys.push('local');

    const watcherSet = new Set<string>();
    targetKeys.forEach((k) => {
      const watchers = this.peerTracker.getWatchers(k);
      watchers.forEach((w) => watcherSet.add(w.peerId));
    });

    watcherSet.forEach((wPid) => {
      let name =
        wPid === selfId ? this.username : this.peerTracker.getUsername(wPid);
      if (!name) {
        name = `Participante (${wPid.slice(0, 4)})`;
      }
      result.push({ peerId: wPid, username: name });
    });

    return result;
  }

  public getPeerPing(peerId: string): number | null {
    if (peerId === 'local' || peerId === selfId) return 0;
    return this.peerTracker.getPing(peerId) ?? null;
  }

  public async getLocalBroadcasterStats(): Promise<PeerStatsInfo> {
    const now = Date.now();
    if (this.localStatsCache && now - this.localStatsCache.timestamp < 800) {
      return this.localStatsCache.stats;
    }

    let fps: number | null = this.currentTargetFps || 60;
    let width: number | null = null;
    let height: number | null = null;
    let bitrateKbps: number | null = this.localStatsCache?.stats.bitrateKbps ?? null;

    if (!this.localStream || !this.room) {
      const emptyResult: PeerStatsInfo = {
        pingMs: 0,
        fps,
        width,
        height,
        bitrateKbps: null,
        connectionType: 'P2P Direto',
      };
      this.localStatsCache = { stats: emptyResult, timestamp: now };
      return emptyResult;
    }

    try {
      const vTrack = this.localStream.getVideoTracks()[0];
      if (vTrack) {
        const settings = vTrack.getSettings?.();
        if (settings) {
          width = settings.width || null;
          height = settings.height || null;
          if (settings.frameRate) {
            fps = Math.round(settings.frameRate);
          }
        }
      }

      const peers = this.room?.getPeers?.() || {};
      const peerList = Object.values(peers);
      let totalBytesSent = 0;
      let timestamp = Date.now();
      let foundOutbound = false;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const peerObj of peerList as any[]) {
        const pc: RTCPeerConnection = peerObj?.connection || peerObj?.pc || peerObj;
        if (pc && typeof pc.getStats === 'function') {
          const stats = await pc.getStats();
          stats.forEach((report) => {
            if (report.type === 'outbound-rtp' && report.kind === 'video') {
              if (typeof report.bytesSent === 'number') {
                totalBytesSent += report.bytesSent;
                foundOutbound = true;
              }
              if (typeof report.framesPerSecond === 'number' && report.framesPerSecond > 0) {
                fps = Math.round(report.framesPerSecond);
              }
              if (typeof report.timestamp === 'number') {
                timestamp = report.timestamp;
              }
            }
          });
        }
      }

      if (foundOutbound) {
        if (this.lastLocalStats) {
          const deltaBytes = totalBytesSent - this.lastLocalStats.bytesSent;
          const deltaSec = (timestamp - this.lastLocalStats.timestamp) / 1000;
          if (deltaSec >= 0.5 && deltaBytes >= 0) {
            const peerCount = Math.max(1, peerList.length);
            bitrateKbps = Math.round((deltaBytes * 8) / (deltaSec * 1000 * peerCount));
            this.lastLocalStats = { bytesSent: totalBytesSent, timestamp };
          }
        } else {
          this.lastLocalStats = { bytesSent: totalBytesSent, timestamp };
        }
      }
    } catch (err) {
      console.warn('[P2P] Failed to get local broadcaster stats:', err);
    }

    const result: PeerStatsInfo = {
      pingMs: 0,
      fps,
      width,
      height,
      bitrateKbps,
      connectionType: 'P2P Direto',
    };
    this.localStatsCache = { stats: result, timestamp: Date.now() };
    return result;
  }

  public async getPeerStats(peerId: string): Promise<PeerStatsInfo | null> {
    if (peerId === 'local' || peerId === selfId) {
      return this.getLocalBroadcasterStats();
    }
    const now = Date.now();
    const cached = this.peerStatsCache.get(peerId);
    if (cached && now - cached.timestamp < 800) {
      return cached.stats;
    }

    const pingMs = this.getPeerPing(peerId);
    let fps: number | null = null;
    let width: number | null = null;
    let height: number | null = null;
    let bitrateKbps: number | null = cached?.stats.bitrateKbps ?? null;
    let connectionType = 'Rota desconhecida';

    try {
      const peers = this.room?.getPeers?.() || {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const peerObj: any = peers[peerId];
      const pc: RTCPeerConnection = peerObj?.connection || peerObj?.pc || peerObj;
      if (pc && typeof pc.getStats === 'function') {
        const stats = await pc.getStats();
        const routeReports: IceStat[] = [];
        let bytesReceived: number | null = null;
        let timestamp: number = Date.now();

        stats.forEach((report) => {
          routeReports.push(report);
          if (report.type === 'inbound-rtp' && report.kind === 'video') {
            if (typeof report.framesPerSecond === 'number') {
              fps = Math.round(report.framesPerSecond);
            }
            if (typeof report.frameWidth === 'number' && typeof report.frameHeight === 'number') {
              width = report.frameWidth;
              height = report.frameHeight;
            }
            if (typeof report.bytesReceived === 'number') {
              bytesReceived = report.bytesReceived;
            }
            if (typeof report.timestamp === 'number') {
              timestamp = report.timestamp;
            }
          }
        });
        const route = selectedIceRoute(routeReports);
        connectionType = route.connectionType;

        if (bytesReceived !== null) {
          const last = this.lastPeerStats.get(peerId);
          if (last) {
            const deltaBytes = bytesReceived - last.bytesReceived;
            const deltaSec = (timestamp - last.timestamp) / 1000;
            if (deltaSec >= 0.5 && deltaBytes >= 0) {
              bitrateKbps = Math.round((deltaBytes * 8) / (deltaSec * 1000));
              this.lastPeerStats.set(peerId, { bytesReceived, timestamp });
            }
          } else {
            this.lastPeerStats.set(peerId, { bytesReceived, timestamp });
          }
        }

        const result: PeerStatsInfo = {
          pingMs: route.pingMs ?? pingMs,
          fps,
          width,
          height,
          bitrateKbps,
          connectionType,
        };
        this.peerStatsCache.set(peerId, { stats: result, timestamp: Date.now() });
        return result;
      }
    } catch {}

    const fallbackResult: PeerStatsInfo = {
      pingMs,
      fps: null,
      width: null,
      height: null,
      bitrateKbps,
      connectionType,
    };
    this.peerStatsCache.set(peerId, { stats: fallbackResult, timestamp: Date.now() });
    return fallbackResult;
  }

  public async getFileTransportDiagnostics(peerId: string): Promise<{
    connectionType: string; rttMs: number | null; transport: FileTransportDiagnostics;
  } | null> {
    const pc = this.room?.getPeers?.()?.[peerId] as FileOptimizedConnection | undefined;
    if (!pc || pc.connectionState !== 'connected') return null;
    try {
      const reports = Array.from((await pc.getStats()).values()) as IceStat[];
      const route = selectedIceRoute(reports);
      const selected = selectedIcePair(reports);
      const channel = pc.roomDataChannel;
      return {
        connectionType: route.connectionType,
        rttMs: route.pingMs,
        transport: {
          protocol: selected?.local?.protocol ?? selected?.remote?.protocol,
          localCandidateType: selected?.local?.candidateType,
          remoteCandidateType: selected?.remote?.candidateType,
          queuedBytes: channel?.bufferedAmount,
          queueLimitBytes: channel?.bufferedAmountLowThreshold,
          pairBytesSent: selected?.pair.bytesSent,
          pairBytesReceived: selected?.pair.bytesReceived,
          pairTimestamp: performance.now(),
          availableOutgoingBitsPerSecond: selected?.pair.availableOutgoingBitrate,
          packetsDiscardedOnSend: selected?.pair.packetsDiscardedOnSend,
        },
      };
    } catch (error) {
      console.warn('[Files] Could not sample WebRTC transport:', error);
      return null;
    }
  }

  public notifyStreamsUpdate() {
    if (!this.callbacks) return;
    const streams = this.getAllActiveStreams();
    const slots = this.getAllRoomSlots();

    const hash = slots
      .map((s) => `${s.peerId}:${s.senderName}:${s.connectionState}:${s.isStreaming}:${s.stream?.id}:${s.watchers?.length || 0}`)
      .join('|');
    if (hash === this.lastStreamsHash) return;
    this.lastStreamsHash = hash;

    this.callbacks.onStreamsUpdate(streams);
    this.callbacks.onSlotsUpdate(slots);
  }

  public sendChatMessage(text: string, replyToId?: string): Promise<ChatMessage> {
    const original = replyToId ? this.chatHistory.find((message) => message.id === replyToId) : undefined;
    const msg: ChatMessage = {
      id: crypto.randomUUID(),
      sender: this.username,
      text,
      timestamp: Date.now(),
      authorId: selfId,
      revision: 0,
      isHost: this.isCreator,
      replyTo: original && !original.deletedAt && !original.isSystem
        ? { id: original.id, sender: original.sender, text: original.text.slice(0, 200) }
        : undefined,
    };

    return this.publishChatMessage(msg);
  }

  public async offerFile(file: NativeChatFile, name: string, autoAccept: boolean): Promise<ChatMessage> {
    if (!name || name.length > 180 || /[\\/:*?"<>|\x00-\x1f]/.test(name)) throw new Error('Invalid file name');
    const checked = await invoke<NativeChatFile>('inspect_chat_file', { id: file.id });
    if (checked.hash !== file.hash || checked.size !== file.size) throw new Error('Source file changed');
    const id = crypto.randomUUID();
    this.fileSources.set(id, { file, autoAcceptUntil: autoAccept ? Date.now() + 10 * 60_000 : 0 });
    try { const message = await this.publishChatMessage({ id, sender: this.username,
      text: '', timestamp: Date.now(), authorId: selfId, revision: 0, isHost: this.isCreator,
      file: { name, size: file.size, sha256: file.hash,
        isImage: file.isImage && /\.(png|jpe?g|gif|webp|bmp)$/i.test(name) } });
      try { await invoke('remember_chat_file_source', { roomId: this.roomId, messageId: id, sourceId: file.id }); }
      catch (error) { console.warn('[Files] Could not remember source for a future session:', error); }
      return message; }
    catch (error) { this.fileSources.delete(id); throw error; }
  }

  public async requestFile(messageId: string, saveAs: boolean): Promise<string | null> {
    const message = this.chatHistory.find((item) => item.id === messageId && !item.deletedAt);
    const authorPeerId = message?.authorKey && this.peerTracker.getVerifiedPeers().find((peer) =>
      this.chatAuth?.getKnownKey(peer.id) === message.authorKey)?.id;
    if (!message?.file || !authorPeerId || message.authorKey === this.chatAuth?.publicKey ||
        (this.authority && !this.isAdmittedPeer(authorPeerId))) {
      throw new Error('File author is not directly connected');
    }
    const requestId = crypto.randomUUID();
    if (this.fileSessions.size >= 8) throw new Error('Too many active transfers');
    if (!await invoke<boolean>('choose_chat_download', { id: requestId, name: message.file.name,
      size: message.file.size, hash: message.file.sha256, saveAs })) return null;
    this.fileSessions.set(requestId, { messageId, peerId: authorPeerId, peerName: message.sender,
      offset: 0, total: message.file.size, direction: 'receive', timings: newFileTimings() });
    this.emitFileProgress(requestId, 'pending');
    try { await this.sendFilePacket(authorPeerId, { kind: 'request', requestId, messageId }); }
    catch (error) {
      this.fileSessions.delete(requestId);
      await invoke('cancel_chat_download', { id: requestId });
      this.emitFileProgress(requestId, 'error', 0, messageId, 'receive', message.file.size);
      throw error;
    }
    return requestId;
  }

  public async requestFilePreview(messageId: string): Promise<void> {
    const message = this.chatHistory.find((item) => item.id === messageId && !item.deletedAt);
    const authorPeerId = message?.authorKey && this.peerTracker.getVerifiedPeers().find((peer) =>
      this.chatAuth?.getKnownKey(peer.id) === message.authorKey)?.id;
    if (!message?.file?.isImage || message.file.size > MAX_IMAGE_PREVIEW_BYTES ||
        !authorPeerId || message.authorKey === this.chatAuth?.publicKey ||
        this.requestedImagePreviews.has(messageId) ||
        (this.authority && !this.isAdmittedPeer(authorPeerId)) || this.fileSessions.size >= 8) {
      throw new Error('Image preview unavailable');
    }
    this.requestedImagePreviews.add(messageId);
    const requestId = crypto.randomUUID();
    this.fileSessions.set(requestId, { messageId, peerId: authorPeerId, peerName: message.sender,
      offset: 0, total: message.file.size, direction: 'receive', preview: true, chunks: [],
      timings: newFileTimings() });
    this.emitFileProgress(requestId, 'pending');
    try { await this.sendFilePacket(authorPeerId, { kind: 'request', requestId, messageId, preview: true }); }
    catch (error) { this.fileSessions.delete(requestId); this.requestedImagePreviews.delete(messageId);
      this.emitFileProgress(requestId, 'error', 0, messageId, 'receive', message.file.size); throw error; }
  }

  private removePendingFileRequest(requestId: string): void {
    if (this.pendingFileRequests.delete(requestId)) this.callbacks?.onFileRequestCancelled?.(requestId);
  }

  public async answerFileRequest(requestId: string, accept: boolean): Promise<void> {
    const request = this.pendingFileRequests.get(requestId);
    if (!request) return;
    this.removePendingFileRequest(requestId);
    const source = this.fileSources.get(request.messageId);
    const message = this.chatHistory.find((item) => item.id === request.messageId && !item.deletedAt);
    if (!accept || !source || !message?.file || this.revokedFileMessages.has(request.messageId)) {
      await this.sendFilePacket(request.peerId, { kind: 'deny', requestId, messageId: request.messageId });
      return;
    }
    try {
      const checked = await invoke<NativeChatFile>('inspect_chat_file', { id: source.file.id });
      if (checked.hash !== message.file.sha256 || checked.size !== message.file.size || checked.path !== source.file.path) {
        throw new Error('Source file changed or moved');
      }
      if (this.revokedFileMessages.has(request.messageId)) throw new Error('File offer was revoked');
      this.fileSessions.set(requestId, { messageId: request.messageId, peerId: request.peerId,
        peerName: request.peerName, sourceId: source.file.id, offset: 0, total: checked.size,
        direction: 'send', preview: request.preview, sentOffset: 0, timings: newFileTimings() });
      this.emitFileProgress(requestId, 'active');
      await this.sendFilePacket(request.peerId, { kind: 'accept', requestId, messageId: request.messageId });
      if (checked.size > 0) await this.sendNextFileChunks(requestId);
      else { this.fileSessions.delete(requestId); this.emitFileProgress(requestId, 'complete', 0, request.messageId, 'send', 0); }
    } catch (error) {
      this.fileSessions.delete(requestId);
      await this.sendFilePacket(request.peerId, { kind: 'deny', requestId, messageId: request.messageId });
      this.callbacks?.onFileProgress?.({ requestId, messageId: request.messageId, direction: 'send',
        bytes: 0, total: message.file.size, status: 'error', error: String(error), peerId: request.peerId,
        previewOnly: request.preview });
    }
  }

  public async cancelFileTransfer(requestId: string): Promise<void> {
    const session = this.fileSessions.get(requestId);
    if (!session) return;
    this.fileSessions.delete(requestId);
    if (session.preview && session.direction === 'receive') this.requestedImagePreviews.delete(session.messageId);
    if (session.direction === 'receive' && !session.preview) await invoke('cancel_chat_download', { id: requestId });
    try { await this.sendFilePacket(session.peerId, { kind: 'cancel', requestId, messageId: session.messageId }); } catch {}
    this.emitFileProgress(requestId, 'cancelled', session.offset, session.messageId, session.direction, session.total);
  }

  private emitFileProgress(requestId: string, status: FileProgress['status'], bytes?: number,
    messageId?: string, direction?: FileProgress['direction'], total?: number, preview?: string,
    previewBytes?: Uint8Array, saved?: boolean): void {
    const session = this.fileSessions.get(requestId);
    if (!session && (!messageId || !direction || total === undefined)) return;
    this.callbacks?.onFileProgress?.({ requestId, messageId: messageId ?? session!.messageId,
      direction: direction ?? session!.direction, bytes: bytes ?? session!.offset,
      total: total ?? session!.total, status, preview, previewBytes, saved,
      peerId: session?.peerId, peerName: session?.peerName, previewOnly: session?.preview,
      timings: session ? { ...session.timings } : undefined });
  }

  private async sendFilePacket(peerId: string, payload: Omit<FilePacket, 'signature'>): Promise<void> {
    if (!this.fileAction || !this.chatAuth || !this.peerTracker.isVerified(peerId) ||
        (this.authority && !this.isAdmittedPeer(peerId))) throw new Error('Peer unavailable');
    const signed = [payload.kind, payload.requestId, payload.messageId, payload.offset ?? null, Boolean(payload.preview)];
    const signature = await this.chatAuth.signControl('chat-file-control-v2', signed);
    await this.fileAction.send({ ...payload, signature }, { target: peerId });
  }

  private async sendFileChunk(session: FileSession, requestId: string,
    offset: number, encoded: string): Promise<void> {
    const peerId = session.peerId;
    if (!this.fileAction || !this.chatAuth || !this.peerTracker.isVerified(peerId) ||
        (this.authority && !this.isAdmittedPeer(peerId))) throw new Error('Peer unavailable');
    const prepareStart = performance.now();
    const bytes = decodeFileBase64(encoded);
    const unsigned = { requestId, messageId: session.messageId, offset, hash: await hashFileChunk(bytes) };
    const signature = await this.chatAuth.signControl('chat-file-chunk-v2', fileChunkSignatureData(unsigned));
    const packet = encodeSignedFileChunk({ ...unsigned, signature }, bytes);
    session.timings.prepareMs += performance.now() - prepareStart;
    const pc = this.room?.getPeers?.()?.[peerId] as FileOptimizedConnection | undefined;
    ensureFileDataChannelWindow(pc);
    const wireStart = performance.now();
    await this.fileAction.send(packet, { target: peerId });
    session.timings.wireMs += performance.now() - wireStart;
  }

  private async sendNextFileChunks(requestId: string): Promise<void> {
    const session = this.fileSessions.get(requestId);
    if (!session || session.direction !== 'send' || !session.sourceId || session.sending) return;
    session.sending = true;
    try {
      while (this.fileSessions.get(requestId) === session && (session.sentOffset ?? 0) < session.total &&
          (session.sentOffset ?? 0) - session.offset < CHAT_FILE_IN_FLIGHT_CHUNKS * CHAT_FILE_CHUNK_BYTES) {
        const offset = session.sentOffset ?? 0;
        const readStart = performance.now();
        const data = await invoke<string>('read_chat_file_chunk', { id: session.sourceId, offset,
          length: CHAT_FILE_CHUNK_BYTES });
        session.timings.readMs += performance.now() - readStart;
        if (this.fileSessions.get(requestId) !== session) return;
        session.sentOffset = offset + Math.min(CHAT_FILE_CHUNK_BYTES, session.total - offset);
        await this.sendFileChunk(session, requestId, offset, data);
      }
    } catch (error) {
      await this.cancelFileTransfer(requestId);
      this.emitFileProgress(requestId, 'error', session.offset, session.messageId, 'send', session.total);
      console.warn('[Files] Failed to send chunk:', error);
    } finally {
      session.sending = false;
      if (this.fileSessions.get(requestId) === session && (session.sentOffset ?? 0) < session.total &&
          (session.sentOffset ?? 0) - session.offset < CHAT_FILE_IN_FLIGHT_CHUNKS * CHAT_FILE_CHUNK_BYTES) {
        void this.sendNextFileChunks(requestId);
      }
    }
  }

  private async handleFilePacket(packet: FilePacket, peerId: string): Promise<void> {
    if (!packet || typeof packet.requestId !== 'string' || packet.requestId.length > 80 ||
        typeof packet.messageId !== 'string' || packet.messageId.length > 80 ||
        !['request', 'accept', 'deny', 'ack', 'cancel'].includes(packet.kind) ||
        (packet.offset !== undefined && (!Number.isSafeInteger(packet.offset) || packet.offset < 0)) ||
        'data' in packet ||
        (packet.preview !== undefined && typeof packet.preview !== 'boolean')) return;
    const key = this.chatAuth?.getKnownKey(peerId);
    if (!key || !await this.chatAuth!.verifyControl('chat-file-control-v2',
      [packet.kind, packet.requestId, packet.messageId, packet.offset ?? null, Boolean(packet.preview)], packet.signature, key)) return;
    const message = this.chatHistory.find((item) => item.id === packet.messageId);
    if (!message?.file) return;
    if (packet.kind === 'request') {
      if (message.authorKey === this.chatAuth?.publicKey &&
          (message.deletedAt || this.revokedFileMessages.has(message.id))) {
        await this.sendFilePacket(peerId, { kind: 'deny', requestId: packet.requestId, messageId: message.id });
        return;
      }
      if (message.authorKey !== this.chatAuth?.publicKey ||
          this.pendingFileRequests.size >= 8 || this.fileSessions.size >= 8 ||
          this.pendingFileRequests.has(packet.requestId) ||
          this.fileSessions.has(packet.requestId)) return;
      let source = this.fileSources.get(message.id);
      if (!source) {
        try {
          const file = await invoke<NativeChatFile | null>('restore_chat_file_source',
            { roomId: this.roomId, messageId: message.id });
          if (file) {
            source = { file, autoAcceptUntil: 0 };
            this.fileSources.set(message.id, source);
          }
        } catch {}
      }
      if (!source) {
        await this.sendFilePacket(peerId, { kind: 'deny', requestId: packet.requestId, messageId: message.id });
        return;
      }
      const request: FileRequest = { requestId: packet.requestId, messageId: message.id, peerId,
        peerName: this.peerTracker.getUsername(peerId) || 'Participante', path: source.file.path,
        name: message.file.name, preview: Boolean(packet.preview && message.file.isImage && message.file.size <= MAX_IMAGE_PREVIEW_BYTES) };
      this.pendingFileRequests.set(packet.requestId, request);
      if (Date.now() < source.autoAcceptUntil) void this.answerFileRequest(packet.requestId, true);
      else this.callbacks?.onFileRequest?.(request);
      return;
    }
    const session = this.fileSessions.get(packet.requestId);
    if (packet.kind === 'cancel' && !session) {
      const pending = this.pendingFileRequests.get(packet.requestId);
      if (pending?.peerId === peerId && pending.messageId === packet.messageId) {
        this.removePendingFileRequest(packet.requestId);
      }
      return;
    }
    if (!session || session.peerId !== peerId || session.messageId !== packet.messageId) return;
    if (packet.kind === 'cancel' || packet.kind === 'deny') {
      this.fileSessions.delete(packet.requestId);
      if (session.preview && session.direction === 'receive') this.requestedImagePreviews.delete(session.messageId);
      if (session.direction === 'receive' && !session.preview) await invoke('cancel_chat_download', { id: packet.requestId });
      this.emitFileProgress(packet.requestId, 'cancelled', session.offset, session.messageId, session.direction, session.total);
      return;
    }
    if (session.direction === 'receive' && message.authorKey === this.chatAuth?.getKnownKey(peerId)) {
      if (packet.kind === 'accept') {
        if (session.total === 0) await this.finishReceivedFile(packet.requestId, session, message);
        else this.emitFileProgress(packet.requestId, 'active');
      }
    } else if (session.direction === 'send' && packet.kind === 'ack' && packet.offset !== undefined &&
               packet.offset > session.offset && packet.offset <= (session.sentOffset ?? 0)) {
      session.offset = packet.offset;
      this.emitFileProgress(packet.requestId, 'active');
      if (session.offset === session.total) {
        this.fileSessions.delete(packet.requestId);
        this.emitFileProgress(packet.requestId, 'complete', session.offset, session.messageId, 'send', session.total);
      } else await this.sendNextFileChunks(packet.requestId);
    }
  }

  private async handleFileChunkWire(packet: Uint8Array, peerId: string): Promise<void> {
    const decoded = decodeSignedFileChunk(packet);
    if (!decoded || !this.peerTracker.isVerified(peerId) ||
        (this.authority && !this.isAdmittedPeer(peerId))) return;
    const { header, bytes } = decoded;
    const session = this.fileSessions.get(header.requestId);
    const message = this.chatHistory.find((item) => item.id === header.messageId);
    const key = this.chatAuth?.getKnownKey(peerId);
    if (!session || !message?.file || !key || message.authorKey !== key ||
        session.direction !== 'receive' || session.peerId !== peerId || session.messageId !== header.messageId ||
        header.offset < session.offset || header.offset >= session.total ||
        header.offset - session.offset > CHAT_FILE_IN_FLIGHT_CHUNKS * CHAT_FILE_CHUNK_BYTES ||
        header.offset + bytes.length > session.total ||
        session.pendingChunks?.has(header.offset) ||
        (session.pendingChunks?.size ?? 0) >= CHAT_FILE_IN_FLIGHT_CHUNKS + 1) return;
    const verifyStart = performance.now();
    const valid = await hashFileChunk(bytes) === header.hash &&
      await this.chatAuth!.verifyControl('chat-file-chunk-v2',
        fileChunkSignatureData(header), header.signature, key);
    session.timings.verifyMs += performance.now() - verifyStart;
    if (!valid) return;
    if (this.fileSessions.get(header.requestId) !== session || header.offset < session.offset ||
        (session.receiving && header.offset === session.offset) ||
        session.pendingChunks?.has(header.offset) ||
        (session.pendingChunks?.size ?? 0) >= CHAT_FILE_IN_FLIGHT_CHUNKS + 1) return;
    session.pendingChunks ??= new Map();
    session.pendingChunks.set(header.offset, bytes);
    await this.processReceivedFileChunks(header.requestId, session, message);
  }

  private async processReceivedFileChunks(requestId: string, session: FileSession, message: ChatMessage): Promise<void> {
    if (session.receiving) return;
    session.receiving = true;
    try {
      while (this.fileSessions.get(requestId) === session) {
        const offset = session.offset;
        const bytes = session.pendingChunks?.get(offset);
        if (!bytes) break;
        session.pendingChunks!.delete(offset);
        const writeStart = performance.now();
        if (session.preview) {
          if (bytes.length === 0 || bytes.length > CHAT_FILE_CHUNK_BYTES || offset + bytes.length > session.total) {
            throw new Error('Invalid image chunk');
          }
          session.chunks!.push(bytes);
          session.offset += bytes.length;
        } else {
          const written = await invoke<number>('write_chat_download_chunk',
            { id: requestId, offset, data: encodeFileBase64(bytes) });
          if (this.fileSessions.get(requestId) !== session) return;
          session.offset = written;
        }
        session.timings.writeMs += performance.now() - writeStart;
        this.emitFileProgress(requestId, 'active');
        if (session.offset === session.total) await this.finishReceivedFile(requestId, session, message);
        const ackStart = performance.now();
        await this.sendFilePacket(session.peerId, { kind: 'ack', requestId,
          messageId: session.messageId, offset: session.offset });
        session.timings.ackMs += performance.now() - ackStart;
      }
    } catch (error) {
      if (this.fileSessions.get(requestId) === session) {
        await this.cancelFileTransfer(requestId);
        this.emitFileProgress(requestId, 'error', session.offset, session.messageId, 'receive', session.total);
        console.warn('[Files] Rejected received chunk:', error);
      }
    } finally {
      session.receiving = false;
      if (this.fileSessions.get(requestId) === session && session.pendingChunks?.has(session.offset)) {
        void this.processReceivedFileChunks(requestId, session, message);
      }
    }
  }

  private async finishReceivedFile(requestId: string, session: FileSession, message: ChatMessage): Promise<void> {
    if (session.preview) {
      const bytes = new Uint8Array(session.total);
      let offset = 0;
      for (const chunk of session.chunks ?? []) { bytes.set(chunk, offset); offset += chunk.length; }
      if (offset !== session.total) throw new Error('Incomplete image preview');
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
        (value) => value.toString(16).padStart(2, '0')).join('');
      if (hash !== message.file?.sha256) throw new Error('Image signature mismatch');
      const extension = message.file.name.split('.').pop()?.toLowerCase();
      const mime = extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' :
        extension === 'png' ? 'image/png' : extension === 'webp' ? 'image/webp' :
        extension === 'gif' ? 'image/gif' : 'image/bmp';
      const preview = URL.createObjectURL(new Blob([bytes], { type: mime }));
      this.fileSessions.delete(requestId);
      this.emitFileProgress(requestId, 'complete', session.total, session.messageId, 'receive', session.total, preview, bytes);
      return;
    }
    await invoke<string>('finish_chat_download', { id: requestId });
    this.fileSessions.delete(requestId);
    let preview: string | undefined;
    if (message.file?.isImage && session.total <= MAX_IMAGE_PREVIEW_BYTES) {
      try {
        const data = await invoke<string>('read_chat_image_preview', { id: requestId });
        const ext = message.file.name.split('.').pop()?.toLowerCase();
        const mime = ext === 'jpg' ? 'image/jpeg' : ext === 'jpeg' ? 'image/jpeg' :
          ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/bmp';
        preview = `data:${mime};base64,${data}`;
      } catch {}
    }
    this.emitFileProgress(requestId, 'complete', session.total, session.messageId, 'receive', session.total, preview, undefined, true);
  }

  public async editChatMessage(id: string, text: string): Promise<boolean> {
    const current = this.chatHistory.find((message) => message.id === id);
    if (!current || current.authorId !== selfId || current.isSystem || current.file || current.deletedAt || !text.trim()) return false;
    await this.publishChatMessage({
      ...current,
      text: text.trim(),
      revision: chatRevision(current) + 1,
      editedAt: Date.now(),
    });
    return true;
  }

  public async deleteChatMessage(id: string): Promise<boolean> {
    const current = this.chatHistory.find((message) => message.id === id);
    if (!current || current.authorId !== selfId || current.isSystem || current.deletedAt) return false;
    if (current.file) {
      this.revokedFileMessages.add(id);
      for (const [requestId, session] of this.fileSessions) {
        if (session.messageId === id) await this.cancelFileTransfer(requestId);
      }
      for (const [requestId, request] of this.pendingFileRequests) {
        if (request.messageId === id) {
          this.removePendingFileRequest(requestId);
          try { await this.sendFilePacket(request.peerId, { kind: 'deny', requestId, messageId: id }); } catch {}
        }
      }
      this.fileSources.delete(id);
    }
    await this.publishChatMessage({
      ...current,
      text: '',
      revision: chatRevision(current) + 1,
      deletedAt: Date.now(),
    });
    return true;
  }

  public sendSystemMessage(
    text: string,
    systemType: NonNullable<ChatMessage['systemType']>,
    systemActor?: string,
    systemRoom?: string,
    systemAppKind?: string,
  ): Promise<ChatMessage> {
    return this.publishChatMessage({
      id: crypto.randomUUID(), sender: 'Sistema', text,
      timestamp: Date.now(), authorId: selfId, revision: 0,
      isSystem: true, systemType, systemActor, systemRoom, systemAppKind,
    });
  }

  public sendAppLifecycleNotice(action: 'start' | 'stop', kind: string): Promise<ChatMessage> {
    const app = getRoomApp(kind);
    if (!app) return Promise.reject(new Error('Unknown room app'));
    return this.sendSystemMessage(action === 'start' ? `${this.username} iniciou ${app.label}` :
      `${this.username} encerrou ${app.label}`, action === 'start' ? 'app-start' : 'app-stop',
    this.username, undefined, kind);
  }

  private async publishChatMessage(msg: ChatMessage): Promise<ChatMessage> {
    if (!this.chatAuth) throw new Error('Chat identity is not ready');
    const signed = await this.chatAuth.sign(msg);
    this.seenChatRevisions.add(chatRevisionKey(signed));
    this.chatHistory = mergeChatHistory(this.chatHistory, [signed]);
    this.callbacks?.onChat(signed);
    try { this.sendRoomAction(this.chatAction, signed); } catch {}
    return signed;
  }

  public getConnectedPeers(): PeerInfo[] {
    return this.peerTracker.getAllRoomPeers().filter((peer) =>
      !this.authority || this.isAdmittedPeer(peer.id))
      .map((peer) => ({ ...peer, isAdmin: this.isPeerAdmin(peer.id) }));
  }

  private notifyPeersUpdate() {
    if (this.callbacks) {
      this.callbacks.onPeersUpdate(this.getConnectedPeers());
    }
  }

  public async updateRoomPassword(newPassword: string): Promise<boolean> {
    if (!this.isRoomHost() || newPassword.length > 128) return false;
    if (this.authority) {
      const command = await this.authority.makeCommand('password', { password: newPassword.trim() });
      this.password = newPassword.trim();
      this.admissionHistory.push(command);
      this.retainAdmissionHistory();
      await this.persistHostCommands();
      await this.persistRememberedPassword();
      for (const peerId of this.admittedTargets()) {
        await this.admissionAction?.send({ kind: 'command', command }, { target: peerId });
      }
      this.callbacks?.onPasswordChange?.(this.password, this.username);
      return true;
    }
    this.password = newPassword.trim();
    if (this.passwordAction) {
      this.passwordAction.send({
        newPassword: this.password,
        updatedBy: this.username,
      });
    }
    if (this.callbacks?.onPasswordChange) {
      this.callbacks.onPasswordChange(this.password, this.username);
    }
    void this.sendSystemMessage(`Senha alterada por ${this.username}`, 'info', this.username)
      .catch((error) => console.warn('[Chat] Failed to publish password notice:', error));
    return true;
  }

  public async transferOwnership(peerId: string): Promise<boolean> {
    if (!this.authority?.isLocalHost() || !this.chatAuth || !this.isAdmittedPeer(peerId)) return false;
    const key = this.chatAuth.getKnownKey(peerId);
    if (!key) return false;
    const proposal = await this.authority.proposeTransfer(key, peerId);
    await this.authorityAction?.send({ kind: 'offer', proposal }, { target: peerId });
    return true;
  }

  public async setAdministrator(peerId: string, enabled: boolean): Promise<boolean> {
    if (!this.authority?.isLocalHost() || !this.chatAuth || !this.peerTracker.isVerified(peerId)) return false;
    const key = this.chatAuth.getKnownKey(peerId);
    if (!key || this.admittedPeers.get(peerId) !== key || this.hasAdminGrant(key) === enabled) return false;
    if (enabled && this.activeAdminKeys().length >= 32) return false;
    const command = await this.authority.makeCommand(enabled ? 'admin' : 'revoke-admin',
      { targetPeerId: peerId, targetKey: key });
    await this.acceptHostCommand(command);
    await this.admissionAction?.send({ kind: 'command', command });
    await this.publishSnapshot(this.roomName);
    return true;
  }

  public async kickPeer(peerId: string): Promise<boolean> {
    if (!this.authority?.isLocalHost() || !this.chatAuth || !this.peerTracker.isVerified(peerId)) return false;
    const key = this.chatAuth.getKnownKey(peerId);
    if (!key || this.admittedPeers.get(peerId) !== key) return false;
    const command = await this.authority.makeCommand('kick', { targetPeerId: peerId, targetKey: key });
    this.admissionHistory.push(command);
    this.admissionHistory = this.admissionHistory.slice(-200);
    await this.persistHostCommands();
    const rotatedPassword = Array.from(crypto.getRandomValues(new Uint8Array(16)),
      (byte) => byte.toString(16).padStart(2, '0')).join('');
    this.password = rotatedPassword;
    if (this.invite) {
      const record = await savedRooms.get(this.roomId);
      if (record) await savedRooms.put({ ...record, protected: true, password: rotatedPassword });
    }
    await this.admissionAction?.send({ kind: 'command', command });
    this.removeKickedPeer(peerId, key);
    const rotation = await this.authority.makeCommand('password', { password: rotatedPassword });
    this.admissionHistory.push(rotation);
    this.retainAdmissionHistory();
    await this.persistHostCommands();
    for (const remaining of this.peerTracker.directConnectedPeers) {
      if (this.isAdmittedPeer(remaining)) {
        await this.admissionAction?.send({ kind: 'command', command: rotation }, { target: remaining });
      }
    }
    this.callbacks?.onPasswordChange?.(rotatedPassword, this.username);
    return true;
  }

  public requestStream(peerId: string): void {
    if (this.streamReqAction) {
      try {
        const payload: StreamRequestPayload = {
          request: true,
          broadcasterId: peerId,
          requesterId: selfId,
          reason: 'initial_join',
        };
        this.streamReqAction.send(payload, { target: peerId });
      } catch {}
    }
    this.watchStream(peerId);
  }

  public stopWatching(peerId: string): void {
    this.stopWatchingStream(peerId);
  }

  public async leave(): Promise<void> {
    this.stopStream();
    if (this.room) {
      await this.sendSystemMessage(`${this.username} saiu`, 'leave', this.username);
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.leaveAction) {
      try {
        this.sendRoomAction(this.leaveAction, { peerId: selfId, username: this.username });
      } catch {}
    }
    if (this.meshRelayAction) {
      try {
        this.sendRoomAction(this.meshRelayAction, {
          target: 'all',
          origin: selfId,
          kind: 'peer_leave',
          payload: { peerId: selfId },
        });
      } catch {}
    }

    // Allow a brief flush window for socket buffers before tearing down WebRTC
    await new Promise((resolve) => setTimeout(resolve, 60));

    const roomToLeave = this.room;
    this.room = null;
    signalingManager.setRoomReconnectionHandler(null);
    await signalingManager.leaveRoom(roomToLeave);

    this.peerTracker.clear();
    this.remoteStreams.clear();
    this.lastBroadcasterStreamIds.clear();
    this.lastStreamRecoveryRequests.clear();
    this.lastBridgeAttempts.clear();
    this.rumorIntermediaries.clear();
    this.announcedPeerNames.clear();
    this.existingAtJoinIds.clear();
    this.pendingJoinNotices.clear();
    this.initialRosterReceived = false;
    this.lastPeerStats.clear();
    this.peerStatsCache.clear();
    this.localStatsCache = null;
    this.initialJoinComplete = false;
    this.chatHistory = [];
    this.fileSources.clear();
    await Promise.allSettled([...this.fileSessions].filter(([, session]) =>
      session.direction === 'receive' && !session.preview).map(([id]) =>
      invoke('cancel_chat_download', { id })));
    this.fileSessions.clear();
    this.pendingFileRequests.clear();
    this.requestedImagePreviews.clear();
    this.revokedFileMessages.clear();
    this.seenChatRevisions.clear();
    this.lastStreamsHash = '';
  }
}
