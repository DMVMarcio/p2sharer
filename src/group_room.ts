import { joinRoom } from '@trystero-p2p/nostr';
import { ChatMessage, PeerInfo } from './types';

const APP_ID = 'p2sharer-nostr-group-v1';

export class GroupHostManager {
  private username: string;
  private roomId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private room: any = null;
  private stream: MediaStream | null = null;
  private peers: Map<string, string> = new Map(); // peerId -> username
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private sendChatAction: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private sendPresenceAction: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private sendStreamStatusAction: any = null;
  private onChatCallback: ((msg: ChatMessage) => void) | null = null;
  private onPeersUpdateCallback: ((peers: PeerInfo[]) => void) | null = null;

  constructor(username: string, roomId: string) {
    this.username = username;
    this.roomId = roomId.toUpperCase().trim();
  }

  public join(
    onChat: (msg: ChatMessage) => void,
    onPeersUpdate: (peers: PeerInfo[]) => void
  ) {
    this.onChatCallback = onChat;
    this.onPeersUpdateCallback = onPeersUpdate;

    try {
      this.room = joinRoom({ appId: APP_ID }, this.roomId);

      const chatActions = this.room.makeAction('chat');
      this.sendChatAction = chatActions[0];
      const onChatReceived = chatActions[1];
      if (typeof onChatReceived === 'function') {
        onChatReceived((msg: ChatMessage) => {
          if (this.onChatCallback) {
            this.onChatCallback(msg);
          }
        });
      }

      const presenceActions = this.room.makeAction('presence');
      this.sendPresenceAction = presenceActions[0];
      const onPresenceReceived = presenceActions[1];
      if (typeof onPresenceReceived === 'function') {
        onPresenceReceived((data: { username: string }, peerId: string) => {
          this.peers.set(peerId, data.username || `Convidado (${peerId.slice(0, 4)})`);
          this.notifyPeersUpdate();
        });
      }

      const streamStatusActions = this.room.makeAction('stream_status');
      this.sendStreamStatusAction = streamStatusActions[0];

      this.room.onPeerJoin((peerId: string) => {
        console.log(`[Host] Peer joined: ${peerId}`);
        if (this.stream && this.room) {
          try {
            this.room.addStream(this.stream, peerId);
          } catch (e) {
            console.warn('Failed to addStream to peer:', e);
          }
        }
        if (this.sendPresenceAction) {
          this.sendPresenceAction({ username: this.username }, peerId);
        }
        this.peers.set(peerId, `Convidado (${peerId.slice(0, 4)})`);
        this.notifyPeersUpdate();
      });

      this.room.onPeerLeave((peerId: string) => {
        console.log(`[Host] Peer left: ${peerId}`);
        this.peers.delete(peerId);
        this.notifyPeersUpdate();
      });
    } catch (err) {
      console.error('Failed to initialize group host room:', err);
    }
  }

  public setStream(stream: MediaStream | null) {
    this.stream = stream;
    if (this.room && stream) {
      this.peers.forEach((_, peerId) => {
        try {
          this.room.addStream(stream, peerId);
        } catch (e) {
          console.warn('Error adding stream to peer:', peerId, e);
        }
      });
    }

    if (this.sendStreamStatusAction) {
      this.sendStreamStatusAction({ isStreaming: stream !== null, hostName: this.username });
    }
  }

  public sendChatMessage(text: string): ChatMessage {
    const msg: ChatMessage = {
      id: crypto.randomUUID(),
      sender: this.username,
      text,
      timestamp: Date.now(),
      isHost: true,
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
    if (this.onPeersUpdateCallback) {
      this.onPeersUpdateCallback(this.getConnectedPeers());
    }
  }

  public stop() {
    if (this.room) {
      this.room.leave();
      this.room = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    this.peers.clear();
  }
}

export class GroupViewerManager {
  private username: string;
  private roomId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private room: any = null;
  private remoteStream: MediaStream = new MediaStream();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private sendChatAction: any = null;
  private onChatCallback: ((msg: ChatMessage) => void) | null = null;
  private onStreamReceivedCallback: ((stream: MediaStream) => void) | null = null;
  private onStreamEndedCallback: (() => void) | null = null;
  private hostName = 'Apresentador';

  constructor(username: string, roomId: string) {
    this.username = username;
    this.roomId = roomId.toUpperCase().trim();
  }

  public join(
    onStream: (stream: MediaStream) => void,
    onStreamEnded: () => void,
    onChat: (msg: ChatMessage) => void,
    onStatusChange: (status: string) => void
  ) {
    this.onStreamReceivedCallback = onStream;
    this.onStreamEndedCallback = onStreamEnded;
    this.onChatCallback = onChat;

    onStatusChange('Conectando à rede...');
    try {
      this.room = joinRoom({ appId: APP_ID }, this.roomId);

      const chatActions = this.room.makeAction('chat');
      this.sendChatAction = chatActions[0];
      const onChatReceived = chatActions[1];
      if (typeof onChatReceived === 'function') {
        onChatReceived((msg: ChatMessage) => {
          if (this.onChatCallback) {
            this.onChatCallback(msg);
          }
        });
      }

      const presenceActions = this.room.makeAction('presence');
      const sendPresence = presenceActions[0];
      const onPresenceReceived = presenceActions[1];
      if (typeof onPresenceReceived === 'function') {
        onPresenceReceived((data: { username: string }) => {
          this.hostName = data.username || 'Apresentador';
        });
      }

      const streamStatusActions = this.room.makeAction('stream_status');
      const onStreamStatus = streamStatusActions[1];
      if (typeof onStreamStatus === 'function') {
        onStreamStatus((data: { isStreaming: boolean; hostName?: string }) => {
          if (data.isStreaming) {
            if (data.hostName) this.hostName = data.hostName;
            onStatusChange(`Ao Vivo por ${this.hostName}`);
          } else {
            if (this.onStreamEndedCallback) {
              this.onStreamEndedCallback();
            }
            onStatusChange('Transmissão encerrada');
          }
        });
      }

      this.room.onPeerJoin((peerId: string) => {
        if (typeof sendPresence === 'function') {
          sendPresence({ username: this.username }, peerId);
        }
        onStatusChange('Conectado à sala');
      });

      this.room.onPeerStream((stream: MediaStream, _peerId: string) => {
        console.log('[Viewer] Remote stream received');
        this.remoteStream = stream;
        if (this.onStreamReceivedCallback) {
          this.onStreamReceivedCallback(stream);
        }
        onStatusChange('Ao Vivo');
      });

      this.room.onPeerLeave(() => {
        onStatusChange('Participante desconectou.');
      });
    } catch (err) {
      console.error('Failed to join room in GroupViewerManager:', err);
      onStatusChange('Erro ao conectar');
    }
  }

  public getRemoteStream(): MediaStream {
    return this.remoteStream;
  }

  public getHostName(): string {
    return this.hostName;
  }

  public sendChatMessage(text: string): ChatMessage {
    const msg: ChatMessage = {
      id: crypto.randomUUID(),
      sender: this.username,
      text,
      timestamp: Date.now(),
      isHost: false,
    };

    if (this.sendChatAction) {
      this.sendChatAction(msg);
    }
    return msg;
  }

  public stop() {
    if (this.room) {
      this.room.leave();
      this.room = null;
    }
  }
}
