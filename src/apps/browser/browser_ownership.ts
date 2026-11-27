interface Ownership { host: string; term: string; version: number }
const token = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);

/** The smallest joined actor serializes start requests; the accepted requester hosts the browser. */
export class BrowserOwnership {
  host = ''; term = ''; version = 0;
  private members = new Set<string>();
  private transferPeer = '';
  private deferred: { packet: unknown; actor: string }[] = [];
  private pending?: { id: string; version: number; resolve(value: boolean): void; timer: ReturnType<typeof setTimeout> };
  private actor: string;
  private send: (packet: unknown, peer: string) => Promise<void>;
  private changed: (previous: string, next: string) => void;
  constructor(actor: string, send: (packet: unknown, peer: string) => Promise<void>, changed: (previous: string, next: string) => void) {
    this.actor = actor; this.send = send; this.changed = changed;
  }
  get coordinator(): string { return [...this.members].sort()[0] ?? ''; }
  snapshot(): Ownership { return { host: this.host, term: this.term, version: this.version }; }
  private publish(peer?: string): void {
    const packet = { type: 'ownership', ...this.snapshot() };
    for (const target of peer ? [peer] : this.members) if (target !== this.actor) void this.send(packet, target).catch(() => {});
  }
  private adopt(value: Ownership): void {
    const previous = this.host; const different = previous !== value.host || this.term !== value.term;
    this.host = value.host; this.term = value.term; this.version = value.version;
    if (different) this.changed(previous, this.host);
    if (this.pending && (this.host || this.version > this.pending.version || !this.members.has(this.actor))) {
      clearTimeout(this.pending.timer);
      const pending = this.pending; this.pending = undefined;
      pending.resolve(this.host === this.actor && this.term === pending.id);
    }
  }
  updateMembers(members: string[]): void {
    const oldCoordinator = this.coordinator; this.members = new Set(members);
    if (!this.members.has(this.actor)) { this.cancel(); return; }
    if (this.coordinator === this.actor) {
      if (this.transferPeer && this.members.has(this.transferPeer) && oldCoordinator === this.actor) return;
      if (oldCoordinator && oldCoordinator !== this.actor && this.members.has(oldCoordinator)) {
        this.transferPeer = oldCoordinator;
        void this.send({ type: 'ownership-transfer-request' }, oldCoordinator).catch(() => {});
        return;
      }
      this.transferPeer = '';
      if (this.host && !this.members.has(this.host)) this.adopt({ host: '', term: '', version: this.version + 1 });
      if (oldCoordinator !== this.coordinator) this.version++;
      this.publish();
    } else {
      if (oldCoordinator === this.actor) void this.send({ type: 'ownership-transfer', ...this.snapshot() }, this.coordinator).catch(() => {});
      void this.send({ type: 'ownership-sync' }, this.coordinator).catch(() => {});
    }
  }
  request(): Promise<boolean> {
    if (this.host || this.pending || !this.members.has(this.actor)) return Promise.resolve(false);
    const id = crypto.randomUUID();
    return new Promise(resolve => {
      this.pending = { id, version: this.version, resolve, timer: setTimeout(() => this.cancel(), 8000) };
      const packet = { type: 'host-request', id, version: this.version };
      if (this.coordinator === this.actor) this.handle(packet, this.actor, false);
      else void this.send(packet, this.coordinator).catch(() => this.cancel());
    });
  }
  release(): Promise<void> {
    if (this.host !== this.actor || !this.members.has(this.actor)) return Promise.resolve();
    const packet = { type: 'host-release', term: this.term };
    if (this.coordinator === this.actor) { this.handle(packet, this.actor, false); return Promise.resolve(); }
    return this.send(packet, this.coordinator);
  }
  handle(value: unknown, actor: string, snapshot: boolean): boolean {
    if (!value || typeof value !== 'object') return false;
    const packet = value as Record<string, unknown>;
    if (!['ownership', 'ownership-sync', 'host-request', 'host-release', 'ownership-transfer-request', 'ownership-transfer'].includes(String(packet.type))) return false;
    if (!this.members.has(actor)) return true;
    if (!snapshot && packet.type === 'ownership-transfer-request' && actor === this.coordinator) {
      void this.send({ type: 'ownership-transfer', ...this.snapshot() }, actor).catch(() => {}); return true;
    }
    if (!snapshot && packet.type === 'ownership-transfer' && actor === this.transferPeer && this.coordinator === this.actor) {
      if (!Number.isSafeInteger(packet.version) || Number(packet.version) < this.version || typeof packet.host !== 'string'
        || typeof packet.term !== 'string' || (packet.host ? !token(packet.term) : packet.term !== '')) return true;
      this.transferPeer = '';
      const live = this.members.has(packet.host);
      this.adopt({ host: live ? packet.host : '', term: live ? packet.term : '', version: Number(packet.version) + 1 });
      this.publish(); const deferred = this.deferred.splice(0);
      for (const request of deferred) this.handle(request.packet, request.actor, false);
      return true;
    }
    if (packet.type === 'ownership') {
      if (actor !== this.coordinator || !Number.isSafeInteger(packet.version) || Number(packet.version) < this.version
        || typeof packet.host !== 'string' || typeof packet.term !== 'string'
        || (packet.host ? !this.members.has(packet.host) || !token(packet.term) : packet.term !== '')
        || Number(packet.version) === this.version && (this.host !== packet.host || this.term !== packet.term)) return true;
      this.adopt({ host: packet.host, term: packet.term, version: Number(packet.version) });
    } else if (!snapshot && this.coordinator === this.actor) {
      if (this.transferPeer) { if (this.deferred.length < 32) this.deferred.push({ packet, actor }); return true; }
      if (packet.type === 'ownership-sync') this.publish(actor);
      if (packet.type === 'host-request' && token(packet.id)) {
        if (!this.host && packet.version === this.version) this.adopt({ host: actor, term: packet.id, version: this.version + 1 });
        this.publish();
      }
      if (packet.type === 'host-release' && actor === this.host && packet.term === this.term) {
        this.adopt({ host: '', term: '', version: this.version + 1 }); this.publish();
      }
    }
    return true;
  }
  cancel(): void {
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.resolve(false); this.pending = undefined; }
  }
}
