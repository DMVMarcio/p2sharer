import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { validStreamDescriptors, type StreamDescriptor } from '../core/media_streams.ts';
import { nativeSenderSource, type NativeSenderSource } from '../video/native_sender_source.ts';
import { MediaCoordinator } from './media_coordinator.ts';
import { logDiagnostic } from '../core/logger.ts';

const SETUP_TIMEOUT_MS = 15_000;
const FIRST_VIDEO_TIMEOUT_MS = 3_500;

type Signal = { id: string; kind: 'offer' | 'answer' | 'ice' | 'reject' | 'stop' | 'ready'; mediaId: string;
  sdp?: string; candidate?: RTCIceCandidateInit; descriptor?: StreamDescriptor; reason?: string };
interface Outgoing { id: string; peer: string; descriptor: StreamDescriptor; source: NativeSenderSource; track: MediaStreamTrack;
  started: number;
  offer?: Signal; retryTimer?: ReturnType<typeof setTimeout>; answering?: boolean; ready?: boolean;
  timer: ReturnType<typeof setTimeout>; offered: boolean; answered: boolean; candidates: RTCIceCandidateInit[]; localCandidates: RTCIceCandidateInit[] }
interface Incoming { id: string; peer: string; descriptor: StreamDescriptor; pc: RTCPeerConnection;
  timer: ReturnType<typeof setInterval>; remoteReady: boolean; candidates: RTCIceCandidateInit[]; started: number; connectedAt?: number;
  verifiedFrames?: boolean;
  stream?: MediaStream; probe?: HTMLVideoElement;
  videoStats?: { bytesReceived: number; framesReceived: number; framesDecoded: number; keyFramesDecoded: number } }
interface TransportConfig {
  rtc: () => RTCConfiguration;
  send: (peer: string, signal: Signal) => void;
  permitted: (peer: string, descriptor?: StreamDescriptor) => boolean;
  receive: (peer: string, stream: MediaStream, descriptor: StreamDescriptor) => void;
  fallback: (peer: string, mediaId: string) => void;
  ready?: (peer: string, mediaId: string) => void;
}
interface NativeSenderStats { frames: number; bytes: number; keyframes: number; gaps: number;
  encoderBitrate: number; budget: number; cap: number; state: string; routeCount: number }

