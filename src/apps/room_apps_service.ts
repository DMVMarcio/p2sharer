import { getRoomApp, isRoomAppKind } from './registry.ts';
import type { RoomAppModel } from './models.ts';
import type { AppWireEvent, RoomAppInstance } from './types.ts';

type Sender = (event: AppWireEvent, target?: string) => void;
type Listener = () => void;
type LifecycleListener = (action: 'start' | 'stop', instance: RoomAppInstance) => void;
const MAX_INSTANCES = 24;

function validInstance(value: unknown): value is RoomAppInstance {
  if (!value || typeof value !== 'object') return false;
  const item = value as RoomAppInstance;
  return typeof item.id === 'string' && /^[a-f0-9-]{36}$/.test(item.id) &&
    isRoomAppKind(item.kind) && typeof item.createdBy === 'string' && item.createdBy.length <= 100 &&
    Number.isFinite(item.createdAt);
}

export class RoomAppsService {
  private instances = new Map<string, RoomAppInstance>();
  private models = new Map<string, RoomAppModel>();
  private participants = new Map<string, Set<string>>();
  private closed = new Set<string>();
  private listeners = new Set<Listener>();
  private sender: Sender | null = null;
  private onLocalLifecycle: LifecycleListener | null = null;
  private localActor = '';

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private notify(): void { this.listeners.forEach((listener) => listener()); }
  getInstances(): RoomAppInstance[] { return [...this.instances.values()].sort((a, b) => a.createdAt - b.createdAt); }
  getInstance(id: string): RoomAppInstance | undefined { return this.instances.get(id); }
  getModel<T extends RoomAppModel>(id: string): T | undefined { return this.models.get(id) as T | undefined; }
  getLocalActor(): string { return this.localActor; }
  getParticipants(id: string): string[] { return [...(this.participants.get(id) || [])]; }
  isJoined(id: string): boolean { return Boolean(this.localActor && this.participants.get(id)?.has(this.localActor)); }

  join(id: string): void {
    if (!this.sender || !this.instances.has(id) || this.isJoined(id)) return;
    this.setPresence(id, this.localActor, true);
    this.sender({ kind: 'presence', id, joined: true });
  }

  leave(id: string): void {
    if (!this.sender || !this.isJoined(id)) return;
    this.setPresence(id, this.localActor, false);
    this.sender({ kind: 'presence', id, joined: false });
  }

  forgetPeer(actor: string): void {
    for (const id of this.participants.keys()) this.setPresence(id, actor, false);
  }

  private setPresence(id: string, actor: string, joined: boolean): void {
    if (!this.instances.has(id) || !actor || actor.length > 100) return;
    const members = this.participants.get(id) || new Set<string>();
    if (joined) members.add(actor);
    else members.delete(actor);
    this.participants.set(id, members);
    this.notify();
  }

  attach(sender: Sender, localActor: string, onLocalLifecycle?: LifecycleListener): void {
    this.reset();
    this.sender = sender;
    this.localActor = localActor;
    this.onLocalLifecycle = onLocalLifecycle || null;
  }

  reset(): void {
    this.sender = null;
    this.onLocalLifecycle = null;
    this.instances.clear();
    this.participants.clear();
    this.closed.clear();
    this.models.forEach((model) => model.destroy());
    this.models.clear();
    this.notify();
  }

  start(kind: string): string {
    if (!this.sender || !getRoomApp(kind) || this.instances.size >= MAX_INSTANCES)
      throw new Error('App indisponível ou limite da sala atingido');
    const instance: RoomAppInstance = { id: crypto.randomUUID(), kind,
      createdBy: this.localActor, createdAt: Date.now() };
    this.addInstance(instance);
    this.sender({ kind: 'start', instance });
    this.onLocalLifecycle?.('start', instance);
    return instance.id;
  }

  stop(id: string): void {
    const instance = this.instances.get(id);
    if (!instance || !this.sender) return;
    this.removeInstance(id);
    this.sender({ kind: 'stop', id });
    this.onLocalLifecycle?.('stop', instance);
  }

  private addInstance(instance: RoomAppInstance): void {
    if (this.closed.has(instance.id) || this.instances.has(instance.id) || this.instances.size >= MAX_INSTANCES) return;
    const definition = getRoomApp(instance.kind);
    if (!definition) return;
    const model = definition.createModel({
      localActor: this.localActor,
      emit: (payload) => this.sender?.({ kind: 'data', id: instance.id, payload }),
      changed: () => this.notify(),
    });
    this.instances.set(instance.id, instance);
    this.models.set(instance.id, model);
    this.notify();
  }

  private removeInstance(id: string): void {
    this.closed.add(id);
    this.instances.delete(id);
    this.participants.delete(id);
    this.models.get(id)?.destroy();
    this.models.delete(id);
    this.notify();
  }

  requestSync(): void { this.sender?.({ kind: 'sync-request' }); }
  sendSync(target: string): void {
    if (!this.sender) return;
    this.sender({ kind: 'sync', instances: this.getInstances(), snapshots: {},
      closed: [...this.closed].slice(-100) }, target);
    for (const [id, model] of this.models) {
      const instance = this.instances.get(id);
      if (instance) this.sender({ kind: 'sync', instances: [instance],
        snapshots: { [id]: model.snapshot() }, closed: [] }, target);
    }
    for (const id of this.instances.keys()) if (this.isJoined(id))
      this.sender({ kind: 'presence', id, joined: true }, target);
  }

  receive(event: unknown, actor: string): void {
    if (!event || typeof event !== 'object' || !this.sender) return;
    const data = event as AppWireEvent;
    if (data.kind === 'sync-request') { this.sendSync(actor); return; }
    if (data.kind === 'start') {
      if (validInstance(data.instance) && data.instance.createdBy === actor) this.addInstance(data.instance);
      return;
    }
    if (data.kind === 'stop') {
      if (typeof data.id === 'string' && this.instances.has(data.id)) this.removeInstance(data.id);
      return;
    }
    if (data.kind === 'data') {
      if (typeof data.id === 'string') {
        try { this.models.get(data.id)?.apply(data.payload, actor, false); }
        catch (error) { console.warn('[Apps] Invalid app update:', error); }
      }
      return;
    }
    if (data.kind === 'presence') {
      if (typeof data.id === 'string' && typeof data.joined === 'boolean')
        this.setPresence(data.id, actor, data.joined);
      return;
    }
    if (data.kind === 'sync' && Array.isArray(data.instances) && data.instances.length <= MAX_INSTANCES &&
      Array.isArray(data.closed) && data.closed.length <= 100 && data.snapshots &&
      typeof data.snapshots === 'object') {
      for (const id of data.closed) if (typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id)) this.removeInstance(id);
      for (const instance of data.instances) if (validInstance(instance)) this.addInstance(instance);
      for (const [id, payload] of Object.entries(data.snapshots)) {
        try { this.models.get(id)?.apply(payload, actor, true); }
        catch (error) { console.warn('[Apps] Invalid app snapshot:', error); }
      }
    }
  }
}

export const roomAppsService = new RoomAppsService();
