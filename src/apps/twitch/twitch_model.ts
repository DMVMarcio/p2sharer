import type { TwitchState } from '../types.ts';
import type { RoomAppModel, RoomAppModelContext } from '../models.ts';

export function validTwitchState(value: unknown): value is TwitchState {
  if (!value || typeof value !== 'object') return false;
  const state = value as TwitchState;
  return typeof state.channel === 'string' &&
    /^[a-zA-Z0-9_]{0,25}$/.test(state.channel) &&
    typeof state.playing === 'boolean' &&
    Number.isFinite(state.updatedAt) && state.updatedAt > 0 &&
    (state.syncReason === undefined || ['channel', 'playback'].includes(state.syncReason));
}

export class TwitchModel implements RoomAppModel {
  private clock = 0;
  private stateValue: TwitchState = { channel: '', playing: true, updatedAt: Date.now() };
  private actorValue = '';
  private snapshotValue = false;
  private receivedAtValue = Date.now();
  private context: RoomAppModelContext;

  constructor(context: RoomAppModelContext) {
    this.context = context;
  }

  get state(): TwitchState { return this.stateValue; }
  get actor(): string { return this.actorValue; }
  get lastChangeWasSnapshot(): boolean { return this.snapshotValue; }
  get receivedAt(): number { return this.receivedAtValue; }

  update(state: TwitchState): void {
    if (!validTwitchState(state)) return;
    this.clock++;
    this.stateValue = state;
    this.actorValue = this.context.localActor;
    this.snapshotValue = false;
    this.receivedAtValue = Date.now();
    this.context.emit(this.snapshot());
    this.context.changed();
  }

  snapshot(): unknown {
    return { state: this.stateValue, clock: this.clock, actor: this.actorValue };
  }

  apply(payload: unknown, actor: string, fromSnapshot: boolean, receivedAt?: number): void {
    if (!payload || typeof payload !== 'object') return;
    const value = payload as { state?: unknown; clock?: unknown; actor?: unknown };
    if (!validTwitchState(value.state) || !Number.isSafeInteger(value.clock) ||
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
