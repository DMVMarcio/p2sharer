import { joinRoom, selfId } from '@trystero-p2p/mqtt';
import { ActiveStreamInfo, ChatMessage, PeerInfo } from './types';

const APP_ID = 'p2sharer-multi-stream-v1';

const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' },
  ],
};

const RELAY_CONFIG = {
  urls: [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt',
  ],
};

export interface RoomCallbacks {
  onStreamsUpdate: (streams: ActiveStreamInfo[]) => void;
  onChat: (msg: ChatMessage) => void;
  onPeersUpdate: (peers: PeerInfo[]) => void;
  onStatusChange: (status: string) => void;
}

export class GroupRoomManager {
  private username: string;
  private roomId: string;
  private isCreator: boolean;
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

  constructor(username: string, roomId: string, isCreator = false) {
    this.username = username;
    this.roomId = roomId.toUpperCase().trim();
    this.isCreator = isCreator;
  }

  public join(callbacks: RoomCallbacks) {
    this.callbacks = callbacks;
    callbacks.onStatusChange('Conectando ao canal P2P...');
    console.log(`[P2P] Joining room ${this.roomId} as ${this.username} (Self ID: ${selfId})`);

    try {
      this.room = joinRoom(
        {
          appId: APP_ID,
          rtcConfig: RTC_CONFIG,
          relayConfig: RELAY_CONFIG,
        },
        this.roomId
      );

      // 1. Data Channel Action: Chat Messages
      const [sendChat, onChatReceived] = this.room.makeAction('chat');
      this.chatAction = { send: sendChat };
      onChatReceived((data: ChatMessage) => {
        if (data && data.text) {
          callbacks.onChat(data);
        }
      });

      // 2. Data Channel Action: Presence & Nicknames
      const [sendPresence, onPresenceReceived] = this.room.makeAction('presence');
      this.presenceAction = { send: sendPresence };
      onPresenceReceived((data: { username: string; isCreator: boolean }, peerId: string) => {
        if (data && data.username) {
          this.peers.set(peerId, data.username);
          this.notifyPeersUpdate();
          this.notifyStreamsUpdate();
        }
      });

      // 3. Data Channel Action: Stream Active Status
      const [sendStreamStatus, onStreamStatus] = this.room.makeAction('stream-status');
      this.streamStatusAction = { send: sendStreamStatus };
      onStreamStatus((data: { isStreaming: boolean; senderName?: string }, peerId: string) => {
        if (!data.isStreaming && this.remoteStreams.has(peerId)) {
          this.remoteStreams.delete(peerId);
          this.notifyStreamsUpdate();
        }
      });

      // 4. Peer Lifecycle Listeners
      this.room.onPeerJoin = (peerId: string) => {
        console.log(`[P2P] Peer joined room: ${peerId}`);
        
        // Send presence immediately to new peer
        if (this.presenceAction) {
          this.presenceAction.send({ username: this.username, isCreator: this.isCreator }, { target: peerId });
        }

        // If I am already sharing a stream, broadcast it to the new peer
        if (this.localStream) {
          try {
            this.room.addStream(this.localStream, peerId);
            setTimeout(() => this.boostAllSendersBitrate(), 150);
          } catch (err) {
            console.warn('[P2P] Error adding stream to new peer:', err);
          }
        }

        this.peers.set(peerId, `Conectado (${peerId.slice(0, 4)})`);
        this.notifyPeersUpdate();
        callbacks.onStatusChange('P2P Conectado');
      };

      this.room.onPeerLeave = (peerId: string) => {
        console.log(`[P2P] Peer left room: ${peerId}`);
        this.peers.delete(peerId);
        if (this.remoteStreams.has(peerId)) {
          this.remoteStreams.delete(peerId);
          this.notifyStreamsUpdate();
        }
        this.notifyPeersUpdate();
        if (this.peers.size === 0) {
          callbacks.onStatusChange(this.isCreator ? 'Sala Ativa (Aguardando amigos)' : 'P2P Conectado');
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

      callbacks.onStatusChange(this.isCreator ? 'Sala Ativa (Aguardando amigos)' : 'P2P Conectado');
    } catch (err) {
      console.error('[P2P] Failed to join room in GroupRoomManager:', err);
      callbacks.onStatusChange('Erro ao conectar');
    }
  }

  public shareStream(stream: MediaStream) {
    this.localStream = stream;
    if (this.room && stream) {
      try {
        this.room.addStream(stream);
        setTimeout(() => this.boostAllSendersBitrate(), 100);
      } catch (err) {
        console.warn('[P2P] Error adding broadcast stream:', err);
      }

      if (this.streamStatusAction) {
        this.streamStatusAction.send({ isStreaming: true, senderName: this.username });
      }

      this.notifyStreamsUpdate();
    }
  }

  public boostAllSendersBitrate() {
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
                params.encodings[0].maxBitrate = 25000000; // 25 Mbps
                params.encodings[0].maxFramerate = 60;
                params.encodings[0].networkPriority = 'high';
                params.encodings[0].priority = 'high';
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

  public sendChatMessage(text: string): ChatMessage {
    const msg: ChatMessage = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      sender: this.username,
      text: text.trim(),
      timestamp: Date.now(),
      isHost: this.isCreator,
    };

    if (this.chatAction && this.room) {
      this.chatAction.send(msg);
    }

    return msg;
  }

  private notifyPeersUpdate() {
    if (!this.callbacks) return;
    const peerList: PeerInfo[] = [];
    this.peers.forEach((uname, id) => {
      peerList.push({
        id,
        username: uname,
        connectionState: 'connected',
        joinedAt: Date.now(),
      });
    });
    this.callbacks.onPeersUpdate(peerList);
  }

  private notifyStreamsUpdate() {
    if (!this.callbacks) return;
    const streamsList: ActiveStreamInfo[] = [];

    // 1. My own stream
    if (this.localStream) {
      streamsList.push({
        peerId: 'local-self',
        senderName: `${this.username} (Você)`,
        stream: this.localStream,
        isLocal: true,
      });
    }

    // 2. Remote streams from peers
    this.remoteStreams.forEach((stream, peerId) => {
      const name = this.peers.get(peerId) || `Participante (${peerId.slice(0, 4)})`;
      streamsList.push({
        peerId,
        senderName: name,
        stream,
        isLocal: false,
      });
    });

    // Stream signature deduplication to avoid DOM rebuilding
    const currentHash = streamsList.map((s) => `${s.peerId}:${s.stream.id}`).sort().join('|');
    if (currentHash !== this.lastStreamsHash) {
      this.lastStreamsHash = currentHash;
      this.callbacks.onStreamsUpdate(streamsList);
    }
  }

  public leave() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.localStream) {
      this.stopStream();
    }
    if (this.room) {
      this.room.leave();
      this.room = null;
    }
    this.peers.clear();
    this.remoteStreams.clear();
    this.callbacks = null;
  }
}
