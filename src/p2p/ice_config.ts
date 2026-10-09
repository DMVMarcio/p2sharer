import type { TurnConfig } from '../core/types.ts';
import { t } from '../i18n/index.ts';
import { selectedIcePair } from '../core/ice_route.ts';
import { diagnosticOpaqueId } from '../core/diagnostic_id.ts';

export const DEFAULT_STUN_SERVERS = [
  'stun:stun.cloudflare.com:3478',
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
  'stun:stun2.l.google.com:19302',
  'stun:stun3.l.google.com:19302',
  'stun:stun4.l.google.com:19302',
];

const reportedIceServerErrors = new Map<string, number>();
let reportedRelayCandidate = false;
let diagnosticConnectionId = 0;
export type IceConnectionMode = 'internet' | 'lan';

/** Describe negotiation structure without retaining addresses, credentials or SDP. */
export function summarizeIceDescription(description: RTCSessionDescription | null) {
  if (!description) return null;
  const lines = description.sdp.split(/\r?\n/);
  const media: Array<{ kind: string; zeroPort: boolean; bundleOnly: boolean }> = [];
  for (const line of lines) {
    if (line.startsWith('m=')) {
      const [kind, port] = line.slice(2).split(/\s+/);
      media.push({ kind: ['audio', 'video', 'application'].includes(kind) ? kind : 'other',
        zeroPort: port === '0', bundleOnly: false });
    } else if (line === 'a=bundle-only' && media.length) media[media.length - 1].bundleOnly = true;
  }
  return { type: description.type, media,
    candidateLines: lines.filter((line) => line.startsWith('a=candidate:')).length,
    mdnsCandidateLines: lines.filter((line) => line.startsWith('a=candidate:') && /\s\S+\.local\s/.test(line)).length,
    hasIceUfrag: lines.some((line) => line.startsWith('a=ice-ufrag:')),
    hasIcePwd: lines.some((line) => line.startsWith('a=ice-pwd:')),
    hasFingerprint: lines.some((line) => line.startsWith('a=fingerprint:')) };
}

/** Allowlist route metadata and counters; never copy raw candidate reports. */
export function summarizeIceStats(stats: RTCStatsReport) {
  const reports = Array.from(stats.values());
  const byId = new Map(reports.map(report => [report.id, report]));
  const candidates = { local: { host: 0, srflx: 0, prflx: 0, relay: 0 }, remote: { host: 0, srflx: 0, prflx: 0, relay: 0 } };
  reports.forEach((report) => {
    if (report.type !== 'local-candidate' && report.type !== 'remote-candidate') return;
    const side = report.type === 'local-candidate' ? candidates.local : candidates.remote;
    const type = report.candidateType as keyof typeof side;
    if (Object.prototype.hasOwnProperty.call(side, type)) side[type]++;
  });
  const selected = selectedIcePair(reports)?.pair;
  const allowed = (value: unknown, values: string[]) => typeof value === 'string' && values.includes(value) ? value : null;
  const candidate = (id: string) => {
    const report = byId.get(id);
    return report ? { id: diagnosticOpaqueId(id),
      type: allowed(report.candidateType, ['host', 'srflx', 'prflx', 'relay']),
      protocol: allowed(report.protocol, ['udp', 'tcp']),
      family: typeof report.address === 'string' ? (report.address.includes(':') ? 'ipv6' :
        /^\d{1,3}(?:\.\d{1,3}){3}$/.test(report.address) ? 'ipv4' : 'unknown') : null,
      tcpType: allowed(report.tcpType, ['active', 'passive', 'so']) } : null;
  };
  const counters = ['requestsSent', 'requestsReceived', 'responsesSent', 'responsesReceived',
    'consentRequestsSent', 'bytesSent', 'bytesReceived', 'currentRoundTripTime'];
  const pairs = reports.filter(report => report.type === 'candidate-pair');
  // Preserve the selected route even if a large checklist exceeds the log limit.
  pairs.sort((a, b) => Number(b.id === selected?.id) - Number(a.id === selected?.id) ||
    (b.responsesReceived || 0) - (a.responsesReceived || 0) || (b.requestsSent || 0) - (a.requestsSent || 0));
  const totals = Object.fromEntries(counters.filter(key => key !== 'currentRoundTripTime').flatMap(key => {
    const values = pairs.map(pair => pair[key]).filter(value => typeof value === 'number' && Number.isFinite(value) && value >= 0);
    return values.length ? [[key, values.reduce((total, value) => total + value, 0)]] : [];
  }));
  return { candidates, pairCount: pairs.length, omittedPairs: Math.max(0, pairs.length - 24),
    totals,
    pairs: pairs.slice(0, 24).map(pair => ({ id: diagnosticOpaqueId(pair.id),
      state: allowed(pair.state, ['frozen', 'waiting', 'in-progress', 'failed', 'succeeded']),
      selected: pair.id === selected?.id, nominated: pair.nominated === true,
      local: candidate(pair.localCandidateId), remote: candidate(pair.remoteCandidateId),
      ...Object.fromEntries(counters.flatMap(key => typeof pair[key] === 'number' && Number.isFinite(pair[key]) && pair[key] >= 0 ? [[key, pair[key]]] : [])),
    })),
    transports: reports.filter(report => report.type === 'transport').slice(0, 4).map(report => ({
      dtls: allowed(report.dtlsState, ['new', 'connecting', 'connected', 'closed', 'failed']),
      iceRole: allowed(report.iceRole, ['controlling', 'controlled', 'unknown']),
    })) };
}

