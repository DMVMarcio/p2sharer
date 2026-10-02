import { invoke, isTauri } from '@tauri-apps/api/core';
import { stateStore } from '../core/state_store.ts';
import { STREAM_POINTER_PING_MS, validStreamPointer, type StreamPointerState, type StreamPointerVisual } from '../core/stream_pointer.ts';

export class StreamPointerReceiver {
  private visuals = new Map<string, StreamPointerVisual>();
  private rates = new Map<string, { move: number; ping: number; draw: number }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private dirty = false;
  private lastPublished = 0;

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
    if (value.kind === 'clear') {
      for (const [id, visual] of this.visuals) if (visual.peerId === peerId && visual.drawing) this.visuals.delete(id);
      this.dirty = true; this.start(); return;
    }
    if (value.kind === 'leave') { this.dirty = this.visuals.delete(peerId) || this.dirty; this.start(); return; }
    const now = Date.now();
    if (value.kind === 'draw') {
      if (!stateStore.allowParticipantCursors || !stateStore.allowParticipantDrawings) return;
      const id = `${peerId}:d:${value.id.slice(0, 28)}`;
      const rate = this.rates.get(peerId) ?? { move: 0, ping: 0, draw: 0 };
      if (now - rate.draw < 80) return;
      rate.draw = now; this.rates.set(peerId, rate);
      // Bound the complete scene, retaining the most recent instructions.
      this.visuals.delete(id);
      const drawings = [...this.visuals.values()].filter(v => v.drawing);
      let points = drawings.reduce((sum, v) => sum + v.drawing!.points.length, 0) + value.drawing.points.length;
      while (drawings.length >= 64 || points > 2048) {
        const oldest = drawings.shift();
        if (!oldest) break;
        this.visuals.delete(oldest.id); points -= oldest.drawing!.points.length;
      }
      this.visuals.set(id, { id, peerId, name: name.slice(0, 80), color: value.drawing.color,
        ...value.drawing.points[0], expires: now + 3000, ping: false, drawing: value.drawing });
      this.dirty = true; this.start(); return;
    }
    const rate = this.rates.get(peerId) ?? { move: 0, ping: 0, draw: 0 };
    const kind = value.kind;
    if (now - rate[kind] < (kind === 'move' ? 25 : 180)) return;
    rate[kind] = now;
    this.rates.set(peerId, rate);
    const visual = { peerId, name: name.slice(0, 80), color, x: value.x, y: value.y };
    if (stateStore.allowParticipantCursors) this.visuals.set(peerId,
      { ...visual, id: peerId, expires: now + 3000, ping: false });
    if (kind === 'ping' && stateStore.allowParticipantCursors && stateStore.allowParticipantPings) {
      if (this.visuals.size < 256) {
        const id = `${peerId}:${now}`;
        this.visuals.set(id, { ...visual, id, expires: now + STREAM_POINTER_PING_MS, ping: true });
      }
    }
    this.dirty = true; this.start();
  }

  forget(peerId: string) {
    for (const [id, visual] of this.visuals) if (visual.peerId === peerId) this.visuals.delete(id);
    this.rates.delete(peerId); this.dirty = true; this.start();
  }

  clear() {
    this.visuals.clear(); this.rates.clear();
    this.publish({ kind: 'state', sentAt: Date.now(), drawingAllowed: stateStore.allowParticipantCursors && stateStore.allowParticipantDrawings, visuals: [] });
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    void this.render([]).catch(console.warn);
  }

  refreshPermissions() { this.dirty = true; this.start(); }

  private start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const now = Date.now();
      for (const [id, v] of this.visuals) {
        if (v.drawing) v.expires = now + 3000;
        if (!stateStore.isSharingScreen || v.expires <= now ||
          (!stateStore.allowParticipantCursors || (v.drawing ? !stateStore.allowParticipantDrawings : v.ping && !stateStore.allowParticipantPings))) { this.visuals.delete(id); this.dirty = true; }
      }
      if (!this.dirty && now - this.lastPublished < 800) return;
      this.dirty = false; this.lastPublished = now;
      this.publish({ kind: 'state', sentAt: now, drawingAllowed: stateStore.allowParticipantCursors && stateStore.allowParticipantDrawings, visuals: [...this.visuals.values()] });
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
