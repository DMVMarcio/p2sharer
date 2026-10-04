import { t } from '../i18n/index.ts';
import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as decoding from 'lib0/decoding';
import type { YouTubeState } from './types.ts';
import { preserveYouTubeTimeline, YOUTUBE_MAX_POSITION_SECONDS } from './youtube_timeline.ts';

export interface RoomAppModel {
  snapshot(): unknown;
  apply(payload: unknown, actor: string, fromSnapshot: boolean, receivedAt?: number): void;
  destroy(): void;
}

export interface RoomAppModelContext {
  localActor: string;
  emit(payload: unknown): void;
  changed(): void;
}

const MAX_NOTE = 500_000;
const MAX_UPDATE = 700_000;

function encodeUpdate(update: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < update.length; offset += 8192)
    binary += String.fromCharCode(...update.subarray(offset, offset + 8192));
  return btoa(binary);
}

function decodeUpdate(value: unknown): Uint8Array | null {
  if (typeof value !== 'string' || value.length > MAX_UPDATE * 1.4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  try { return Uint8Array.from(atob(value), (char) => char.charCodeAt(0)); }
  catch { return null; }
}

export class NotepadModel implements RoomAppModel {
  private doc = new Y.Doc();
  private awarenessValue: Awareness | null = null;
  private awarenessClients = new Map<string, number>();
  private context: RoomAppModelContext;
  constructor(context: RoomAppModelContext) {
    this.context = context;
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      this.context.changed();
      if (origin !== 'remote' && update.byteLength <= MAX_UPDATE)
        this.context.emit({ update: encodeUpdate(update) });
    });
  }
  get awareness(): Awareness {
    if (this.awarenessValue) return this.awarenessValue;
    const awareness = new Awareness(this.doc);
    awareness.on('update', ({ added, updated, removed }: {
      added: number[]; updated: number[]; removed: number[]
    }, origin: unknown) => {
      if (origin === 'remote') return;
      const clients = [...added, ...updated, ...removed].filter((id) => id === this.doc.clientID);
      if (clients.length) this.context.emit({ awareness: encodeUpdate(encodeAwarenessUpdate(awareness, clients)) });
    });
    this.awarenessValue = awareness;
    return awareness;
  }
  get text(): Y.Text { return this.doc.getText('content'); }
  get richContent(): Y.XmlFragment { return this.doc.getXmlFragment('rich-content'); }
  get document(): Y.Doc { return this.doc; }
  replace(content: string): void {
    if (content.length > MAX_NOTE) throw new Error(t("message.c915d1570950"));
    const text = this.text;
    this.doc.transact(() => { text.delete(0, text.length); text.insert(0, content); });
  }
  snapshot(): unknown { return { update: encodeUpdate(Y.encodeStateAsUpdate(this.doc)) }; }
  apply(payload: unknown, actor: string, fromSnapshot: boolean): void {
    if (!payload || typeof payload !== 'object') return;
    const data = payload as { update?: unknown; awareness?: unknown };
    if (!fromSnapshot && data.awareness !== undefined) {
      const update = decodeUpdate(data.awareness);
      if (!update || update.byteLength > 4096) return;
      try {
        const decoder = decoding.createDecoder(update);
        if (decoding.readVarUint(decoder) !== 1) return;
        const clientId = decoding.readVarUint(decoder);
        if (clientId === this.doc.clientID ||
          ([...this.awarenessClients].some(([peer, id]) => peer !== actor && id === clientId))) return;
        const previous = this.awarenessClients.get(actor);
        if (previous !== undefined && previous !== clientId) return;
        this.awarenessClients.set(actor, clientId);
        if (this.awarenessValue) applyAwarenessUpdate(this.awarenessValue, update, 'remote');
      } catch { /* Reject malformed awareness data. */ }
      return;
    }
    const update = decodeUpdate(data.update);
    if (!update || this.text.length > MAX_NOTE) return;
    try { Y.applyUpdate(this.doc, update, 'remote'); } catch { /* Reject malformed updates. */ }
  }
  destroy(): void { this.awarenessValue?.destroy(); this.doc.destroy(); }
}

