import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { t } from '../i18n/index.ts';
import { listenTunnelPayloads, receiveTunnelPayload } from '../core/tunnel_payload_bridge.ts';
import type { RoomAppModel, RoomAppModelContext } from './models.ts';
import { createTunnelRules, isVirtualIp, validTunnelAdvertisements, validTunnelRule, type TunnelAdvertisement, type TunnelExport, type TunnelRule } from './tunnel_rules.ts';

export interface TunnelCounters { sent: number; received: number; sessions: number }
export interface TunnelForward { id: string; peer: string; tunnel: string; port: number; protocol: string }
interface Status { counters: Record<string, TunnelCounters>; forwards: TunnelForward[] }
interface NativeEvent { scope: string; peer: string; packet: { kind: string; session: string } }
interface NetworkEvent { scope?: string; peer?: string; data?: string; sequence?: number; ip?: string; error?: string }
export interface NetworkCounters { sent: number; received: number; dropped: number }
export interface TunnelNative {
  available: boolean;
  call<T>(command: string, args: Record<string, unknown>): Promise<T>;
  listen(handler: (event: NativeEvent) => void): Promise<() => void>;
  listenVirtual?(handler: (event: NetworkEvent) => void): Promise<() => void>;
  listenBinary?(scope: string, handler: (header: any, bytes: Uint8Array) => void): Promise<() => void>;
  receiveBinary?(scope: string, peer: string, payload: unknown): Promise<void>;
}
const native: TunnelNative = {
  available: isTauri(), call: (command, args) => invoke(command, args),
  listen: async (handler) => listen<NativeEvent>('port-tunnel-event', ({ payload }) => handler(payload)),
  listenVirtual: async (handler) => listen<NetworkEvent>('virtual-network-event', ({ payload }) => handler(payload)),
  listenBinary: listenTunnelPayloads, receiveBinary: receiveTunnelPayload,
};

/** Room state is owner-authored advertisements only; socket state stays on its device. */
export class TunnelModel implements RoomAppModel {
  rules: TunnelRule[] = [];
  active = new Map<string, TunnelExport>();
  remote = new Map<string, TunnelAdvertisement[]>();
  status: Status = { counters: {}, forwards: [] };
  error = '';
  busy = false;
  readonly available: boolean;
  ip = '';
  remoteIPs = new Map<string, string>();
  networkConnections = new Map<string, { peer: string; rule: TunnelAdvertisement }>();
  networkCounters: Record<string, NetworkCounters> = {};
  networkRunning = false;
  private members = new Set<string>();
  private revision = 0;
  private revisions = new Map<string, number>();
  private joined = false;
  private epoch = 0;
  private disposed = false;
  private removeListener?: () => void;
  private removeStorageListener?: () => void;
  private removeNetworkListener?: () => void;
  private removeBinaryListener?: () => void;
  private binaryReady: Promise<void>;
  private incomingWire = new Map<string, { pending: number; tail: Promise<unknown> }>();
  private incomingDatagrams = 0;
  private networkReady: Promise<void>;
  private networkPending = 0;
  private timer?: ReturnType<typeof setInterval>;
  private serial = Promise.resolve();
  private readonly store: ReturnType<typeof createTunnelRules> | null;
  private readonly scope: string;
  private listening: Promise<void>;
  private context: RoomAppModelContext;
  private bridge: TunnelNative;

