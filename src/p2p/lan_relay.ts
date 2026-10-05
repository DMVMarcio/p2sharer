import type { LanRoomConnection } from '../core/lan_room.ts';

export type LanSignalEvent = { kind: 'closed' } | { kind: 'message'; topic: string; data: string };
export interface LanSignalDriver {
  listen(id: string, receive: (event: LanSignalEvent) => void): Promise<() => void>;
  connect(id: string, room: string, connection: LanRoomConnection): Promise<void>;
  send(id: string, frame: string): Promise<void>;
  disconnect(id: string): Promise<void>;
}

/** Recover rendezvous independently of live WebRTC channels. */
export class LanRelay {
  connected = false;
  private stopped = false;
  private unlisten?: () => void;
  private retry?: ReturnType<typeof setTimeout>;
  private opening?: Promise<void>;
  private writes: Promise<void> = Promise.resolve();
  private topics = new Map<string, (topic: string, data: string) => void | Promise<void>>();
  readonly id = Array.from(crypto.getRandomValues(new Uint8Array(16)),
    (byte) => byte.toString(16).padStart(2, '0')).join('');
  private driver: LanSignalDriver;
  readonly connection: LanRoomConnection;
  readonly room: string;
  private status: (connected: boolean) => void;
  private retryMs: number;

  constructor(driver: LanSignalDriver, connection: LanRoomConnection,
    room: string, status: (connected: boolean) => void, retryMs = 2000) {
    this.driver = driver;
    this.connection = connection;
    this.room = room;
    this.status = status;
    this.retryMs = retryMs;
  }

  async start(): Promise<void> {
    this.unlisten = await this.driver.listen(this.id, (event) => {
      if (this.stopped) return;
      if (event.kind === 'closed') {
        this.connected = false;
        this.status(false);
        this.scheduleReconnect();
      } else if (event.kind === 'message' && typeof event.topic === 'string' &&
          typeof event.data === 'string' && event.data.length <= 65536) {
        const receive = this.topics.get(event.topic);
        if (receive) void Promise.resolve().then(() => receive(event.topic, event.data))
          .catch(() => console.warn('[LAN] Could not process a signaling message'));
      }
    });
    if (this.stopped) { this.unlisten(); return; }
    await this.open();
  }

  private open(): Promise<void> {
    return this.opening ??= (async () => {
      await this.driver.disconnect(this.id);
      if (this.stopped) return;
      await this.driver.connect(this.id, this.room, this.connection);
      if (this.stopped) { await this.driver.disconnect(this.id); return; }
      this.connected = true;
      for (const topic of this.topics.keys()) await this.send({ kind: 'subscribe', topic });
      this.status(true);
    })().finally(() => { this.opening = undefined; });
  }

  private scheduleReconnect(): void {
    if (this.retry || this.stopped) return;
    this.retry = setTimeout(() => {
      this.retry = undefined;
      if (!this.stopped) void this.open().catch(() => {
        this.connected = false;
        this.status(false);
        this.scheduleReconnect();
      });
    }, this.retryMs);
  }

  private send(frame: object): Promise<void> {
    const operation = this.writes.catch(() => {}).then(async () => {
      if (!this.stopped && this.connected) await this.driver.send(this.id, JSON.stringify(frame));
    });
    this.writes = operation;
    return operation;
  }

  async subscribe(topic: string, receive: (topic: string, data: string) => void | Promise<void>): Promise<() => void> {
    if (this.stopped) return () => {};
    this.topics.set(topic, receive);
    await this.send({ kind: 'subscribe', topic });
    return () => {
      if (this.topics.get(topic) !== receive) return;
      this.topics.delete(topic);
      void this.send({ kind: 'unsubscribe', topic }).catch(() => {});
    };
  }

  publish(topic: string, data: string): Promise<void> {
    return this.send({ kind: 'publish', topic, data });
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.connected = false;
    if (this.retry) clearTimeout(this.retry);
    this.unlisten?.();
    this.topics.clear();
    await this.opening?.catch(() => {});
    await this.writes.catch(() => {});
    await this.driver.disconnect(this.id);
  }
}
