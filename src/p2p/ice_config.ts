import type { TurnConfig } from '../core/types.ts';

export const DEFAULT_STUN_SERVERS = [
  'stun:stun.cloudflare.com:3478',
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
  'stun:stun2.l.google.com:19302',
  'stun:stun3.l.google.com:19302',
  'stun:stun4.l.google.com:19302',
  'stun:stun.services.mozilla.com',
];

export function sanitizeTurnUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('turn:') || trimmed.startsWith('turns:') || trimmed.startsWith('stun:')) {
    return trimmed;
  }
  return `turn:${trimmed}`;
}

export function buildIceServers(turnConfig?: TurnConfig | null): RTCIceServer[] {
  const iceServers: RTCIceServer[] = [
    {
      urls: DEFAULT_STUN_SERVERS,
    },
  ];

  if (turnConfig && turnConfig.enabled && turnConfig.url) {
    const sanitizedUrl = sanitizeTurnUrl(turnConfig.url);
    const turnEntry: RTCIceServer = {
      urls: sanitizedUrl,
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
  return {
    iceServers: buildIceServers(turnConfig),
    iceTransportPolicy: turnConfig?.forceRelay ? 'relay' : 'all',
    iceCandidatePoolSize: 2,
  };
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
      return `Falha de conexão WebRTC${peer}: servidor TURN configurado inacessível por ambos os peers.`;
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