  constructor(context: RoomAppModelContext, bridge: TunnelNative = native,
    storage: Pick<Storage, 'getItem' | 'setItem'> | null = typeof localStorage === 'undefined' ? null : localStorage) {
    this.context = context; this.bridge = bridge;
    this.scope = context.instanceId || crypto.randomUUID();
    this.available = bridge.available;
    this.binaryReady = bridge.available && bridge.listenBinary ? bridge.listenBinary(this.scope, (header, bytes) => {
      if (this.disposed) return;
      const allowed = this.joined && this.members.has(header.peer);
      if (header.type === 'wire' && allowed) {
        void this.context.send?.({ type: 'wire', packet: { ...header.packet,
          ...(['data', 'datagram'].includes(header.packet?.kind) ? { data: bytes } : {}) } }, header.peer).catch(() => {
          void this.bridge.call('receive_port_tunnel', { scope: this.scope, peer: header.peer,
            packet: { kind: 'close', session: header.packet?.session } }).catch(() => {});
        });
      } else if (header.type === 'virtual-packet' && Number.isSafeInteger(header.sequence)) {
        let failed = !allowed || !this.context.send || this.networkPending >= 32;
        if (failed) { void this.bridge.call('virtual_network_sent', { scope: this.scope, sequence: header.sequence, failed: true }).catch(() => {}); return; }
        this.networkPending++;
        void this.context.send!({ type: 'virtual-packet', data: bytes }, header.peer).catch(() => { failed = true; })
          .finally(() => { this.networkPending--; return this.bridge.call('virtual_network_sent', { scope: this.scope, sequence: header.sequence, failed }).catch(() => {}); });
      }
    }).then(remove => { if (this.disposed) remove(); else this.removeBinaryListener = remove; }) : Promise.resolve();
    void this.binaryReady.catch(error => { this.error = String(error); this.context.changed(); });
    this.store = storage ? createTunnelRules(storage) : null;
    try { this.rules = this.store?.list() ?? []; } catch (error) { this.error = String(error); }
    this.removeStorageListener = this.store?.subscribe(() => {
      if (this.disposed) return;
      try {
        const rules = this.store!.list();
        let revoked = false;
        for (const [id, active] of this.active) {
          const rule = rules.find((row) => row.id === id);
          if (!rule || rule.name !== active.name || rule.port !== active.port || rule.protocol !== active.protocol || rule.mode !== active.mode) {
            this.active.delete(id); revoked = true;
          }
        }
        this.rules = rules;
        if (revoked) void this.command(async () => { await this.configure(); this.revision++; this.advertise(); }).catch(() => {});
        this.context.changed();
      } catch (error) { this.error = String(error); this.context.changed(); }
    });
    this.listening = bridge.available ? bridge.listen((event) => {
      if (event.scope !== this.scope || !this.joined || this.disposed || !this.members.has(event.peer)) return;
      void this.context.send?.({ type: 'wire', packet: event.packet }, event.peer).catch(() => {
        if (!this.disposed) void this.bridge.call('receive_port_tunnel', {
          scope: this.scope, peer: event.peer, packet: { kind: 'close', session: event.packet.session },
        }).catch(() => {});
      });
    }).then((remove) => { if (this.disposed) remove(); else this.removeListener = remove; })
      .catch((error) => { this.error = String(error); this.context.changed(); throw error; }) : Promise.resolve();
    // Listener setup failures are displayed and block activation, without an unhandled rejection.
    void this.listening.catch(() => {});
    this.networkReady = bridge.available && bridge.listenVirtual ? Promise.all([
      bridge.call<{ ip: string }>('get_virtual_network_identity', {}).then((identity) => {
        if (!isVirtualIp(identity?.ip)) throw new Error('Invalid virtual IP');
        this.ip = identity.ip; if (!this.disposed) { this.context.changed(); this.revision++; this.advertise(); }
      }),
      bridge.listenVirtual((event) => {
        if (this.disposed) return;
        if (event.error) {
          for (const [id, rule] of this.active) if (rule.mode === 'virtual') this.active.delete(id);
          this.networkConnections.clear(); this.networkRunning = false; this.error = event.error;
          this.revision++; this.advertise(); this.context.changed(); return;
        }
        if (isVirtualIp(event.ip)) { this.ip = event.ip; this.revision++; this.advertise(); this.context.changed(); return; }
        if (event.scope !== this.scope || typeof event.peer !== 'string' || typeof event.data !== 'string' || !Number.isSafeInteger(event.sequence)) return;
        const sequence = event.sequence!;
        if (this.networkPending >= 32) { void this.bridge.call('virtual_network_sent', { scope: this.scope, sequence, failed: true }).catch(() => {}); return; }
        this.networkPending++;
        let failed = !this.joined || !this.members.has(event.peer) || !this.context.send;
        const sent = !failed ? this.context.send!({ type: 'virtual-packet', data: event.data }, event.peer) : Promise.resolve();
        void Promise.resolve(sent).catch(() => { failed = true; }).finally(() => { this.networkPending--; return this.bridge.call('virtual_network_sent', { scope: this.scope, sequence, failed }).catch(() => {}); });
      }).then((remove) => { if (this.disposed) remove(); else this.removeNetworkListener = remove; }),
    ]).then(() => {}).catch((error) => { this.error = String(error); this.context.changed(); throw error; }) : Promise.resolve();
    void this.networkReady.catch(() => {});
  }
  private command(operation: () => Promise<void>): Promise<void> {
    const next = this.serial.then(async () => {
      if (this.disposed) return;
      this.busy = true; this.error = ''; this.context.changed();
      try { await this.listening; await this.binaryReady; await operation(); }
      catch (error) { this.error = String(error); throw error; }
      finally { this.busy = false; this.context.changed(); }
    });
    this.serial = next.catch(() => {});
    return next;
  }
  prepareJoin(): Promise<void> {
    return this.command(async () => {
      if (!this.available) throw new Error(t('web.unsupported'));
      await this.networkReady;
      await this.bridge.call('prepare_virtual_network_app', { scope: this.scope });
      if (this.disposed) await this.bridge.call('stop_virtual_network_scope', { scope: this.scope });
    });
  }
  private advertise(target?: string): void {
    if (!this.joined || this.disposed) return;
    const payload = this.snapshot();
    if (target) void this.context.send?.(payload, target).catch(() => {});
    else this.context.emit(payload);
  }
  private async configure(): Promise<void> {
    if (!this.available) return;
    this.updateNetworkConnections();
    await this.bridge.call('configure_port_tunnels', { scope: this.scope,
      exports: this.joined ? [...this.active.values()].filter((row) => row.mode !== 'virtual') : [],
      peers: this.joined ? [...this.members].filter((id) => id !== this.context.localActor) : [] }).catch(async (error) => {
        this.active.clear();
        await this.bridge.call('stop_port_tunnels', { scope: this.scope }).catch(() => {});
        this.revision++; this.advertise();
        throw error;
      });
    if (this.bridge.listenVirtual) {
      try {
        await this.networkReady;
        const grant = (row: TunnelExport) => ({ id: row.id, port: row.port, protocol: row.protocol, generation: row.generation });
        await this.bridge.call('configure_virtual_network', { scope: this.scope, permissions: {
          own: this.joined ? [...this.active.values()].filter((row) => row.mode === 'virtual').map(grant) : [],
          peers: this.joined ? [...this.remoteIPs].filter(([peer]) => this.members.has(peer)).map(([id, ip]) => ({ id, ip,
            grants: [...this.networkConnections.values()].filter((c) => c.peer === id).map((c) => grant(c.rule)) })) : [],
        } });
      } catch (error) {
        for (const [id, rule] of this.active) if (rule.mode === 'virtual') this.active.delete(id);
        this.networkConnections.clear();
        await this.bridge.call('stop_virtual_network_scope', { scope: this.scope }).catch(() => {});
        this.revision++; this.advertise(); throw error;
      }
    }
  }
  private updateNetworkConnections(): void {
    this.networkConnections.clear();
    if (!this.joined) return;
    for (const [peer, rules] of this.remote) {
      if (!this.members.has(peer) || !this.remoteIPs.has(peer)) continue;
      for (const rule of rules) if (rule.enabled && rule.mode === 'virtual')
        this.networkConnections.set(this.networkKey(peer, rule.id), { peer, rule });
    }
  }
  private async reconcileRemoteProxies(): Promise<void> {
    if (!this.available || !this.joined) return;
    for (const forward of [...this.status.forwards]) {
      const rule = this.remote.get(forward.peer)?.find((row) => row.id === forward.tunnel);
      if (!rule?.enabled || rule.mode === 'virtual' || this.remoteGenerations.get(forward.id) !== rule.generation) {
        await this.bridge.call('disconnect_port_tunnel', { scope: this.scope, id: forward.id });
        this.remoteGenerations.delete(forward.id);
      }
    }
    await this.refresh();
    for (const [peer, rules] of this.remote) for (const rule of rules) {
      if (!rule.enabled || rule.mode === 'virtual' || this.disposed || !this.joined) continue;
      if (!this.status.forwards.some((f) => f.peer === peer && f.tunnel === rule.id))
        await this.connectForward(peer, rule.id, 0, this.epoch, false);
    }
  }
  setParticipants(participants: string[]): void {
    const previous = this.members;
    this.members = new Set(participants);
    const wasJoined = this.joined;
    this.joined = this.members.has(this.context.localActor);
    if (wasJoined !== this.joined) this.epoch++;
    for (const actor of this.remote.keys()) if (!this.members.has(actor)) {
      this.remote.delete(actor); this.revisions.delete(actor);
      this.remoteIPs.delete(actor);
      for (const [key, c] of this.networkConnections) if (c.peer === actor) this.networkConnections.delete(key);
    }
    if (wasJoined && !this.joined) {
      this.active.clear(); this.revision++; this.remote.clear(); this.revisions.clear();
      this.remoteIPs.clear(); this.networkConnections.clear(); this.networkCounters = {};
      this.status = { counters: {}, forwards: [] };
      clearInterval(this.timer); this.timer = undefined;
    }
    void this.command(async () => {
      await this.configure();
      await this.reconcileRemoteProxies();
      if (this.joined) {
        for (const actor of this.members) if (actor !== this.context.localActor && (!previous.has(actor) || !wasJoined)) this.advertise(actor);
        if (!this.timer && this.available) this.timer = setInterval(() => { void this.refresh().catch(() => {}); }, 1000);
      }
      await this.refresh();
    }).catch(() => {});
    this.context.changed();
  }
  save(rule: TunnelRule): Promise<void> {
    return this.command(async () => {
      if (!validTunnelRule(rule)) throw new Error('Invalid tunnel configuration');
      const rows = [...(this.store?.list() ?? this.rules).filter((row) => row.id !== rule.id), rule];
      this.store?.write(rows);
      this.rules = rows;
      this.active.delete(rule.id); // Editing always revokes the old permission first.
      await this.configure(); this.revision++; this.advertise();
    });
  }
  delete(id: string): Promise<void> {
    return this.command(async () => {
      const rows = (this.store?.list() ?? this.rules).filter((row) => row.id !== id);
      this.store?.write(rows); this.rules = rows; this.active.delete(id);
      await this.configure(); this.revision++; this.advertise();
    });
  }
  toggle(id: string, enabled: boolean): Promise<void> {
    const epoch = this.epoch;
    return this.command(async () => {
      if (!this.available || !this.joined || epoch !== this.epoch) throw new Error('Tunnel participant unavailable');
      const rule = this.rules.find((row) => row.id === id);
      if (!rule) throw new Error('Tunnel no longer exists');
      if (rule.mode === 'virtual' && !this.bridge.listenVirtual) throw new Error('Virtual networking requires Windows x64');
      if (enabled) this.active.set(id, { ...rule, generation: crypto.randomUUID() });
      else this.active.delete(id);
      await this.configure();
      this.revision++; this.advertise(); await this.refresh();
    });
  }
  connect(peer: string, id: string, port: number): Promise<void> {
    const epoch = this.epoch;
    return this.command(() => this.connectForward(peer, id, port, epoch));
  }
  private async connectForward(peer: string, id: string, port: number, epoch: number, persist = true): Promise<void> {
      const item = this.remote.get(peer)?.find((row) => row.id === id);
      if (!this.joined || epoch !== this.epoch || !this.members.has(peer) || !item?.enabled || !Number.isInteger(port) || port < 0 || port > 65535)
        throw new Error('Tunnel participant unavailable');
      if (this.status.forwards.some((f) => f.peer === peer && f.tunnel === id)) throw new Error('Tunnel already connected');
      const { enabled: _enabled, ...exportRule } = item;
      const forward = await this.bridge.call<TunnelForward>('connect_port_tunnel', { scope: this.scope, peer, export: exportRule, port });
      this.remoteGenerations.set(forward.id, item.generation);
      // A revocation/disconnect may arrive while the socket bind is pending.
      const current = this.remote.get(peer)?.find((row) => row.id === id);
      if (!this.joined || epoch !== this.epoch || !current?.enabled || current.generation !== item.generation) {
        await this.bridge.call('disconnect_port_tunnel', { scope: this.scope, id: forward.id });
        throw new Error('Tunnel participant unavailable');
      }
      try { if (persist) this.store?.saveLocalPort(id, port); }
      catch (error) {
        await this.bridge.call('disconnect_port_tunnel', { scope: this.scope, id: forward.id });
        throw error;
      }
      await this.refresh();
  }
  disconnect(id: string): Promise<void> {
    return this.command(async () => { await this.bridge.call('disconnect_port_tunnel', { scope: this.scope, id }); this.remoteGenerations.delete(id); await this.refresh(); });
  }
  networkKey(peer: string, id: string): string { return `${peer}:${id}`; }
  regenerateIP(): Promise<void> {
    return this.command(async () => {
      await this.networkReady;
      const identity = await this.bridge.call<{ ip: string }>('regenerate_virtual_network_ip', {});
      if (!isVirtualIp(identity?.ip)) throw new Error('Invalid virtual IP');
      this.ip = identity.ip; this.revision++; this.advertise();
    });
  }
  async refresh(): Promise<void> {
    if (this.disposed || !this.available || !this.joined) return;
    const result = await this.bridge.call<Status>('get_port_tunnel_status', { scope: this.scope });
    if (this.disposed || !this.joined) return;
    this.status = result; this.context.changed();
    if (this.bridge.listenVirtual) {
      const network = await this.bridge.call<{ ip: string; running: boolean; active: boolean; counters: Record<string, NetworkCounters> }>('get_virtual_network_status', { scope: this.scope });
      if (this.disposed || !this.joined) return;
      this.networkRunning = network.running; this.networkCounters = network.counters;
      if (!network.active && (this.networkConnections.size || [...this.active.values()].some((r) => r.mode === 'virtual'))) {
        this.networkConnections.clear();
        for (const [id, rule] of this.active) if (rule.mode === 'virtual') this.active.delete(id);
        this.revision++; this.advertise();
      }
      this.context.changed();
    }
  }
  localPort(id: string, fallback: number): number { return this.store?.localPort(id, fallback) ?? fallback; }
  snapshot(): unknown {
    return { type: 'advertise', revision: this.revision, ...(this.ip ? { ip: this.ip } : {}), exports: this.joined ? this.rules.map((rule) => ({ ...rule,
      enabled: this.active.has(rule.id), generation: this.active.get(rule.id)?.generation ?? '00000000-0000-0000-0000-000000000000' })) : [] };
  }
  apply(payload: unknown, actor: string, fromSnapshot: boolean): void {
    if (this.disposed || !this.joined || actor === this.context.localActor || !this.members.has(actor) || !payload || typeof payload !== 'object') return;
    const data = payload as { type?: string; revision?: number; exports?: unknown; packet?: unknown; ip?: unknown; data?: unknown };
    if (data.type === 'advertise' && Number.isSafeInteger(data.revision) && data.revision! >= 0 && validTunnelAdvertisements(data.exports)) {
      if (data.revision! < (this.revisions.get(actor) ?? -1)) return;
      this.revisions.set(actor, data.revision!);
      const previousRules = this.remote.get(actor);
      this.remote.set(actor, data.exports);
      const previousIP = this.remoteIPs.get(actor);
      if (isVirtualIp(data.ip)) this.remoteIPs.set(actor, data.ip); else this.remoteIPs.delete(actor);
      this.updateNetworkConnections();
      if (previousIP !== this.remoteIPs.get(actor) || JSON.stringify(previousRules) !== JSON.stringify(data.exports))
        void this.command(async () => { await this.configure(); await this.reconcileRemoteProxies(); await this.refresh(); }).catch(() => {});
      this.context.changed();
    } else if (!fromSnapshot && data.type === 'virtual-packet' && this.available && this.bridge.listenVirtual) {
      if (data.data instanceof Uint8Array && data.data.length <= 1280 && this.bridge.receiveBinary) {
        this.receiveDatagram(actor, data); return;
      }
      if (typeof data.data !== 'string' || data.data.length > 1708) return;
      void this.bridge.call('receive_virtual_network_packet', { scope: this.scope, peer: actor, data: data.data }).catch(() => {});
    } else if (!fromSnapshot && data.type === 'wire' && this.available && data.packet && typeof data.packet === 'object') {
      const packet = data.packet as { kind?: string; data?: unknown };
      if (this.bridge.receiveBinary && ['open', 'ready', 'data', 'datagram', 'ack', 'end', 'close'].includes(packet.kind || '') &&
        (!['data', 'datagram'].includes(packet.kind || '') || (packet.data instanceof Uint8Array && packet.data.length <= 65507))) {
        if (packet.kind === 'datagram') {
          this.receiveDatagram(actor, data);
        } else {
          const entry = this.incomingWire.get(actor) ?? { pending: 0, tail: Promise.resolve() };
          if (entry.pending >= 1024) return;
          this.incomingWire.set(actor, entry); entry.pending++;
          const epoch = this.epoch;
          entry.tail = entry.tail.then(async () => {
            if (this.disposed || !this.joined || this.epoch !== epoch || !this.members.has(actor)) return;
            await this.bridge.receiveBinary!(this.scope, actor, data);
          }).catch(() => {}).finally(() => { if (--entry.pending === 0 && this.incomingWire.get(actor) === entry) this.incomingWire.delete(actor); });
        }
        return;
      }
      if (!['open', 'ready', 'data', 'datagram', 'ack', 'end', 'close'].includes(packet.kind || '') ||
        (['data', 'datagram'].includes(packet.kind || '') && (typeof packet.data !== 'string' || packet.data.length > 87_344))) return;
      void this.bridge.call('receive_port_tunnel', { scope: this.scope, peer: actor, packet: data.packet }).catch(() => {});
    }
  }
  private remoteGenerations = new Map<string, string>();
  private receiveDatagram(actor: string, payload: unknown): void {
    if (!this.bridge.receiveBinary || this.incomingDatagrams >= 32) return;
    this.incomingDatagrams++;
    void this.bridge.receiveBinary(this.scope, actor, payload).catch(() => {})
      .finally(() => { this.incomingDatagrams--; });
  }
  destroy(): void {
    this.disposed = true; this.joined = false; this.active.clear(); clearInterval(this.timer); this.removeListener?.(); this.removeStorageListener?.(); this.removeNetworkListener?.(); this.removeBinaryListener?.();
    if (this.available && this.bridge.listenVirtual) void this.bridge.call('stop_virtual_network_scope', { scope: this.scope }).catch(() => {});
    // Finish any pending bind/configure before removing the scope, preventing late task resurrection.
    void this.serial.finally(async () => {
      if (this.available) await this.bridge.call('stop_port_tunnels', { scope: this.scope }).catch(() => {});
      if (this.available && this.bridge.listenVirtual) await this.bridge.call('stop_virtual_network_scope', { scope: this.scope }).catch(() => {});
    });
  }
}
