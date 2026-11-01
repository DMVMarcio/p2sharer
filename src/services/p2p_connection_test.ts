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
  private pingAction: any = null;
  private pongAction: any = null;
  private candInfoAction: any = null;
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
    this.addLog(`Starting P2P connectivity test (${isHost ? 'Host' : 'Connector'}). Code: ${cleanCode}`);
    this.notify();

    const topic = `p2s-diag-${cleanCode.toLowerCase()}`;
    const prefs = loadRendezvousPreferences();
    const urls = enabledRendezvousUrls(prefs, 'mqtt');
    const relayConfig = { urls, redundancy: urls.length };
    this.addLog(`Connecting to MQTT signaling relay broker (${urls.length} relays configured)...`);

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
      this.addLog(`Connected to signaling topic "${topic}". Waiting for peer...`);

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
      this.addLog(`Signaling initialization error: ${this.state.verdictMessage}`);
      this.notify();
    }
  }

  private setupRoomActions() {
    if (!this.room) return;

    this.pingAction = this.room.makeAction('diag_ping');
    this.pongAction = this.room.makeAction('diag_pong');
    this.candInfoAction = this.room.makeAction('diag_cand_info');

    // On Ping -> reply with Pong immediately
    this.pingAction.onMessage = (data: any, meta: { peerId: string }) => {
      try {
        void this.pongAction?.send({ seq: data.seq, sentAt: data.sentAt }, { target: meta.peerId });
      } catch {}
    };

    // On Pong -> measure RTT
    this.pongAction.onMessage = (data: any) => {
      const now = performance.now();
      const rtt = Math.max(1, Math.round(now - data.sentAt));
      this.state.metrics.rttSamples.push(rtt);
      this.addLog(`[DataChannel] Ping #${data.seq} acknowledged in ${rtt} ms.`);
      this.updateRttAverages();
    };

    // Remote candidate counts
    this.candInfoAction.onMessage = (info: any) => {
      if (info && info.candidates) {
        this.state.metrics.remoteCandidates = { ...info.candidates };
        this.addLog(`[Remote Candidates] Host: ${info.candidates.host}, STUN (srflx): ${info.candidates.srflx}, Relay: ${info.candidates.relay}`);
        this.notify();
      }
    };

    // Direct property assignment for Trystero v0.25 peer event handlers
    this.room.onPeerJoin = (peerId: string) => {
      this.addLog(`[Signaling] Peer detected: ${peerId}. Initiating WebRTC negotiation...`);
      this.state.remotePeerId = peerId;
      this.state.stepOfferAnswer = 'running';
      this.state.stepIceGathering = 'running';
      this.state.stepIceHandshake = 'running';
      this.state.phase = 'negotiating';
      this.notify();

      this.monitorPeerConnection(peerId);
    };

    this.room.onPeerLeave = (peerId: string) => {
      this.addLog(`[Signaling] Peer ${peerId} left the room.`);
    };
  }

  private monitorPeerConnection(peerId: string) {
    let attempts = 0;
    const findPc = () => {
      if (this.destroyed) return;
      const pc = this.room?.getPeers?.()?.[peerId] as RTCPeerConnection | undefined;
      if (pc) {
        this.peerConnection = pc;
        this.attachPcListeners(pc);
      } else if (attempts < 40) {
        attempts++;
        setTimeout(findPc, 150);
      }
    };
    findPc();
  }

  private attachPcListeners(pc: RTCPeerConnection) {
    this.addLog('[WebRTC] RTCPeerConnection initialized. Starting ICE candidate gathering...');
    this.state.stepOfferAnswer = 'success';
    this.notify();

    pc.addEventListener('signalingstatechange', () => {
      this.addLog(`[WebRTC SDP] Signaling state: ${pc.signalingState}`);
    });

    pc.addEventListener('icegatheringstatechange', () => {
      this.addLog(`[WebRTC ICE] Gathering state: ${pc.iceGatheringState}`);
    });

    pc.addEventListener('connectionstatechange', () => {
      this.addLog(`[WebRTC Peer] Connection state (DTLS): ${pc.connectionState}`);
      if (pc.connectionState === 'failed') {
        this.addLog('[WebRTC Peer] Critical failure in DTLS encryption handshake or transport teardown.');
      }
    });

    pc.addEventListener('icecandidateerror', (event: Event) => {
      const err = event as RTCPeerConnectionIceErrorEvent;
      const host = err.url ? ` (${err.url})` : '';
      this.addLog(`[WebRTC ICE Error] Failed to query STUN/TURN endpoint${host}: Code ${err.errorCode} - ${err.errorText || 'unknown'}`);
    });

    pc.addEventListener('icecandidate', (e) => {
      if (e.candidate) {
        const type = e.candidate.type ?? 'unknown';
        const address = e.candidate.address ?? 'private';
        if (type === 'host') this.state.metrics.localCandidates.host++;
        else if (type === 'srflx') this.state.metrics.localCandidates.srflx++;
        else if (type === 'relay') this.state.metrics.localCandidates.relay++;

        this.addLog(`[ICE Local] Candidate discovered: ${type} ${address}:${e.candidate.port ?? ''} (${e.candidate.protocol ?? 'udp'})`);
        this.notify();
      } else {
        this.addLog('[ICE Local] Local candidate gathering completed.');
        this.state.stepIceGathering = 'success';
        this.notify();
        // Send candidate summary to peer
        try {
          void this.candInfoAction?.send({ candidates: this.state.metrics.localCandidates });
        } catch {}
      }
    });

    pc.addEventListener('iceconnectionstatechange', () => {
      const state = pc.iceConnectionState;
      this.addLog(`[ICE State] Connection state transition: ${state}`);
      if (state === 'connected' || state === 'completed') {
        this.state.stepIceHandshake = 'success';
        this.state.phase = 'measuring';
        this.notify();
        this.runDataChannelMeasurements();
      } else if (state === 'failed') {
        this.state.stepIceHandshake = 'failed';
        this.finishWithVerdict('failed', 'ICE handshake failed: firewall or symmetric NAT dropped direct UDP connections.');
      }
    });

    if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
      this.state.stepIceHandshake = 'success';
      this.state.phase = 'measuring';
      this.notify();
      this.runDataChannelMeasurements();
    }
  }

  private async runDataChannelMeasurements() {
    this.state.stepDataChannel = 'running';
    this.addLog('[DataChannel] ICE route established. Running RTT and latency measurement...');
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
        void this.pingAction?.send({ seq: sent, sentAt: performance.now() });
      } catch (e) {
        this.addLog(`[DataChannel] Error sending ping probe #${sent}: ${e}`);
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
      this.finishWithVerdict('optimal', 'Direct P2P connection successfully established.');
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

        this.state.metrics.localSelectedCandidate = `${localType} (${localAddr || 'protected'})`;
        this.state.metrics.remoteSelectedCandidate = `${remoteType} (${remoteAddr || 'protected'})`;

        this.addLog(`[Selected Route] Local: ${this.state.metrics.localSelectedCandidate} <-> Remote: ${this.state.metrics.remoteSelectedCandidate}`);

        const isVpn = localAddr.startsWith('26.') || remoteAddr.startsWith('26.');
        const isRelay = localType === 'relay' || remoteType === 'relay';
        const isLan = localType === 'host' && remoteType === 'host';

        if (isVpn) {
          this.state.metrics.connectionType = 'virtual_vpn';
          this.finishWithVerdict('vpn', 'Connection successfully routed through virtual VPN adapter (Radmin/Hamachi).');
        } else if (isRelay) {
          this.state.metrics.connectionType = 'turn_relay';
          this.finishWithVerdict('optimal', 'Connection established via TURN relay server.');
        } else if (isLan) {
          this.state.metrics.connectionType = 'local_lan';
          this.finishWithVerdict('optimal', 'Direct local network connection (LAN).');
        } else {
          this.state.metrics.connectionType = 'direct_stun';
          this.finishWithVerdict('optimal', 'Direct P2P Internet connection (STUN / Server-Reflexive). Optimal compatibility.');
        }
      } else {
        this.finishWithVerdict('optimal', 'Direct P2P connection successfully established.');
      }
    } catch {
      this.finishWithVerdict('optimal', 'Direct P2P connection successfully established.');
    }
  }

  private finishWithVerdict(verdict: 'optimal' | 'vpn' | 'failed' | 'timeout', message: string) {
    if (this.state.phase === 'done') return;
    this.state.phase = verdict === 'failed' || verdict === 'timeout' ? 'failed' : 'done';
    this.state.stepDataChannel = verdict === 'failed' || verdict === 'timeout' ? 'failed' : 'success';
    this.state.verdict = verdict;
    this.state.verdictMessage = message;
    this.addLog(`[Verdict] ${message}`);
    this.notify();
  }

  private handleTimeout() {
    if (this.state.phase === 'done') return;
    this.addLog('[Timeout] Test did not establish connection within 25-second limit.');

    if (!this.state.remotePeerId) {
      this.finishWithVerdict('timeout', 'The other user did not join the test room with the provided session code.');
    } else {
      this.finishWithVerdict('failed', 'Both users joined the room, but routers dropped direct path negotiation (typical of double CGNAT or Symmetric NAT without UPnP). Recommendation: use VPN mode (Radmin) or TURN relay.');
    }
  }

  public generateReport(): string {
    const s = this.state;
    const m = s.metrics;
    return [
      '==================================================',
      '         P2P DIAGNOSTIC REPORT - P2SHARER         ',
      '==================================================',
      `Date/Time: ${new Date().toISOString()}`,
      `Session Code: ${s.code}`,
      `Local Role: ${s.isHost ? 'Host' : 'Connector'}`,
      `Remote Peer: ${s.remotePeerId ?? 'Not connected'}`,
      `Verdict: ${s.verdictMessage ?? 'Inconclusive'}`,
      '',
      '--- NETWORK METRICS ---',
      `Route Type: ${m.connectionType ?? 'N/A'}`,
      `Local Candidate: ${m.localSelectedCandidate ?? 'N/A'}`,
      `Remote Candidate: ${m.remoteSelectedCandidate ?? 'N/A'}`,
      `Average RTT Latency: ${m.avgRttMs != null ? m.avgRttMs + ' ms' : 'N/A'} (Min: ${m.minRttMs ?? '—'}, Max: ${m.maxRttMs ?? '—'})`,
      `Ping Samples: ${m.rttSamples.join(', ') || 'None'}`,
      `Discovered Local Candidates: Host=${m.localCandidates.host}, STUN=${m.localCandidates.srflx}, Relay=${m.localCandidates.relay}`,
      `Discovered Remote Candidates: Host=${m.remoteCandidates.host}, STUN=${m.remoteCandidates.srflx}, Relay=${m.remoteCandidates.relay}`,
      '',
      '--- DETAILED TECHNICAL LOGS ---',
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
    this.pingAction = null;
    this.pongAction = null;
    this.candInfoAction = null;
  }
}
