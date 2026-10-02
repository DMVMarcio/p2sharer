import { invoke, isTauri } from '@tauri-apps/api/core';
import { stateStore } from '../core/state_store.ts';
import { StreamDrawingHistory } from '../core/stream_drawing_history.ts';
import { STREAM_POINTER_PING_MS, streamDrawingLimit, streamDrawingPointLimit, validStreamPointer, type StreamPointerState, type StreamPointerVisual } from '../core/stream_pointer.ts';

export class StreamPointerReceiver {
  private visuals = new Map<string, StreamPointerVisual>();
  private history = new StreamDrawingHistory();
  private rates = new Map<string, { move: number; ping: number; draw: number; sync: number }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private dirty = false;
  private drawingsDirty = true;
  private nativeDrawingsDirty = true;
  private lastPublished = 0;

  private publish: (state: StreamPointerState) => void;
  private render: (visuals: StreamPointerVisual[], drawingsIncluded: boolean) => Promise<unknown>;

  constructor(publish: (state: StreamPointerState) => void = () => {},
    render: (visuals: StreamPointerVisual[], drawingsIncluded: boolean) => Promise<unknown> = (visuals, drawingsIncluded) =>
      isTauri() ? invoke('update_stream_pointer_overlay', { visuals, drawingsIncluded }) : Promise.resolve()) { this.publish = publish; this.render = render; }

  private drawingsChanged() { this.dirty = true; this.drawingsDirty = true; this.nativeDrawingsDirty = true; }
  private enforceLimit() {
    const limit = streamDrawingLimit(stateStore.participantDrawingLimit);
    const drawings = [...this.visuals.values()].filter(v => v.drawing);
    let points = drawings.reduce((sum, v) => sum + v.drawing!.points.length, 0);
    while (drawings.length > limit || points > streamDrawingPointLimit(limit)) {
      const oldest = drawings.shift()!;
      this.visuals.delete(oldest.id); points -= oldest.drawing!.points.length;
      this.history.discard(oldest.id); this.drawingsChanged();
    }
    this.history.trim(limit);
  }

  receive(value: unknown, peerId: string, name: string, color: string) {
    if (!stateStore.isSharingScreen || !validStreamPointer(value)) return;
    const limit = streamDrawingLimit(stateStore.participantDrawingLimit);
    if (value.kind === 'sync') {
      const now = Date.now(), rate = this.rates.get(peerId) ?? { move: 0, ping: 0, draw: 0, sync: 0 };
      if (now - rate.sync < 1000) return;
      rate.sync = now; this.rates.set(peerId, rate);
      this.drawingsChanged(); this.start(); return;
    }
    if (value.kind === 'clear') {
      const removed = [...this.visuals.values()].filter(v => v.peerId === peerId && v.drawing);
      if (removed.length) {
        this.history.record(peerId, { removed, added: [] }, limit);
        for (const v of removed) this.visuals.delete(v.id);
        this.drawingsChanged(); this.start();
      }
      return;
    }
    if (value.kind === 'undo' || value.kind === 'redo') {
      if (!stateStore.allowParticipantCursors || !stateStore.allowParticipantDrawings) return;
      const action = this.history.step(peerId, value.kind);
      if (!action) return;
      for (const v of action.removed) this.visuals.delete(v.id);
      for (const v of action.added) this.visuals.set(v.id, { ...v, expires: Date.now() + 3000 });
      this.enforceLimit(); this.drawingsChanged(); this.start(); return;
    }
    if (value.kind === 'leave') { this.dirty = this.visuals.delete(peerId) || this.dirty; this.start(); return; }
    const now = Date.now();
    if (value.kind === 'draw') {
      if (!stateStore.allowParticipantCursors || !stateStore.allowParticipantDrawings) return;
      const id = `${peerId}:d:${value.id.slice(0, 28)}`;
      const rate = this.rates.get(peerId) ?? { move: 0, ping: 0, draw: 0, sync: 0 };
      if (now - rate.draw < 80 || this.visuals.has(id)) return;
      rate.draw = now; this.rates.set(peerId, rate);
      const visual: StreamPointerVisual = { id, peerId, name: name.slice(0, 80), color: value.drawing.color,
        ...value.drawing.points[0], expires: now + 3000, ping: false, drawing: value.drawing };
      this.visuals.set(id, visual);
      this.history.record(peerId, { removed: [], added: [visual] }, limit);
      this.enforceLimit(); this.drawingsChanged(); this.start(); return;
    }
    const rate = this.rates.get(peerId) ?? { move: 0, ping: 0, draw: 0, sync: 0 };
    const kind = value.kind;
    if (now - rate[kind] < (kind === 'move' ? 25 : 180)) return;
    rate[kind] = now; this.rates.set(peerId, rate);
    const visual = { peerId, name: name.slice(0, 80), color, x: value.x, y: value.y };
    if (stateStore.allowParticipantCursors) this.visuals.set(peerId,
      { ...visual, id: peerId, expires: now + 3000, ping: false });
    if (kind === 'ping' && stateStore.allowParticipantCursors && stateStore.allowParticipantPings) {
      if ([...this.visuals.values()].filter(v => !v.drawing).length < 256) {
        const id = `${peerId}:${now}`;
        this.visuals.set(id, { ...visual, id, expires: now + STREAM_POINTER_PING_MS, ping: true });
      }
    }
    this.dirty = true; this.start();
  }