async function sampleIceStats(connection: RTCPeerConnection) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const stats = await Promise.race([connection.getStats(), new Promise<null>(resolve => {
      timer = setTimeout(() => resolve(null), 1_000);
    })]);
    return stats ? { status: 'available', ...summarizeIceStats(stats) } : { status: 'timeout' };
  } catch {
    return { status: 'unavailable' };
  } finally {
    clearTimeout(timer);
  }
}

export function sanitizeTurnUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('turn:') || trimmed.startsWith('turns:')) {
    return trimmed;
  }
  return `turn:${trimmed}`;
}

export function parseTurnUrls(rawUrls: string): string[] {
  return [...new Set(rawUrls.split(/[\n,]+/).map(sanitizeTurnUrl).filter(Boolean))];
}

export function isValidTurnUrl(url: string): boolean {
  return /^turns?:(?:\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::\d{1,5})?(?:\?transport=(?:udp|tcp))?$/i.test(url);
}

export function buildIceServers(turnConfig?: TurnConfig | null): RTCIceServer[] {
  const iceServers: RTCIceServer[] = [
    {
      urls: DEFAULT_STUN_SERVERS,
    },
  ];

  if (turnConfig && turnConfig.enabled && turnConfig.url) {
    const urls = parseTurnUrls(turnConfig.url).filter(isValidTurnUrl);
    if (urls.length === 0) return iceServers;
    const turnEntry: RTCIceServer = {
      urls,
    };
    if (turnConfig.username) {
      turnEntry.username = turnConfig.username;
    }
    if (turnConfig.credential) {
      turnEntry.credential = turnConfig.credential;
    }
    iceServers.push(turnEntry);
  }

  return iceServers;
}

export function buildRtcConfiguration(turnConfig?: TurnConfig | null): RTCConfiguration {
  const servers = buildIceServers(turnConfig);
  const relayOnly = Boolean(turnConfig?.forceRelay && servers.some((server) =>
    (Array.isArray(server.urls) ? server.urls : [server.urls]).some((url) => /^turns?:/i.test(url))));
  return {
    iceServers: relayOnly ? servers.filter((server) =>
      (Array.isArray(server.urls) ? server.urls : [server.urls]).some((url) => /^turns?:/i.test(url))) : servers,
    iceTransportPolicy: relayOnly ? 'relay' : 'all',
    iceCandidatePoolSize: 0,
  };
}

