import { encodeToken, decodeToken } from './token_codec';
import { ChatMessage, PeerInfo, QualityProfile, RoomToken } from './types';

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ],
};

export class HostManager {
  private username: string;
  private stream: MediaStream | null = null;
  private peers: Map<string, { pc: RTCPeerConnection; dc: RTCDataChannel; username: string }> = new Map();
  private onChatCallback: ((msg: ChatMessage) => void) | null = null;
  private onPeersUpdateCallback: ((peers: PeerInfo[]) => void) | null = null;
  private onStatsCallback: ((stats: { fps: number; resolution: string; bitrate: number }) => void) | null = null;
  private statsInterval: number | null = null;

  constructor(username: string) {
    this.username = username;
  }

  public async startCapture(
    profile: QualityProfile,
    customAudioTrack?: MediaStreamTrack | null
  ): Promise<MediaStream> {
    const videoConstraints: MediaTrackConstraints = {
      frameRate: { ideal: profile.frameRate, max: profile.frameRate },
      width: profile.width > 0 ? { ideal: profile.width, max: profile.width } : undefined,
      height: profile.height > 0 ? { ideal: profile.height, max: profile.height } : undefined,
    };

    const displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: videoConstraints,
      audio: true,
    });

    if (customAudioTrack) {
      // Remove any default audio tracks and attach our native filtered WASAPI track
      const existingAudio = displayStream.getAudioTracks();
      existingAudio.forEach((t) => {
        t.stop();
        displayStream.removeTrack(t);
      });
      displayStream.addTrack(customAudioTrack);
    }

    this.stream = displayStream;
    this.startStatsMonitoring();
    return displayStream;
  }

  public getStream(): MediaStream | null {
    return this.stream;
  }

  public setCallbacks(
    onChat: (msg: ChatMessage) => void,
    onPeersUpdate: (peers: PeerInfo[]) => void,
    onStats?: (stats: { fps: number; resolution: string; bitrate: number }) => void
  ) {
    this.onChatCallback = onChat;
    this.onPeersUpdateCallback = onPeersUpdate;
    this.onStatsCallback = onStats || null;
  }

  /**
   * Generates a new Room Offer Token for a new viewer to join.
   */
  public async createInviteToken(viewerSlotId: string): Promise<string> {
    if (!this.stream) {
      throw new Error('A transmissão de tela precisa ser iniciada antes de gerar convites.');
    }

    // Clean up existing peer on this slot if any
    if (this.peers.has(viewerSlotId)) {
      this.peers.get(viewerSlotId)?.pc.close();
      this.peers.delete(viewerSlotId);
    }

    const pc = new RTCPeerConnection(RTC_CONFIG);
    const dc = pc.createDataChannel('p2sharer-chat', { ordered: true });
    this.setupDataChannel(dc, viewerSlotId);

    // Add tracks to peer connection
    this.stream.getTracks().forEach((track) => {
      pc.addTrack(track, this.stream!);
    });

    this.peers.set(viewerSlotId, {
      pc,
      dc,
      username: `Convidado (${viewerSlotId.slice(0, 4)})`,
    });

    this.setupPeerListeners(pc, viewerSlotId);

    // Create SDP Offer
    const offer = await pc.createOffer({
      offerToReceiveAudio: false,
      offerToReceiveVideo: false,
    });

    await pc.setLocalDescription(offer);

    // Wait for ICE gathering to complete so all candidates are bundled in single token
    await this.waitForIceGatheringComplete(pc);

    const token: RoomToken = {
      type: 'offer',
      senderName: this.username,
      peerId: viewerSlotId,
      sdp: pc.localDescription?.sdp || '',
      timestamp: Date.now(),
    };

    return encodeToken(token);
  }

  /**
   * Accepts a Join/Answer token from a viewer and finishes the P2P connection.
   */
  public async acceptJoinToken(rawToken: string): Promise<string> {
    const token = decodeToken(rawToken);
    if (token.type !== 'answer') {
      throw new Error('O código colado não é uma Resposta de Convidado (P2P-JOIN).');
    }

    const targetPeerId = token.peerId || '';
    const peerData = this.peers.get(targetPeerId);
    if (!peerData) {
      throw new Error(`Nenhum convite pendente encontrado para este código (Slot: ${targetPeerId}).`);
    }

    peerData.username = token.senderName || 'Participante';

    await peerData.pc.setRemoteDescription(
      new RTCSessionDescription({ type: 'answer', sdp: token.sdp })
    );

    this.notifyPeersUpdate();
    return peerData.username;
  }

  private setupDataChannel(dc: RTCDataChannel, peerId: string) {
    dc.onopen = () => {
      // Send welcome / presence
      const welcome: ChatMessage = {
        id: crypto.randomUUID(),
        sender: 'Sistema',
        text: `Você conectou à transmissão de ${this.username}!`,
        timestamp: Date.now(),
        isSystem: true,
      };
      dc.send(JSON.stringify({ type: 'chat', data: welcome }));
      this.notifyPeersUpdate();
    };

    dc.onmessage = (evt) => {
      try {
        const payload = JSON.parse(evt.data);
        if (payload.type === 'chat') {
          const msg = payload.data as ChatMessage;
          if (this.onChatCallback) {
            this.onChatCallback(msg);
          }
          // Broadcast to all other connected peers
          this.broadcastChatMessage(msg, peerId);
        }
      } catch (err) {
        console.error('Error handling DataChannel message:', err);
      }
    };
  }

  private setupPeerListeners(pc: RTCPeerConnection, _peerId: string) {
    pc.onconnectionstatechange = () => {
      this.notifyPeersUpdate();
    };

    pc.oniceconnectionstatechange = () => {
      this.notifyPeersUpdate();
    };
  }

  public sendChatMessage(text: string): ChatMessage {
    const msg: ChatMessage = {
      id: crypto.randomUUID(),
      sender: this.username,
      text,
      timestamp: Date.now(),
      isHost: true,
    };

    this.broadcastChatMessage(msg);
    return msg;
  }

  public broadcastChatMessage(msg: ChatMessage, exceptPeerId?: string) {
    const raw = JSON.stringify({ type: 'chat', data: msg });
    this.peers.forEach((peer, pId) => {
      if (pId !== exceptPeerId && peer.dc.readyState === 'open') {
        peer.dc.send(raw);
      }
    });
  }

  public getConnectedPeers(): PeerInfo[] {
    const list: PeerInfo[] = [];
    this.peers.forEach((peer, id) => {
      const state = peer.pc.connectionState === 'connected' ? 'connected' : peer.pc.connectionState === 'connecting' ? 'connecting' : 'disconnected';
      list.push({
        id,
        username: peer.username,
        connectionState: state,
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

  private waitForIceGatheringComplete(pc: RTCPeerConnection, timeoutMs = 2500): Promise<void> {
    return new Promise((resolve) => {
      if (pc.iceGatheringState === 'complete') {
        resolve();
        return;
      }

      const checkState = () => {
        if (pc.iceGatheringState === 'complete') {
          pc.removeEventListener('icegatheringstatechange', checkState);
          resolve();
        }
      };

      pc.addEventListener('icegatheringstatechange', checkState);
      setTimeout(() => {
        pc.removeEventListener('icegatheringstatechange', checkState);
        resolve();
      }, timeoutMs);
    });
  }

  private startStatsMonitoring() {
    this.statsInterval = window.setInterval(async () => {
      if (!this.stream || !this.onStatsCallback) return;
      const videoTrack = this.stream.getVideoTracks()[0];
      if (!videoTrack) return;

      const settings = videoTrack.getSettings();
      const fps = settings.frameRate ? Math.round(settings.frameRate) : 60;
      const resolution = settings.width && settings.height ? `${settings.width}x${settings.height}` : '1080p';

      this.onStatsCallback({
        fps,
        resolution,
        bitrate: 15000,
      });
    }, 2000);
  }

  public stop() {
    if (this.statsInterval) clearInterval(this.statsInterval);
    this.peers.forEach((p) => {
      p.dc.close();
      p.pc.close();
    });
    this.peers.clear();
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
  }
}