/** Separate standard RTP connection for native encoded video; room signaling and audio remain canonical. */
export class NativeVideoTransport {
  private outgoing = new Map<string, Outgoing>();
  private incoming = new Map<string, Incoming>();
  private blocked = new Set<string>();
  private unlisten: UnlistenFn | undefined;
  private listening: Promise<void> | undefined;
  private closed = false;
  private config: TransportConfig;
  constructor(config: TransportConfig) { this.config = config; }
  private key(peer: string, mediaId: string): string { return `${peer}/${mediaId}`; }
  private ensureListener(): Promise<void> {
    return this.listening ??= listen<{ id: string; kind: string; candidate?: RTCIceCandidateInit; reason?: string }>('native-video-signal', ({ payload }) => {
      const route = [...this.outgoing.values()].find(r => r.id === payload.id);
      if (!route || this.closed) return;
      if (payload.kind === 'failed') { this.fail(route, 'native_sender_failure', payload.reason); return; }
      if (payload.kind === 'ice' && payload.candidate) {
        if (route.localCandidates.length < 64) route.localCandidates.push(payload.candidate);
        if (route.offered) this.send(route.peer, { id: route.id, mediaId: route.descriptor.id, kind: 'ice', candidate: payload.candidate });
      }
    }).then(unlisten => { if (this.closed) unlisten(); else this.unlisten = unlisten; });
  }
  public dispatch(peer: string, stream: MediaStream, descriptor: StreamDescriptor): boolean {
    const track = stream.getVideoTracks()[0]; const source = nativeSenderSource(track);
    const key = this.key(peer, descriptor.id);
    if (this.closed || !source || this.blocked.has(key) || !this.config.permitted(peer)) return false;
    const existing = this.outgoing.get(key);
    if (existing?.track === track) return true;
    if (existing) this.closeOutgoing(existing, true);
    const route: Outgoing = { id: crypto.randomUUID(), peer, descriptor, source, track, offered: false, answered: false, started: performance.now(),
      candidates: [], localCandidates: [], timer: setTimeout(() => this.fail(route, 'setup_timeout'), SETUP_TIMEOUT_MS) };
    this.outgoing.set(key, route);
    void this.open(route).catch(error => {
      if (this.outgoing.get(key) !== route) return;
      this.fail(route, 'create_offer_failed', error);
    });
    return true;
  }
  private async open(route: Outgoing): Promise<void> {
    await this.ensureListener();
    if (!this.current(route)) return;
    const rtc = this.config.rtc();
    const sdp = await invoke<string>('create_native_video_offer', { id: route.id, ...route.source,
      streamId: route.descriptor.id, trackId: route.track.id, bitrate: Math.round(route.descriptor.bitrate * 1000),
      iceServers: (rtc.iceServers ?? []).map(s => ({ urls: Array.isArray(s.urls) ? s.urls : [s.urls],
        username: s.username ?? '', credential: s.credential ?? '' })), relayOnly: rtc.iceTransportPolicy === 'relay' });
    if (!this.current(route)) { await this.closeNative(route); return; }
    route.offer = { id: route.id, mediaId: route.descriptor.id, kind: 'offer', descriptor: route.descriptor, sdp };
    this.sendOffer(route);
  }
  private sendOffer(route: Outgoing): void {
    if (!this.current(route) || route.answered || !route.offer) return;
    this.send(route.peer, route.offer);
    route.offered = true;
    for (const candidate of route.localCandidates) this.send(route.peer, { id: route.id, mediaId: route.descriptor.id, kind: 'ice', candidate });
    // Admission/manifest handlers can still be binding on reentry. Retry the
    // same route and ICE history until acknowledged, within the setup deadline.
    clearTimeout(route.retryTimer);
    route.retryTimer = setTimeout(() => this.sendOffer(route), 1500);
  }
  private current(route: Outgoing): boolean { return !this.closed && this.outgoing.get(this.key(route.peer,route.descriptor.id)) === route; }
  private send(peer: string, signal: Signal): void {
    if (!this.closed && this.config.permitted(peer)) this.config.send(peer,signal);
  }
  public async signal(peer: string, value: unknown): Promise<void> {
    if (this.closed || !this.config.permitted(peer) || !validNativeSignal(value)) return;
    const signal = value; const key = this.key(peer, signal.mediaId);
    const outgoing = this.outgoing.get(key);
    if (outgoing?.id === signal.id) {
      try {
        if (signal.kind === 'ready' && outgoing.answered && !outgoing.ready) {
          outgoing.ready = true;
          clearTimeout(outgoing.timer);
          logDiagnostic('INFO', 'transmission.native', 'Receiver confirmed decoded native video; retiring browser video', {
            routeId: outgoing.id, mediaId: outgoing.descriptor.id, elapsedMs: Math.round(performance.now() - outgoing.started) });
          this.config.ready?.(peer, outgoing.descriptor.id);
          return;
        }
        if (signal.kind === 'reject') { this.fail(outgoing, 'receiver_rejected', signal.reason); return; }
        if (signal.kind === 'answer' && !outgoing.answered && !outgoing.answering) {
          outgoing.answering = true;
          await invoke('answer_native_video', { id: outgoing.id, feedbackToken: outgoing.source.feedbackToken, sdp: signal.sdp });
          if (!this.current(outgoing)) return;
          outgoing.answered = true;
          clearTimeout(outgoing.retryTimer);
          logDiagnostic('INFO', 'transmission.native', 'Native H264 offer answered; awaiting transport frames', {
            routeId: outgoing.id, mediaId: outgoing.descriptor.id, sessionId: outgoing.source.sessionId,
            elapsedMs: Math.round(performance.now() - outgoing.started) });
          for (const candidate of outgoing.candidates.splice(0)) await this.nativeIce(outgoing,candidate);
          // Keep the setup deadline until the receiver proves that video decodes.
        } else if (signal.kind === 'ice' && signal.candidate) {
          if (outgoing.answered) await this.nativeIce(outgoing,signal.candidate);
          else if (outgoing.candidates.length < 64) outgoing.candidates.push(signal.candidate);
        }
      } catch (error) { if (this.current(outgoing)) this.fail(outgoing, 'answer_or_ice_failed', error); }
      return;
    }
    if (signal.kind === 'offer') {
      if (!signal.descriptor || !this.config.permitted(peer, signal.descriptor) || this.incoming.size >= 128) return;
      const old = this.incoming.get(key);
      if (old?.id === signal.id) {
        const answer = old.pc.localDescription;
        if (answer?.type === 'answer') this.send(peer, { id: old.id, mediaId: signal.mediaId, kind: 'answer', sdp: answer.sdp });
        if (old.verifiedFrames) this.send(peer, { id: old.id, mediaId: signal.mediaId, kind: 'ready' });
        return;
      }
      if (old) this.closeIncoming(old);
      const pc = new RTCPeerConnection(this.config.rtc());
      const incoming: Incoming = { id: signal.id, peer, descriptor: signal.descriptor, pc, candidates: [], remoteReady: false,
        started: performance.now(), timer: setInterval(() => { void this.checkReceiver(incoming); }, 500) };
      this.incoming.set(key, incoming);
      pc.onconnectionstatechange = () => {
        logDiagnostic('INFO', 'transmission.native', 'Native receiver connection state changed', {
          routeId: incoming.id, mediaId: incoming.descriptor.id, connectionState: pc.connectionState,
          iceState: pc.iceConnectionState, elapsedMs: Math.round(performance.now() - incoming.started) });
        if (pc.connectionState === 'connected') incoming.connectedAt ??= performance.now();
        if (pc.connectionState === 'failed') this.reject(incoming, 'connection_failed');
      };
      pc.onicecandidate = ({ candidate }) => {
        if (candidate && this.incoming.get(key) === incoming) this.send(peer, { id: signal.id, mediaId: signal.mediaId, kind: 'ice', candidate: candidate.toJSON() });
      };
      pc.ontrack = ({ track }) => {
        if (this.incoming.get(key) !== incoming || !this.config.permitted(peer,incoming.descriptor)) return;
        MediaCoordinator.tuneReceiverJitterBuffer(pc);
        if (track.kind !== 'video') return;
        incoming.stream = new MediaStream([track]);
        // A muted probe consumes native video without replacing the currently
        // playing browser route. Handoff requires real decoded frames.
        const probe = document.createElement('video');
        probe.muted = true; probe.autoplay = true; probe.playsInline = true;
        probe.srcObject = incoming.stream;
        incoming.probe = probe;
        void probe.play().catch(error => {
          if (this.incoming.get(key) === incoming) this.reject(incoming, 'receiver_play_failed', error);
        });
      };
      try {
        await pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
        if (this.incoming.get(key) !== incoming) return;
        incoming.remoteReady = true;
        for (const candidate of incoming.candidates.splice(0)) await pc.addIceCandidate(candidate);
        const answer = await pc.createAnswer(); await pc.setLocalDescription(answer);
        if (this.incoming.get(key) === incoming) this.send(peer,{ id: incoming.id, mediaId: signal.mediaId, kind:'answer',sdp:answer.sdp });
      } catch (error) { this.reject(incoming, 'receiver_setup_failed', error); }
      return;
    }
    const incoming = this.incoming.get(key);
    if (!incoming || incoming.id !== signal.id) return;
    if (signal.kind === 'stop') { this.closeIncoming(incoming); return; }
    if (signal.kind === 'ice' && signal.candidate) {
      try {
        if (incoming.remoteReady) await incoming.pc.addIceCandidate(signal.candidate);
        else if (incoming.candidates.length < 64) incoming.candidates.push(signal.candidate);
      } catch (error) { this.reject(incoming, 'receiver_ice_failed', error); }
    }
  }
  private async checkReceiver(r: Incoming): Promise<void> {
    if (this.incoming.get(this.key(r.peer,r.descriptor.id)) !== r) return;
    if (r.verifiedFrames) return;
    if (!this.config.permitted(r.peer,r.descriptor)) { this.closeIncoming(r); return; }
    if (r.pc.connectionState === 'failed') {
      this.reject(r, 'connection_failed');
      return;
    }
    const elapsed = performance.now() - r.started;
    if (r.pc.connectionState === 'connected') r.connectedAt ??= performance.now();
    const stats = await r.pc.getStats().catch(() => undefined);
    if (this.incoming.get(this.key(r.peer,r.descriptor.id)) !== r || r.verifiedFrames) return;
    const video = stats && [...stats.values()].find(s => s.type === 'inbound-rtp' && s.kind === 'video');
    if (video) r.videoStats = { bytesReceived: video.bytesReceived ?? 0, framesReceived: video.framesReceived ?? 0,
      framesDecoded: video.framesDecoded ?? 0, keyFramesDecoded: video.keyFramesDecoded ?? 0 };
    const received = video?.framesDecoded > 0;
    if (received) {
      r.verifiedFrames = true;
      logDiagnostic('INFO', 'transmission.native', 'Native H264 receiver has video frames', {
        routeId: r.id, mediaId: r.descriptor.id, elapsedMs: Math.round(elapsed) });
      clearInterval(r.timer);
      if (r.stream) this.config.receive(r.peer, r.stream, r.descriptor);
      this.releaseProbe(r);
      this.send(r.peer, { id: r.id, mediaId: r.descriptor.id, kind: 'ready' });
      return;
    }
    if (r.connectedAt !== undefined && performance.now() - r.connectedAt >= FIRST_VIDEO_TIMEOUT_MS) {
      this.reject(r, 'no_video_before_receiver_deadline');
    } else if (r.connectedAt === undefined && elapsed >= SETUP_TIMEOUT_MS) {
      this.reject(r, 'receiver_setup_timeout');
    }
  }
  private reject(r: Incoming, reason = 'receiver_failed', error?: unknown): void {
    if (this.incoming.get(this.key(r.peer,r.descriptor.id)) !== r) return;
    logDiagnostic('WARN', 'transmission.native', 'Rejecting native video; requesting browser WebRTC fallback', {
      routeId: r.id, mediaId: r.descriptor.id, reason, error, connectionState: r.pc.connectionState,
      iceState: r.pc.iceConnectionState, videoStats: r.videoStats, elapsedMs: Math.round(performance.now() - r.started) });
    this.send(r.peer,{id:r.id,mediaId:r.descriptor.id,kind:'reject',reason}); this.closeIncoming(r);
  }
  private nativeIce(r: Outgoing, candidate: RTCIceCandidateInit): Promise<void> {
    return invoke('add_native_video_ice',{id:r.id,feedbackToken:r.source.feedbackToken,candidate});
  }
  private closeNative(r: Outgoing): Promise<void> { return invoke<void>('close_native_video',{id:r.id,feedbackToken:r.source.feedbackToken}).catch(() => {}); }
  private fail(r: Outgoing, reason = 'native_route_failed', error?: unknown): void {
    if (!this.current(r)) return;
    logDiagnostic('WARN', 'transmission.native', 'Native sender failed; fallback=browser WebRTC', {
      routeId: r.id, mediaId: r.descriptor.id, sessionId: r.source.sessionId, reason, error,
      offered: r.offered, answered: r.answered, elapsedMs: Math.round(performance.now() - r.started) });
    this.blocked.add(this.key(r.peer,r.descriptor.id)); this.closeOutgoing(r,true);
    if (this.config.permitted(r.peer)) this.config.fallback(r.peer,r.descriptor.id);
  }
  private closeOutgoing(r: Outgoing, notify: boolean): void {
    this.outgoing.delete(this.key(r.peer,r.descriptor.id)); clearTimeout(r.timer); clearTimeout(r.retryTimer);
    if (notify && r.offered) this.send(r.peer,{id:r.id,mediaId:r.descriptor.id,kind:'stop'});
    void this.closeNative(r);
  }
  private closeIncoming(r: Incoming): void {
    this.incoming.delete(this.key(r.peer,r.descriptor.id)); clearInterval(r.timer); this.releaseProbe(r); r.pc.close();
  }
  private releaseProbe(r: Incoming): void {
    if (!r.probe) return;
    r.probe.pause(); r.probe.srcObject = null; r.probe = undefined;
  }
  public sending(peer: string, mediaId: string): boolean { return this.outgoing.get(this.key(peer, mediaId))?.ready === true; }
  public receiving(peer: string, mediaId: string): boolean { return this.incoming.get(this.key(peer, mediaId))?.verifiedFrames === true; }
  public update(mediaId: string, bitrate: number): void {
    for (const r of this.outgoing.values()) if (r.descriptor.id === mediaId) {
      r.descriptor = {...r.descriptor, bitrate};
      void invoke('set_native_video_bitrate',{id:r.id,feedbackToken:r.source.feedbackToken,bitrate:Math.round(bitrate*1000)}).catch(() => this.fail(r));
    }
  }
  public stop(mediaId?: string, peer?: string): void {
    for (const r of this.outgoing.values()) if (!(mediaId && peer) && (!mediaId || r.descriptor.id===mediaId) && (!peer || r.peer===peer)) this.closeOutgoing(r,true);
    for (const r of this.incoming.values()) if (!(mediaId && !peer) && (!mediaId || r.descriptor.id===mediaId) && (!peer || r.peer===peer)) this.closeIncoming(r);
    for (const key of this.blocked) if (!(mediaId && peer) && (!peer || key.startsWith(`${peer}/`)) && (!mediaId || key.endsWith(`/${mediaId}`))) this.blocked.delete(key);
  }
  public close(): void { this.stop(); this.closed=true; this.unlisten?.(); }
  public receiver(peer: string, mediaId: string): RTCPeerConnection | undefined {
    const route = this.incoming.get(this.key(peer, mediaId));
    return route?.verifiedFrames ? route.pc : undefined;
  }
  public async senderStats(mediaId: string): Promise<NativeSenderStats[]> {
    // Pending native routes must not hide active browser statistics. Teardown
    // can also finish while an IPC sample is in flight.
    const samples = await Promise.all([...this.outgoing.values()].filter(r => r.descriptor.id === mediaId && r.ready).map(async r => {
      try {
        const stats = await invoke<NativeSenderStats>('get_native_video_stats',{id:r.id,feedbackToken:r.source.feedbackToken});
        return this.current(r) ? stats : undefined;
      } catch (error) {
        if (this.current(r)) throw error;
        return undefined;
      }
    }));
    return samples.filter((stats): stats is NativeSenderStats => stats !== undefined);
  }
}

export function validNativeSignal(value: unknown): value is Signal {
  const s = value as Signal;
  if (!s || typeof s !== 'object' || typeof s.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(s.id) ||
      typeof s.mediaId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(s.mediaId)) return false;
  if (s.kind==='offer') return typeof s.sdp==='string' && s.sdp.length<=128*1024 && validStreamDescriptors([s.descriptor]) && s.descriptor?.id===s.mediaId;
  if (s.kind==='answer') return typeof s.sdp==='string' && s.sdp.length<=128*1024;
  if (s.kind==='ice') return !!s.candidate && typeof s.candidate.candidate==='string' && s.candidate.candidate.length<=4096;
  return s.kind==='stop' || s.kind==='ready' || (s.kind==='reject' && (s.reason === undefined ||
    (typeof s.reason === 'string' && /^[a-z_]{1,100}$/.test(s.reason))));
}
