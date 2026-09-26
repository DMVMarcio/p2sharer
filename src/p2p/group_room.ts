import { selfId } from '@trystero-p2p/core';
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
import { MediaCoordinator } from './media_coordinator.ts';
import { PeerTracker } from './peer_tracker.ts';
import { signalingManager } from './signaling_manager.ts';

const APP_ID = 'p2sharer-multi-stream-v1';

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
  // Cryptographically isolate rooms with passwords (even with identical names)
  try {
    const encoder = new TextEncoder();
    const data = encoder.encode(`p2sharer-auth:${cleanRoom}:${cleanPass}`);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('').substring(0, 16);
    return `sec-${cleanRoom}-${hashHex}`;
  } catch {
    // Fallback if crypto.subtle is unavailable
    let hash = 0;
    const combined = `${cleanRoom}:${cleanPass}`;
    for (let i = 0; i < combined.length; i++) {
      hash = (hash << 5) - hash + combined.charCodeAt(i);
      hash |= 0;
    }
    return `sec-${cleanRoom}-${Math.abs(hash).toString(16)}`;
  }
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
  onStreamsUpdate: (streams: ActiveStreamInfo[]) => void;
  onSlotsUpdate: (slots: RoomSlotInfo[]) => void;
  onChat: (msg: ChatMessage) => void;
  onChatHistory: (messages: ChatMessage[]) => void;
  onPeersUpdate: (peers: PeerInfo[]) => void;
  onStatusChange: (status: string) => void;
  onPasswordChange?: (newPassword: string, updatedBy: string) => void;
  onPeerJoined?: (peer: PeerInfo, isInitial: boolean) => void;
  onPeerLeft?: (peerId: string, username: string) => void;
  onStreamStarted?: (peerId: string, username: string, isLocal: boolean) => void;
  onStreamStopped?: (peerId: string, username: string, isLocal: boolean) => void;
  onWatchStarted?: (watcherPeerId: string, watcherName: string, broadcasterPeerId: string) => void;
  onWatchStopped?: (watcherPeerId: string, watcherName: string, broadcasterPeerId: string) => void;
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
  private seenChatMsgIds: Set<string> = new Set();

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

  private lastPeerStats: Map<string, { bytesReceived: number; timestamp: number }> = new Map();
  private lastLocalStats: { bytesSent: number; timestamp: number } | null = null;
  private initialJoinComplete: boolean = false;
  private callbacks: RoomCallbacks | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastStreamsHash: string = '';
  private lastBroadcasterStreamIds: Map<string, string> = new Map();
  private lastStreamRecoveryRequests: Map<string, number> = new Map();
  private lastBridgeAttempts: Map<string, number> = new Map();
  private lastRumorReannounceTime: number = 0;
  private currentTargetBitrate: number = 25000000;
  private currentTargetFps: number = 60;
  private signalingTopic: string = '';
  private rtcConfig: RTCConfiguration | null = null;

  constructor(username: string, roomId: string, password = '', isCreator = false, turnConfig?: TurnConfig) {
    this.username = username;
    this.roomId = roomId.trim();
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
    return this.peerTracker.isHost(selfId, this.myJoinedAt, this.isCreator);
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

    const verifiedPeers = this.peerTracker.getVerifiedPeers();
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
      this.signalingTopic = await computeSignalingRoomId(this.roomId, this.password);
      console.log(`[P2P] Computed signaling topic: "${this.signalingTopic}"`);

      this.setupRoomInstance();
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
    this.setupRoomInstance();

    // Re-announce presence and PEX
    if (this.presenceAction) {
      this.presenceAction.send({
        username: this.username,
        isCreator: this.isCreator,
        isStreaming: Boolean(this.localStream),
        joinedAt: this.myJoinedAt,
      });
    }

    // Re-announce active stream if currently sharing
    if (this.localStream && this.streamStatusAction) {
      const payload = MediaCoordinator.buildStreamStatusPayload(this.localStream, true, this.username);
      this.streamStatusAction.send(payload);

      const verified = Array.from(this.peerTracker.directConnectedPeers);
      if (verified.length > 0) {
        verified.forEach((pId) => this.sendStreamToPeer(pId));
      }
    }

    this.notifyPeersUpdate();
    this.notifyStreamsUpdate();
  }

  private bindRoomActions(): void {
    if (!this.room) return;

    // 0. Setup Live Room Password Sync Action
    this.passwordAction = this.room.makeAction('room_password_sync');
    this.passwordAction.onMessage = (data: { newPassword?: string; updatedBy?: string }) => {
      if (typeof data.newPassword === 'string') {
        this.password = data.newPassword.trim();
        if (this.callbacks?.onPasswordChange) {
          this.callbacks.onPasswordChange(this.password, data.updatedBy || 'Participante');
        }
      }
    };

    // 1. Setup Chat Action with In-Mesh Forwarding & Deduplication
    this.chatAction = this.room.makeAction('chat');
    this.chatAction.onMessage = (msg: ChatMessage) => {
      if (!msg || !msg.id) return;
      if (this.seenChatMsgIds.has(msg.id)) return;
      this.seenChatMsgIds.add(msg.id);
      if (this.seenChatMsgIds.size > 500) {
        const firstKey = this.seenChatMsgIds.values().next().value;
        if (firstKey) this.seenChatMsgIds.delete(firstKey);
      }

      this.chatHistory.push(msg);
      if (this.callbacks) {
        this.callbacks.onChat(msg);
      }

      // Mesh forward to guarantee 100% room delivery across mesh
      try {
        this.chatAction.send(msg);
      } catch {}
    };

    // 2. Setup Chat History Sync Action (P2P pull from host / peers)
    this.historyAction = this.room.makeAction('history_sync');
    this.historyAction.onMessage = (
      data: { request?: boolean; history?: ChatMessage[] },
      meta: { peerId: string }
    ) => {
      const peerId = meta.peerId;
      if (data.request) {
        if (this.chatHistory.length > 0) {
          this.historyAction.send({ history: this.chatHistory }, { target: peerId });
        }
      } else if (data.history && Array.isArray(data.history) && data.history.length > 0) {
        const existingIds = new Set(this.chatHistory.map((m) => m.id));
        const newMessages = data.history.filter((m) => !existingIds.has(m.id));
        if (newMessages.length > 0) {
          newMessages.forEach((m) => this.seenChatMsgIds.add(m.id));
          this.chatHistory = [...this.chatHistory, ...newMessages].sort((a, b) => a.timestamp - b.timestamp);
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
      this.peerTracker.touchPeer(peerId);

      const oldName = this.peerTracker.getUsername(peerId);
      const newName = data.username || `Usuário (${peerId.slice(0, 4)})`;
      if (oldName !== newName) {
        this.peerTracker.addPeer(peerId, newName, Boolean(data.isCreator), data.joinedAt);
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
      const peerId = meta.peerId;
      this.peerTracker.touchPeer(peerId);

      const senderName =
        data.senderName || this.peerTracker.getUsername(peerId) || `Participante (${peerId.slice(0, 4)})`;
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
      const watcherName =
        data.watcherName || this.peerTracker.getUsername(watcherPeerId) || `Participante (${watcherPeerId.slice(0, 4)})`;
      const broadcasterId = data.broadcasterId;
      if (!broadcasterId) return;

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
    this.streamReqAction.onMessage = (data: { request?: boolean }, meta: { peerId: string }) => {
      const requesterId = meta.peerId;
      this.peerTracker.touchPeer(requesterId);

      console.log(`[P2P] Received stream request from peer ${requesterId}`);
      if (this.localStream && data.request) {
        this.sendStreamToPeer(requesterId);
      }
    };

    // 6. Setup Explicit Peer Leave Action (Instant ghost peer elimination)
    this.leaveAction = this.room.makeAction('peer_leave');
    this.leaveAction.onMessage = (data: { peerId?: string } | unknown, meta: { peerId: string }) => {
      const payloadPid = (data as { peerId?: string })?.peerId;
      const targetPid = payloadPid || meta.peerId;
      console.log(`[P2P] Received explicit leave notice for peer ${targetPid}`);
      this.removePeer(targetPid);
    };

    // 7. Setup Peer Exchange (PEX) - Distinguishes verified direct peers from unverified gossip rumors
    this.pexAction = this.room.makeAction('peer_exchange');
    this.pexAction.onMessage = (data: { peers?: PeerExchangeItem[] }, meta: { peerId: string }) => {
      if (!data || !Array.isArray(data.peers)) return;
      this.peerTracker.touchPeer(meta.peerId);

      data.peers.forEach((p) => {
        if (p.peerId && p.peerId !== selfId) {
          const isDirect = this.peerTracker.isVerified(p.peerId);
          this.peerTracker.receivePeerExchange(p.peerId, isDirect, p.username, p.isCreator, p.joinedAt);

          // If peer is not yet directly connected to us, bridge via intermediary peer
          if (!isDirect && !this.peerTracker.isVerified(p.peerId)) {
            this.bridgeIndirectPeer(p.peerId, meta.peerId, p.username);
          }
        }
      });
    };

    // 8. Setup In-Mesh Signaling Relay (Forwarding messages between unbridged peers)
    this.meshRelayAction = this.room.makeAction('mesh_relay');
    this.meshRelayAction.onMessage = (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data: { target: string; origin: string; kind: string; payload: any },
      meta: { peerId: string }
    ) => {
      if (!data) return;
      this.peerTracker.touchPeer(meta.peerId);

      if (data.target === selfId || data.target === 'all') {
        if (data.kind === 'mesh_hello') {
          console.log(`[P2P/Mesh] Received mesh_hello from indirect peer ${data.origin}`);
          const p = data.payload || {};
          this.peerTracker.receivePeerExchange(data.origin, false, p.username, p.isCreator, p.joinedAt);

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
          this.peerTracker.receivePeerExchange(data.origin, false, p.username, p.isCreator, p.joinedAt);

          // Force signaling re-announcement on the broker
          if (this.signalingTopic) {
            signalingManager.reannounce(this.signalingTopic, data.origin);
          }
        } else if (data.kind === 'stream_req' && this.localStream) {
          this.sendStreamToPeer(data.origin);
        } else if (data.kind === 'peer_leave') {
          this.removePeer(data.origin);
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
      if (data?.t && this.pongAction) {
        try {
          this.pongAction.send({ t: data.t }, { target: meta.peerId });
        } catch {}
      }
    };

    this.pongAction.onMessage = (data: { t: number }, meta: { peerId: string }) => {
      if (data?.t) {
        const ping = Math.max(1, Date.now() - data.t);
        this.peerTracker.setPing(meta.peerId, ping);
      }
    };
  }

  private bindRoomListeners(): void {
    if (!this.room) return;

    // 9. Direct WebRTC Peer Lifecycle Listeners
    this.room.onPeerJoin = (peerId: string) => {
      console.log(`[P2P] Direct WebRTC peer connection active: ${peerId}`);
      const isNew = !this.peerTracker.isVerified(peerId);

      // Verify and record direct WebRTC connection
      this.peerTracker.receivePeerExchange(peerId, true);
      signalingManager.setPeerConnected(peerId);

      // Instantly acknowledge peer on signaling broker to ensure both directions are open
      if (this.signalingTopic) {
        signalingManager.reannounce(this.signalingTopic, peerId);
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

      // If I am already sharing a stream, broadcast it to the new peer with burst bitrate
      if (this.localStream) {
        this.sendStreamToPeer(peerId);
      }

      const uname = this.peerTracker.getUsername(peerId) || `Conectado (${peerId.slice(0, 4)})`;
      if (isNew) {
        const peerInfo: PeerInfo = {
          id: peerId,
          username: uname,
          connectionState: 'connected',
          joinedAt: this.peerTracker.getJoinedAt(peerId) || Date.now(),
        };
        this.callbacks?.onPeerJoined?.(peerInfo, !this.initialJoinComplete);
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
      console.log(`[P2P] Peer left room: ${peerId}`);
      this.removePeer(peerId);
    };

    // 10. Incoming Stream Listener
    this.room.onPeerStream = (stream: MediaStream, peerId: string) => {
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
        this.presenceAction.send({
          username: this.username,
          isCreator: this.isCreator,
          isStreaming: Boolean(this.localStream),
          joinedAt: this.myJoinedAt,
        });
      }

      // Broadcast PEX to bridge any disconnected pairs in the mesh
      if (this.pexAction) {
        this.pexAction.send({ peers: this.getPeersPayload() });
      }

      // Ping all active verified peers for live latency calculation
      if (this.pingAction) {
        this.peerTracker.directConnectedPeers.forEach((pid) => {
          try {
            this.pingAction.send({ t: Date.now() }, { target: pid });
          } catch {}
        });
      }

      // Continuous presence re-announcement on broker until direct peers connect or if rumors exist
      const hasNoDirectPeers = this.peerTracker.directConnectedPeers.size === 0;
      const rumors = this.peerTracker.getPendingRumors();
      const now = Date.now();
      if (
        (hasNoDirectPeers || rumors.length > 0) &&
        this.signalingTopic &&
        now - this.lastRumorReannounceTime > 20000
      ) {
        this.lastRumorReannounceTime = now;
        signalingManager.reannounce(this.signalingTopic);
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
        this.historyAction.send({ request: true });
      }
      if (this.presenceAction) {
        this.presenceAction.send({
          username: this.username,
          isCreator: this.isCreator,
          isStreaming: Boolean(this.localStream),
          joinedAt: this.myJoinedAt,
        });
      }
    }, 400);
  }

  private removePeer(peerId: string) {
    const uname = this.peerTracker.getUsername(peerId) || `Participante (${peerId.slice(0, 4)})`;
    const wasRemoved = this.peerTracker.removePeer(peerId);

    signalingManager.setPeerDisconnected(peerId);

    if (this.remoteStreams.has(peerId)) {
      this.remoteStreams.delete(peerId);
    }
    this.lastPeerStats.delete(peerId);
    this.lastBroadcasterStreamIds.delete(peerId);
    this.lastStreamRecoveryRequests.delete(peerId);
    this.lastBridgeAttempts.delete(peerId);

    if (wasRemoved) {
      this.callbacks?.onPeerLeft?.(peerId, uname);
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
    if (now - lastAttempt < 15000) {
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
        this.watchAction.send({
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
        this.watchAction.send({
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
      this.meshRelayAction.send({
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
    if (!this.localStream || !this.room) return;
    try {
      const peers = this.room.getPeers?.() || {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const peerObj: any = peers[peerId];
      const pc: RTCPeerConnection = peerObj?.connection || peerObj?.pc || peerObj;

      if (pc) {
        MediaCoordinator.configureCodecPreferences(pc);
        if (typeof pc.addEventListener === 'function') {
          pc.addEventListener('negotiationneeded', () => {
            MediaCoordinator.configureCodecPreferences(pc);
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
    this.localStream = stream;
    this.currentTargetBitrate = targetBitrateBps;
    this.currentTargetFps = targetFps;

    this.callbacks?.onStreamStarted?.('local', this.username, true);

    if (this.room && stream) {
      try {
        const verifiedPeers = Array.from(this.peerTracker.directConnectedPeers);
        if (verifiedPeers.length > 0) {
          verifiedPeers.forEach((pId) => this.sendStreamToPeer(pId));
        } else {
          MediaCoordinator.broadcastStream(this.room, stream);
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
        this.streamStatusAction.send(payload);
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
          MediaCoordinator.configureCodecPreferences(pc);
          MediaCoordinator.applySenderBitrate(pc, maxBitrateBps, maxFps);
        }
      });
    } catch {}
  }

  public stopStream() {
    const wasStreaming = Boolean(this.localStream);
    if (this.room && this.localStream) {
      try {
        this.room.removeStream(this.localStream);
      } catch (err) {
        console.warn('[P2P] Error removing stream:', err);
      }
    }

    this.localStream = null;
    this.lastLocalStats = null;

    // Screen share toggle protocol: emit stream_status with isStreaming: false
    if (this.streamStatusAction) {
      const payload = MediaCoordinator.buildStreamStatusPayload(null, false, this.username);
      this.streamStatusAction.send(payload);
    }

    if (wasStreaming) {
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

    // 2. Verified Peer slots ONLY (no ghost cards from unverified PEX rumors)
    this.peerTracker.directConnectedPeers.forEach((peerId) => {
      const uname = this.peerTracker.getUsername(peerId) || `Participante (${peerId.slice(0, 4)})`;
      const stream = this.remoteStreams.get(peerId) || null;
      const isBroadcasting = this.peerTracker.isStreaming(peerId) || Boolean(stream);
      list.push({
        peerId,
        senderName: uname,
        stream,
        isStreaming: isBroadcasting,
        isLocal: false,
        color: generateUserColor(uname),
        watchers: this.getStreamWatchers(peerId),
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
    let fps: number | null = this.currentTargetFps || 60;
    let width: number | null = null;
    let height: number | null = null;
    let bitrateKbps: number | null = null;

    if (!this.localStream || !this.room) {
      return {
        pingMs: 0,
        fps,
        width,
        height,
        bitrateKbps: null,
        connectionType: 'P2P Direto',
      };
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
          if (deltaSec > 0 && deltaBytes >= 0) {
            const peerCount = Math.max(1, peerList.length);
            bitrateKbps = Math.round((deltaBytes * 8) / (deltaSec * 1000 * peerCount));
          }
        }
        this.lastLocalStats = { bytesSent: totalBytesSent, timestamp };
      }
    } catch (err) {
      console.warn('[P2P] Failed to get local broadcaster stats:', err);
    }

    return {
      pingMs: 0,
      fps,
      width,
      height,
      bitrateKbps,
      connectionType: 'P2P Direto',
    };
  }

  public async getPeerStats(peerId: string): Promise<PeerStatsInfo | null> {
    if (peerId === 'local' || peerId === selfId) {
      return this.getLocalBroadcasterStats();
    }
    const pingMs = this.getPeerPing(peerId);
    let fps: number | null = null;
    let width: number | null = null;
    let height: number | null = null;
    let bitrateKbps: number | null = null;
    let connectionType = 'P2P Direto';

    try {
      const peers = this.room?.getPeers?.() || {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const peerObj: any = peers[peerId];
      const pc: RTCPeerConnection = peerObj?.connection || peerObj?.pc || peerObj;
      if (pc && typeof pc.getStats === 'function') {
        const stats = await pc.getStats();
        let rttMs: number | null = null;
        let bytesReceived: number | null = null;
        let timestamp: number = Date.now();

        stats.forEach((report) => {
          if (report.type === 'candidate-pair' && (report.state === 'succeeded' || report.nominated)) {
            if (typeof report.currentRoundTripTime === 'number') {
              rttMs = Math.round(report.currentRoundTripTime * 1000);
            } else if (typeof report.roundTripTime === 'number') {
              rttMs = Math.round(report.roundTripTime * 1000);
            }
          }
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
          if (
            report.type === 'remote-candidate' &&
            (report.candidateType === 'relay' || report.candidateType === 'relayed')
          ) {
            connectionType = 'TURN Relay';
          }
        });

        if (bytesReceived !== null) {
          const last = this.lastPeerStats.get(peerId);
          if (last) {
            const deltaBytes = bytesReceived - last.bytesReceived;
            const deltaSec = (timestamp - last.timestamp) / 1000;
            if (deltaSec > 0 && deltaBytes >= 0) {
              bitrateKbps = Math.round((deltaBytes * 8) / (deltaSec * 1000));
            }
          }
          this.lastPeerStats.set(peerId, { bytesReceived, timestamp });
        }

        return {
          pingMs: rttMs !== null ? rttMs : pingMs,
          fps,
          width,
          height,
          bitrateKbps,
          connectionType,
        };
      }
    } catch {}

    return {
      pingMs,
      fps: null,
      width: null,
      height: null,
      bitrateKbps: null,
      connectionType,
    };
  }

  public notifyStreamsUpdate() {
    if (!this.callbacks) return;
    const streams = this.getAllActiveStreams();
    const slots = this.getAllRoomSlots();

    const hash = slots
      .map((s) => `${s.peerId}:${s.senderName}:${s.isStreaming}:${s.stream?.id}:${s.watchers?.length || 0}`)
      .join('|');
    if (hash === this.lastStreamsHash) return;
    this.lastStreamsHash = hash;

    this.callbacks.onStreamsUpdate(streams);
    this.callbacks.onSlotsUpdate(slots);
  }

  public sendChatMessage(text: string): ChatMessage {
    const msg: ChatMessage = {
      id: crypto.randomUUID(),
      sender: this.username,
      text,
      timestamp: Date.now(),
      isHost: this.isRoomHost(),
    };

    this.seenChatMsgIds.add(msg.id);
    this.chatHistory.push(msg);

    if (this.chatAction) {
      try {
        this.chatAction.send(msg);
      } catch {}
    }
    return msg;
  }

  public getConnectedPeers(): PeerInfo[] {
    return this.peerTracker.getVerifiedPeers();
  }

  private notifyPeersUpdate() {
    if (this.callbacks) {
      this.callbacks.onPeersUpdate(this.getConnectedPeers());
    }
  }

  public updateRoomPassword(newPassword: string) {
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
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.leaveAction) {
      try {
        this.leaveAction.send({ peerId: selfId, username: this.username });
      } catch {}
    }
    if (this.meshRelayAction) {
      try {
        this.meshRelayAction.send({
          target: 'all',
          origin: selfId,
          kind: 'peer_leave',
          payload: { peerId: selfId },
        });
      } catch {}
    }

    this.stopStream();

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
    this.lastPeerStats.clear();
    this.initialJoinComplete = false;
    this.chatHistory = [];
    this.seenChatMsgIds.clear();
    this.lastStreamsHash = '';
  }
}
