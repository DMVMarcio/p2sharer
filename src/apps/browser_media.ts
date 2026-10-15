import { AudioBridge } from '../audio/audio_bridge.ts';
import { buildRtcConfiguration } from '../p2p/ice_config.ts';
import { stateStore } from '../core/state_store.ts';
import { MediaCoordinator } from '../p2p/media_coordinator.ts';
import type { BrowserState } from './browser_protocol.ts';
import { BrowserQualityController, loadBrowserQuality, type BrowserQualitySettings } from './browser_quality.ts';
import { BrowserCapture } from './browser_capture.ts';

/** Media stays outside snapshots; bounded capture never queues stale frames. */
export class BrowserMedia {
  readonly quality = new BrowserQualityController(loadBrowserQuality());
  stream: MediaStream | null = null;
  videoTab = 0;
  private audio?: AudioBridge;
  private capture?: BrowserCapture;
  private stopped = true;
  private borrowed = false;
  private relayTracks: MediaStreamTrack[] = [];
  private generation = 0;
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
    this.quality.reset();
    this.stream = new MediaStream();
    this.audio = new AudioBridge(); const track = this.audio.init();
    if (track) this.stream.addTrack(track);
    await this.audio.startListening(`shared-browser-audio-${this.scope}`);
    if (this.stopped || generation !== this.generation) return;
    this.capture = new BrowserCapture(this.scope, this.quality, (stream, tab) => { this.videoTab = tab; this.installVideo(stream); }, this.metadata,
      () => { this.changed(); for (const { pc } of this.peers.values()) this.configureEncoding(pc); },
      error => { if (!this.stopped && generation === this.generation) this.failed(error); });
    await this.capture.start();
    if (!this.stopped && generation === this.generation) this.changed();
  }
  refreshCapture(): void { this.capture?.requestRefresh(); }
  /** A device-local view borrows the live tracks without owning capture or room peers. */
  relay(stream: MediaStream | null): void {
    this.borrowed = true; this.stopped = false;
    const tracks = stream?.getTracks() ?? [];
    if (this.stream === stream && tracks.length === this.relayTracks.length && tracks.every((track, index) => track === this.relayTracks[index])) return;
    this.relayTracks = tracks;
    this.stream = stream;
    for (const [peer, { pc }] of this.peers) {
      for (const sender of pc.getSenders()) {
        const kind = sender.track?.kind;
        if (kind) void sender.replaceTrack(stream?.getTracks().find(track => track.kind === kind) ?? null).catch(this.failed);
      }
      if (stream && stream.getTracks().some(track => !pc.getSenders().some(sender => sender.track?.kind === track.kind))) {
        this.lastOffers.delete(peer); void this.offer(peer).catch(this.failed);
      }
    }
  }
  private installVideo(stream: MediaStream): void {
    const track = stream.getVideoTracks()[0]; if (!track || !this.stream || this.stopped) return;
    // Rebind the host video element even if its previous source ended between tabs.
    this.stream = new MediaStream([track, ...this.stream.getAudioTracks()]);
    track.contentHint = this.quality.quality.video ? 'motion' : 'detail';
    for (const [peer, { pc }] of this.peers) {
      const sender = pc.getSenders().find(sender => sender.track?.kind === 'video');
      if (sender) void sender.replaceTrack(track).catch(() => {
        this.lastOffers.delete(peer); return this.offer(peer);
      }).catch(this.failed);
      else { this.lastOffers.delete(peer); void this.offer(peer).catch(this.failed); }
    }
    this.changed();
  }
  configure(settings: BrowserQualitySettings): void {
    this.quality.configure(settings);
    this.capture?.requestRefresh();
    try { localStorage.setItem('browser-quality-v1', JSON.stringify(settings)); } catch {}
    this.changed();
  }
  private configureEncoding(pc: RTCPeerConnection): void {
    // The local relay must preserve the borrowed track's hints and source frame rate.
    if (this.borrowed) return;
    const quality = this.quality.quality;
    for (const track of this.stream?.getVideoTracks() ?? []) track.contentHint = quality.video ? 'motion' : 'detail';
    for (const sender of pc.getSenders()) if (sender.track?.kind === 'video') {
      const parameters = sender.getParameters();
      if (!parameters.encodings?.length) continue;
      parameters.degradationPreference = quality.video ? 'balanced' : 'maintain-resolution';
      for (const encoding of parameters.encodings) {
        encoding.maxFramerate = quality.fps;
        encoding.maxBitrate = quality.width === 1920 ? (quality.fps === 60 ? 9_000_000 : 6_000_000) : (quality.video ? 4_000_000 : 3_000_000);
      }
      // Some runtimes reject parameters during negotiation; retry on the next quality change.
      void sender.setParameters(parameters).catch(() => {});
    }
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
      MediaCoordinator.tuneReceiverJitterBuffer(pc);
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
    this.configureEncoding(pc);
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
        MediaCoordinator.tuneReceiverJitterBuffer(pc);
        await pc.setLocalDescription(await pc.createAnswer());
        if (this.peers.get(peer) !== entry) return;
        await this.send({ type: 'media', token: value.token, description: pc.localDescription?.toJSON() }, peer);
        entry.announced = true;
        for (const candidate of entry.local.splice(0)) await this.send({ type: 'media', token: value.token, candidate }, peer);
      } else if (description.type === 'answer' && this.host && entry?.token === value.token && entry.pc.signalingState === 'have-local-offer') {
        await entry.pc.setRemoteDescription(description);
        this.configureEncoding(entry.pc);
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
    this.stopped = true; this.generation++; this.capture?.stop(); this.capture = undefined;
    for (const peer of this.peers.keys()) this.remove(peer);
    if (!this.borrowed) this.stream?.getTracks().forEach(t => t.stop()); this.stream = null;
    this.relayTracks = [];
    this.audio?.stop(); this.audio = undefined;
  }
}
