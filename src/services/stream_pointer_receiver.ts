import { invoke, isTauri } from '@tauri-apps/api/core';
import { stateStore } from '../core/state_store.ts';
import { STREAM_POINTER_PING_MS, validStreamPointer, type StreamPointerState, type StreamPointerVisual } from '../core/stream_pointer.ts';

export class StreamPointerReceiver {
  private visuals = new Map<string, StreamPointerVisual>();
  private rates = new Map<string, { move: number; ping: number }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;

  private publish: (state: StreamPointerState) => void;
  private render: (visuals: StreamPointerVisual[]) => Promise<unknown>;

  constructor(publish: (state: StreamPointerState) => void = () => {},
    render: (visuals: StreamPointerVisual[]) => Promise<unknown> = (visuals) =>
      isTauri() ? invoke('update_stream_pointer_overlay', { visuals }) : Promise.resolve()) {
    this.publish = publish;
    this.render = render;
  }

  receive(value: unknown, peerId: string, name: string, color: string) {
    if (!stateStore.isSharingScreen || !validStreamPointer(value)) return;
    if (value.kind === 'leave') { this.visuals.delete(peerId); return; }
    const now = Date.now();
    const rate = this.rates.get(peerId) ?? { move: 0, ping: 0 };
    const kind = value.kind;
    if (now - rate[kind] < (kind === 'move' ? 25 : 180)) return;
    rate[kind] = now;
    this.rates.set(peerId, rate);
    const visual = { peerId, name: name.slice(0, 80), color, x: value.x, y: value.y };
    if (stateStore.allowParticipantCursors) this.visuals.set(peerId,
      { ...visual, id: peerId, expires: now + 3000, ping: false });
    if (kind === 'ping' && stateStore.allowParticipantPings) {
      if (this.visuals.size < 256) {
        const id = `${peerId}:${now}`;
        this.visuals.set(id, { ...visual, id, expires: now + STREAM_POINTER_PING_MS, ping: true });
      }
    }
    this.start();
  }

  forget(peerId: string) {
    for (const [id] of this.visuals) if (id === peerId || id.startsWith(`${peerId}:`)) this.visuals.delete(id);
    this.rates.delete(peerId);
  }

  clear() {
    this.visuals.clear(); this.rates.clear();
    this.publish({ kind: 'state', sentAt: Date.now(), visuals: [] });
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    void this.render([]).catch(console.warn);
  }

  private start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const now = Date.now();
      for (const [id, v] of this.visuals) {
        if (!stateStore.isSharingScreen || v.expires <= now ||
          (v.ping ? !stateStore.allowParticipantPings : !stateStore.allowParticipantCursors)) this.visuals.delete(id);
      }
      this.publish({ kind: 'state', sentAt: now, visuals: [...this.visuals.values()] });
      if (this.busy) return;
      this.busy = true;
      void this.render([...this.visuals.values()])
        .catch(console.warn).finally(() => { this.busy = false; });
      if (!this.visuals.size) {
        clearInterval(this.timer!); this.timer = null;
      }
    }, 50);
  }
}
