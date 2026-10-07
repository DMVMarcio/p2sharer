import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { validStreamDescriptors, type StreamDescriptor } from '../core/media_streams.ts';
import { nativeSenderSource, type NativeSenderSource } from '../video/native_sender_source.ts';
import { MediaCoordinator } from './media_coordinator.ts';
import { logDiagnostic } from '../core/logger.ts';

type Signal = { id: string; kind: 'offer' | 'answer' | 'ice' | 'reject' | 'stop'; mediaId: string;
  sdp?: string; candidate?: RTCIceCandidateInit; descriptor?: StreamDescriptor };
interface Outgoing { id: string; peer: string; descriptor: StreamDescriptor; source: NativeSenderSource; track: MediaStreamTrack;
  started: number;
  timer: ReturnType<typeof setTimeout>; offered: boolean; answered: boolean; candidates: RTCIceCandidateInit[]; localCandidates: RTCIceCandidateInit[] }
interface Incoming { id: string; peer: string; descriptor: StreamDescriptor; pc: RTCPeerConnection;
  timer: ReturnType<typeof setInterval>; remoteReady: boolean; candidates: RTCIceCandidateInit[]; started: number }
interface TransportConfig {
  rtc: () => RTCConfiguration;
  send: (peer: string, signal: Signal) => void;
  permitted: (peer: string, descriptor?: StreamDescriptor) => boolean;
  receive: (peer: string, stream: MediaStream, descriptor: StreamDescriptor) => void;
  fallback: (peer: string, mediaId: string) => void;
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
    return this.listening ??= listen<{ id: string; kind: string; candidate?: RTCIceCandidateInit }>('native-video-signal', ({ payload }) => {
      const route = [...this.outgoing.values()].find(r => r.id === payload.id);
      if (!route || this.closed) return;
      if (payload.kind === 'failed') { this.fail(route, 'native_sender_failure'); return; }
      if (payload.kind === 'ice' && payload.candidate) {
        if (!route.offered) route.localCandidates.push(payload.candidate);
        else this.send(route.peer, { id: route.id, mediaId: route.descriptor.id, kind: 'ice', candidate: payload.candidate });
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
      candidates: [], localCandidates: [], timer: setTimeout(() => this.fail(route, 'setup_timeout'), 15_000) };
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
    this.send(route.peer, { id: route.id, mediaId: route.descriptor.id, kind: 'offer', descriptor: route.descriptor, sdp });
    route.offered = true;
    for (const candidate of route.localCandidates.splice(0)) this.send(route.peer, { id: route.id, mediaId: route.descriptor.id, kind: 'ice', candidate });
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
        if (signal.kind === 'reject') { this.fail(outgoing, 'receiver_rejected'); return; }
        if (signal.kind === 'answer' && !outgoing.answered) {
          await invoke('answer_native_video', { id: outgoing.id, feedbackToken: outgoing.source.feedbackToken, sdp: signal.sdp });
          if (!this.current(outgoing)) return;
          outgoing.answered = true;
          logDiagnostic('INFO', 'transmission.native', 'Native H264 offer answered; awaiting transport frames', {
            routeId: outgoing.id, mediaId: outgoing.descriptor.id, sessionId: outgoing.source.sessionId,
            elapsedMs: Math.round(performance.now() - outgoing.started) });
          for (const candidate of outgoing.candidates.splice(0)) await this.nativeIce(outgoing,candidate);
          // The receiver sends reject if the connected RTP route does not decode frames.
          clearTimeout(outgoing.timer);
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
      if (old?.id === signal.id) return;
      if (old) this.closeIncoming(old);
      const pc = new RTCPeerConnection(this.config.rtc());
      const incoming: Incoming = { id: signal.id, peer, descriptor: signal.descriptor, pc, candidates: [], remoteReady: false,
        started: performance.now(), timer: setInterval(() => { void this.checkReceiver(incoming); }, 1000) };
      this.incoming.set(key, incoming);
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed') this.reject(incoming, 'connection_failed');
      };
      pc.onicecandidate = ({ candidate }) => {
        if (candidate && this.incoming.get(key) === incoming) this.send(peer, { id: signal.id, mediaId: signal.mediaId, kind: 'ice', candidate: candidate.toJSON() });
      };
      pc.ontrack = ({ track }) => {
        if (this.incoming.get(key) !== incoming || !this.config.permitted(peer,incoming.descriptor)) return;
        MediaCoordinator.tuneReceiverJitterBuffer(pc);
        this.config.receive(peer,new MediaStream([track]),incoming.descriptor);
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
    if (!this.config.permitted(r.peer,r.descriptor)) { this.closeIncoming(r); return; }
    if (r.pc.connectionState === 'failed' || performance.now()-r.started > 12_000) {
      const stats = await r.pc.getStats().catch(() => undefined);
      const received = stats && [...stats.values()].some(s => s.type === 'inbound-rtp' && s.kind === 'video' &&
        (s.framesDecoded > 0 || s.framesReceived > 0));
      if (!received || r.pc.connectionState === 'failed') this.reject(r, r.pc.connectionState === 'failed' ? 'connection_failed' : 'no_video_before_receiver_deadline');
      else {
        logDiagnostic('INFO', 'transmission.native', 'Native H264 receiver has video frames', {
          routeId: r.id, mediaId: r.descriptor.id, elapsedMs: Math.round(performance.now() - r.started) });
        clearInterval(r.timer); // Idle/unsubscribed viewers need not poll stable transports forever.
      }
    }
  }
  private reject(r: Incoming, reason = 'receiver_failed', error?: unknown): void {
    if (this.incoming.get(this.key(r.peer,r.descriptor.id)) !== r) return;
    logDiagnostic('WARN', 'transmission.native', 'Rejecting native video; requesting browser WebRTC fallback', {
      routeId: r.id, mediaId: r.descriptor.id, reason, error, connectionState: r.pc.connectionState,
      iceState: r.pc.iceConnectionState, elapsedMs: Math.round(performance.now() - r.started) });
    this.send(r.peer,{id:r.id,mediaId:r.descriptor.id,kind:'reject'}); this.closeIncoming(r);
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
    this.outgoing.delete(this.key(r.peer,r.descriptor.id)); clearTimeout(r.timer);
    if (notify && r.offered) this.send(r.peer,{id:r.id,mediaId:r.descriptor.id,kind:'stop'});
    void this.closeNative(r);
  }
  private closeIncoming(r: Incoming): void {
    this.incoming.delete(this.key(r.peer,r.descriptor.id)); clearInterval(r.timer); r.pc.close();
  }
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
  public receiver(peer: string, mediaId: string): RTCPeerConnection | undefined { return this.incoming.get(this.key(peer,mediaId))?.pc; }
  public async senderStats(mediaId: string): Promise<NativeSenderStats[]> {
    return Promise.all([...this.outgoing.values()].filter(r => r.descriptor.id === mediaId).map(r =>
      invoke<NativeSenderStats>('get_native_video_stats',{id:r.id,feedbackToken:r.source.feedbackToken})));
  }
}

export function validNativeSignal(value: unknown): value is Signal {
  const s = value as Signal;
  if (!s || typeof s !== 'object' || typeof s.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(s.id) ||
      typeof s.mediaId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(s.mediaId)) return false;
  if (s.kind==='offer') return typeof s.sdp==='string' && s.sdp.length<=128*1024 && validStreamDescriptors([s.descriptor]) && s.descriptor?.id===s.mediaId;
  if (s.kind==='answer') return typeof s.sdp==='string' && s.sdp.length<=128*1024;
  if (s.kind==='ice') return !!s.candidate && typeof s.candidate.candidate==='string' && s.candidate.candidate.length<=4096;
  return s.kind==='stop' || s.kind==='reject';
}
