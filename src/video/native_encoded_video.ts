import { invoke } from '@tauri-apps/api/core';

export interface NativeEncodedPacket {
  key: boolean; width: number; height: number; sequence: number; timestamp: number; data: Uint8Array;
}
export function isNativeEncodedPacket(buffer: ArrayBuffer): boolean {
  return buffer.byteLength >= 4 && new DataView(buffer).getUint32(0, true) === 0x564e3250;
}
export function parseNativeEncodedPacket(buffer: ArrayBuffer): NativeEncodedPacket {
  if (!isNativeEncodedPacket(buffer) || buffer.byteLength <= 28 || buffer.byteLength > 16 * 1024 * 1024 + 28) {
    throw new Error('Invalid native encoded video packet');
  }
  const view = new DataView(buffer);
  if (view.getUint8(4) !== 1 || view.getUint8(5) > 1 || view.getUint16(6, true) !== 0) {
    throw new Error('Unsupported native encoded video packet');
  }
  const width = view.getUint32(8, true), height = view.getUint32(12, true);
  const timestamp = Number(view.getBigUint64(20, true));
  if (!width || !height || width > 8192 || height > 8192 || !Number.isSafeInteger(timestamp)) {
    throw new Error('Invalid native encoded video dimensions or timestamp');
  }
  return { key: Boolean(view.getUint8(5)), width, height, sequence: view.getUint32(16, true), timestamp,
    data: new Uint8Array(buffer, 28) };
}

/** Sequential low-delay Annex B decoding, with keyframe recovery after bounded-queue drops. */
export class NativeEncodedDecoder {
  private decoder: VideoDecoder | null = null;
  private pending = new Map<number, { resolve: (frame: VideoFrame | null) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private queued: Array<{ buffer: ArrayBuffer; sequence: number; resolve: (frame: VideoFrame | null) => void; reject: (error: Error) => void }> = [];
  private sequence: number | null = null;
  private geometry = '';
  private waitingForKey = true;
  private closed = false;
  private requestingKey = false;
  private lastKeyRequest = -Infinity;
  private sessionId: string;
  private feedbackToken: string;
  constructor(sessionId: string, feedbackToken: string) { this.sessionId = sessionId; this.feedbackToken = feedbackToken; }

  public diagnosticSnapshot(): Record<string, number | boolean> {
    return { pending: this.pending.size, queued: this.queued.length,
      waiting_for_key: this.waitingForKey, decode_queue_size: this.decoder?.decodeQueueSize ?? 0 };
  }

  private requestKey(): void {
    const now = performance.now();
    if (this.requestingKey || this.closed || now - this.lastKeyRequest < 250) return;
    this.lastKeyRequest = now;
    this.requestingKey = true;
    void invoke('control_capture_encoder', { sessionId: this.sessionId, feedbackToken: this.feedbackToken, disable: false })
      .catch(() => {}).finally(() => { this.requestingKey = false; });
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    for (const queued of this.queued) queued.reject(error);
    this.queued = [];
  }

  private discardPending(): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.resolve(null); }
    this.pending.clear();
  }

  public async decode(buffer: ArrayBuffer): Promise<VideoFrame | null> {
    if (this.closed) return null;
    const packet = parseNativeEncodedPacket(buffer);
    if (packet.sequence === (this.queued.length ? this.queued[this.queued.length - 1].sequence : this.sequence)) return null;
    // WebView UI stalls deliver intact WS pictures in a burst. Keep at most eight
    // compressed inputs behind the eight submitted pictures instead of destroying
    // valid prediction state. Presentation can discard decoded pictures safely.
    if (this.pending.size >= 8 || this.queued.length) {
      if (this.queued.length >= 8) {
        this.discardPending();
        for (const queued of this.queued) queued.resolve(null);
        this.queued = [];
        this.waitingForKey = true;
        this.requestKey();
        return null;
      }
      return new Promise((resolve, reject) => this.queued.push({ buffer, sequence: packet.sequence, resolve, reject }));
    }
    return this.decodePacket(buffer);
  }

  private drainQueued(): void {
    while (!this.closed && this.pending.size < 8 && this.queued.length) {
      const queued = this.queued.shift()!;
      void this.decodePacket(queued.buffer).then(queued.resolve, queued.reject);
    }
  }

  private async decodePacket(buffer: ArrayBuffer): Promise<VideoFrame | null> {
    if (this.closed) return null;
    const packet = parseNativeEncodedPacket(buffer);
    // A cached JPEG-style refresh is repetition, not another dependent H264 frame.
    if (packet.sequence === this.sequence) return null;
    if (this.sequence !== null && packet.sequence !== ((this.sequence + 1) >>> 0)) this.waitingForKey = true;
    this.sequence = packet.sequence;
    const geometry = `${packet.width}x${packet.height}`;
    if (geometry !== this.geometry) { this.geometry = geometry; this.waitingForKey = true; }
    if (this.waitingForKey && !packet.key) { this.requestKey(); return null; }
    if (this.pending.size >= 8) {
      this.discardPending(); this.waitingForKey = true; this.requestKey(); return null;
    }
    if (!this.decoder || packet.key && this.waitingForKey) {
      if (typeof VideoDecoder === 'undefined') throw new Error('WebCodecs decoder unavailable');
      this.discardPending();
      if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
      this.decoder = new VideoDecoder({
        output: frame => {
          const pending = this.pending.get(frame.timestamp); this.pending.delete(frame.timestamp);
          if (!pending || this.closed) { frame.close(); return; }
          clearTimeout(pending.timer); pending.resolve(frame);
          this.drainQueued();
        },
        error: error => this.rejectPending(error),
      });
      // Hardware decoding produced 83 ms delivery stalls on the measured WebView2 host.
      // Encoding still uses NVENC; prefer low-delay software decoding for this local bridge.
      this.decoder.configure({ codec: 'avc1.420033', optimizeForLatency: true, hardwareAcceleration: 'prefer-software' });
    }
    this.waitingForKey = false;
    return new Promise<VideoFrame | null>((resolve, reject) => {
      const timer = setTimeout(() => this.rejectPending(new Error('Native H264 decoding timed out')), 1500);
      this.pending.set(packet.timestamp, { resolve, reject, timer });
      try {
        this.decoder!.decode(new EncodedVideoChunk({ type: packet.key ? 'key' : 'delta', timestamp: packet.timestamp, data: packet.data }));
      } catch (error) { this.rejectPending(error instanceof Error ? error : new Error(String(error))); }
    });
  }

  public close(): void {
    this.closed = true;
    this.rejectPending(new Error('Native encoded decoder stopped'));
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    this.decoder = null;
  }
}