export function attachIceDiagnostics(connection: RTCPeerConnection, mode: IceConnectionMode = 'internet'): void {
  const id = ++diagnosticConnectionId;
  const started = performance.now();
  const generated = { host: 0, srflx: 0, relay: 0, mdns: 0 };
  let pendingTimer: ReturnType<typeof setTimeout> | undefined;
  let lateTimer: ReturnType<typeof setTimeout> | undefined;
  let reportedPending = false;
  let reportedConnected = false;
  let negotiatedAt: number | undefined;
  const snapshot = async () => ({
    id, mode, elapsedMs: Math.round(performance.now() - started),
    negotiatedElapsedMs: negotiatedAt === undefined ? null : Math.round(performance.now() - negotiatedAt),
    gathering: connection.iceGatheringState, ice: connection.iceConnectionState,
    connection: connection.connectionState, signaling: connection.signalingState,
    localDescription: summarizeIceDescription(connection.localDescription),
    remoteDescription: summarizeIceDescription(connection.remoteDescription),
    generated: { ...generated }, routes: await sampleIceStats(connection),
  });
  connection.addEventListener('icecandidate', (event) => {
    const raw = event.candidate?.candidate ?? '';
    const kind = /\styp (host|srflx|relay)(?:\s|$)/.exec(raw)?.[1] as 'host' | 'srflx' | 'relay' | undefined;
    if (kind) generated[kind]++;
    if (/\s\S+\.local\s/.test(raw)) generated.mdns++;
    if (reportedRelayCandidate || !event.candidate?.candidate.includes(' typ relay')) return;
    reportedRelayCandidate = true;
    console.warn('[P2P/ICE] Relay candidate gathered');
  });

  connection.addEventListener('signalingstatechange', () => {
    if (connection.signalingState !== 'stable' || !connection.remoteDescription || reportedPending || pendingTimer) return;
    negotiatedAt ??= performance.now();
    pendingTimer = setTimeout(() => {
      pendingTimer = undefined;
      if (connection.connectionState === 'connected' || connection.connectionState === 'closed') return;
      reportedPending = true;
      void snapshot().then((summary) => {
        if (connection.connectionState !== 'connected' && connection.connectionState !== 'closed')
          console.warn('[P2P/ICE] Pending connection candidate summary', summary);
      }).catch(() => {});
    }, 5_000);
    // Capture checks shortly before Trystero's negotiation deadline as well as
    // the early snapshot. Do not poll idle prewarmed or established connections.
    lateTimer = setTimeout(() => {
      lateTimer = undefined;
      if (connection.connectionState === 'connected' || connection.connectionState === 'closed') return;
      void snapshot().then(summary => {
        if (connection.connectionState !== 'connected' && connection.connectionState !== 'closed')
          console.warn('[P2P/ICE] Pending connection route summary', summary);
      });
    }, 12_000);
  });

  connection.addEventListener('connectionstatechange', () => {
    if (connection.connectionState === 'connected' || connection.connectionState === 'closed') {
      clearTimeout(pendingTimer);
      pendingTimer = undefined;
      clearTimeout(lateTimer);
      lateTimer = undefined;
    }
    if (connection.connectionState !== 'connected' || reportedConnected) return;
    reportedConnected = true;
    void snapshot().then((summary) => {
      console.log('[P2P] Direct WebRTC peer ICE summary', summary);
    }).catch(() => {});
  });

  connection.addEventListener('icecandidateerror', (event) => {
    const error = event as RTCPeerConnectionIceErrorEvent;
    const server = error.url.replace(/^([^:]+:)[^@]+@/, '$1***@');
    const key = `${server}:${error.errorCode}`;
    const now = Date.now();
    if (now - (reportedIceServerErrors.get(key) ?? 0) < 60_000) return;
    reportedIceServerErrors.set(key, now);
    console.warn('[P2P/ICE] Candidate server error', {
      server, code: error.errorCode, message: error.errorText,
    });
  });

  connection.addEventListener('iceconnectionstatechange', () => {
    if (connection.iceConnectionState !== 'failed') return;
    void snapshot().then((summary) => {
      console.warn('[P2P/ICE] Connection failed route summary', summary);
    });
  });
}

export interface JoinErrorDetails {
  error: string;
  appId?: string;
  roomId?: string;
  peerId?: string;
}

export function formatJoinError(details: JoinErrorDetails, mode: IceConnectionMode = 'internet'): string {
  const err = details.error || '';
  const peer = details.peerId ? ` (peer: ${details.peerId.slice(0, 6)})` : '';

  if (err.includes('after exchanging SDP') || err.includes('TURN')) {
    if (mode === 'lan') return t('ice.lanTimeout', { peer });
    if (err.includes('check that your TURN server')) {
      return `Falha de conexão WebRTC${peer}: a troca de SDP terminou, mas nenhuma rota ICE foi estabelecida. Verifique a conectividade STUN/TURN e as credenciais do TURN, se configurado.`;
    }
    return t('ice.connectionTimeout', { peer });
  }

  if (err.includes('handshake timeout')) {
    return `Tempo esgotado no handshake criptográfico com peer${peer}.`;
  }

  if (err.includes('SDP') || err.includes('offer') || err.includes('answer')) {
    return `Erro na negociação SDP com peer${peer}: ${err}`;
  }

  return `Erro de conexão P2P${peer}: ${err || 'Falha de sinalização/ICE'}`;
}

export function createJoinErrorHandler(
  onDiagnostic?: (formattedMsg: string, details: JoinErrorDetails) => void,
  mode: IceConnectionMode = 'internet'
): (details: JoinErrorDetails) => void {
  return (details: JoinErrorDetails) => {
    const formatted = formatJoinError(details, mode);
    console.warn(`[P2P/ICE] Join error: ${formatted}`, details);
    if (onDiagnostic) {
      onDiagnostic(formatted, details);
    }
  };
}
