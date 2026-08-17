import { joinRoom, selfId } from '@trystero-p2p/mqtt';
import { ChatMessage, PeerInfo } from './types';

const APP_ID = 'p2sharer-mqtt-room-v2';

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
  onStream: (stream: MediaStream, senderName: string) => void;
  onStreamEnded: () => void;
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private chatAction: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private presenceAction: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private streamStatusAction: any = null;

  private callbacks: RoomCallbacks | null = null;
  private activeStreamSenderName: string = '';
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
        callbacks.onStatusChange('P2P Conectado');
      };

      // 3. Setup Stream Status Action
      this.streamStatusAction = this.room.makeAction('stream_status');
      this.streamStatusAction.onMessage = (data: { isStreaming: boolean; senderName?: string }) => {
        if (data.isStreaming) {
          this.activeStreamSenderName = data.senderName || 'Participante';
          callbacks.onStatusChange(`Ao Vivo: ${this.activeStreamSenderName}`);
        } else {
          callbacks.onStreamEnded();
          callbacks.onStatusChange('P2P Conectado');
        }
      };

      // 4. Peer Lifecycle Listeners (Setters in Trystero 0.20+)
      this.room.onPeerJoin = (peerId: string) => {
        console.log(`[P2P] Peer joined room: ${peerId}`);
        
        // Send presence immediately to new peer
        if (this.presenceAction) {
          this.presenceAction.send({ username: this.username, isCreator: this.isCreator }, { target: peerId });
        }

        // If I am already sharing screen, broadcast to new peer
        if (this.localStream) {
          try {
            this.room.addStream(this.localStream, peerId);
          } catch (err) {
            console.warn('[P2P] Error adding stream to new peer:', err);
          }
        }

        this.peers.set(peerId, `Conectando... (${peerId.slice(0, 4)})`);
        this.notifyPeersUpdate();
        callbacks.onStatusChange('P2P Conectado');
      };

      this.room.onPeerLeave = (peerId: string) => {
        console.log(`[P2P] Peer left room: ${peerId}`);
        this.peers.delete(peerId);
        this.notifyPeersUpdate();
        if (this.peers.size === 0) {
          callbacks.onStatusChange(this.isCreator ? 'Sala Ativa (Aguardando amigos)' : 'P2P Conectado');
        }
      };

      // 5. Incoming Stream Listener
      this.room.onPeerStream = (stream: MediaStream, peerId: string) => {
        console.log(`[P2P] Received stream from peer ${peerId}`);
        const sender = this.peers.get(peerId) || this.activeStreamSenderName || 'Participante';
        callbacks.onStream(stream, sender);
        callbacks.onStatusChange(`Ao Vivo por ${sender}`);
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
  }
}