export function validYouTubeState(value: unknown): value is YouTubeState {
  if (!value || typeof value !== 'object') return false;
  const state = value as YouTubeState;
  return Array.isArray(state.queue) && state.queue.length <= 200 && state.queue.every((entry) =>
    typeof entry?.videoId === 'string' && /^[\w-]{11}$/.test(entry.videoId) &&
    typeof entry.title === 'string' && entry.title.length <= 300 &&
    (entry.isLive === undefined || typeof entry.isLive === 'boolean') &&
    (entry.addedBy === undefined || (typeof entry.addedBy === 'string' && entry.addedBy.length <= 100)) &&
    (entry.addedByName === undefined || (typeof entry.addedByName === 'string' && entry.addedByName.length <= 80))) &&
    Number.isInteger(state.index) && state.index >= 0 &&
    (state.queue.length === 0 ? state.index === 0 : state.index < state.queue.length) &&
    typeof state.playing === 'boolean' && (state.ended === undefined || typeof state.ended === 'boolean') &&
    !(state.ended && state.playing) && Number.isFinite(state.position) && state.position >= 0 &&
    state.position < YOUTUBE_MAX_POSITION_SECONDS && ['off', 'all', 'one'].includes(state.repeat) &&
    typeof state.shuffle === 'boolean' && typeof state.removePlayed === 'boolean' &&
    Number.isFinite(state.updatedAt) && state.updatedAt > 0 &&
    (state.syncReason === undefined || ['heartbeat', 'playback', 'seek', 'update', 'queue-replace', 'auto-advance'].includes(state.syncReason));
}

export class YouTubeModel implements RoomAppModel {
  private clock = 0;
  private stateValue: YouTubeState = { queue: [], index: 0, playing: false, position: 0,
    repeat: 'off', shuffle: false, removePlayed: false, updatedAt: Date.now() };
  private actorValue = '';
  private snapshotValue = false;
  private receivedAtValue = Date.now();
  private context: RoomAppModelContext;
  constructor(context: RoomAppModelContext) { this.context = context; }
  get state(): YouTubeState { return this.stateValue; }
  get actor(): string { return this.actorValue; }
  get lastChangeWasSnapshot(): boolean { return this.snapshotValue; }
  get receivedAt(): number { return this.receivedAtValue; }
  update(state: YouTubeState): void {
    if (!validYouTubeState(state)) return;
    this.clock++;
    this.stateValue = preserveYouTubeTimeline(this.stateValue, state, this.receivedAtValue, Date.now());
    this.actorValue = this.context.localActor;
    this.snapshotValue = false;
    this.receivedAtValue = Date.now();
    this.context.emit(this.snapshot());
    this.context.changed();
  }
  snapshot(): unknown { return { state: this.stateValue, clock: this.clock, actor: this.actorValue }; }
  apply(payload: unknown, actor: string, fromSnapshot: boolean, receivedAt?: number): void {
    if (!payload || typeof payload !== 'object') return;
    const value = payload as { state?: unknown; clock?: unknown; actor?: unknown };
    if (!validYouTubeState(value.state) || !Number.isSafeInteger(value.clock) ||
      (value.clock as number) < 0 || typeof value.actor !== 'string' || value.actor.length > 100 ||
      (!fromSnapshot && value.actor !== actor)) return;
    const clock = value.clock as number;
    if (clock < this.clock || (clock === this.clock && value.actor <= this.actorValue)) return;
    this.clock = clock;
    this.actorValue = value.actor;
    this.snapshotValue = fromSnapshot;
    this.stateValue = value.state;
    this.receivedAtValue = receivedAt !== undefined && Number.isFinite(receivedAt) ? receivedAt : Date.now();
    this.context.changed();
  }
  destroy(): void {}
}
