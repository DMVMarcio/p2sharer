import { joinRoom, selfId } from '@trystero-p2p/mqtt';
import { ActiveStreamInfo, ChatMessage, PeerInfo, RoomSlotInfo, TurnConfig } from './types';

const APP_ID = 'p2sharer-multi-stream-v1';

const ADJECTIVES = [
  'cyber', 'neon', 'rapid', 'swift', 'cosmic', 'hyper', 'solar', 'lunar',
  'mystic', 'sonic', 'ultra', 'mega', 'royal', 'epic', 'prime', 'iron',
  'silver', 'golden', 'shadow', 'crystal', 'astro', 'blaze', 'storm', 'vortex',
  'quantum', 'echo', 'alpha', 'nova', 'turbo', 'ninja', 'pixel', 'phantom'
];

const NOUNS = [
  'falcon', 'tiger', 'wolf', 'eagle', 'hawk', 'panther', 'fox', 'dragon',
  'phoenix', 'bear', 'shark', 'cobra', 'viper', 'lion', 'lynx', 'titan',
  'nomad', 'runner', 'driver', 'spark', 'storm', 'pulse', 'byte', 'core',
  'matrix', 'drift', 'horizon', 'forge', 'nexus', 'rover', 'shield', 'vortex'
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
}

function optimizeSDP(sdp: string, bitrateKbps: number = 25000): string {
  let modified = sdp;
  const bitrateBps = bitrateKbps * 1000;

  // 1. Add bandwidth modifier (b=AS and b=TIAS) specifically under m=video section
  const videoSectionRegex = /(m=video [^\r\n]+(?:\r?\n[\s\S]*?)(?=m=|$))/g;
  modified = modified.replace(videoSectionRegex, (videoBlock) => {
    let block = videoBlock;
    if (!block.includes('b=AS:')) {
      block = block.replace(/(m=video[^\r\n]*\r?\n)/, `$1b=AS:${bitrateKbps}\r\nb=TIAS:${bitrateBps}\r\n`);
    } else {
      block = block.replace(/b=AS:\d+/g, `b=AS:${bitrateKbps}`);
      block = block.replace(/b=TIAS:\d+/g, `b=TIAS:${bitrateBps}`);
    }

    // Find video payload types (H264/VP8/VP9/AV1)
    const rtpmapMatches = Array.from(block.matchAll(/a=rtpmap:(\d+) (?:H264|VP8|VP9|AV1|H265)\//gi));
    const videoPts = new Set<string>();
    for (const m of rtpmapMatches) {
      videoPts.add(m[1]);
    }

    // Add google bitrate parameters exclusively to video payload fmtp lines
    for (const pt of videoPts) {
      const fmtpRegex = new RegExp(`(a=fmtp:${pt} [^\\r\\n]*)`, 'g');
      if (fmtpRegex.test(block)) {
        block = block.replace(fmtpRegex, (line) => {
          if (line.includes('x-google-min-bitrate')) return line;
          return `${line};x-google-min-bitrate=${Math.floor(bitrateKbps * 0.6)};x-google-start-bitrate=${bitrateKbps};x-google-max-bitrate=${Math.floor(bitrateKbps * 1.5)}`;
        });
      } else {
        block = block.replace(
          new RegExp(`(a=rtpmap:${pt} [^\\r\\n]*\\r?\\n)`),
          `$1a=fmtp:${pt} x-google-min-bitrate=${Math.floor(bitrateKbps * 0.6)};x-google-start-bitrate=${bitrateKbps};x-google-max-bitrate=${Math.floor(bitrateKbps * 1.5)}\r\n`
        );
      }
    }
    return block;
  });

  // 2. Opus audio optimizations (low latency, high fidelity stereo)
  modified = modified.replace(/(a=fmtp:111 [^\r\n]*)/g, (line) => {
    if (line.includes('minptime=')) return line;
    return `${line};minptime=10;useinbandfec=1;stereo=1;maxaveragebitrate=128000;cbr=1`;
  });

  return modified;
}

let sdpHooked = false;
function ensureSDPHooked() {
  if (sdpHooked || typeof RTCPeerConnection === 'undefined') return;
  sdpHooked = true;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const originalSetLocalDescription = (RTCPeerConnection.prototype as any).setLocalDescription;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (RTCPeerConnection.prototype as any).setLocalDescription = function (description: any, ...args: any[]) {
    if (description && description.sdp) {
      const optimized = optimizeSDP(description.sdp, 25000);
      try {
        const newDesc = {
          type: description.type,
          sdp: optimized,
        };
        return originalSetLocalDescription.apply(this, [newDesc, ...args]);
      } catch {
        return originalSetLocalDescription.apply(this, [description, ...args]);
      }
    }
    return originalSetLocalDescription.apply(this, [description, ...args]);
  };
}

export class GroupRoomManager {
  private username: string;
  private roomId: string;
  private password: string = '';
  private isCreator: boolean;
  private turnConfig: TurnConfig | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private room: any = null;
  private localStream: MediaStream | null = null;
  private peers: Map<string, string> = new Map(); // peerId -> username
  private peerLastSeen: Map<string, number> = new Map(); // peerId -> timestamp
  private streamingPeers: Set<string> = new Set(); // peerId set of who is broadcasting
  private remoteStreams: Map<string, MediaStream> = new Map(); // peerId -> stream
  private chatHistory: ChatMessage[] = [];
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

  private callbacks: RoomCallbacks | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastStreamsHash: string = '';
  private currentTargetBitrate: number = 25000000;
  private currentTargetFps: number = 60;

  constructor(username: string, roomId: string, password = '', isCreator = false, turnConfig?: TurnConfig) {
    this.username = username;
    this.roomId = roomId.trim();
    this.password = password.trim();
    this.isCreator = isCreator;
    this.turnConfig = turnConfig || null;
    ensureSDPHooked();
  }

  public getDisplayRoomId(): string {
    return this.roomId;
  }

  public getPassword(): string {
    return this.password;
  }

  public async join(callbacks: RoomCallbacks) {
    this.callbacks = callbacks;
    callbacks.onStatusChange('Conectando...');
    console.log(`[P2P] Joining room ${this.roomId} (Password Protected: ${Boolean(this.password)}) as ${this.username} (Self ID: ${selfId})`);

    const iceServers: RTCIceServer[] = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:global.stun.twilio.com:3478' },
    ];

    if (this.turnConfig?.enabled && this.turnConfig.url && this.turnConfig.url.trim()) {
      let turnUrl = this.turnConfig.url.trim();
      if (!turnUrl.startsWith('turn:') && !turnUrl.startsWith('turns:') && !turnUrl.startsWith('stun:')) {
        turnUrl = `turn:${turnUrl}`;
      }

      console.log(`[P2P] Custom TURN relay enabled: "${turnUrl}" (Force Relay: ${Boolean(this.turnConfig.forceRelay)})`);

      const customTurn: RTCIceServer = {
        urls: turnUrl,
      };
      if (this.turnConfig.username) {
        customTurn.username = this.turnConfig.username.trim();
      }
      if (this.turnConfig.credential) {
        customTurn.credential = this.turnConfig.credential.trim();
      }
      iceServers.unshift(customTurn);
    } else {
      console.log('[P2P] Custom TURN relay is disabled. Using public Google & Twilio STUN servers.');
    }

    const rtcConfig: RTCConfiguration = {
      iceServers,
      iceTransportPolicy: this.turnConfig?.enabled && this.turnConfig?.forceRelay ? 'relay' : 'all',
    };

    const relayConfig = {
      urls: [
        'wss://broker.emqx.io:8084/mqtt',
        'wss://broker.hivemq.com:8884/mqtt',
      ],
    };

    try {
      console.log(`[P2P] Computing signaling topic for room "${this.roomId}" (password: "${this.password}")...`);
      const signalingTopic = await computeSignalingRoomId(this.roomId, this.password);
      console.log(`[P2P] Computed signaling topic: "${signalingTopic}"`);

      console.log(`[P2P] Initializing joinRoom for appId "${APP_ID}" with relays:`, relayConfig.urls);
      this.room = joinRoom(
        {
          appId: APP_ID,
          relayConfig,
          rtcConfig,
        },
        signalingTopic
      );
      console.log('[P2P] joinRoom instance initialized successfully. Configuring actions...');

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

      // 1. Setup Chat Action
      this.chatAction = this.room.makeAction('chat');
      this.chatAction.onMessage = (msg: ChatMessage) => {
        this.chatHistory.push(msg);
        if (this.callbacks) {
          this.callbacks.onChat(msg);
        }
      };

      // 2. Setup Chat History Sync Action (P2P pull from host / peers)
      this.historyAction = this.room.makeAction('history_sync');
      this.historyAction.onMessage = (data: { request?: boolean; history?: ChatMessage[] }, meta: { peerId: string }) => {
        const peerId = meta.peerId;
        if (data.request) {
          // Send my history back to the requesting peer
          if (this.chatHistory.length > 0) {
            this.historyAction.send({ history: this.chatHistory }, { target: peerId });
          }
        } else if (data.history && Array.isArray(data.history) && data.history.length > 0) {
          // Merge history without duplicates
          const existingIds = new Set(this.chatHistory.map((m) => m.id));
          const newMessages = data.history.filter((m) => !existingIds.has(m.id));
          if (newMessages.length > 0) {
            this.chatHistory = [...this.chatHistory, ...newMessages].sort((a, b) => a.timestamp - b.timestamp);
            if (this.callbacks) {
              this.callbacks.onChatHistory(this.chatHistory);
            }
          }
        }
      };

      // 3. Setup Presence Action (Exchange usernames & broadcast status)
      this.presenceAction = this.room.makeAction('presence');
      this.presenceAction.onMessage = (
        data: { username: string; isCreator?: boolean; isStreaming?: boolean },
        meta: { peerId: string }
      ) => {
        const peerId = meta.peerId;
        this.peerLastSeen.set(peerId, Date.now());

        const oldName = this.peers.get(peerId);
        const newName = data.username || `Usuário (${peerId.slice(0, 4)})`;
        if (oldName !== newName) {
          this.peers.set(peerId, newName);
        }

        if (data.isStreaming) {
          this.streamingPeers.add(peerId);
        } else if (data.isStreaming === false) {
          this.streamingPeers.delete(peerId);
          if (this.remoteStreams.has(peerId)) {
            this.remoteStreams.delete(peerId);
          }
        }

        // If I am currently streaming, push stream to this peer on presence
        if (this.localStream) {
          this.sendStreamToPeer(peerId);
        }

        this.notifyPeersUpdate();
        this.notifyStreamsUpdate();
        callbacks.onStatusChange(this.turnConfig?.forceRelay ? 'P2P (Relay Seguro)' : 'P2P Conectado');
      };

      // 4. Setup Stream Status Action
      this.streamStatusAction = this.room.makeAction('stream_status');
      this.streamStatusAction.onMessage = (data: { isStreaming: boolean; senderName?: string }, meta: { peerId: string }) => {
        const peerId = meta.peerId;
        this.peerLastSeen.set(peerId, Date.now());

        if (data.isStreaming) {
          this.streamingPeers.add(peerId);
        } else {
          this.streamingPeers.delete(peerId);
          if (this.remoteStreams.has(peerId)) {
            this.remoteStreams.delete(peerId);
          }
        }
        this.notifyStreamsUpdate();
      };

      // 5. Setup On-Demand Stream Request Action
      this.streamReqAction = this.room.makeAction('stream_req');
      this.streamReqAction.onMessage = (data: { request?: boolean }, meta: { peerId: string }) => {
        const requesterId = meta.peerId;
        this.peerLastSeen.set(requesterId, Date.now());

        console.log(`[P2P] Received stream request from peer ${requesterId}`);
        if (this.localStream && data.request) {
          this.sendStreamToPeer(requesterId);
        }
      };

      // 6. Setup Explicit Peer Leave Action (Instant ghost peer elimination)
      this.leaveAction = this.room.makeAction('peer_leave');
      this.leaveAction.onMessage = (_data: unknown, meta: { peerId: string }) => {
        const peerId = meta.peerId;
        console.log(`[P2P] Received explicit leave notice from peer ${peerId}`);
        this.removePeer(peerId);
      };

      // 7. Peer Lifecycle Listeners
      this.room.onPeerJoin = (peerId: string) => {
        console.log(`[P2P] Peer joined room: ${peerId}`);
        this.peerLastSeen.set(peerId, Date.now());
        
        // Send presence immediately to new peer
        if (this.presenceAction) {
          this.presenceAction.send(
            { username: this.username, isCreator: this.isCreator, isStreaming: Boolean(this.localStream) },
            { target: peerId }
          );
        }

        // If I am already sharing a stream, broadcast it to the new peer with burst bitrate
        if (this.localStream) {
          this.sendStreamToPeer(peerId);
        }

        this.peers.set(peerId, `Conectado (${peerId.slice(0, 4)})`);
        this.notifyPeersUpdate();
        this.notifyStreamsUpdate();
        callbacks.onStatusChange(this.turnConfig?.forceRelay ? 'P2P (Relay Seguro)' : 'P2P Conectado');
      };

      this.room.onPeerLeave = (peerId: string) => {
        console.log(`[P2P] Peer left room: ${peerId}`);
        this.removePeer(peerId);
      };

      // 8. Incoming Stream Listener
      this.room.onPeerStream = (stream: MediaStream, peerId: string) => {
        console.log(`[P2P] Received stream from peer: ${peerId}`);
        this.peerLastSeen.set(peerId, Date.now());
        this.streamingPeers.add(peerId);
        this.remoteStreams.set(peerId, stream);

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

        // Eliminate Chromium receiver jitter buffer delay for true real-time P2P (Discord/TeamSpeak level)
        try {
          const peers = this.room?.getPeers?.() || {};
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const peerObj: any = peers[peerId];
          const pc: RTCPeerConnection = peerObj?.connection || peerObj?.pc || peerObj;
          if (pc?.getReceivers) {
            pc.getReceivers().forEach((receiver) => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (receiver as any).playoutDelayHint = 0;
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (receiver as any).jitterBufferTarget = 0;
            });
          }
        } catch {}

        this.notifyStreamsUpdate();
        callbacks.onStatusChange('Ao Vivo');
      };

      // 9. Continuous presence heartbeat & Ghost Peer Pruner (every 2.5s)
      this.heartbeatTimer = setInterval(() => {
        if (!this.room) return;

        // Broadcast presence
        if (this.presenceAction) {
          this.presenceAction.send({
            username: this.username,
            isCreator: this.isCreator,
            isStreaming: Boolean(this.localStream),
          });
        }

        // Prune ghost peers that missed heartbeats for > 6.5s
        const now = Date.now();
        const deadPeers: string[] = [];
        this.peerLastSeen.forEach((lastSeen, peerId) => {
          if (now - lastSeen > 6500) {
            deadPeers.push(peerId);
          }
        });

        deadPeers.forEach((p) => {
          console.log(`[P2P] Pruning ghost peer due to timeout: ${p}`);
          this.removePeer(p);
        });
      }, 2500);

      // Initial broadcast and request history from room
      setTimeout(() => {
        if (this.presenceAction) {
          this.presenceAction.send({
            username: this.username,
            isCreator: this.isCreator,
            isStreaming: Boolean(this.localStream),
          });
        }
        if (this.historyAction && !this.isCreator) {
          this.historyAction.send({ request: true });
        }
      }, 350);

      callbacks.onStatusChange('Sala Ativa');
      this.notifyStreamsUpdate();
    } catch (err: any) {
      console.error('[P2P] Failed to join room in GroupRoomManager:', err);
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      callbacks.onStatusChange(`Erro ao conectar (${msg})`);
    }
  }

  public removePeer(peerId: string) {
    this.peers.delete(peerId);
    this.peerLastSeen.delete(peerId);
    this.streamingPeers.delete(peerId);
    if (this.remoteStreams.has(peerId)) {
      this.remoteStreams.delete(peerId);
    }
    this.notifyPeersUpdate();
    this.notifyStreamsUpdate();
    if (this.peers.size === 0 && this.callbacks) {
      this.callbacks.onStatusChange('Sala Ativa');
    }
  }

  public requestStreamFromPeer(peerId: string) {
    if (this.streamReqAction && peerId !== 'local') {
      console.log(`[P2P] Requesting live stream from peer ${peerId}`);
      this.streamReqAction.send({ request: true }, { target: peerId });
    }
  }

  public sendStreamToPeer(peerId: string) {
    if (!this.localStream || !this.room) return;
    try {
      const peers = this.room.getPeers?.() || {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const peerObj: any = peers[peerId];
      const pc: RTCPeerConnection = peerObj?.connection || peerObj?.pc || peerObj;

      if (pc && pc.getSenders) {
        const existingSenders = pc.getSenders();
        const localVideoTrack = this.localStream.getVideoTracks()[0];
        const localAudioTrack = this.localStream.getAudioTracks()[0];

        const videoSender = existingSenders.find((s) => s.track && s.track.kind === 'video');
        const audioSender = existingSenders.find((s) => s.track && s.track.kind === 'audio');

        let replaced = false;
        if (videoSender && localVideoTrack) {
          videoSender.replaceTrack(localVideoTrack).catch(() => {});
          replaced = true;
        }
        if (audioSender && localAudioTrack) {
          audioSender.replaceTrack(localAudioTrack).catch(() => {});
          replaced = true;
        }

        if (!replaced) {
          this.room.addStream(this.localStream, peerId);
        }
      } else {
        this.room.addStream(this.localStream, peerId);
      }

      [0, 30, 80, 150, 300, 600, 1200, 2000].forEach((delay) => {
        setTimeout(() => this.boostSenders(this.currentTargetBitrate, this.currentTargetFps), delay);
      });
    } catch (err) {
      console.warn('[P2P] Error sending stream to peer, fallback:', err);
      try {
        this.room.addStream(this.localStream, peerId);
      } catch {}
    }
  }

  public shareStream(stream: MediaStream, targetBitrateBps: number = 25000000, targetFps: number = 60) {
    this.localStream = stream;
    this.currentTargetBitrate = targetBitrateBps;
    this.currentTargetFps = targetFps;

    if (this.room && stream) {
      try {
        const peers = this.room.getPeers?.() || {};
        const peerIds = Object.keys(peers);
        if (peerIds.length > 0) {
          peerIds.forEach((pId) => this.sendStreamToPeer(pId));
        } else {
          this.room.addStream(stream);
        }
        [0, 30, 80, 150, 300, 600, 1200, 2000].forEach((delay) => {
          setTimeout(() => this.boostSenders(targetBitrateBps, targetFps), delay);
        });
      } catch (err) {
        console.warn('[P2P] Error adding broadcast stream:', err);
      }

      if (this.streamStatusAction) {
        this.streamStatusAction.send({ isStreaming: true, senderName: this.username });
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
        if (pc?.getSenders) {
          pc.getSenders().forEach((sender) => {
            if (sender.track && sender.track.kind === 'video') {
              try {
                const params = sender.getParameters();
                if (!params.encodings || params.encodings.length === 0) {
                  params.encodings = [{}];
                }
                params.encodings[0].maxBitrate = maxBitrateBps;
                params.encodings[0].maxFramerate = maxFps;
                params.encodings[0].scaleResolutionDownBy = 1.0;
                params.encodings[0].networkPriority = 'high';
                params.encodings[0].priority = 'high';
                // Lock resolution to avoid 8-second blurriness downscaling
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (params as any).degradationPreference = 'maintain-resolution';
                sender.setParameters(params).catch(() => {});
              } catch {}
            }
          });
        }
      });
    } catch {}
  }

  public stopStream() {
    if (this.room && this.localStream) {
      try {
        this.room.removeStream(this.localStream);
      } catch (err) {
        console.warn('[P2P] Error removing stream:', err);
      }
    }

    this.localStream = null;

    if (this.streamStatusAction) {
      this.streamStatusAction.send({ isStreaming: false });
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

    // Remote streams from other peers
    this.remoteStreams.forEach((stream, peerId) => {
      const senderName = this.peers.get(peerId) || `Participante (${peerId.slice(0, 4)})`;
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
    });

    // 2. Peer slots
    this.peers.forEach((uname, peerId) => {
      const stream = this.remoteStreams.get(peerId) || null;
      const isBroadcasting = this.streamingPeers.has(peerId) || Boolean(stream);
      list.push({
        peerId,
        senderName: uname,
        stream,
        isStreaming: isBroadcasting,
        isLocal: false,
        color: generateUserColor(uname),
      });
    });

    return list;
  }

  public notifyStreamsUpdate() {
    if (!this.callbacks) return;
    const streams = this.getAllActiveStreams();
    const slots = this.getAllRoomSlots();

    const hash = slots.map((s) => `${s.peerId}:${s.senderName}:${s.isStreaming}:${s.stream?.id}`).join('|');
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
      isHost: this.isCreator,
    };

    this.chatHistory.push(msg);

    if (this.chatAction) {
      this.chatAction.send(msg);
    }
    return msg;
  }

  public getConnectedPeers(): PeerInfo[] {
    const list: PeerInfo[] = [];
    this.peers.forEach((uname, id) => {
      list.push({
        id,
        username: uname,
        connectionState: 'connected',
        joinedAt: Date.now(),
      });
    });
    return list;
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

  public leave() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.leaveAction) {
      try {
        this.leaveAction.send({ peerId: selfId });
      } catch {}
    }

    this.stopStream();
    if (this.room) {
      this.room.leave();
      this.room = null;
    }
    this.peers.clear();
    this.peerLastSeen.clear();
    this.streamingPeers.clear();
    this.remoteStreams.clear();
    this.chatHistory = [];
    this.lastStreamsHash = '';
  }
}
