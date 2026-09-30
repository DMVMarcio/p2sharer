import type { TurnConfig } from '../core/types.ts';

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
let pendingIceSnapshots = 0;

async function summarizeIceCandidates(connection: RTCPeerConnection): Promise<{
  local: Record<string, number>;
  remote: Record<string, number>;
}> {
  const candidates = { local: { host: 0, srflx: 0, relay: 0 }, remote: { host: 0, srflx: 0, relay: 0 } };
  const stats = await connection.getStats();
  stats.forEach((report) => {
    if (report.type !== 'local-candidate' && report.type !== 'remote-candidate') return;
    const side = report.type === 'local-candidate' ? candidates.local : candidates.remote;
    const type = report.candidateType as keyof typeof side;
    if (type in side) side[type]++;
  });
  return candidates;
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

export function attachIceDiagnostics(connection: RTCPeerConnection): void {
  connection.addEventListener('icecandidate', (event) => {
    if (reportedRelayCandidate || !event.candidate?.candidate.includes(' typ relay')) return;
    reportedRelayCandidate = true;
    console.warn('[P2P/ICE] Relay candidate gathered');
  });

  connection.addEventListener('signalingstatechange', () => {
    if (connection.signalingState !== 'stable' || !connection.remoteDescription || pendingIceSnapshots >= 4) return;
    pendingIceSnapshots++;
    setTimeout(() => {
      if (connection.connectionState === 'connected' || connection.connectionState === 'closed') return;
      void summarizeIceCandidates(connection).then((candidates) => {
        console.warn('[P2P/ICE] Pending connection candidate summary', {
          gathering: connection.iceGatheringState,
          ice: connection.iceConnectionState,
          connection: connection.connectionState,
          localDescription: Boolean(connection.localDescription),
          remoteDescription: Boolean(connection.remoteDescription),
          candidates,
        });
      }).catch(() => {});
    }, 5_000);
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
    void summarizeIceCandidates(connection).then((candidates) => {
      console.warn('[P2P/ICE] Connection failed candidate summary', candidates);
    }).catch((error) => {
      console.warn('[P2P/ICE] Could not collect failed connection stats', error);
    });
  });
}

export interface JoinErrorDetails {
  error: string;
  appId?: string;
  roomId?: string;
  peerId?: string;
}

export function formatJoinError(details: JoinErrorDetails): string {
  const err = details.error || '';
  const peer = details.peerId ? ` (peer: ${details.peerId.slice(0, 6)})` : '';

  if (err.includes('after exchanging SDP') || err.includes('TURN')) {
    if (err.includes('check that your TURN server')) {
      return `Falha de conexão WebRTC${peer}: a troca de SDP terminou, mas nenhuma rota ICE foi estabelecida. Verifique a conectividade STUN/TURN e as credenciais do TURN, se configurado.`;
    }
    return `Falha de conexão WebRTC${peer} (NAT Simétrico / Timeout de ICE): rota direta não estabelecida a tempo. Configure um servidor TURN nas opções de rede se persistir.`;
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
  onDiagnostic?: (formattedMsg: string, details: JoinErrorDetails) => void
): (details: JoinErrorDetails) => void {
  return (details: JoinErrorDetails) => {
    const formatted = formatJoinError(details);
    console.warn(`[P2P/ICE] Join error: ${formatted}`, details);
    if (onDiagnostic) {
      onDiagnostic(formatted, details);
    }
  };
}
