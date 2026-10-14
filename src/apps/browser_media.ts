import { invoke } from '@tauri-apps/api/core';
import { AudioBridge } from '../audio/audio_bridge.ts';
import { buildRtcConfiguration } from '../p2p/ice_config.ts';
import { stateStore } from '../core/state_store.ts';
import { MediaCoordinator } from '../p2p/media_coordinator.ts';
import { BROWSER_HEIGHT, BROWSER_WIDTH, type BrowserState } from './browser_protocol.ts';

/** Media stays outside snapshots; bounded capture never queues stale frames. */
export class BrowserMedia {
  stream: MediaStream | null = null;
  private audio?: AudioBridge;
  private canvas?: HTMLCanvasElement;
  private stopped = true;
  private generation = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private peers = new Map<string, { pc: RTCPeerConnection; token: string; pending: RTCIceCandidateInit[];
    local: RTCIceCandidateInit[]; announced: boolean }>();
  private retries = new Map<string, ReturnType<typeof setTimeout>>();
  private lastOffers = new Map<string, number>();
  private scope: string;
  private host: boolean;
  private send: (payload: unknown, target: string) => Promise<void>;
  private changed: () => void;
  private metadata: (state: BrowserState) => void;
  private failed: (error: unknown) => void;
  private rtcConfiguration: () => RTCConfiguration;
  constructor(scope: string, host: boolean,
    send: (payload: unknown, target: string) => Promise<void>,
    changed: () => void, metadata: (state: BrowserState) => void,
    failed: (error: unknown) => void, rtcConfiguration = () => buildRtcConfiguration(stateStore.getTurnConfig())) {
    this.scope = scope; this.host = host; this.send = send;
    this.changed = changed; this.metadata = metadata; this.failed = failed;
    this.rtcConfiguration = rtcConfiguration;
  }
  async start(): Promise<void> {
    this.stop(); this.stopped = false; const generation = ++this.generation;
    if (!this.host) return;
    this.canvas = document.createElement('canvas'); this.canvas.width = BROWSER_WIDTH; this.canvas.height = BROWSER_HEIGHT;
    this.stream = this.canvas.captureStream(15);
    for (const track of this.stream.getVideoTracks()) track.contentHint = 'detail';
    this.audio = new AudioBridge(); const track = this.audio.init();
    if (track) this.stream.addTrack(track);
    await this.audio.startListening(`shared-browser-audio-${this.scope}`);
    if (this.stopped || generation !== this.generation) return;
    this.changed(); let count = 0;
    const capture = async () => {
      try {
        const frame = await invoke<{ image: string; state: BrowserState | null }>('capture_shared_browser', { scope: this.scope, metadata: count++ % 15 === 0 });
        if (this.stopped || generation !== this.generation) return;
        const bytes = Uint8Array.from(atob(frame.image), c => c.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
        if (!this.stopped && generation === this.generation) {
          this.canvas?.getContext('2d')?.drawImage(bitmap, 0, 0, BROWSER_WIDTH, BROWSER_HEIGHT);
          if (frame.state) this.metadata(frame.state);
        }
        bitmap.close();
      } catch (error) { if (!this.stopped && generation === this.generation) this.failed(error); }
      if (!this.stopped && generation === this.generation) this.timer = setTimeout(() => void capture(), 67);
    };
    void capture();
  }
  private connection(peer: string, token: string): RTCPeerConnection {
    this.remove(peer);
    const pc = new RTCPeerConnection(this.rtcConfiguration());
    const entry = { pc, token, pending: [] as RTCIceCandidateInit[], local: [] as RTCIceCandidateInit[], announced: false }; this.peers.set(peer, entry);
    pc.onicecandidate = e => { if (e.candidate && this.peers.get(peer) === entry) {
      if (entry.announced) void this.send({ type: 'media', token, candidate: e.candidate.toJSON() }, peer).catch(this.failed);
      else if (entry.local.length < 64) entry.local.push(e.candidate.toJSON());
    } };
    pc.ontrack = e => {
      if (this.host || this.peers.get(peer) !== entry) return;
      const stream = this.stream ?? new MediaStream(); stream.addTrack(e.track); this.stream = stream; this.changed();
    };
    pc.onconnectionstatechange = () => {
      if (this.peers.get(peer) !== entry || this.stopped) return;
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        if (!this.retries.has(peer)) this.retries.set(peer, setTimeout(() => {
          this.retries.delete(peer); if (this.stopped || this.peers.get(peer) !== entry) return;
          if (this.host) void this.offer(peer).catch(this.failed);
          else { this.remove(peer); void this.send({ type: 'media-request' }, peer).catch(this.failed); }
        }, 3000));
      } else if (pc.connectionState === 'connected') { clearTimeout(this.retries.get(peer)); this.retries.delete(peer); }
    };
    return pc;
  }
  async offer(peer: string): Promise<void> {
    if (!this.host || !this.stream || this.stopped) return;
    if (this.peers.has(peer) && performance.now() - (this.lastOffers.get(peer) ?? -Infinity) < 1000) return;
    this.lastOffers.set(peer, performance.now());
    const token = crypto.randomUUID(); const pc = this.connection(peer, token);
    for (const track of this.stream.getTracks()) pc.addTrack(track, this.stream);
    MediaCoordinator.configureCodecPreferences(pc);
    await pc.setLocalDescription(await pc.createOffer());
    if (this.peers.get(peer)?.pc !== pc) return;
    await this.send({ type: 'media', token, description: pc.localDescription?.toJSON() }, peer);
    const entry = this.peers.get(peer);
    if (entry?.pc === pc) { entry.announced = true;
      for (const candidate of entry.local.splice(0)) await this.send({ type: 'media', token, candidate }, peer);
    }
  }
  async receive(peer: string, value: Record<string, unknown>): Promise<void> {
    if (this.stopped || typeof value.token !== 'string' || value.token.length !== 36) return;
    const description = value.description as RTCSessionDescriptionInit | undefined;
    let entry = this.peers.get(peer);
    if (description) {
      if (typeof description.sdp !== 'string' || description.sdp.length > 100_000) return;
      if (description.type === 'offer' && !this.host) {
        const pc = this.connection(peer, value.token); entry = this.peers.get(peer)!;
        await pc.setRemoteDescription(description);
        await pc.setLocalDescription(await pc.createAnswer());
        if (this.peers.get(peer) !== entry) return;
        await this.send({ type: 'media', token: value.token, description: pc.localDescription?.toJSON() }, peer);
        entry.announced = true;
        for (const candidate of entry.local.splice(0)) await this.send({ type: 'media', token: value.token, candidate }, peer);
      } else if (description.type === 'answer' && this.host && entry?.token === value.token && entry.pc.signalingState === 'have-local-offer') {
        await entry.pc.setRemoteDescription(description);
      } else return;
      for (const candidate of entry.pending.splice(0)) await entry.pc.addIceCandidate(candidate);
    } else if (value.candidate && entry?.token === value.token) {
      const candidate = value.candidate as RTCIceCandidateInit;
      if (typeof candidate.candidate !== 'string' || candidate.candidate.length > 4096) return;
      if (entry.pc.remoteDescription) await entry.pc.addIceCandidate(candidate);
      else if (entry.pending.length < 64) entry.pending.push(candidate);
    }
  }
  remove(peer: string): void {
    clearTimeout(this.retries.get(peer)); this.retries.delete(peer);
    const entry = this.peers.get(peer); if (entry) { entry.pc.ontrack = null; entry.pc.onicecandidate = null; entry.pc.onconnectionstatechange = null; entry.pc.close(); }
    this.peers.delete(peer);
    if (!this.host && entry) { this.stream?.getTracks().forEach(t => t.stop()); this.stream = null; this.changed(); }
  }
  stop(): void {
    this.stopped = true; this.generation++; clearTimeout(this.timer);
    for (const peer of this.peers.keys()) this.remove(peer);
    this.stream?.getTracks().forEach(t => t.stop()); this.stream = null;
    this.audio?.stop(); this.audio = undefined; this.canvas = undefined;
  }
}
