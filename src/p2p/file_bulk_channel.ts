const CHANNEL_ID = 42;
const HIGH_WATER_BYTES = 2 * 1024 * 1024;
const LOW_WATER_BYTES = 1024 * 1024;
const WAIT_TIMEOUT_MS = 10000;

interface PeerChannel {
  connection: RTCPeerConnection;
  channel: RTCDataChannel;
}

function waitForEvent(channel: RTCDataChannel, eventName: 'open' | 'bufferedamountlow'): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      channel.removeEventListener(eventName, onReady);
      channel.removeEventListener('close', onClosed);
      channel.removeEventListener('error', onClosed);
    };
    const onReady = () => { cleanup(); resolve(); };
    const onClosed = () => { cleanup(); reject(new Error('File data channel closed')); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('File data channel timed out')); }, WAIT_TIMEOUT_MS);
    channel.addEventListener(eventName, onReady);
    channel.addEventListener('close', onClosed);
    channel.addEventListener('error', onClosed);
    if (channel.readyState === 'closed') onClosed();
    else if (eventName === 'open' && channel.readyState === 'open') onReady();
    else if (eventName === 'bufferedamountlow' && channel.bufferedAmount <= LOW_WATER_BYTES) onReady();
  });
}

export class FileBulkChannelManager {
  private channels = new Map<string, PeerChannel>();
  private getConnection: (peerId: string) => RTCPeerConnection | undefined;
  private onPacket: (peerId: string, packet: Uint8Array) => void;

  constructor(getConnection: (peerId: string) => RTCPeerConnection | undefined,
    onPacket: (peerId: string, packet: Uint8Array) => void) {
    this.getConnection = getConnection;
    this.onPacket = onPacket;
  }

  public ensure(peerId: string): RTCDataChannel {
    const connection = this.getConnection(peerId);
    if (!connection || connection.connectionState !== 'connected') throw new Error('Peer unavailable');
    const existing = this.channels.get(peerId);
    if (existing?.connection === connection && existing.channel.readyState !== 'closed') return existing.channel;
    this.close(peerId);
    const channel = connection.createDataChannel('chat_file_bulk_v1', {
      negotiated: true, id: CHANNEL_ID, ordered: false,
    });
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = LOW_WATER_BYTES;
    const entry = { connection, channel };
    this.channels.set(peerId, entry);
    channel.onmessage = (event) => {
      if (this.channels.get(peerId) !== entry || this.getConnection(peerId) !== connection ||
          !(event.data instanceof ArrayBuffer)) return;
      this.onPacket(peerId, new Uint8Array(event.data));
    };
    channel.onclose = () => {
      if (this.channels.get(peerId) === entry) this.channels.delete(peerId);
    };
    return channel;
  }

  public async ready(peerId: string): Promise<RTCDataChannel> {
    const channel = this.getChannel(peerId);
    if (!channel) throw new Error('File data channel unavailable');
    if (channel.readyState !== 'open') await waitForEvent(channel, 'open');
    if (this.getChannel(peerId) !== channel || channel.readyState !== 'open') {
      throw new Error('File data channel unavailable');
    }
    return channel;
  }

  public async send(peerId: string, packet: Uint8Array, isCurrent: () => boolean): Promise<void> {
    const channel = await this.ready(peerId);
    const connection = this.getConnection(peerId);
    const maxMessageSize = connection?.sctp?.maxMessageSize;
    if (maxMessageSize && packet.byteLength > maxMessageSize) {
      throw new Error('File block exceeds WebRTC message limit');
    }
    while (channel.bufferedAmount > HIGH_WATER_BYTES) {
      await waitForEvent(channel, 'bufferedamountlow');
    }
    if (!isCurrent() || this.getChannel(peerId) !== channel || channel.readyState !== 'open') {
      throw new Error('File transfer no longer active');
    }
    channel.send(packet);
  }

  public getChannel(peerId: string): RTCDataChannel | null {
    const entry = this.channels.get(peerId);
    if (!entry || entry.connection !== this.getConnection(peerId) || entry.channel.readyState === 'closed') return null;
    return entry.channel;
  }

  public close(peerId: string): void {
    const entry = this.channels.get(peerId);
    if (!entry) return;
    this.channels.delete(peerId);
    entry.channel.close();
  }

  public closeAll(): void {
    for (const peerId of this.channels.keys()) this.close(peerId);
  }
}
