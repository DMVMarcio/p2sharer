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
          relayConfig: RELAY_CONFIG,
          rtcConfig: RTC_CONFIG,
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
        console.log(`[P2P] Presence received from ${peerId}:`, data.username);
        this.peers.set(peerId, data.username || `Usuário (${peerId.slice(0, 4)})`);
        this.notifyPeersUpdate();
        this.notifyStreamsUpdate();
        callbacks.onStatusChange('P2P Conectado');
      };

      // 3. Setup Stream Status Action
      this.streamStatusAction = this.room.makeAction('stream_status');
      this.streamStatusAction.onMessage = (data: { isStreaming: boolean; senderName?: string }, meta: { peerId: string }) => {
        const peerId = meta.peerId;
        if (!data.isStreaming) {
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

        // If I am already sharing a stream, broadcast it to the new peer
        if (this.localStream) {
          try {
            this.room.addStream(this.localStream, peerId);
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
        this.remoteStreams.delete(peerId);
        this.notifyPeersUpdate();
        this.notifyStreamsUpdate();
        if (this.peers.size === 0) {
          callbacks.onStatusChange(this.isCreator ? 'Sala Ativa (Aguardando amigos)' : 'P2P Conectado');
        }
      };

      // 5. Incoming Stream Listener (Supports multiple concurrent streams from different peers!)
      this.room.onPeerStream = (stream: MediaStream, peerId: string) => {
        console.log(`[P2P] Received stream from peer: ${peerId}`);
        this.remoteStreams.set(peerId, stream);
        this.notifyStreamsUpdate();
        callbacks.onStatusChange('Ao Vivo');
      };

      // 6. Continuous presence heartbeat (every 2.5s)
      this.heartbeatTimer = setInterval(() => {
        if (!this.room) return;
        if (this.presenceAction) {
          this.presenceAction.send({ username: this.username, isCreator: this.isCreator });
        }
      }, 2500);

      // Initial broadcast
      setTimeout(() => {
        if (this.presenceAction) {
          this.presenceAction.send({ username: this.username, isCreator: this.isCreator });
        }
      }, 300);

      callbacks.onStatusChange(this.isCreator ? 'Sala Ativa (Aguardando amigos)' : 'Conectado à sala');
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
      } catch (err) {
        console.warn('[P2P] Error adding broadcast stream:', err);
      }

      if (this.streamStatusAction) {
        this.streamStatusAction.send({ isStreaming: true, senderName: this.username });
      }

      this.notifyStreamsUpdate();
    }
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
        senderName: `${this.username} (Sua Tela)`,
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

  public notifyStreamsUpdate() {
    if (this.callbacks) {
      this.callbacks.onStreamsUpdate(this.getAllActiveStreams());
    }
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
  }
}
