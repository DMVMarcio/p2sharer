import mqtt from 'mqtt';
import {
  defaultRelayUrls as defaultMqttUrls,
  getRelaySockets as getMqttRelaySockets,
  joinRoom as joinMqttRoom,
  selfId as mqttSelfId,
} from '@trystero-p2p/mqtt';
import {
  defaultRelayUrls as defaultNostrUrls,
  getRelaySockets as getNostrRelaySockets,
  joinRoom as joinNostrRoom,
} from '@trystero-p2p/nostr';
import {
  defaultRelayUrls as defaultTorrentUrls,
  getRelaySockets as getTorrentRelaySockets,
  joinRoom as joinTorrentRoom,
} from '@trystero-p2p/torrent';
import type {
  SignalingStatus,
  SignalingTransport,
  TransportStatusInfo,
} from '../core/types.ts';

export interface RoomReconnectionHandler {
  (newTransport: SignalingTransport, previousTransport: SignalingTransport): Promise<void> | void;
}

export interface SignalingFailoverEvent {
  from: SignalingTransport;
  to: SignalingTransport;
  reason: string;
  timestamp: number;
}

export const DEFAULT_MQTT_RELAY_URLS = [
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://broker.emqx.io:8084/mqtt',
  'wss://test.mosquitto.org:8081/mqtt',
];

export async function computeTrysteroSha1(str: string): Promise<string> {
  try {
    const encoder = new TextEncoder();
    const data = encoder.encode(str);
    const hashBuffer = await crypto.subtle.digest('SHA-1', data);
    return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(36)).join('');
  } catch {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = (hash << 5) - hash + str.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash).toString(36);
  }
}

/**
 * SignalingManager provides resilient multi-transport WebRTC signaling failover.
 * It manages seamless failover across:
 *   1. MQTT (@trystero-p2p/mqtt) - Primary low-latency transport (~50-150ms)
 *   2. Nostr (@trystero-p2p/nostr) - Secondary decentralized relay mesh (~200-500ms)
 *   3. WebTorrent (@trystero-p2p/torrent) - Tertiary tracker fallback (~1-3s)
 *
 * An integrated watchdog monitors relay socket health and triggers automatic
 * fallback if public brokers or relays drop connections or stall.
 */
export class SignalingManager {
  private activeTransport: SignalingTransport = 'mqtt';
  private availableTransports: SignalingTransport[] = ['mqtt', 'nostr', 'torrent'];
  private statusListeners: Array<(status: SignalingStatus) => void> = [];
  private failoverListeners: Array<(event: SignalingFailoverEvent) => void> = [];
  public failoverHistory: Array<{ from: SignalingTransport; to: SignalingTransport; timestamp: number }> = [];

  // Watchdog state
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private consecutiveStalls = 0;
  private maxConsecutiveStalls = 2; // 2 intervals @ 1.5s = 3.0s stall threshold
  private roomJoinedTimestamp = 0;
  private isFailingOver = false;
  private reconnectHandler: RoomReconnectionHandler | null = null;

  // Active room and configuration references
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private activeRoom: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private lastRoomParams: { config: any; topic: string; callbacks?: any } | null = null;
  private directConnectedPeers: Set<string> = new Set();

  // Active MQTT WebSocket probe monitoring
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private monitoredMqttSockets: Map<string, any> = new Map();
  private mqttSocketStatuses: Map<string, { readyState: number; connected: boolean }> = new Map();

  constructor() {
    this.setupNetworkEventListeners();
  }

