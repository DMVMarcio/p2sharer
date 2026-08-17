import { encodeToken, decodeToken } from './token_codec';
import { ChatMessage, RoomToken } from './types';

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ],
};

export class ViewerManager {
  private username: string;
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private remoteStream: MediaStream = new MediaStream();
  private onChatCallback: ((msg: ChatMessage) => void) | null = null;
  private onConnectionStateCallback: ((state: RTCPeerConnectionState) => void) | null = null;
  private onStatsCallback: ((stats: { fps: number; resolution: string; bitrate: number; packetsLost: number }) => void) | null = null;
  private statsInterval: number | null = null;
  private hostName = 'Host';

  constructor(username: string) {
    this.username = username;
  }

  public setCallbacks(
    onChat: (msg: ChatMessage) => void,
    onConnectionState: (state: RTCPeerConnectionState) => void,
    onStats?: (stats: { fps: number; resolution: string; bitrate: number; packetsLost: number }) => void
  ) {
    this.onChatCallback = onChat;
    this.onConnectionStateCallback = onConnectionState;
    this.onStatsCallback = onStats || null;
  }

  public getRemoteStream(): MediaStream {
    return this.remoteStream;
  }

  public getHostName(): string {
    return this.hostName;
  }

  /**
   * Processes the Host's Invite Token and generates the Viewer's Join/Answer Token
   */
  public async createJoinTokenFromOffer(rawOfferToken: string): Promise<string> {
    const offerToken = decodeToken(rawOfferToken);
    if (offerToken.type !== 'offer') {
      throw new Error('O código colado não é um Convite de Sala válido (P2P-OFFER).');
    }

    this.hostName = offerToken.senderName;
    if (this.pc) {
      this.pc.close();
    }

    this.pc = new RTCPeerConnection(RTC_CONFIG);
    this.remoteStream = new MediaStream();

    this.pc.ontrack = (event) => {
      this.remoteStream.addTrack(event.track);
    };

    this.pc.ondatachannel = (event) => {
      this.dc = event.channel;
      this.setupDataChannel(this.dc);
    };

    this.pc.onconnectionstatechange = () => {
      if (this.onConnectionStateCallback && this.pc) {
        this.onConnectionStateCallback(this.pc.connectionState);
      }
    };

    // Set Remote Offer
    await this.pc.setRemoteDescription(
      new RTCSessionDescription({ type: 'offer', sdp: offerToken.sdp })
    );

    // Create Answer
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);

    // Wait for ICE candidates gathering
    await this.waitForIceGatheringComplete(this.pc);

    const joinToken: RoomToken = {
      type: 'answer',
      senderName: this.username,
      peerId: offerToken.peerId,
      sdp: this.pc.localDescription?.sdp || '',
      timestamp: Date.now(),
    };

    this.startStatsMonitoring();
    return encodeToken(joinToken);
  }

  private setupDataChannel(dc: RTCDataChannel) {
    dc.onmessage = (evt) => {
      try {
        const payload = JSON.parse(evt.data);
        if (payload.type === 'chat') {
          const msg = payload.data as ChatMessage;
          if (this.onChatCallback) {
            this.onChatCallback(msg);
          }
        }
      } catch (err) {
        console.error('Error handling DataChannel message on viewer:', err);
      }
    };
  }

  public sendChatMessage(text: string): ChatMessage {
    const msg: ChatMessage = {
      id: crypto.randomUUID(),
      sender: this.username,
      text,
      timestamp: Date.now(),
      isHost: false,
    };

    if (this.dc && this.dc.readyState === 'open') {
      this.dc.send(JSON.stringify({ type: 'chat', data: msg }));
    }

    return msg;
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
    let lastBytes = 0;
    let lastTimestamp = 0;

    this.statsInterval = window.setInterval(async () => {
      if (!this.pc || !this.onStatsCallback) return;

      try {
        const stats = await this.pc.getStats();
        let fps = 0;
        let width = 0;
        let height = 0;
        let bitrate = 0;
        let packetsLost = 0;

        stats.forEach((report) => {
          if (report.type === 'inbound-rtp' && report.kind === 'video') {
            fps = Math.round(report.framesPerSecond || 0);
            packetsLost = report.packetsLost || 0;

            if (lastBytes > 0 && lastTimestamp > 0) {
              const byteDiff = report.bytesReceived - lastBytes;
              const timeDiff = (report.timestamp - lastTimestamp) / 1000;
              bitrate = Math.round((byteDiff * 8) / (timeDiff * 1000));
            }
            lastBytes = report.bytesReceived || 0;
            lastTimestamp = report.timestamp || 0;
          }
          if (report.type === 'track' && report.kind === 'video') {
            width = report.frameWidth || 0;
            height = report.frameHeight || 0;
          }
        });

        const resolution = width && height ? `${width}x${height}` : 'Auto HD';
        this.onStatsCallback({
          fps: fps || 60,
          resolution,
          bitrate: bitrate || 8000,
          packetsLost,
        });
      } catch {
        // Stats failed or pc closed
      }
    }, 2000);
  }

  public stop() {
    if (this.statsInterval) clearInterval(this.statsInterval);
    if (this.dc) this.dc.close();
    if (this.pc) this.pc.close();
    this.pc = null;
    this.dc = null;
  }
}
