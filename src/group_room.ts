import { joinRoom, selfId } from '@trystero-p2p/mqtt';
import { ChatMessage, PeerInfo } from './types';

const APP_ID = 'p2sharer-mqtt-room';

const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
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
  private sendChatAction: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private sendPresenceAction: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private sendStreamStatusAction: any = null;

  private callbacks: RoomCallbacks | null = null;
  private activeStreamSenderName: string = '';

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
        },
        this.roomId
      );

      // 1. Chat Action
      const chatTuple = this.room.makeAction('chat');
      this.sendChatAction = chatTuple[0];
      const onChat = chatTuple[1];
      if (typeof onChat === 'function') {
        onChat((msg: ChatMessage) => {
          if (this.callbacks) {
            this.callbacks.onChat(msg);
          }
        });
      }

      // 2. Presence Action (Exchange usernames)
      const presenceTuple = this.room.makeAction('presence');
      this.sendPresenceAction = presenceTuple[0];
      const onPresence = presenceTuple[1];
      if (typeof onPresence === 'function') {
        onPresence((data: { username: string; isCreator?: boolean }, peerId: string) => {
          console.log(`[P2P] Presence received from ${peerId}:`, data.username);
          this.peers.set(peerId, data.username || `Usuário (${peerId.slice(0, 4)})`);
          this.notifyPeersUpdate();
          callbacks.onStatusChange('P2P Conectado');
        });
      }

      // 3. Stream Status Action
      const streamStatusTuple = this.room.makeAction('stream_status');
      this.sendStreamStatusAction = streamStatusTuple[0];
      const onStreamStatus = streamStatusTuple[1];
      if (typeof onStreamStatus === 'function') {
        onStreamStatus((data: { isStreaming: boolean; senderName?: string }) => {
          if (data.isStreaming) {
            this.activeStreamSenderName = data.senderName || 'Participante';
            callbacks.onStatusChange(`Ao Vivo: ${this.activeStreamSenderName}`);
          } else {
            callbacks.onStreamEnded();
            callbacks.onStatusChange('P2P Conectado');
          }
        });
      }

      // 4. Peer Lifecycle
      this.room.onPeerJoin((peerId: string) => {
        console.log(`[P2P] Peer joined room: ${peerId}`);
        // Broadcast my username to the new peer
        if (this.sendPresenceAction) {
          this.sendPresenceAction({ username: this.username, isCreator: this.isCreator }, peerId);
        }

        // If I am currently sharing a screen, send the stream to the new peer
        if (this.localStream) {
          try {
            this.room.addStream(this.localStream, peerId);
          } catch (err) {
            console.warn('[P2P] Failed to add stream to new peer:', err);
          }
        }

        this.peers.set(peerId, `Conectado (${peerId.slice(0, 4)})`);
        this.notifyPeersUpdate();
        callbacks.onStatusChange('P2P Conectado');
      });

      this.room.onPeerLeave((peerId: string) => {
        console.log(`[P2P] Peer left room: ${peerId}`);
        this.peers.delete(peerId);
        this.notifyPeersUpdate();
        if (this.peers.size === 0) {
          callbacks.onStatusChange(this.isCreator ? 'Sala Ativa (Aguardando amigos)' : 'P2P Conectado');
        }
      });

      // 5. Incoming Stream
      this.room.onPeerStream((stream: MediaStream, peerId: string) => {
        console.log(`[P2P] Received stream from peer ${peerId}`);
        const sender = this.peers.get(peerId) || this.activeStreamSenderName || 'Participante';
        callbacks.onStream(stream, sender);
        callbacks.onStatusChange(`Ao Vivo por ${sender}`);
      });

      // Heartbeat presence announcement every 3 seconds to ensure sync
      const presenceInterval = setInterval(() => {
        if (!this.room) {
          clearInterval(presenceInterval);
          return;
        }
        if (this.sendPresenceAction) {
          this.sendPresenceAction({ username: this.username, isCreator: this.isCreator });
        }
      }, 3000);

      // Initial presence broadcast
      setTimeout(() => {
        if (this.sendPresenceAction) {
          this.sendPresenceAction({ username: this.username, isCreator: this.isCreator });
        }
      }, 300);

      callbacks.onStatusChange(this.isCreator ? 'Sala Aberta (Aguardando amigos)' : 'Conectado à sala');
    } catch (err) {
      console.error('[P2P] Failed to join room:', err);
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

      if (this.sendStreamStatusAction) {
        this.sendStreamStatusAction({ isStreaming: true, senderName: this.username });
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

    if (this.sendStreamStatusAction) {
      this.sendStreamStatusAction({ isStreaming: false });
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

    if (this.sendChatAction) {
      this.sendChatAction(msg);
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
    this.stopStream();
    if (this.room) {
      this.room.leave();
      this.room = null;
    }
    this.peers.clear();
  }
}