  forget(peerId: string) {
    for (const [id, visual] of this.visuals) if (visual.peerId === peerId) this.visuals.delete(id);
    this.history.forget(peerId); this.rates.delete(peerId); this.drawingsChanged(); this.start();
  }

  clear() {
    this.visuals.clear(); this.history.clear(); this.rates.clear();
    this.publish({ kind: 'state', sentAt: Date.now(), drawingAllowed: stateStore.allowParticipantCursors && stateStore.allowParticipantDrawings, visuals: [], drawingsIncluded: true, history: [] });
    if (this.timer) clearInterval(this.timer);
    this.timer = null; this.drawingsChanged();
    void this.render([], true).catch(console.warn);
  }

  refreshPermissions() { this.drawingsChanged(); this.start(); }

  private start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const now = Date.now();
      const drawingAllowed = stateStore.isSharingScreen && stateStore.allowParticipantCursors && stateStore.allowParticipantDrawings;
      if (!drawingAllowed && this.history.state().length) { this.history.clear(); this.drawingsChanged(); }
      for (const [id, v] of this.visuals) {
        if (v.drawing) v.expires = now + 3000;
        if (!stateStore.isSharingScreen || v.expires <= now ||
          (!stateStore.allowParticipantCursors || (v.drawing ? !stateStore.allowParticipantDrawings : v.ping && !stateStore.allowParticipantPings))) {
          this.visuals.delete(id); this.dirty = true; if (v.drawing) this.drawingsChanged();
        }
      }
      this.enforceLimit();
      if (!this.dirty && now - this.lastPublished < 800) return;
      this.dirty = false; this.lastPublished = now;
      const visuals = [...this.visuals.values()];
      this.publish({ kind: 'state', sentAt: now, drawingAllowed, history: this.history.state(), drawingsIncluded: this.drawingsDirty,
        visuals: this.drawingsDirty ? visuals : visuals.filter(v => !v.drawing) });
      this.drawingsDirty = false;
      if (this.busy) return;
      this.busy = true;
      const nativeIncluded = this.nativeDrawingsDirty;
      this.nativeDrawingsDirty = false;
      void this.render(nativeIncluded ? visuals : visuals.filter(v => !v.drawing), nativeIncluded)
        .catch(error => { this.nativeDrawingsDirty = true; this.dirty = true; console.warn(error); }).finally(() => { this.busy = false; });
      if (!this.visuals.size) { clearInterval(this.timer!); this.timer = null; }
    }, 50);
  }
}