  private setupNetworkEventListeners(): void {
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('online', () => {
        console.log('[SignalingManager] Network online event detected. Probing relay sockets...');
        this.consecutiveStalls = 0;
        this.checkRelayHealth();
      });

      window.addEventListener('offline', () => {
        console.warn('[SignalingManager] Network offline event detected.');
      });
    }
  }

  public getActiveTransport(): SignalingTransport {
    return this.activeTransport;
  }

  public getAvailableTransports(): SignalingTransport[] {
    return [...this.availableTransports];
  }

  public getSelfId(): string {
    return mqttSelfId;
  }

  public setRoomReconnectionHandler(handler: RoomReconnectionHandler | null): void {
    this.reconnectHandler = handler;
  }

  private startMqttRelayMonitoring(): void {
    this.stopMqttRelayMonitoring();

    DEFAULT_MQTT_RELAY_URLS.forEach((url) => {
      this.initMqttProbeSocket(url);
    });
  }

  private initMqttProbeSocket(url: string): void {
    try {
      if (typeof mqtt !== 'undefined' && typeof mqtt.connect === 'function') {
        const client = mqtt.connect(url, {
          connectTimeout: 7000,
          keepalive: 20,
          reconnectPeriod: 4000,
        });

        this.monitoredMqttSockets.set(url, client);
        this.mqttSocketStatuses.set(url, {
          readyState: client.connected ? 1 : 0,
          connected: Boolean(client.connected),
        });

        client.on('connect', () => {
          this.mqttSocketStatuses.set(url, { readyState: 1, connected: true });
          this.notifyStatusChange();
        });

        client.on('close', () => {
          this.mqttSocketStatuses.set(url, { readyState: 3, connected: false });
        });

        client.on('offline', () => {
          this.mqttSocketStatuses.set(url, { readyState: 3, connected: false });
        });

        client.on('error', () => {
          this.mqttSocketStatuses.set(url, { readyState: 3, connected: false });
        });
        return;
      }
    } catch {
      // Fallback to WebSocket below
    }

    if (typeof WebSocket === 'undefined') return;
    try {
      const ws = new WebSocket(url, 'mqtt');
      this.monitoredMqttSockets.set(url, ws);
      this.mqttSocketStatuses.set(url, { readyState: ws.readyState, connected: ws.readyState === 1 });

      ws.onopen = () => {
        this.mqttSocketStatuses.set(url, { readyState: 1, connected: true });
        this.notifyStatusChange();
      };

      ws.onclose = () => {
        this.mqttSocketStatuses.set(url, { readyState: 3, connected: false });
        if (this.activeRoom && this.activeTransport === 'mqtt') {
          setTimeout(() => {
            if (this.activeRoom && this.activeTransport === 'mqtt') {
              this.initMqttProbeSocket(url);
            }
          }, 3000);
        }
      };

      ws.onerror = () => {
        this.mqttSocketStatuses.set(url, { readyState: 3, connected: false });
      };
    } catch {
      this.mqttSocketStatuses.set(url, { readyState: 3, connected: false });
    }
  }

  private stopMqttRelayMonitoring(): void {
    this.monitoredMqttSockets.forEach((client) => {
      try {
        if (typeof client.end === 'function') {
          client.end(true);
        } else if (typeof client.close === 'function') {
          client.close();
        }
      } catch {}
    });
    this.monitoredMqttSockets.clear();
    this.mqttSocketStatuses.clear();
  }

  /**
   * Synchronously queries active relay sockets for the specified or active transport.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public getRelaySockets(transport: SignalingTransport = this.activeTransport): Record<string, any> {
    try {
      if (transport === 'mqtt') {
        const raw = getMqttRelaySockets() || {};
        if (Object.keys(raw).length > 0) {
          return raw;
        }
        const result: Record<string, any> = {};
        this.mqttSocketStatuses.forEach((val, url) => {
          result[url] = val;
        });
        if (Object.keys(result).length > 0) {
          return result;
        }
        if (this.activeRoom) {
          DEFAULT_MQTT_RELAY_URLS.forEach((u) => {
            result[u] = { readyState: 1, connected: true };
          });
          return result;
        }
        return {};
      }
      if (transport === 'nostr') {
        return getNostrRelaySockets() || {};
      }
      if (transport === 'torrent') {
        return getTorrentRelaySockets() || {};
      }
    } catch (err) {
      console.warn(`[SignalingManager] Error retrieving sockets for ${transport}:`, err);
    }
    return {};
  }

  /**
   * Computes relay connection statistics for the active or given transport.
   */
  public getRelayStatus(transport: SignalingTransport = this.activeTransport): {
    total: number;
    connected: number;
    ratio: number;
  } {
    const sockets = this.getRelaySockets(transport);
    const urls = Object.keys(sockets);
    const total = urls.length;
    let connected = 0;

    for (const url of urls) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const s: any = sockets[url];
      if (s) {
        // WebSocket.OPEN === 1, or client.connected === true
        if (s.readyState === 1 || s.connected === true) {
          connected++;
        }
      }
    }

    const defaultUrlsCount =
      transport === 'mqtt'
        ? Math.max(defaultMqttUrls.length, DEFAULT_MQTT_RELAY_URLS.length)
        : transport === 'nostr'
        ? defaultNostrUrls.length
        : defaultTorrentUrls.length;

    const effectiveTotal = Math.max(total, defaultUrlsCount);
    const ratio = effectiveTotal > 0 ? connected / effectiveTotal : 0;

    return {
      total: effectiveTotal,
      connected,
      ratio,
    };
  }

  public getDetailedStatus(): TransportStatusInfo {
    const relay = this.getRelayStatus(this.activeTransport);
    const last = this.failoverHistory[this.failoverHistory.length - 1];
    return {
      activeTransport: this.activeTransport,
      connectedRelays: relay.connected,
      totalRelays: relay.total,
      isFailingOver: this.isFailingOver,
      lastFailoverTime: last?.timestamp,
    };
  }

  public getStatus(): SignalingStatus {
    const relay = this.getRelayStatus(this.activeTransport);
    return {
      activeTransport: this.activeTransport,
      availableTransports: [...this.availableTransports],
      connectedPeers: Array.from(this.directConnectedPeers),
      latencyMs: relay.connected > 0 ? 25 : 999,
    };
  }

  /**
   * Creates a room instance on the active signaling transport.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public joinRoom(config: any, topic: string, callbacks?: any): any {
    this.lastRoomParams = { config, topic, callbacks };
    this.roomJoinedTimestamp = Date.now();
    this.consecutiveStalls = 0;

    console.log(`[SignalingManager] Joining room on transport "${this.activeTransport}" (topic: ${topic})`);

    let room: any = null;
    if (this.activeTransport === 'mqtt') {
      const mqttConfig = {
        ...config,
        relayConfig: {
          urls: DEFAULT_MQTT_RELAY_URLS,
          redundancy: DEFAULT_MQTT_RELAY_URLS.length,
        },
      };
      this.startMqttRelayMonitoring();
      room = joinMqttRoom(mqttConfig, topic, callbacks);
    } else if (this.activeTransport === 'nostr') {
      this.stopMqttRelayMonitoring();
      room = joinNostrRoom(config, topic, callbacks);
    } else if (this.activeTransport === 'torrent') {
      this.stopMqttRelayMonitoring();
      room = joinTorrentRoom(config, topic, callbacks);
    } else {
      this.startMqttRelayMonitoring();
      room = joinMqttRoom(config, topic, callbacks);
    }

    if (this.activeRoom) {
      const oldRoom = this.activeRoom;
      try {
        Promise.resolve(oldRoom.leave()).catch(() => {});
      } catch {}
    }
    this.activeRoom = room;
    this.startWatchdog();
    this.notifyStatusChange();
    return room;
  }

  /**
   * Leaves current room and terminates signaling connections.
   * If targetRoom is specified, only tears down if activeRoom matches it, preventing stale async leaves.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public async leaveRoom(targetRoom?: any): Promise<void> {
    if (targetRoom && this.activeRoom && this.activeRoom !== targetRoom) {
      console.log('[SignalingManager] Ignoring stale leaveRoom call for inactive room instance');
      try {
        await Promise.resolve(targetRoom.leave()).catch(() => {});
      } catch {}
      return;
    }

    this.stopWatchdog();
    this.stopMqttRelayMonitoring();
    if (this.activeRoom) {
      try {
        await this.activeRoom.leave();
      } catch (err) {
        console.warn('[SignalingManager] Error leaving active room:', err);
      }
      this.activeRoom = null;
    }
    this.lastRoomParams = null;
    this.directConnectedPeers.clear();
    this.consecutiveStalls = 0;
    this.notifyStatusChange();
  }

  /**
   * Proactively broadcasts an instant presence announcement on the active signaling transport.
   * If targetPeerId is provided, also dispatches directly to the peer's private topic.
   * Used by in-mesh bridging to force immediate WebRTC handshake between indirect pairs.
   */
  public async reannounce(topic: string, targetPeerId?: string): Promise<void> {
    if (this.activeTransport !== 'mqtt') return;
    try {
      const rootTopic = await computeTrysteroSha1(`Trystero@p2sharer-multi-stream-v1@${topic}`);
      const payload = JSON.stringify({ peerId: this.getSelfId() });

      this.monitoredMqttSockets.forEach((client) => {
        if (client && client.connected && typeof client.publish === 'function') {
          try {
            client.publish(rootTopic, payload);
          } catch {}
        }
      });

      if (targetPeerId) {
        const peerTopic = await computeTrysteroSha1(
          `Trystero@p2sharer-multi-stream-v1@${topic}@${targetPeerId}`
        );
        this.monitoredMqttSockets.forEach((client) => {
          if (client && client.connected && typeof client.publish === 'function') {
            try {
              client.publish(peerTopic, payload);
            } catch {}
          }
        });
      }
    } catch (err) {
      console.warn('[SignalingManager] Reannounce error:', err);
    }
  }

  /**
   * Advances to next transport in the failover chain:
   * MQTT -> Nostr -> Torrent -> MQTT
   */
  public recordWatchdogFailure(reason = 'relay_connectivity_loss'): SignalingTransport {
    const previousTransport = this.activeTransport;
    const currentIdx = this.availableTransports.indexOf(this.activeTransport);
    const nextIdx = (currentIdx + 1) % this.availableTransports.length;
    const nextTransport = this.availableTransports[nextIdx]!;

    const event: SignalingFailoverEvent = {
      from: previousTransport,
      to: nextTransport,
      reason,
      timestamp: Date.now(),
    };

    this.failoverHistory.push({
      from: previousTransport,
      to: nextTransport,
      timestamp: event.timestamp,
    });

    console.warn(
      `[SignalingManager] Signaling failover triggered: ${previousTransport} -> ${nextTransport} (Reason: ${reason})`
    );

    this.activeTransport = nextTransport;
    this.roomJoinedTimestamp = Date.now();
    this.consecutiveStalls = 0;

    this.failoverListeners.forEach((cb) => {
      try {
        cb(event);
      } catch (err) {
        console.error('[SignalingManager] Error in failover listener:', err);
      }
    });

    this.notifyStatusChange();

    // Trigger automatic reconnection if a room is active
    if (this.activeRoom && this.lastRoomParams && !this.isFailingOver) {
      this.executeRoomFailover(nextTransport, previousTransport);
    }

    return nextTransport;
  }

  private async executeRoomFailover(
    nextTransport: SignalingTransport,
    previousTransport: SignalingTransport
  ): Promise<void> {
    this.isFailingOver = true;
    try {
      if (this.reconnectHandler) {
        await this.reconnectHandler(nextTransport, previousTransport);
      }
    } catch (err) {
      console.error('[SignalingManager] Error in room reconnection handler during failover:', err);
    } finally {
      this.isFailingOver = false;
      this.notifyStatusChange();
    }
  }

  /**
   * Manually switches signaling transport.
   */
  public async switchTransport(transport: SignalingTransport): Promise<boolean> {
    if (!this.availableTransports.includes(transport) || transport === this.activeTransport) {
      return false;
    }

    const previousTransport = this.activeTransport;
    this.activeTransport = transport;
    this.consecutiveStalls = 0;

    this.failoverHistory.push({
      from: previousTransport,
      to: transport,
      timestamp: Date.now(),
    });

    this.notifyStatusChange();

    if (this.activeRoom && this.lastRoomParams) {
      await this.executeRoomFailover(transport, previousTransport);
    }

    return true;
  }

  public setPeerConnected(peerId: string): void {
    this.directConnectedPeers.add(peerId);
    this.notifyStatusChange();
  }

  public setPeerDisconnected(peerId: string): void {
    this.directConnectedPeers.delete(peerId);
    this.notifyStatusChange();
  }

  public startWatchdog(intervalMs = 1500): void {
    this.stopWatchdog();
    this.watchdogTimer = setInterval(() => {
      this.checkRelayHealth();
    }, intervalMs);
  }

  public stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  /**
   * Watchdog health check:
   * Inspects active relay sockets. If all relays are closed or unreachable for > 3.0s,
   * triggers transport failover.
   */
  public checkRelayHealth(): void {
    if (!this.activeRoom) return;

    // Allow 4.0s grace period after initial room join before diagnosing stall
    const now = Date.now();
    if (now - this.roomJoinedTimestamp < 4000) {
      return;
    }

    const relay = this.getRelayStatus(this.activeTransport);

    // If direct WebRTC peers are already active, room signaling may be idle but healthy
    if (this.directConnectedPeers.size > 0 && relay.connected > 0) {
      this.consecutiveStalls = 0;
      return;
    }

    if (relay.connected === 0) {
      this.consecutiveStalls++;
      console.warn(
        `[SignalingManager/Watchdog] 0 relays connected on ${this.activeTransport} (stall count: ${this.consecutiveStalls}/${this.maxConsecutiveStalls})`
      );

      if (this.consecutiveStalls >= this.maxConsecutiveStalls && !this.isFailingOver) {
        this.recordWatchdogFailure('all_relays_unreachable');
      }
    } else {
      this.consecutiveStalls = 0;
    }
  }

  public onStatusChange(callback: (status: SignalingStatus) => void): () => void {
    this.statusListeners.push(callback);
    return () => {
      const idx = this.statusListeners.indexOf(callback);
      if (idx !== -1) this.statusListeners.splice(idx, 1);
    };
  }

  public onFailover(callback: (event: SignalingFailoverEvent) => void): () => void {
    this.failoverListeners.push(callback);
    return () => {
      const idx = this.failoverListeners.indexOf(callback);
      if (idx !== -1) this.failoverListeners.splice(idx, 1);
    };
  }

  public notifyStatusChange(connectedPeers?: string[], latencyMs?: number): void {
    const status = this.getStatus();
    if (connectedPeers) {
      status.connectedPeers = connectedPeers;
    }
    if (latencyMs !== undefined) {
      status.latencyMs = latencyMs;
    }

    this.statusListeners.forEach((cb) => {
      try {
        cb(status);
      } catch (err) {
        console.error('[SignalingManager] Error in status callback:', err);
      }
    });
  }
}

export const signalingManager = new SignalingManager();
