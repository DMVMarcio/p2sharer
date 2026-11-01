import { joinRoom as joinMqttRoom } from '@trystero-p2p/mqtt';
import { DEFAULT_STUN_SERVERS } from '../p2p/ice_config.ts';
import { enabledRendezvousUrls, loadRendezvousPreferences } from '../p2p/relay_preferences.ts';
import { selectedIcePair, type IceStat } from '../core/ice_route.ts';

export type StepStatus = 'pending' | 'running' | 'success' | 'failed';

export interface P2PTestMetrics {
  rttSamples: number[];
  avgRttMs: number | null;
  minRttMs: number | null;
  maxRttMs: number | null;
  packetLossPercent: number;
  localCandidates: { host: number; srflx: number; relay: number };
  remoteCandidates: { host: number; srflx: number; relay: number };
  connectionType: 'direct_stun' | 'virtual_vpn' | 'local_lan' | 'turn_relay' | 'unknown' | null;
  localSelectedCandidate: string | null;
  remoteSelectedCandidate: string | null;
}

export interface P2PTestState {
  code: string;
  isHost: boolean;
  phase: 'idle' | 'signaling' | 'gathering' | 'negotiating' | 'measuring' | 'done' | 'failed';
  stepSignaling: StepStatus;
  stepOfferAnswer: StepStatus;
  stepIceGathering: StepStatus;
  stepIceHandshake: StepStatus;
  stepDataChannel: StepStatus;
  remotePeerId: string | null;
  metrics: P2PTestMetrics;
  verdict: 'optimal' | 'vpn' | 'failed' | 'timeout' | null;
  verdictMessage: string | null;
  logs: string[];
}

