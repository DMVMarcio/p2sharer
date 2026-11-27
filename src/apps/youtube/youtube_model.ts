import type { YouTubeState } from '../types.ts';
import { preserveYouTubeTimeline, YOUTUBE_MAX_POSITION_SECONDS } from './youtube_timeline.ts';
import type { RoomAppModel, RoomAppModelContext } from '../models.ts';

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
