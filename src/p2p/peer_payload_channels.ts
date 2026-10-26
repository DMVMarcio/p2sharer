type Lane = 'profile' | 'tunnel' | 'datagram';
const lanes: Lane[] = ['profile', 'tunnel', 'datagram'];
const limits = { profile: 128 * 1024, tunnel: 64 * 1024, datagram: 16 * 1024 };
interface Entry { connection: RTCPeerConnection; channels: Record<Lane, RTCDataChannel>; queues: Partial<Record<Lane, Promise<unknown>>>; pending: Partial<Record<Lane, number>> }

/** Independent binary lanes keep bulk images out of interactive packet queues. */
export class PeerPayloadChannels {
  private peers = new Map<string, Entry>();
  private connection: (peer: string) => RTCPeerConnection | undefined;
  private receive: (peer: string, lane: Lane, frame: Uint8Array) => void;
  constructor(connection: (peer: string) => RTCPeerConnection | undefined,
    receive: (peer: string, lane: Lane, frame: Uint8Array) => void) {
    this.connection = connection; this.receive = receive;
  }
  ensure(peer: string): void {
    const connection = this.connection(peer);
    if (!connection || connection.connectionState !== 'connected') return;
    if (this.peers.get(peer)?.connection === connection) return;
    this.close(peer);
    const channels = {} as Record<Lane, RTCDataChannel>;
    const entry: Entry = { connection, channels, queues: {}, pending: {} };
    this.peers.set(peer, entry);
    lanes.forEach((lane, index) => {
      const channel = connection.createDataChannel(`peer_${lane}_v1`, {
        negotiated: true, id: 43 + index, ordered: lane !== 'datagram',
        ...(lane === 'datagram' ? { maxRetransmits: 0 } : {}),
      });
      channels[lane] = channel;
      channel.binaryType = 'arraybuffer'; channel.bufferedAmountLowThreshold = limits[lane] / 2;
      channel.onmessage = event => {
        if (this.peers.get(peer) === entry && this.connection(peer) === connection && event.data instanceof ArrayBuffer)
          this.receive(peer, lane, new Uint8Array(event.data));
      };
    });
  }
  available(peer: string, lane: Lane): boolean {
    const entry = this.peers.get(peer);
    return Boolean(entry && this.connection(peer) === entry.connection && entry.channels[lane].readyState === 'open');
  }
  send(peer: string, lane: Lane, frame: Uint8Array, current: () => boolean, maxBuffer?: number): Promise<boolean> {
    const entry = this.peers.get(peer);
    if (!entry || lane === 'datagram') return this.transmit(peer, lane, frame, current, maxBuffer);
    if ((entry.pending[lane] ?? 0) >= 1024) return Promise.reject(new Error('Peer payload queue is full'));
    entry.pending[lane] = (entry.pending[lane] ?? 0) + 1;
    const next = (entry.queues[lane] ?? Promise.resolve()).then(() => {
      if (this.peers.get(peer) !== entry || !current()) throw new Error('Peer unavailable');
      return this.transmit(peer, lane, frame, current, maxBuffer);
    });
    entry.queues[lane] = next.catch(() => {});
    return next.finally(() => { entry.pending[lane]!--; });
  }
  private async transmit(peer: string, lane: Lane, frame: Uint8Array, current: () => boolean, maxBuffer?: number): Promise<boolean> {
    const entry = this.peers.get(peer), channel = entry?.channels[lane];
    if (!entry || !channel) return false;
    if (channel.readyState === 'connecting') {
      if (lane === 'datagram') return true;
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); channel.removeEventListener('open', opened); channel.removeEventListener('close', closed); channel.removeEventListener('error', closed); };
        const opened = () => { cleanup(); resolve(); };
        const closed = () => { cleanup(); reject(new Error('Peer payload channel closed')); };
        const timer = setTimeout(closed, 10000);
        channel.addEventListener('open', opened); channel.addEventListener('close', closed); channel.addEventListener('error', closed);
        if (channel.readyState === 'open') opened(); else if (channel.readyState !== 'connecting') closed();
      });
    }
    if (!this.available(peer, lane)) throw new Error('Peer payload channel unavailable');
    if (frame.length > (entry.connection.sctp?.maxMessageSize || 65536)) return false;
    const limit = maxBuffer ?? limits[lane];
    if (lane === 'datagram' && channel.bufferedAmount > 0 && channel.bufferedAmount + frame.length > limit) return true; // Drop stale traffic, never build a latency queue.
    while (channel.bufferedAmount > limit) {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); channel.removeEventListener('bufferedamountlow', ready); channel.removeEventListener('close', closed); channel.removeEventListener('error', closed); };
        const ready = () => { cleanup(); resolve(); };
        const closed = () => { cleanup(); reject(new Error('Peer payload channel closed')); };
        const timer = setTimeout(closed, 10000);
        channel.addEventListener('bufferedamountlow', ready); channel.addEventListener('close', closed); channel.addEventListener('error', closed);
        if (channel.readyState !== 'open') closed(); else if (channel.bufferedAmount <= channel.bufferedAmountLowThreshold) ready();
      });
    }
    if (!current() || this.peers.get(peer) !== entry || !this.available(peer, lane)) throw new Error('Peer unavailable');
    channel.send(frame); return true;
  }
  close(peer: string): void {
    const entry = this.peers.get(peer); this.peers.delete(peer);
    if (entry) for (const channel of Object.values(entry.channels)) channel.close();
  }
  closeAll(): void { for (const peer of this.peers.keys()) this.close(peer); }
}
