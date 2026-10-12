import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { RoomAppModel, RoomAppModelContext } from './models.ts';
import { createTunnelRules, validTunnelAdvertisements, validTunnelRule, type TunnelAdvertisement, type TunnelExport, type TunnelRule } from './tunnel_rules.ts';

export interface TunnelCounters { sent: number; received: number; sessions: number }
export interface TunnelForward { id: string; peer: string; tunnel: string; port: number; protocol: string }
interface Status { counters: Record<string, TunnelCounters>; forwards: TunnelForward[] }
interface NativeEvent { scope: string; peer: string; packet: { kind: string; session: string } }
export interface TunnelNative {
  available: boolean;
  call<T>(command: string, args: Record<string, unknown>): Promise<T>;
  listen(handler: (event: NativeEvent) => void): Promise<() => void>;
}
const native: TunnelNative = {
  available: isTauri(), call: (command, args) => invoke(command, args),
  listen: async (handler) => listen<NativeEvent>('port-tunnel-event', ({ payload }) => handler(payload)),
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
  private members = new Set<string>();
  private revision = 0;
  private revisions = new Map<string, number>();
  private joined = false;
  private epoch = 0;
  private disposed = false;
  private removeListener?: () => void;
  private removeStorageListener?: () => void;
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
    this.store = storage ? createTunnelRules(storage) : null;
    try { this.rules = this.store?.list() ?? []; } catch (error) { this.error = String(error); }
    this.removeStorageListener = this.store?.subscribe(() => {
      if (this.disposed) return;
      try {
        const rules = this.store!.list();
        let revoked = false;
        for (const [id, active] of this.active) {
          const rule = rules.find((row) => row.id === id);
          if (!rule || rule.name !== active.name || rule.port !== active.port || rule.protocol !== active.protocol) {
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
  }
  private command(operation: () => Promise<void>): Promise<void> {
    const next = this.serial.then(async () => {
      if (this.disposed) return;
      this.busy = true; this.error = ''; this.context.changed();
      try { await this.listening; await operation(); }
      catch (error) { this.error = String(error); throw error; }
      finally { this.busy = false; this.context.changed(); }
    });
    this.serial = next.catch(() => {});
    return next;
  }
  private advertise(target?: string): void {
    if (!this.joined || this.disposed) return;
    const payload = this.snapshot();
    if (target) void this.context.send?.(payload, target).catch(() => {});
    else this.context.emit(payload);
  }
  private async configure(): Promise<void> {
    if (!this.available) return;
    await this.bridge.call('configure_port_tunnels', { scope: this.scope,
      exports: this.joined ? [...this.active.values()] : [],
      peers: this.joined ? [...this.members].filter((id) => id !== this.context.localActor) : [] }).catch(async (error) => {
        this.active.clear();
        await this.bridge.call('stop_port_tunnels', { scope: this.scope }).catch(() => {});
        this.revision++; this.advertise();
        throw error;
      });
  }
  setParticipants(participants: string[]): void {
    const previous = this.members;
    this.members = new Set(participants);
    const wasJoined = this.joined;
    this.joined = this.members.has(this.context.localActor);
    if (wasJoined !== this.joined) this.epoch++;
    for (const actor of this.remote.keys()) if (!this.members.has(actor)) {
      this.remote.delete(actor); this.revisions.delete(actor);
    }
    if (wasJoined && !this.joined) {
      this.active.clear(); this.revision++; this.remote.clear(); this.revisions.clear();
      this.status = { counters: {}, forwards: [] };
      clearInterval(this.timer); this.timer = undefined;
    }
    void this.command(async () => {
      await this.configure();
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
      if (enabled) this.active.set(id, { ...rule, generation: crypto.randomUUID() });
      else this.active.delete(id);
      await this.configure();
      this.revision++; this.advertise(); await this.refresh();
    });
  }
  connect(peer: string, id: string, port: number): Promise<void> {
    const epoch = this.epoch;
    return this.command(async () => {
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
      try { this.store?.saveLocalPort(id, port); }
      catch (error) {
        await this.bridge.call('disconnect_port_tunnel', { scope: this.scope, id: forward.id });
        throw error;
      }
      await this.refresh();
    });
  }
  disconnect(id: string): Promise<void> {
    return this.command(async () => { await this.bridge.call('disconnect_port_tunnel', { scope: this.scope, id }); this.remoteGenerations.delete(id); await this.refresh(); });
  }
  async refresh(): Promise<void> {
    if (this.disposed || !this.available || !this.joined) return;
    const result = await this.bridge.call<Status>('get_port_tunnel_status', { scope: this.scope });
    if (this.disposed || !this.joined) return;
    this.status = result; this.context.changed();
  }
  localPort(id: string, fallback: number): number { return this.store?.localPort(id, fallback) ?? fallback; }
  snapshot(): unknown {
    return { type: 'advertise', revision: this.revision, exports: this.joined ? this.rules.map((rule) => ({ ...rule,
      enabled: this.active.has(rule.id), generation: this.active.get(rule.id)?.generation ?? '00000000-0000-0000-0000-000000000000' })) : [] };
  }
  apply(payload: unknown, actor: string, fromSnapshot: boolean): void {
    if (this.disposed || !this.joined || actor === this.context.localActor || !this.members.has(actor) || !payload || typeof payload !== 'object') return;
    const data = payload as { type?: string; revision?: number; exports?: unknown; packet?: unknown };
    if (data.type === 'advertise' && Number.isSafeInteger(data.revision) && data.revision! >= 0 && validTunnelAdvertisements(data.exports)) {
      if (data.revision! < (this.revisions.get(actor) ?? -1)) return;
      this.revisions.set(actor, data.revision!);
      this.remote.set(actor, data.exports);
      for (const forward of this.status.forwards) if (forward.peer === actor) {
        const previous = this.remoteGenerations.get(forward.id);
        const item = data.exports.find((row) => row.id === forward.tunnel);
        if (!item?.enabled || (previous !== undefined && previous !== item.generation))
          void this.disconnect(forward.id).catch(() => {});
      }
      for (const forward of this.status.forwards) if (forward.peer === actor) {
        const item = data.exports.find((row) => row.id === forward.tunnel);
        if (item) this.remoteGenerations.set(forward.id, item.generation);
      }
      this.context.changed();
    } else if (!fromSnapshot && data.type === 'wire' && this.available && data.packet && typeof data.packet === 'object') {
      const packet = data.packet as { kind?: string; data?: unknown };
      if (!['open', 'ready', 'data', 'ack', 'end', 'close'].includes(packet.kind || '') ||
        (packet.kind === 'data' && (typeof packet.data !== 'string' || packet.data.length > 87_344))) return;
      void this.bridge.call('receive_port_tunnel', { scope: this.scope, peer: actor, packet: data.packet }).catch(() => {});
    }
  }
  private remoteGenerations = new Map<string, string>();
  destroy(): void {
    this.disposed = true; this.joined = false; this.active.clear(); clearInterval(this.timer); this.removeListener?.(); this.removeStorageListener?.();
    // Finish any pending bind/configure before removing the scope, preventing late task resurrection.
    void this.serial.finally(async () => {
      if (this.available) await this.bridge.call('stop_port_tunnels', { scope: this.scope }).catch(() => {});
    });
  }
}
