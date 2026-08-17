import { joinRoom, selfId } from '@trystero-p2p/mqtt';
import { ActiveStreamInfo, ChatMessage, PeerInfo, RoomSlotInfo, TurnConfig } from './types';

const APP_ID = 'p2sharer-multi-stream-v1';

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
  onPeersUpdate: (peers: PeerInfo[]) => void;
  onStatusChange: (status: string) => void;
}

function optimizeSDP(sdp: string, bitrateKbps: number = 25000): string {
  let modified = sdp;
  const bitrateBps = bitrateKbps * 1000;

  // 1. Add bandwidth modifier (b=AS and b=TIAS) directly under video media line
  modified = modified.replace(
    /(m=video[^\r\n]*\r\n)/g,
    `$1b=AS:${bitrateKbps}\r\nb=TIAS:${bitrateBps}\r\n`
  );

  // 2. Add Google-specific initial bitrate parameters to fmtp lines
  modified = modified.replace(
    /(a=fmtp:\d+ [^\r\n]*)/g,
    `$1;x-google-min-bitrate=${Math.floor(bitrateKbps * 0.5)};x-google-start-bitrate=${bitrateKbps};x-google-max-bitrate=${Math.floor(bitrateKbps * 1.5)}`
  );

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
  private isCreator: boolean;
  private turnConfig: TurnConfig | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private room: any = null;
  private localStream: MediaStream | null = null;
  private peers: Map<string, string> = new Map(); // peerId -> username
  private remoteStreams: Map<string, MediaStream> = new Map(); // peerId -> stream
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private chatAction: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private presenceAction: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private streamStatusAction: any = null;

  private callbacks: RoomCallbacks | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastStreamsHash: string = '';
  private currentTargetBitrate: number = 25000000;
  private currentTargetFps: number = 60;

  constructor(username: string, roomId: string, isCreator = false, turnConfig?: TurnConfig) {
    this.username = username;
    this.roomId = roomId.toUpperCase().trim();
    this.isCreator = isCreator;
    this.turnConfig = turnConfig || null;
    ensureSDPHooked();
  }

  public join(callbacks: RoomCallbacks) {
    this.callbacks = callbacks;
    callbacks.onStatusChange('Conectando...');
    console.log(`[P2P] Joining room ${this.roomId} as ${this.username} (Self ID: ${selfId})`);

    const iceServers: RTCIceServer[] = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:global.stun.twilio.com:3478' },
    ];

    if (this.turnConfig?.enabled && this.turnConfig.url) {
      const customTurn: RTCIceServer = {
        urls: this.turnConfig.url.trim(),
      };
      if (this.turnConfig.username) {
        customTurn.username = this.turnConfig.username.trim();
      }
      if (this.turnConfig.credential) {
        customTurn.credential = this.turnConfig.credential.trim();
      }
      iceServers.unshift(customTurn);
    }

    const rtcConfig: RTCConfiguration = {
      iceServers,
      iceTransportPolicy: this.turnConfig?.forceRelay ? 'relay' : 'all',
    };

    const relayConfig = {
      urls: [
        'wss://broker.emqx.io:8084/mqtt',
        'wss://broker.hivemq.com:8884/mqtt',
      ],
    };

    try {
      this.room = joinRoom(
        {
          appId: APP_ID,
          relayConfig,
          rtcConfig,
        },
        this.roomId
      );

      // 1. Setup Chat Action
      this.chatAction = this.room.makeAction('chat');
      this.chatAction.onMessage = (msg: ChatMessage) => {
        if (this.callbacks) {
          this.callbacks.onChat(msg);
        }
      };

      // 2. Setup Presence Action (Exchange usernames)
      this.presenceAction = this.room.makeAction('presence');
      this.presenceAction.onMessage = (data: { username: string; isCreator?: boolean }, meta: { peerId: string }) => {
        const peerId = meta.peerId;
        const oldName = this.peers.get(peerId);
        const newName = data.username || `Usuário (${peerId.slice(0, 4)})`;
        if (oldName !== newName) {
          this.peers.set(peerId, newName);
          this.notifyPeersUpdate();
          this.notifyStreamsUpdate();
        }
        callbacks.onStatusChange(this.turnConfig?.forceRelay ? 'P2P (Relay Seguro)' : 'P2P Conectado');
      };

      // 3. Setup Stream Status Action
      this.streamStatusAction = this.room.makeAction('stream_status');
      this.streamStatusAction.onMessage = (data: { isStreaming: boolean; senderName?: string }, meta: { peerId: string }) => {
        const peerId = meta.peerId;
        if (!data.isStreaming && this.remoteStreams.has(peerId)) {
          this.remoteStreams.delete(peerId);
          this.notifyStreamsUpdate();
        }
      };

      // 4. Peer Lifecycle Listeners
      this.room.onPeerJoin = (peerId: string) => {
        console.log(`[P2P] Peer joined room: ${peerId}`);
        
        // Send presence immediately to new peer
        if (this.presenceAction) {
          this.presenceAction.send({ username: this.username, isCreator: this.isCreator }, { target: peerId });
        }

        // If I am already sharing a stream, broadcast it to the new peer with burst bitrate
        if (this.localStream) {
          try {
            this.room.addStream(this.localStream, peerId);
            [50, 150, 300, 600, 1200, 2000].forEach((delay) => {
              setTimeout(() => this.boostSenders(this.currentTargetBitrate, this.currentTargetFps), delay);
            });
          } catch (err) {
            console.warn('[P2P] Error adding stream to new peer:', err);
          }
        }

        this.peers.set(peerId, `Conectado (${peerId.slice(0, 4)})`);
        this.notifyPeersUpdate();
        this.notifyStreamsUpdate();
        callbacks.onStatusChange(this.turnConfig?.forceRelay ? 'P2P (Relay Seguro)' : 'P2P Conectado');
      };

      this.room.onPeerLeave = (peerId: string) => {
        console.log(`[P2P] Peer left room: ${peerId}`);
        this.peers.delete(peerId);
        if (this.remoteStreams.has(peerId)) {
          this.remoteStreams.delete(peerId);
        }
        this.notifyPeersUpdate();
        this.notifyStreamsUpdate();
        if (this.peers.size === 0) {
          callbacks.onStatusChange('Sala Ativa');
        }
      };

      // 5. Incoming Stream Listener
      this.room.onPeerStream = (stream: MediaStream, peerId: string) => {
        console.log(`[P2P] Received stream from peer: ${peerId}`);
        this.remoteStreams.set(peerId, stream);
        this.notifyStreamsUpdate();
        callbacks.onStatusChange('Ao Vivo');
      };

      // 6. Continuous presence heartbeat (every 3s)
      this.heartbeatTimer = setInterval(() => {
        if (!this.room) return;
        if (this.presenceAction) {
          this.presenceAction.send({ username: this.username, isCreator: this.isCreator });
        }
      }, 3000);

      // Initial broadcast
      setTimeout(() => {
        if (this.presenceAction) {
          this.presenceAction.send({ username: this.username, isCreator: this.isCreator });
        }
      }, 300);

      callbacks.onStatusChange('Sala Ativa');
      this.notifyStreamsUpdate();
    } catch (err) {
      console.error('[P2P] Failed to join room in GroupRoomManager:', err);
      callbacks.onStatusChange('Erro ao conectar');
    }
  }

  public shareStream(stream: MediaStream, targetBitrateBps: number = 25000000, targetFps: number = 60) {
    this.localStream = stream;
    this.currentTargetBitrate = targetBitrateBps;
    this.currentTargetFps = targetFps;

    if (this.room && stream) {
      try {
        this.room.addStream(stream);
        // Fire rapid bursts so WebRTC skips the 6-second low-bitrate probing ramp-up
        [30, 100, 250, 500, 1000, 1800, 2500].forEach((delay) => {
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
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (params as any).degradationPreference = 'maintain-framerate';
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
      list.push({
        peerId,
        senderName: uname,
        stream,
        isStreaming: Boolean(stream),
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

  public leave() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.stopStream();
    if (this.room) {
      this.room.leave();
      this.room = null;
    }
    this.peers.clear();
    this.remoteStreams.clear();
    this.lastStreamsHash = '';
  }
}