export function generateTestCode(): string {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

export function formatTimestamp(): string {
  const d = new Date();
  const pad = (n: number, s = 2) => String(n).padStart(s, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export class P2PConnectionTester {
  private room: any = null;
  private peerConnection: RTCPeerConnection | null = null;
  private state: P2PTestState;
  private listeners = new Set<(state: P2PTestState) => void>();
  private timeoutTimer: any = null;
  private pingTimer: any = null;
  private destroyed = false;

  constructor() {
    this.state = this.initialState('');
  }

  private initialState(code: string, isHost = true): P2PTestState {
    return {
      code,
      isHost,
      phase: 'idle',
      stepSignaling: 'pending',
      stepOfferAnswer: 'pending',
      stepIceGathering: 'pending',
      stepIceHandshake: 'pending',
      stepDataChannel: 'pending',
      remotePeerId: null,
      metrics: {
        rttSamples: [],
        avgRttMs: null,
        minRttMs: null,
        maxRttMs: null,
        packetLossPercent: 0,
        localCandidates: { host: 0, srflx: 0, relay: 0 },
        remoteCandidates: { host: 0, srflx: 0, relay: 0 },
        connectionType: null,
        localSelectedCandidate: null,
        remoteSelectedCandidate: null,
      },
      verdict: null,
      verdictMessage: null,
      logs: [],
    };
  }

  public getState(): P2PTestState {
    return { ...this.state };
  }

  public subscribe(fn: (state: P2PTestState) => void): () => void {
    this.listeners.add(fn);
    fn(this.getState());
    return () => this.listeners.delete(fn);
  }

  private notify() {
    const current = this.getState();
    this.listeners.forEach((fn) => fn(current));
  }

  private addLog(message: string) {
    const line = `[${formatTimestamp()}] ${message}`;
    this.state.logs.push(line);
    this.notify();
  }

  public start(code: string, isHost: boolean) {
    this.cleanup();
    const cleanCode = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!cleanCode) return;

    this.destroyed = false;
    this.state = this.initialState(cleanCode, isHost);
    this.state.phase = 'signaling';
    this.state.stepSignaling = 'running';
    this.addLog(`Iniciando teste de conectividade P2P (${isHost ? 'Host' : 'Conector'}). Código: ${cleanCode}`);
    this.notify();

    const topic = `p2s-diag-${cleanCode.toLowerCase()}`;
    const prefs = loadRendezvousPreferences();
    const urls = enabledRendezvousUrls(prefs, 'mqtt');
    const relayConfig = { urls, redundancy: urls.length };
    this.addLog(`Conectando ao broker de sinalização MQTT (${urls.length} relays configurados)...`);

    try {
      this.room = joinMqttRoom(
        {
          appId: 'p2sharer-diagnostics-v1',
          relayConfig,
          rtcConfig: {
            iceServers: [{ urls: DEFAULT_STUN_SERVERS }],
          },
        },
        topic
      );

      this.state.stepSignaling = 'success';
      this.addLog(`Conectado à sala de sinalização "${topic}". Aguardando par...`);

      // Set a 25-second overall timeout
      this.timeoutTimer = setTimeout(() => {
        if (this.state.phase !== 'done') {
          this.handleTimeout();
        }
      }, 25000);

      this.setupRoomActions();
    } catch (err) {
      this.state.phase = 'failed';
      this.state.stepSignaling = 'failed';
      this.state.verdict = 'failed';
      this.state.verdictMessage = err instanceof Error ? err.message : String(err);
      this.addLog(`Erro ao inicializar sinalização: ${this.state.verdictMessage}`);
      this.notify();
    }
  }

  private setupRoomActions() {
    if (!this.room) return;

    const [sendPing, getPing] = this.room.makeAction('diag_ping');
    const [sendPong, getPong] = this.room.makeAction('diag_pong');
    const [sendCandInfo, getCandInfo] = this.room.makeAction('diag_cand_info');

    // On Ping -> reply with Pong immediately
    getPing((data: any, peerId: string) => {
      sendPong({ seq: data.seq, sentAt: data.sentAt }, peerId);
    });

    // On Pong -> measure RTT
    getPong((data: any) => {
      const now = performance.now();
      const rtt = Math.max(1, Math.round(now - data.sentAt));
      this.state.metrics.rttSamples.push(rtt);
      this.addLog(`[Canal de Dados] Ping #${data.seq} respondido em ${rtt} ms.`);
      this.updateRttAverages();
    });

    // Remote candidate counts
    getCandInfo((info: any) => {
      if (info && info.candidates) {
        this.state.metrics.remoteCandidates = { ...info.candidates };
        this.addLog(`[Candidatos Remotos] Host: ${info.candidates.host}, STUN (srflx): ${info.candidates.srflx}, Relay: ${info.candidates.relay}`);
        this.notify();
      }
    });

    this.room.onPeerJoin((peerId: string) => {
      this.addLog(`[Sinalização] Peer detectado: ${peerId}. Negociando conexão WebRTC...`);
      this.state.remotePeerId = peerId;
      this.state.stepOfferAnswer = 'running';
      this.state.stepIceGathering = 'running';
      this.state.stepIceHandshake = 'running';
      this.state.phase = 'negotiating';
      this.notify();

      this.monitorPeerConnection(peerId, sendCandInfo, sendPing);
    });

    this.room.onPeerLeave((peerId: string) => {
      this.addLog(`[Sinalização] Peer ${peerId} saiu da sala.`);
    });
  }

  private monitorPeerConnection(peerId: string, sendCandInfo: any, sendPing: any) {
    let attempts = 0;
    const findPc = () => {
      if (this.destroyed) return;
      const pc = this.room?.getPeers?.()?.[peerId] as RTCPeerConnection | undefined;
      if (pc) {
        this.peerConnection = pc;
        this.attachPcListeners(pc, sendCandInfo, sendPing);
      } else if (attempts < 20) {
        attempts++;
        setTimeout(findPc, 150);
      }
    };
    findPc();
  }

  private attachPcListeners(pc: RTCPeerConnection, sendCandInfo: any, sendPing: any) {
    this.addLog('[WebRTC] RTCPeerConnection instanciado. Iniciando coleta de candidatos ICE...');
    this.state.stepOfferAnswer = 'success';
    this.notify();

    pc.addEventListener('signalingstatechange', () => {
      this.addLog(`[WebRTC SDP] Estado de sinalização SDP: ${pc.signalingState}`);
    });

    pc.addEventListener('icegatheringstatechange', () => {
      this.addLog(`[WebRTC ICE] Estado da coleta de candidatos: ${pc.iceGatheringState}`);
    });

    pc.addEventListener('connectionstatechange', () => {
      this.addLog(`[WebRTC Peer] Estado geral da conexão (DTLS): ${pc.connectionState}`);
      if (pc.connectionState === 'failed') {
        this.addLog('[WebRTC Peer] Falha crítica no handshake de criptografia DTLS ou queda de transporte.');
      }
    });

    pc.addEventListener('icecandidateerror', (event: Event) => {
      const err = event as RTCPeerConnectionIceErrorEvent;
      const host = err.url ? ` (${err.url})` : '';
      this.addLog(`[WebRTC ICE Erro] Falha ao consultar endpoint STUN/TURN${host}: Código ${err.errorCode} - ${err.errorText || 'desconhecido'}`);
    });

    pc.addEventListener('icecandidate', (e) => {
      if (e.candidate) {
        const type = e.candidate.type ?? 'unknown';
        const address = e.candidate.address ?? 'private';
        if (type === 'host') this.state.metrics.localCandidates.host++;
        else if (type === 'srflx') this.state.metrics.localCandidates.srflx++;
        else if (type === 'relay') this.state.metrics.localCandidates.relay++;

        this.addLog(`[ICE Local] Candidato descoberto: ${type} ${address}:${e.candidate.port ?? ''} (${e.candidate.protocol ?? 'udp'})`);
        this.notify();
      } else {
        this.addLog('[ICE Local] Coleta de candidatos locais concluída.');
        this.state.stepIceGathering = 'success';
        this.notify();
        // Send candidate summary to peer
        try {
          sendCandInfo({ candidates: this.state.metrics.localCandidates });
        } catch {}
      }
    });

    pc.addEventListener('iceconnectionstatechange', () => {
      const state = pc.iceConnectionState;
      this.addLog(`[ICE Estado] Transição de estado de conexão ICE: ${state}`);
      if (state === 'connected' || state === 'completed') {
        this.state.stepIceHandshake = 'success';
        this.state.phase = 'measuring';
        this.notify();
        this.runDataChannelMeasurements(sendPing);
      } else if (state === 'failed') {
        this.state.stepIceHandshake = 'failed';
        this.finishWithVerdict('failed', 'Falha no aperto de mão ICE: o firewall ou NAT descartou as conexões UDP diretas.');
      }
    });
  }

  private async runDataChannelMeasurements(sendPing: any) {
    this.state.stepDataChannel = 'running';
    this.addLog('[Canal de Dados] Rota ICE estabelecida! Iniciando medição de latência e RTT...');
    this.notify();

    let sent = 0;
    const totalPings = 5;

    this.pingTimer = setInterval(async () => {
      if (this.destroyed) return;
      if (sent >= totalPings) {
        clearInterval(this.pingTimer);
        this.pingTimer = null;
        await this.inspectFinalStats();
        return;
      }
      sent++;
      try {
        sendPing({ seq: sent, sentAt: performance.now() });
      } catch (e) {
        this.addLog(`[Canal de Dados] Erro ao enviar ping #${sent}: ${e}`);
      }
    }, 400);
  }

  private updateRttAverages() {
    const s = this.state.metrics.rttSamples;
    if (s.length === 0) return;
    const sum = s.reduce((a, b) => a + b, 0);
    this.state.metrics.avgRttMs = Math.round(sum / s.length);
    this.state.metrics.minRttMs = Math.min(...s);
    this.state.metrics.maxRttMs = Math.max(...s);
    this.notify();
  }

  private async inspectFinalStats() {
    if (!this.peerConnection) {
      this.finishWithVerdict('optimal', 'Conexão direta estabelecida com sucesso.');
      return;
    }

    try {
      const stats = await this.peerConnection.getStats();
      const reports: IceStat[] = [];
      stats.forEach((r) => reports.push(r as unknown as IceStat));

      const selected = selectedIcePair(reports);
      if (selected) {
        const { local, remote } = selected;
        const localType = local?.candidateType ?? 'unknown';
        const remoteType = remote?.candidateType ?? 'unknown';
        const localAddr = local?.address ?? '';
        const remoteAddr = remote?.address ?? '';

        this.state.metrics.localSelectedCandidate = `${localType} (${localAddr || 'protegido'})`;
        this.state.metrics.remoteSelectedCandidate = `${remoteType} (${remoteAddr || 'protegido'})`;

        this.addLog(`[Rota Selecionada] Local: ${this.state.metrics.localSelectedCandidate} <-> Remoto: ${this.state.metrics.remoteSelectedCandidate}`);

        const isVpn = localAddr.startsWith('26.') || remoteAddr.startsWith('26.');
        const isRelay = localType === 'relay' || remoteType === 'relay';
        const isLan = localType === 'host' && remoteType === 'host';

        if (isVpn) {
          this.state.metrics.connectionType = 'virtual_vpn';
          this.finishWithVerdict('vpn', 'Conexão estabelecida com sucesso através do adaptador virtual VPN (Radmin/Hamachi).');
        } else if (isRelay) {
          this.state.metrics.connectionType = 'turn_relay';
          this.finishWithVerdict('optimal', 'Conexão estabelecida via servidor de retransmissão TURN.');
        } else if (isLan) {
          this.state.metrics.connectionType = 'local_lan';
          this.finishWithVerdict('optimal', 'Conexão direta na mesma rede local (LAN).');
        } else {
          this.state.metrics.connectionType = 'direct_stun';
          this.finishWithVerdict('optimal', 'Conexão P2P direta via Internet (STUN / Server-Reflexive). Excelente compatibilidade!');
        }
      } else {
        this.finishWithVerdict('optimal', 'Conexão P2P direta estabelecida com sucesso.');
      }
    } catch {
      this.finishWithVerdict('optimal', 'Conexão P2P direta estabelecida com sucesso.');
    }
  }

  private finishWithVerdict(verdict: 'optimal' | 'vpn' | 'failed' | 'timeout', message: string) {
    if (this.state.phase === 'done') return;
    this.state.phase = verdict === 'failed' || verdict === 'timeout' ? 'failed' : 'done';
    this.state.stepDataChannel = verdict === 'failed' || verdict === 'timeout' ? 'failed' : 'success';
    this.state.verdict = verdict;
    this.state.verdictMessage = message;
    this.addLog(`[Veredito] ${message}`);
    this.notify();
  }

  private handleTimeout() {
    if (this.state.phase === 'done') return;
    this.addLog('[Tempo Esgotado] O teste não conseguiu estabelecer a conexão no tempo limite de 25 segundos.');

    if (!this.state.remotePeerId) {
      this.finishWithVerdict('timeout', 'O outro usuário não entrou na sala de teste com o código fornecido. Verifique o código e tente novamente.');
    } else {
      this.finishWithVerdict('failed', 'Ambos os usuários entraram na sala, mas os roteadores descartaram a negociação de rota direta (típico de CGNAT duplo ou NAT Simétrico sem UPnP). Recomendado: usar o modo VPN (Radmin) ou servidor TURN.');
    }
  }

  public generateReport(): string {
    const s = this.state;
    const m = s.metrics;
    return [
      '==================================================',
      '      RELATÓRIO DE DIAGNÓSTICO P2P - P2SHARER     ',
      '==================================================',
      `Data/Hora: ${new Date().toLocaleString()}`,
      `Código da Sessão: ${s.code}`,
      `Papel Local: ${s.isHost ? 'Host (Criador)' : 'Conector (Participante)'}`,
      `Peer Remoto: ${s.remotePeerId ?? 'Não conectado'}`,
      `Veredito: ${s.verdictMessage ?? 'Inconclusivo'}`,
      '',
      '--- MÉTRICAS DE REDE ---',
      `Tipo de Rota: ${m.connectionType ?? 'N/A'}`,
      `Candidato Local: ${m.localSelectedCandidate ?? 'N/A'}`,
      `Candidato Remoto: ${m.remoteSelectedCandidate ?? 'N/A'}`,
      `Latência RTT Média: ${m.avgRttMs != null ? m.avgRttMs + ' ms' : 'N/A'} (Mín: ${m.minRttMs ?? '—'}, Máx: ${m.maxRttMs ?? '—'})`,
      `Amostras de Ping: ${m.rttSamples.join(', ') || 'Nenhuma'}`,
      `Candidatos Locais Descobertos: Host=${m.localCandidates.host}, STUN=${m.localCandidates.srflx}, Relay=${m.localCandidates.relay}`,
      `Candidatos Remotos Descobertos: Host=${m.remoteCandidates.host}, STUN=${m.remoteCandidates.srflx}, Relay=${m.remoteCandidates.relay}`,
      '',
      '--- LOGS TÉCNICOS DETALHADOS ---',
      ...s.logs,
      '==================================================',
    ].join('\n');
  }

  public cleanup() {
    this.destroyed = true;
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.room) {
      try {
        this.room.leave();
      } catch {}
      this.room = null;
    }
    this.peerConnection = null;
  }
}
