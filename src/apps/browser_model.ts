import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { RoomAppModel, RoomAppModelContext } from './models.ts';
import { BrowserControlLease, validBrowserCommand, validBrowserState, validBrowserDialog, type BrowserCommand, type BrowserState, type BrowserPageDialog } from './browser_protocol.ts';
import { BrowserMedia } from './browser_media.ts';
import { getLanguage } from '../i18n/index.ts';

export interface BrowserNative { call<T>(command: string, args: Record<string, unknown>): Promise<T> }
export class BrowserModel implements RoomAppModel {
  readonly host: string;
  readonly isHost: boolean;
  state: BrowserState = { tabs: [], active: 0, temporary: false };
  controller = '';
  pointer: { x: number; y: number; actor: string } | null = null;
  running = false;
  busy = false;
  paused = false;
  error = '';
  revision = 0;
  media: BrowserMedia | null = null;
  extensions: { id: string; name: string; enabled: boolean }[] = [];
  dialog: BrowserPageDialog | null = null;
  private dialogOpenedAt = 0;
  private answering = false;
  private members = new Set<string>();
  private memberEpochs = new Map<string, number>();
  private disposed = false;
  private sequence = 0;
  private received = new Map<string, number>();
  private lease: BrowserControlLease;
  private serial = Promise.resolve();
  private pending = 0;
  private pendingMoves = new Map<string, { packet: Record<string, unknown> }>();
  private visualSequences = new Map<string, number>();
  private epoch = 0;
  private session = '';
  private hostPriorityUntil = 0;
  private timer?: ReturnType<typeof setInterval>;
  private unlisten?: () => void;
  private listening?: Promise<void>;
  private scope: string;
  private context: RoomAppModelContext;
  private native: BrowserNative;
  private desktop: boolean;
  constructor(context: RoomAppModelContext, native: BrowserNative = { call: invoke }, desktop = isTauri()) {
    this.context = context; this.native = native; this.desktop = desktop;
    this.host = context.createdBy ?? context.localActor; this.isHost = this.host === context.localActor;
    this.scope = context.instanceId!; this.lease = new BrowserControlLease(this.host);
  }
  get joined(): boolean { return this.members.has(this.context.localActor); }
  get hostOnline(): boolean { return this.members.has(this.host); }
  get stream(): MediaStream | null { return this.media?.stream ?? null; }
  get canControl(): boolean { return this.joined && this.running && this.hostOnline && (!this.paused || this.isHost); }
  get canAnswerDialog(): boolean {
    return this.canControl && Boolean(this.dialog) && (this.isHost || !this.controller || this.controller === this.context.localActor
      || !this.members.has(this.controller) || Date.now() - this.dialogOpenedAt >= 1000);
  }
  snapshot(): unknown {
    return { type: 'state', state: this.state, revision: this.revision, running: this.running, controller: this.controller, paused: this.paused, dialog: this.dialog, session: this.session };
  }
  private publish(target?: string): void {
    if (!this.isHost || !this.joined || this.disposed) return;
    if (target) void this.context.send?.(this.snapshot(), target).catch(() => {});
    else for (const peer of this.members) if (peer !== this.host) void this.context.send?.(this.snapshot(), peer).catch(() => {});
    this.context.changed();
  }
  private changed(): void { this.revision++; this.publish(); }
  private acceptNativeState(state: unknown): void {
    if (!this.joined || !this.running || !validBrowserState(state) || (state.serial ?? 0) < (this.state.serial ?? 0)) return;
    if (JSON.stringify(state) !== JSON.stringify(this.state)) {
      const activeChanged = state.active !== this.state.active;
      this.state = state; this.changed(); if (activeChanged) this.media?.refreshCapture();
    }
  }
  private fail(error: unknown): void { if (!this.disposed) { this.error = String(error); this.context.changed(); } }
  private queue(operation: () => Promise<void>): Promise<void> {
    if (this.pending >= 96 || this.disposed) return Promise.resolve();
    this.pending++;
    const epoch = this.epoch;
    const next = this.serial.then(async () => { if (!this.disposed && epoch === this.epoch) await operation(); });
    this.serial = next.catch(e => { if (epoch === this.epoch) this.fail(e); }).finally(() => { this.pending--; });
    return next;
  }
  private ensureMedia(): void {
    if (!this.desktop || !this.joined || this.media) return;
    this.media = new BrowserMedia(this.scope, this.isHost, async (payload, target) => {
      if (!this.joined || !this.members.has(target) || this.disposed) throw new Error('Browser participant unavailable');
      await this.context.send?.(payload, target);
    }, () => this.context.changed(), state => this.acceptNativeState(state), error => this.fail(error), this.context.rtcConfiguration);
  }
  async start(temporary = false): Promise<void> {
    if (!this.isHost || !this.joined || this.busy || this.running || !this.desktop) return;
    this.busy = true; this.error = ''; this.context.changed();
    const epoch = this.epoch;
    try {
      this.listening ??= (async () => {
        const removePopup = await listen<{ scope: string; url: string }>('shared-browser-popup', ({ payload }) => {
        if (payload.scope === this.scope && this.running && this.joined && validBrowserCommand({ kind: 'new-tab', url: payload.url })) {
          void this.queue(async () => {
            const state = await this.native.call<BrowserState>('control_shared_browser', { scope: this.scope, command: { kind: 'new-tab', url: payload.url } });
            this.acceptNativeState(state);
          }).catch(() => {});
        }
        });
        try {
          const removeDialog = await listen<{ scope: string; dialog: unknown }>('shared-browser-dialog', ({ payload }) => {
            if (payload.scope === this.scope && this.joined && !this.disposed && (this.running || this.busy) && validBrowserDialog(payload.dialog)) {
              this.dialog = payload.dialog; this.dialogOpenedAt = Date.now(); this.changed();
            }
          });
          let removeLoading: () => void;
          try {
            removeLoading = await listen<{ scope: string; tab: number; loading: boolean; serial: number }>('shared-browser-loading', ({ payload }) => {
              if (payload.scope !== this.scope || !this.joined || !this.running || !Number.isSafeInteger(payload.serial)
                || payload.serial <= (this.state.serial ?? 0) || typeof payload.loading !== 'boolean') return;
              if (!this.state.tabs.some(tab => tab.id === payload.tab)) return;
              this.state = { ...this.state, serial: payload.serial,
                tabs: this.state.tabs.map(tab => tab.id === payload.tab ? { ...tab, loading: payload.loading } : tab) };
              this.changed();
            });
          } catch (error) { removeDialog(); throw error; }
          const remove = () => { removePopup(); removeDialog(); removeLoading(); };
          if (this.disposed) remove(); else this.unlisten = remove;
        } catch (error) { removePopup(); throw error; }
      })();
      await this.listening;
      const state = await this.native.call<BrowserState>('start_shared_browser', { scope: this.scope, temporary, language: getLanguage() });
      if (this.disposed || epoch !== this.epoch || !this.joined) {
        await this.native.call('stop_shared_browser', { scope: this.scope }); return;
      }
      this.state = state; this.session = crypto.randomUUID(); this.running = true; this.ensureMedia(); await this.media?.start();
      if (this.disposed || epoch !== this.epoch || !this.joined) { this.stop(); return; }
      this.timer = setInterval(() => {
        if (this.lease.owner && this.lease.expired(Date.now())) void this.queue(async () => {
          if (this.lease.owner && this.lease.expired(Date.now())) await this.release();
        }).catch(() => {});
      }, 250);
      this.changed();
      for (const peer of this.members) if (peer !== this.host) void this.media?.offer(peer).catch(e => this.fail(e));
    } catch (error) {
      if (!this.unlisten) this.listening = undefined;
      this.running = false; this.media?.stop();
      await this.native.call('stop_shared_browser', { scope: this.scope }).catch(() => {});
      this.dialog = null; this.changed(); this.fail(error);
    } finally { this.busy = false; this.context.changed(); }
  }
  private async release(): Promise<void> {
    const keys = [...this.lease.keys.values()]; this.lease.clear(); this.controller = '';
    if (this.running) {
      for (const key of keys) await this.native.call('control_shared_browser', { scope: this.scope, command: { ...key, event: 'keyUp', modifiers: 0 } });
      await this.native.call('control_shared_browser', { scope: this.scope, command: { kind: 'release' } });
    }
    this.changed();
  }
  command(command: BrowserCommand): void {
    if (!this.canControl || !validBrowserCommand(command)) return;
    const packet = { type: 'command', command, sequence: ++this.sequence, tab: this.state.active, session: this.session };
    if (this.isHost) this.apply(packet, this.context.localActor, false);
    else void this.context.send?.(packet, this.host).catch(e => this.fail(e));
  }
  answerDialog(accept: boolean, text = ''): void {
    if (!this.canAnswerDialog || !this.dialog || text.length > 4096) return;
    const packet = { type: 'dialog-answer', id: this.dialog.id, accept, text, sequence: ++this.sequence };
    if (this.isHost) this.apply(packet, this.context.localActor, false);
    else void this.context.send?.(packet, this.host).catch(e => this.fail(e));
  }
  private updatePointer(actor: string, command: Extract<BrowserCommand, { kind: 'mouse' }>, sequence: number): void {
    if (sequence <= (this.visualSequences.get(actor) ?? 0)) return;
    this.visualSequences.set(actor, sequence);
    this.pointer = { x: command.x, y: command.y, actor };
    for (const peer of this.members) if (peer !== this.host) void this.context.send?.({ type: 'cursor', ...this.pointer }, peer).catch(() => {});
    this.context.changed();
  }
  apply(payload: unknown, actor: string, fromSnapshot: boolean): void {
    if (this.disposed || !payload || typeof payload !== 'object') return;
    const data = payload as Record<string, unknown>;
    if (data.type === 'cursor' && actor === this.host && !this.isHost && !fromSnapshot && this.joined && this.hostOnline
      && typeof data.x === 'number' && Number.isFinite(data.x) && data.x >= 0 && data.x <= 1280
      && typeof data.y === 'number' && Number.isFinite(data.y) && data.y >= 0 && data.y <= 720
      && typeof data.actor === 'string' && this.members.has(data.actor)) {
      this.pointer = { x: data.x, y: data.y, actor: data.actor }; this.context.changed(); return;
    }
    if (data.type === 'state') {
      if (this.isHost || actor !== this.host || !validBrowserState(data.state) ||
        !Number.isSafeInteger(data.revision) || Number(data.revision) < this.revision ||
        typeof data.running !== 'boolean' || typeof data.paused !== 'boolean' ||
        typeof data.controller !== 'string' || data.controller.length > 100 || data.dialog !== undefined && data.dialog !== null && !validBrowserDialog(data.dialog)
        || data.session !== undefined && (typeof data.session !== 'string' || data.session !== '' && !/^[a-f0-9-]{36}$/.test(data.session))) return;
      const wasRunning = this.running;
      this.state = data.state; this.revision = Number(data.revision); this.running = data.running;
      this.session = typeof data.session === 'string' ? data.session : '';
      if (!this.running) { this.media?.stop(); this.pointer = null; }
      else if (!wasRunning && this.joined) void this.media?.start().catch(e => this.fail(e));
      this.controller = data.controller; this.paused = data.paused;
      const dialog = data.dialog as BrowserPageDialog | null ?? null;
      if (dialog?.id !== this.dialog?.id) this.dialogOpenedAt = Date.now();
      this.dialog = dialog; this.context.changed(); return;
    }
    if (fromSnapshot || !this.joined || !this.members.has(actor)) return;
    if (data.type === 'dialog-answer') {
      if (!this.isHost || !this.dialog || this.answering || data.id !== this.dialog.id || typeof data.accept !== 'boolean'
        || typeof data.text !== 'string' || data.text.length > 4096 || this.paused && actor !== this.host
        || !Number.isSafeInteger(data.sequence) || Number(data.sequence) <= (this.received.get(actor) ?? 0)) return;
      this.received.set(actor, Number(data.sequence));
      if (actor !== this.host && actor !== this.controller && this.members.has(this.controller)
        && Date.now() - this.dialogOpenedAt < 1000) return;
      const dialog = this.dialog; this.answering = true;
      // Answer outside the input queue: dispatching a click may itself be paused by the dialog.
      void this.native.call('resolve_browser_dialog', { scope: this.scope, tab: dialog.tab, id: dialog.id, accept: data.accept, text: data.text })
        .then(() => { if (this.dialog?.id === dialog.id) { this.dialog = null; this.changed(); }
          return this.queue(() => this.release()); }).catch(e => this.fail(e)).finally(() => { this.answering = false; });
      return;
    }
    if (data.type === 'media-request' && this.isHost && this.running) {
      this.publish(actor); if (!this.media) return;
      void this.media.offer(actor).catch(e => this.fail(e)); return;
    }
    if (data.type === 'media' && (this.isHost || actor === this.host)) {
      void this.media?.receive(actor, data).catch(e => this.fail(e)); return;
    }
    if (data.type !== 'command' || !this.isHost || !this.running || !validBrowserCommand(data.command)
      || (data.session ?? '') !== this.session
      || !Number.isSafeInteger(data.sequence) || Number(data.sequence) <= (this.received.get(actor) ?? 0)) return;
    this.received.set(actor, Number(data.sequence));
    if (this.paused && actor !== this.host) return;
    const command = data.command;
    const epoch = this.epoch;
    const memberEpoch = this.memberEpochs.get(actor) ?? 0;
    if (actor === this.host && command.kind !== 'release') this.hostPriorityUntil = Date.now() + 1000;
    let move: { packet: Record<string, unknown> } | undefined;
    if (command.kind === 'mouse' && command.event === 'mouseMoved') {
      if (data.tab === this.state.active && this.controller === actor && this.lease.accepts(actor, Date.now())
        && (actor === this.host || Date.now() >= this.hostPriorityUntil)) {
        if (this.lease.owner === actor) this.lease.touched = Date.now();
        this.updatePointer(actor, command, Number(data.sequence));
      }
      const previous = this.pendingMoves.get(actor);
      if (previous) { previous.packet = data; return; }
      if (this.pending >= 95) return;
      move = { packet: data }; this.pendingMoves.set(actor, move);
    } else {
      // Button/key/navigation actions are ordering barriers for coalesced motion.
      this.pendingMoves.delete(actor);
    }
    void this.queue(async () => {
      const packet = move?.packet ?? data;
      const command = packet.command as BrowserCommand;
      if (move && this.pendingMoves.get(actor) === move) this.pendingMoves.delete(actor);
      if (!this.joined || !this.members.has(actor) || !this.running || this.paused && actor !== this.host) return;
      if ((this.memberEpochs.get(actor) ?? 0) !== memberEpoch) return;
      if (command.kind === 'release') { if (this.lease.owner === actor) await this.release(); return; }
      if (packet.tab !== this.state.active) return;
      if (actor !== this.host && Date.now() < this.hostPriorityUntil) return;
      if (!this.lease.accepts(actor, Date.now())) return;
      if (this.lease.owner && this.lease.owner !== actor) await this.release();
      if (['navigate', 'select-tab', 'close-tab', 'new-tab', 'back', 'forward', 'reload'].includes(command.kind)
        && (this.lease.buttons || this.lease.keys.size)) await this.release();
      const oldOwner = this.lease.owner;
      this.lease.update(actor, command, Date.now()); this.controller = actor;
      if (command.kind === 'mouse') {
        this.updatePointer(actor, command, Number(packet.sequence));
      }
      if (oldOwner !== actor) this.changed();
      const state = await this.native.call<BrowserState | null>('control_shared_browser', { scope: this.scope, command });
      if (epoch === this.epoch) this.acceptNativeState(state);
    }).catch(() => {});
  }
  togglePause(): void {
    if (!this.isHost || !this.joined) return;
    this.paused = !this.paused; void this.queue(() => this.release()).catch(() => {}); this.changed();
  }
  async finish(): Promise<void> {
    if (!this.isHost || !this.joined || !this.running || this.busy) return;
    this.busy = true; this.stop(false);
    this.state = { tabs: [], active: 0, temporary: this.state.temporary };
    this.pointer = null; this.changed();
    try { await this.native.call('stop_shared_browser', { scope: this.scope }); }
    finally { this.busy = false; this.context.changed(); }
  }
  async clear(mode: 'cache' | 'sites' | 'history' | 'reset'): Promise<void> {
    if (!this.isHost || !this.joined || !this.running || this.busy) return;
    this.busy = true; this.context.changed();
    const temporary = this.state.temporary;
    try {
      await this.queue(async () => {
        await this.release();
        await this.native.call('clear_shared_browser', { scope: this.scope, mode });
        if (mode === 'reset') { this.stop(false); this.state = { tabs: [], active: 0, temporary }; this.extensions = []; this.changed(); }
      });
    } catch (error) {
      if (mode === 'reset') { this.stop(); this.state = { tabs: [], active: 0, temporary }; this.changed(); }
      throw error;
    } finally { this.busy = false; this.context.changed(); }
    if (mode === 'reset' && this.joined) await this.start(temporary);
  }
  async manageExtensions(action: 'install' | 'list' | 'enable' | 'disable' | 'remove', id?: string): Promise<void> {
    if (!this.isHost || !this.joined || !this.running || this.busy) return;
    this.busy = true; this.context.changed();
    try {
      await this.native.call('browser_extensions', { scope: this.scope, action, id: id ?? null, language: getLanguage() });
      this.extensions = await this.native.call('browser_extensions', { scope: this.scope, action: 'list', id: null, language: getLanguage() });
    } finally { this.busy = false; this.context.changed(); }
  }
  setParticipants(participants: string[]): void {
    const previous = this.members; this.members = new Set(participants);
    for (const peer of previous) if (!this.members.has(peer)) {
      this.memberEpochs.set(peer, (this.memberEpochs.get(peer) ?? 0) + 1);
      this.media?.remove(peer); this.received.delete(peer);
      this.pendingMoves.delete(peer); this.visualSequences.delete(peer);
      if (this.lease.owner === peer && this.isHost) void this.queue(() => this.release()).catch(() => {});
    }
    if (!this.joined) { this.stop(); return; }
    this.ensureMedia();
    if (!this.isHost) {
      if (!this.hostOnline) { this.media?.stop(); this.controller = ''; this.running = false; this.dialog = null; this.pointer = null; this.context.changed(); }
      else if (!previous.has(this.context.localActor) || !previous.has(this.host)) {
        void this.media?.start().then(() => this.context.send?.({ type: 'media-request' }, this.host)).catch(e => this.fail(e));
      }
    } else if (this.running) for (const peer of this.members) if (peer !== this.host && !previous.has(peer)) {
      this.publish(peer); void this.media?.offer(peer).catch(e => this.fail(e));
    }
  }
  private stop(native = true): void {
    this.epoch++; clearInterval(this.timer); this.media?.stop(); this.media = null;
    this.session = '';
    this.pendingMoves.clear(); this.visualSequences.clear();
    this.lease.clear(); this.controller = ''; this.running = false;
    this.dialog = null;
    if (native && this.isHost && this.desktop) void this.native.call('stop_shared_browser', { scope: this.scope }).catch(() => {});
  }
  destroy(): void { this.disposed = true; this.stop(); this.unlisten?.(); }
}
