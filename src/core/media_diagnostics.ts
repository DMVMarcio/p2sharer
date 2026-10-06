import { invoke, isTauri } from '@tauri-apps/api/core';

const measurements = (`timestamp ssrc bytesSent bytesReceived packetsSent packetsReceived packetsLost
  framesEncoded framesDecoded framesReceived framesSent framesDropped framesPerSecond frameWidth frameHeight
  keyFramesEncoded keyFramesDecoded totalEncodeTime totalDecodeTime totalPacketSendDelay jitter jitterBufferDelay
  jitterBufferEmittedCount jitterBufferTargetDelay freezeCount totalFreezesDuration pauseCount totalPausesDuration
  pliCount firCount nackCount retransmittedPacketsSent retransmittedBytesSent roundTripTime totalRoundTripTime
  roundTripTimeMeasurements fractionLost currentRoundTripTime availableOutgoingBitrate availableIncomingBitrate
  concealedSamples silentConcealedSamples totalSamplesReceived totalSamplesDuration concealmentEvents audioLevel
  totalAudioEnergy qualityLimitationResolutionChanges`).split(/\s+/).filter(Boolean);
const types = ['inbound-rtp', 'outbound-rtp', 'remote-inbound-rtp', 'remote-outbound-rtp', 'candidate-pair'];
const states = ['new', 'connecting', 'connected', 'disconnected', 'failed', 'closed'];
const peers = new Map<RTCPeerConnection, number>();
const pending = new WeakSet<RTCPeerConnection>();
const bridges = new Set<() => Record<string, unknown>>();
const videoIds = new WeakMap<HTMLVideoElement, number>();
let nextId = 1;
let bootstrap: Promise<boolean> | undefined;
let enabledDiagnostics = false;
let renderer = 0;

export function isMediaDiagnosticsActive(): boolean { return enabledDiagnostics; }

/** Matches native opaque IDs; never stores raw track, stream or peer identifiers. */
export function diagnosticOpaqueId(value: string): number {
  let hash = 2166136261;
  for (const byte of new TextEncoder().encode(value)) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
  return hash;
}

export function startMediaDiagnostics(): Promise<boolean> {
  if (bootstrap) return bootstrap;
  if (typeof window === 'undefined' || !isTauri() || new URLSearchParams(location.search).has('pointerOverlay')) {
    return Promise.resolve(false);
  }
  bootstrap = invoke<boolean>('media_diagnostics_enabled').then(enabled => {
    if (enabled) {
      enabledDiagnostics = true;
      renderer = crypto.getRandomValues(new Uint32Array(1))[0];
      let previous = performance.now();
      let running = false;
      const surface = new URLSearchParams(location.search).has('pip') ? 1 : 0;
      window.setInterval(() => {
        if (running) return;
        running = true;
        const now = performance.now();
        const interval = now - previous;
        previous = now;
        void sample(surface, interval).catch(() => {}).finally(() => { running = false; });
      }, 2000);
    }
    return enabled;
  }).catch(() => false);
  return bootstrap;
}

export function observeDiagnosticPeerConnection(pc: RTCPeerConnection): void {
  if (pending.has(pc)) return;
  pending.add(pc);
  void startMediaDiagnostics().then(enabled => {
    if (!enabled || pc.connectionState === 'closed' || peers.size >= 32) return;
    peers.set(pc, nextId++);
    pc.addEventListener('connectionstatechange', () => {
      void invoke('write_media_diagnostics', { record: { renderer, surface: new URLSearchParams(location.search).has('pip') ? 1 : 0,
        peers: [{ id: peers.get(pc), state: states.indexOf(pc.connectionState) }] } }).catch(() => {});
      if (pc.connectionState === 'closed') peers.delete(pc);
    });
  });
}

export function registerDiagnosticBridge(snapshot: () => Record<string, unknown>): () => void {
  let disposed = false;
  void startMediaDiagnostics().then(enabled => {
    if (enabled && !disposed && bridges.size < 32) bridges.add(snapshot);
  });
  return () => { disposed = true; bridges.delete(snapshot); };
}

export async function diagnosticPeerSnapshot(pc: RTCPeerConnection, id: number): Promise<Record<string, unknown>> {
  const base = { id, state: states.indexOf(pc.connectionState),
    ice: ['new', 'checking', 'connected', 'completed', 'disconnected', 'failed', 'closed'].indexOf(pc.iceConnectionState),
    signaling: ['stable', 'have-local-offer', 'have-remote-offer', 'have-local-pranswer', 'have-remote-pranswer', 'closed'].indexOf(pc.signalingState) };
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const report = await Promise.race([pc.getStats(), new Promise<null>(resolve => {
      timeout = setTimeout(() => resolve(null), 1000);
    })]);
    if (!report) return { ...base, timed_out: true };
    const values: Record<string, unknown>[] = [];
    report.forEach(stat => {
      const type = types.indexOf(stat.type);
      if (type < 0 || values.length >= 96 || (stat.type === 'candidate-pair' && !stat.nominated)) return;
      const value: Record<string, unknown> = { id: diagnosticOpaqueId(stat.id), type, kind: stat.kind === 'audio' ? 1 : 0 };
      for (const key of measurements) {
        if (typeof stat[key] === 'number' && Number.isFinite(stat[key])) value[key] = stat[key];
      }
      for (const key of ['powerEfficientEncoder', 'powerEfficientDecoder']) {
        if (typeof stat[key] === 'boolean') value[key] = stat[key];
      }
      if (typeof stat.trackIdentifier === 'string') value.track = diagnosticOpaqueId(stat.trackIdentifier);
      if (typeof stat.qualityLimitationReason === 'string') {
        value.qualityLimitationReason = ['none', 'cpu', 'bandwidth', 'other'].indexOf(stat.qualityLimitationReason);
      }
      values.push(value);
    });
    return { ...base, peers: values };
  } catch { return { ...base, failed: true }; }
  finally { clearTimeout(timeout); }
}

async function sample(surface: number, interval_ms: number): Promise<void> {
  const reports = await Promise.all(Array.from(peers, ([pc, id]) => diagnosticPeerSnapshot(pc, id)));
  const videos = Array.from(document.querySelectorAll('video')).slice(0, 32).map(video => {
    let id = videoIds.get(video);
    if (!id) { id = nextId++; videoIds.set(video, id); }
    const quality = video.getVideoPlaybackQuality();
    const stream = video.srcObject instanceof MediaStream ? video.srcObject : null;
    const track = stream?.getVideoTracks()[0];
    return { id, track: track ? diagnosticOpaqueId(track.id) : 0, readyState: video.readyState,
      paused: video.paused, muted: video.muted, width: video.videoWidth, height: video.videoHeight,
      currentTime: video.currentTime, totalVideoFrames: quality.totalVideoFrames,
      droppedVideoFrames: quality.droppedVideoFrames, ended: track?.readyState === 'ended', enabled: track?.enabled ?? false };
  });
  const record = { renderer, surface, visibility: document.visibilityState === 'visible', interval_ms,
    peers: reports, videos, bridges: Array.from(bridges, snapshot => snapshot()), failed: false };
  while (JSON.stringify(record).length > 60_000 && record.peers.length) {
    record.peers.pop(); record.failed = true;
  }
  await invoke('write_media_diagnostics', { record });
}
