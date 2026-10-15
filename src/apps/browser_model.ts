import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { RoomAppModel, RoomAppModelContext } from './models.ts';
import { BrowserControlLease, validBrowserCommand, validBrowserState, validBrowserDialog, type BrowserCommand, type BrowserState, type BrowserPageDialog } from './browser_protocol.ts';
import { BrowserMedia } from './browser_media.ts';
import { getLanguage } from '../i18n/index.ts';
import { BrowserOwnership } from './browser_ownership.ts';
import { validBrowserContext, validBrowserCursorShape, type BrowserCursorShape, type BrowserContext } from './browser_protocol.ts';
import { showToast } from '../hooks/useToast.ts';
import { localizeError } from '../i18n/index.ts';
import { BrowserLocalRequests } from './browser_local_requests.ts';
import { validBrowserQuality, type BrowserQualitySettings } from './browser_quality.ts';

export interface BrowserNative { call<T>(command: string, args: Record<string, unknown>): Promise<T> }
const ACTIVITY_ACTIONS = ['navigate', 'home', 'new-tab', 'close-tab', 'select-tab', 'move-tab', 'back', 'forward', 'reload'];
export class BrowserModel implements RoomAppModel {
  private ownership: BrowserOwnership;
  get host(): string { return this.context.localView ? this.mirrorHost : this.ownership.host; }
  private mirrorHost = '';
  private localRequests: BrowserLocalRequests;
  private clipboardRequests: BrowserLocalRequests;
  get localView(): boolean { return Boolean(this.context.localView); }
  get isHost(): boolean { return this.host === this.context.localActor; }
  get canStart(): boolean { return this.joined && (!this.host || this.isHost) && !this.running && !this.busy; }
  state: BrowserState = { tabs: [], active: 0, temporary: false };
  controller = '';
  gameOwner = '';
  private gameRequest: { actor: string; tab: number; time: number } | null = null;
  pointer: { x: number; y: number; actor: string; shape?: BrowserCursorShape } | null = null;
  private cursorShape: BrowserCursorShape = 'default';
  activity: { id: number; actor: string; action: string; title?: string } | null = null;
  extensionRequest: string | null = null;
  private activityId = 0;
  private leftSequences = new Map<string, number>();
  running = false;
  busy = false;
  paused = false;
  contextMenu: (BrowserContext & { id: number }) | null = null;
  private contextActor: { actor: string; tab: number; time: number } | null = null;
  private contextId = 0;
  private lastError = { message: '', time: 0 };
  revision = 0;
  presentation = 0;
  private mirroredContextId = 0;
  media: BrowserMedia | null = null;
  hardwareAcceleration = (() => { try { return localStorage.getItem('browser-hardware-acceleration') !== 'false'; } catch { return true; } })();
  extensions: { id: string; name: string; enabled: boolean; popup?: boolean }[] = [];
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
    this.localRequests = new BrowserLocalRequests(payload => this.context.emit(payload));
    this.clipboardRequests = new BrowserLocalRequests(payload => {
      const { id } = payload as { id: string };
      const packet = { type: 'copy-request', id, tab: this.state.active, session: this.session, sequence: ++this.sequence };
      if (this.isHost) this.apply(packet, this.context.localActor, false);
      else void this.context.send?.(packet, this.host).catch(() => this.clipboardRequests.result(id, 'Browser selection unavailable'));
    }, 10_000);
    this.ownership = new BrowserOwnership(context.localActor, async (packet, peer) => { await context.send?.(packet, peer); }, (previous, next) => {
      const wasRunning = this.running;
      this.stop(false);
      if (wasRunning && previous === context.localActor && this.desktop) void this.native.call('stop_shared_browser', { scope: this.scope }).catch(() => {});
      this.lease = new BrowserControlLease(next); this.state = { tabs: [], active: 0, temporary: false };
      this.revision = 0; this.paused = false; this.pointer = null; this.extensions = [];
      this.activity = null; this.activityId = 0; this.leftSequences.clear(); this.extensionRequest = null;
      if (next && this.joined && !this.isHost) {
        this.ensureMedia(); void this.media?.start().then(() => this.context.send?.({ type: 'media-request' }, next)).catch(e => this.fail(e));
      }
      this.context.changed();
    });
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
    return { type: 'state', ownership: this.ownership.snapshot(), hostTerm: this.ownership.term, state: this.state, revision: this.revision, running: this.running, controller: this.controller, gameOwner: this.gameOwner, paused: this.paused, dialog: this.dialog, session: this.session, presentation: this.presentation };
  }
  localSnapshot() {
    return { state: this.state, host: this.host, running: this.running, busy: this.busy, paused: this.paused,
      controller: this.controller, gameOwner: this.gameOwner, pointer: this.pointer, activity: this.activity, contextMenu: this.contextMenu,
      extensions: this.extensions, extensionRequest: this.extensionRequest, dialog: this.dialog,
      quality: this.media?.quality.settings, hardwareAcceleration: this.hardwareAcceleration, session: this.session, presentation: this.presentation };
  }
  applyLocalSnapshot(value: unknown): void {
    if (!this.localView || !value || typeof value !== 'object') return;
    const data = value as ReturnType<BrowserModel['localSnapshot']>;
    if (!validBrowserState(data.state) || typeof data.host !== 'string') return;
    this.state = data.state; this.mirrorHost = data.host; this.running = data.running === true;
    this.busy = data.busy === true; this.paused = data.paused === true; this.controller = data.controller;
    this.gameOwner = data.running && typeof data.gameOwner === 'string' && data.gameOwner === data.controller ? data.gameOwner : '';
    this.hardwareAcceleration = data.hardwareAcceleration !== false;
    this.pointer = data.pointer;
    if (this.activity?.id !== data.activity?.id) this.activity = data.activity;
    if (data.contextMenu && data.contextMenu.id !== this.mirroredContextId) { this.contextMenu = data.contextMenu; this.mirroredContextId = data.contextMenu.id; }
    this.extensions = data.extensions; this.extensionRequest = data.extensionRequest; this.dialog = data.dialog;
    this.session = data.session;
    this.presentation = data.presentation;
    if (this.media && validBrowserQuality(data.quality) && JSON.stringify(this.media.quality.settings) !== JSON.stringify(data.quality)) this.media.quality.configure(data.quality);
    this.context.changed();
  }
  acceptLocalResult(id: string, error?: string, value?: unknown): void { this.localRequests.result(id, error, value); }
  async copy(): Promise<string> {
    if (!this.joined || !this.running || !this.hostOnline || this.disposed) return '';
    const text = this.localView ? await this.localRequests.request<unknown>('copy') : await this.clipboardRequests.request<unknown>('copy');
    return typeof text === 'string' && text.length <= 65536 ? text : '';
  }
  async applyLocalUpdate(value: unknown): Promise<void> {
    if (this.localView || !this.joined || !value || typeof value !== 'object') return;
    const data = value as { type?: string; action?: string; args?: unknown[] };
    if (data.type !== 'browser-local' || !Array.isArray(data.args)) return;
    const [first, second] = data.args;
    switch (data.action) {
      case 'command': if (validBrowserCommand(first)) this.command(first); break;
      case 'start': if (typeof first === 'boolean') await this.start(first); break;
      case 'finish': await this.finish(); break;
      case 'pause': this.togglePause(); break;
      case 'volume': if (typeof first === 'number' && typeof second === 'boolean') await this.setLocalVolume(first, second); break;
      case 'quality': if (validBrowserQuality(first)) this.configureQuality(first); break;
      case 'hardware': if (typeof first === 'boolean') this.configureHardwareAcceleration(first); break;
      case 'restart': await this.restart(); break;
      case 'dismiss-extension': this.dismissExtensionRequest(); break;
      case 'dismiss-context': if (this.contextMenu?.id === first) { this.contextMenu = null; this.context.changed(); } break;
      case 'answer': if (typeof first === 'boolean' && typeof second === 'string') this.answerDialog(first, second); break;
      case 'clear': if (['cache', 'sites', 'history', 'reset'].includes(String(first))) await this.clear(first as 'cache' | 'sites' | 'history' | 'reset'); break;
      case 'extensions': if (['install', 'install-folder', 'install-store', 'list', 'enable', 'disable', 'remove', 'popup'].includes(String(first))
        && (second === undefined || typeof second === 'string' && second.length <= 4096)) await this.manageExtensions(first as Parameters<BrowserModel['manageExtensions']>[0], second as string | undefined); break;
    }
  }
  configureQuality(settings: BrowserQualitySettings): void {
    if (this.localView) { void this.localRequests.request('quality', [settings]).catch(error => this.fail(error)); return; }
    this.media?.configure(settings);
  }
  configureHardwareAcceleration(enabled: boolean): void {
    if (this.localView) { void this.localRequests.request('hardware', [enabled]).catch(error => this.fail(error)); return; }
    if (!this.isHost || !this.joined || this.busy) return;
    this.hardwareAcceleration = enabled;
    try { localStorage.setItem('browser-hardware-acceleration', String(enabled)); } catch {}
    this.context.changed();
  }
  consumeContextMenu(): void {
    const id = this.contextMenu?.id; this.contextMenu = null;
    if (this.localView && id) void this.localRequests.request('dismiss-context', [id]).catch(error => this.fail(error));
  }
  private publish(target?: string): void {
    if (!this.isHost || !this.joined || this.disposed) return;
    if (target) void this.context.send?.(this.snapshot(), target).catch(() => {});
    else for (const peer of this.members) if (peer !== this.host) void this.context.send?.(this.snapshot(), peer).catch(() => {});
    this.context.changed();
  }
  private changed(): void { this.revision++; this.publish(); }
  private acceptNativeState(state: unknown): void {
    if (!this.isHost || !this.joined || !this.running || !validBrowserState(state) || (state.serial ?? 0) < (this.state.serial ?? 0)) return;
    if (JSON.stringify(state) !== JSON.stringify(this.state)) {
      const activeChanged = state.active !== this.state.active;
      this.state = state; this.changed(); if (activeChanged) this.media?.refreshCapture();
    }
  }
  private fail(error: unknown): void {
    if (this.disposed) return;
    const message = localizeError(error); const time = Date.now();
    if (message !== this.lastError.message || time - this.lastError.time > 4000) showToast(message, 5000, 'error');
    this.lastError = { message, time };
  }
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
    }, () => {
      if (this.isHost && this.media && this.presentation !== this.media.videoTab) { this.presentation = this.media.videoTab; this.changed(); }
      else this.context.changed();
    }, state => this.acceptNativeState(state), error => this.fail(error), this.context.rtcConfiguration);
  }
  async start(temporary = false): Promise<void> {
    if (this.localView) return this.localRequests.request('start', [temporary]);
    if (!this.canStart || !this.desktop) return;
    this.busy = true; this.context.changed();
    try { if ((this.isHost || await this.ownership.request()) && this.joined && this.isHost) await this.startNative(temporary); }
    finally { this.busy = false; this.context.changed(); }
  }
  async restart(): Promise<void> {
    if (this.localView) return this.localRequests.request('restart');
    if (!this.desktop || !this.isHost || !this.joined || !this.running || this.busy) return;
    const temporary = this.state.temporary;
    this.busy = true; this.stop(false);
    this.state = { tabs: [], active: 0, temporary }; this.changed();
    await this.startNative(temporary, true);
  }
  private async startNative(temporary: boolean, restart = false): Promise<void> {
    this.busy = true; this.context.changed();
    const epoch = this.epoch;
    try {
      this.listening ??= (async () => {
        const removePopup = await listen<{ scope: string; tab: number; url: string }>('shared-browser-popup', ({ payload }) => {
        if (this.isHost && payload.scope === this.scope && payload.tab === this.state.active && this.running && this.joined && validBrowserCommand({ kind: 'new-tab', url: payload.url })) {
          void this.queue(async () => {
            const state = await this.native.call<BrowserState>('control_shared_browser', { scope: this.scope, command: { kind: 'new-tab', url: payload.url } });
            this.acceptNativeState(state);
          }).catch(() => {});
        }
        });
        try {
          const removeDialog = await listen<{ scope: string; dialog: unknown }>('shared-browser-dialog', ({ payload }) => {
            if (this.isHost && payload.scope === this.scope && this.joined && !this.disposed && (this.running || this.busy) && validBrowserDialog(payload.dialog)) {
              this.dialog = payload.dialog; this.dialogOpenedAt = Date.now(); this.changed();
            }
          });
          let removeLoading: () => void;
          try {
            removeLoading = await listen<{ scope: string; tab: number; loading: boolean; serial: number; canBack?: boolean; canForward?: boolean }>('shared-browser-loading', ({ payload }) => {
              if (!this.isHost || payload.scope !== this.scope || !this.joined || !this.running || !Number.isSafeInteger(payload.serial)
                || payload.serial <= (this.state.serial ?? 0) || typeof payload.loading !== 'boolean') return;
              if (!this.state.tabs.some(tab => tab.id === payload.tab)) return;
              this.state = { ...this.state, serial: payload.serial,
                tabs: this.state.tabs.map(tab => tab.id === payload.tab ? { ...tab, loading: payload.loading,
                  canBack: typeof payload.canBack === 'boolean' ? payload.canBack : tab.canBack,
                  canForward: typeof payload.canForward === 'boolean' ? payload.canForward : tab.canForward } : tab) };
              this.changed();
            });
          } catch (error) { removeDialog(); throw error; }
          const removeExtension = await listen<{ scope: string; url: string }>('shared-browser-extension-request', ({ payload }) => {
            if (this.isHost && this.running && this.joined && !this.extensionRequest && payload.scope === this.scope && typeof payload.url === 'string' && payload.url.length <= 4096) {
              this.extensionRequest = payload.url; this.context.changed();
            }
          }).catch(error => { removeDialog(); removeLoading(); throw error; });
          const removeContext = await listen<{ scope: string; menu: unknown }>('shared-browser-context', ({ payload }) => {
            const request = this.contextActor;
            if (!this.isHost || !this.running || !this.joined || payload.scope !== this.scope || !validBrowserContext(payload.menu)
              || !request || request.tab !== payload.menu.tab || Date.now() - request.time > 3000 || !this.members.has(request.actor)) return;
            this.contextActor = null;
            if (request.actor === this.context.localActor) { this.contextMenu = { ...payload.menu, id: ++this.contextId }; this.context.changed(); }
            else void this.context.send?.({ type: 'context-menu', menu: payload.menu, session: this.session }, request.actor).catch(() => {});
          }).catch(error => { removeDialog(); removeLoading(); removeExtension(); throw error; });
          const removeCursor = await listen<{ scope: string; tab: number; shape: unknown }>('shared-browser-cursor', ({ payload }) => {
            if (!this.isHost || !this.running || !this.joined || payload.scope !== this.scope || payload.tab !== this.state.active || !validBrowserCursorShape(payload.shape)) return;
            this.cursorShape = payload.shape;
            if (this.pointer) { this.pointer = { ...this.pointer, shape: payload.shape }; this.publishPointer(); this.context.changed(); }
          }).catch(error => { removeDialog(); removeLoading(); removeExtension(); removeContext(); throw error; });
          const removeLock = await listen<{ scope: string; tab: number; locked: boolean }>('shared-browser-pointer-lock', ({ payload }) => {
            if (!this.isHost || !this.running || payload.scope !== this.scope || payload.tab !== this.state.active) return;
            const request = this.gameRequest;
            if (payload.locked) this.gameRequest = null;
            if (payload.locked && request && request.actor === this.lease.owner && request.tab === payload.tab
              && Date.now() - request.time < 3000 && this.members.has(request.actor) && (!this.paused || request.actor === this.host)) {
              this.lease.locked = true; this.gameOwner = request.actor; this.pointer = null; this.changed();
            } else if (payload.locked || this.gameOwner) void this.queue(() => this.release()).catch(() => {});
          }).catch(error => { removeDialog(); removeLoading(); removeExtension(); removeContext(); removeCursor(); throw error; });
          const remove = () => { removeLock(); removePopup(); removeDialog(); removeLoading(); removeExtension(); removeContext(); removeCursor(); };
          if (this.disposed) remove(); else this.unlisten = remove;
        } catch (error) { removePopup(); throw error; }
      })();
      await this.listening;
      const state = await this.native.call<BrowserState>('start_shared_browser', { scope: this.scope, temporary, language: getLanguage(), hardwareAcceleration: this.hardwareAcceleration, ...(restart ? { restart: true } : {}) });
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
      if (this.disposed || epoch !== this.epoch || !this.isHost) {
        await this.native.call('stop_shared_browser', { scope: this.scope }).catch(() => {}); return;
      }
      if (!this.unlisten) this.listening = undefined;
      this.running = false; this.media?.stop();
      await this.native.call('stop_shared_browser', { scope: this.scope }).catch(() => {});
      this.dialog = null; this.changed(); this.fail(error);
      await this.ownership.release().catch(() => {});
    } finally { this.busy = false; this.context.changed(); }
  }
  private async release(): Promise<void> {
    this.gameRequest = null;
    const keys = [...this.lease.keys.values()]; this.lease.clear(); this.controller = ''; this.gameOwner = '';
    if (this.running) {
      for (const key of keys) await this.native.call('control_shared_browser', { scope: this.scope, command: { ...key, event: 'keyUp', modifiers: 0 } });
      await this.native.call('control_shared_browser', { scope: this.scope, command: { kind: 'release' } });
    }
    this.changed();
  }
  command(command: BrowserCommand): void {
    if (!this.canControl || !validBrowserCommand(command)) return;
    const active = this.state.tabs.find(tab => tab.id === this.state.active);
    if (command.kind === 'back' && active?.canBack === false || command.kind === 'forward' && active?.canForward === false) return;
    if (this.localView) { this.context.emit({ type: 'browser-local', action: 'command', args: [command] }); return; }
    const packet = { type: 'command', command, sequence: ++this.sequence, tab: this.state.active, session: this.session };
    if (this.isHost) this.apply(packet, this.context.localActor, false);
    else void this.context.send?.(packet, this.host).catch(e => this.fail(e));
  }
  answerDialog(accept: boolean, text = ''): void {
    if (this.localView) { void this.localRequests.request('answer', [accept, text]).catch(error => this.fail(error)); return; }
    if (!this.canAnswerDialog || !this.dialog || text.length > 4096) return;
    const packet = { type: 'dialog-answer', id: this.dialog.id, accept, text, sequence: ++this.sequence };
    if (this.isHost) this.apply(packet, this.context.localActor, false);
    else void this.context.send?.(packet, this.host).catch(e => this.fail(e));
  }
  private updatePointer(actor: string, command: Extract<BrowserCommand, { kind: 'mouse' }>, sequence: number): void {
    if (sequence <= (this.visualSequences.get(actor) ?? 0)) return;
    this.visualSequences.set(actor, sequence);
    this.pointer = { x: command.x, y: command.y, actor, shape: this.cursorShape };
    this.publishPointer();
    this.context.changed();
  }
  private publishPointer(): void {
    for (const peer of this.members) if (peer !== this.host) void this.context.send?.({ type: 'cursor', ...this.pointer, tab: this.state.active, session: this.session }, peer).catch(() => {});
  }
  apply(payload: unknown, actor: string, fromSnapshot: boolean): void {
    if (this.disposed || !payload || typeof payload !== 'object') return;
    const data = payload as Record<string, unknown>;
    if (this.ownership.handle(payload, actor, fromSnapshot)) return;
    if (data.type === 'cursor-hidden' && actor === this.host && !fromSnapshot && this.joined && data.session === this.session) {
      this.pointer = null; this.context.changed(); return;
    }
    if (data.type === 'activity' && !this.isHost && actor === this.host && !fromSnapshot && this.joined && this.running
      && data.session === this.session && data.hostTerm === this.ownership.term && typeof data.actor === 'string' && this.members.has(data.actor)
      && typeof data.action === 'string' && ACTIVITY_ACTIONS.includes(data.action) && Number.isSafeInteger(data.id) && Number(data.id) > this.activityId) {
      this.activityId = Number(data.id); this.activity = { id: this.activityId, actor: data.actor, action: data.action, title: typeof data.title === 'string' ? data.title.slice(0, 400) : '' }; this.context.changed(); return;
    }
    if (fromSnapshot && data.ownership && typeof data.ownership === 'object')
      this.ownership.handle({ ...data.ownership, type: 'ownership' }, actor, true);
    if (data.type === 'copy-result' && actor === this.host && !fromSnapshot && this.joined && this.running
      && data.session === this.session && Number.isSafeInteger(data.tab) && Number(data.tab) > 0 && typeof data.id === 'string'
      && typeof data.text === 'string' && data.text.length <= 65536 && (data.error === undefined || data.error === 'Browser selection unavailable')) {
      this.clipboardRequests.result(data.id, data.error as string | undefined, data.text); return;
    }
    if (data.type === 'context-menu' && !this.isHost && actor === this.host && !fromSnapshot && this.canControl
      && data.session === this.session && validBrowserContext(data.menu) && data.menu.tab === this.state.active) {
      this.contextMenu = { ...data.menu, id: ++this.contextId }; this.context.changed(); return;
    }
    if (data.type === 'cursor' && actor === this.host && !this.isHost && !fromSnapshot && this.joined && this.hostOnline
      && data.session === this.session && data.tab === this.state.active && validBrowserCursorShape(data.shape)
      && typeof data.x === 'number' && Number.isFinite(data.x) && data.x >= 0 && data.x <= 1280
      && typeof data.y === 'number' && Number.isFinite(data.y) && data.y >= 0 && data.y <= 720
      && typeof data.actor === 'string' && this.members.has(data.actor)) {
      this.pointer = { x: data.x, y: data.y, actor: data.actor, shape: data.shape }; this.context.changed(); return;
    }
    if (data.type === 'state') {
      if (this.isHost || actor !== this.host || data.hostTerm !== this.ownership.term || !validBrowserState(data.state) ||
        !Number.isSafeInteger(data.revision) || Number(data.revision) < this.revision ||
        typeof data.running !== 'boolean' || typeof data.paused !== 'boolean' ||
        typeof data.controller !== 'string' || data.controller.length > 100 || data.dialog !== undefined && data.dialog !== null && !validBrowserDialog(data.dialog)
        || data.session !== undefined && (typeof data.session !== 'string' || data.session !== '' && !/^[a-f0-9-]{36}$/.test(data.session))) return;
      const wasRunning = this.running;
      this.state = data.state; this.revision = Number(data.revision); this.running = data.running;
      this.presentation = Number.isSafeInteger(data.presentation) && Number(data.presentation) >= 0 ? Number(data.presentation) : 0;
      this.session = typeof data.session === 'string' ? data.session : '';
      if (!this.running) { this.media?.stop(); this.pointer = null; }
      else if (!wasRunning && this.joined) void this.media?.start().catch(e => this.fail(e));
      this.controller = data.controller; this.paused = data.paused;
      this.gameOwner = data.running && typeof data.gameOwner === 'string' && data.gameOwner === data.controller ? data.gameOwner : '';
      const dialog = data.dialog as BrowserPageDialog | null ?? null;
      if (dialog?.id !== this.dialog?.id) this.dialogOpenedAt = Date.now();
      this.dialog = dialog; this.context.changed(); return;
    }
    if (fromSnapshot || !this.joined || !this.members.has(actor)) return;
    if (data.type === 'copy-request' && this.isHost && this.running && data.session === this.session && data.tab === this.state.active
      && typeof data.id === 'string' && /^[a-f0-9-]{36}$/.test(data.id) && Number.isSafeInteger(data.sequence)
      && Number(data.sequence) > (this.received.get(actor) ?? 0)) {
      this.received.set(actor, Number(data.sequence));
      const epoch = this.epoch; const membership = this.memberEpochs.get(actor); const tab = this.state.active;
      const respond = (text: string, error?: string) => {
        if (this.epoch !== epoch || !this.running || !this.members.has(actor) || this.memberEpochs.get(actor) !== membership) return;
        const result = { type: 'copy-result', id: data.id, text, error, session: this.session, tab };
        if (actor === this.host) this.apply(result, this.host, false);
        else void this.context.send?.(result, actor).catch(() => {});
      };
      void this.queue(async () => {
        if (this.epoch !== epoch || !this.running || this.memberEpochs.get(actor) !== membership) return;
        if (this.state.active !== tab) { respond(''); return; }
        const text = await this.native.call<unknown>('read_shared_browser_selection', { scope: this.scope, tab });
        respond(typeof text === 'string' ? text.slice(0, 65536) : '');
      }).catch(() => respond('', 'Browser selection unavailable'));
      return;
    }
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
    if (command.kind === 'cursor-leave') {
      if (this.gameOwner === actor) return;
      this.leftSequences.set(actor, Number(data.sequence)); this.visualSequences.set(actor, Number(data.sequence)); this.pendingMoves.delete(actor);
      if (actor === this.host) this.hostPriorityUntil = 0;
      if (this.controller === actor) {
        this.pointer = null; this.controller = '';
        for (const peer of this.members) if (peer !== this.host) void this.context.send?.({ type: 'cursor-hidden', session: this.session }, peer).catch(() => {});
        void this.release().catch(() => {}); this.changed();
      }
      return;
    }
    const epoch = this.epoch;
    const memberEpoch = this.memberEpochs.get(actor) ?? 0;
    if (actor === this.host && command.kind !== 'release') this.hostPriorityUntil = Date.now() + 1000;
    let move: { packet: Record<string, unknown> } | undefined;
    if (command.kind === 'relative-mouse') {
      const previous = this.pendingMoves.get(actor);
      if (previous?.packet.command && (previous.packet.command as BrowserCommand).kind === 'relative-mouse') {
        const old = previous.packet.command as Extract<BrowserCommand, { kind: 'relative-mouse' }>;
        previous.packet = { ...data, command: { kind: 'relative-mouse', dx: Math.max(-5000, Math.min(5000, old.dx + command.dx)), dy: Math.max(-5000, Math.min(5000, old.dy + command.dy)) } }; return;
      }
      if (this.pending >= 95) return;
      move = { packet: data }; this.pendingMoves.set(actor, move);
    } else if (command.kind === 'mouse' && command.event === 'mouseMoved') {
      if (this.gameOwner === actor) return;
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
      if (Number(packet.sequence) <= (this.leftSequences.get(actor) ?? 0)) return;
      if (move && this.pendingMoves.get(actor) === move) this.pendingMoves.delete(actor);
      if (!this.joined || !this.members.has(actor) || !this.running || this.paused && actor !== this.host) return;
      if ((this.memberEpochs.get(actor) ?? 0) !== memberEpoch) return;
      if (command.kind === 'release') { if (this.lease.owner === actor) await this.release(); return; }
      if (packet.tab !== this.state.active) return;
      if (actor !== this.host && Date.now() < this.hostPriorityUntil) return;
      if (!this.lease.accepts(actor, Date.now())) return;
      if (command.kind === 'relative-mouse' && this.gameOwner !== actor) return;
      if (this.gameOwner === actor && command.kind === 'mouse' && command.event === 'mouseMoved') return;
      if (this.lease.owner && this.lease.owner !== actor) await this.release();
      if (['navigate', 'select-tab', 'close-tab', 'move-tab', 'new-tab', 'back', 'forward', 'reload'].includes(command.kind)
        && (this.lease.buttons || this.lease.keys.size || this.lease.locked)) await this.release();
      const oldOwner = this.lease.owner;
      this.lease.update(actor, command, Date.now()); this.controller = actor;
      if (command.kind === 'mouse' && command.event === 'mousePressed' || command.kind === 'key' && command.event === 'keyDown' && command.key !== 'Escape')
        this.gameRequest = { actor, tab: this.state.active, time: Date.now() };
      if (command.kind === 'mouse') {
        if (command.event === 'mousePressed' && command.button === 'right') this.contextActor = { actor, tab: this.state.active, time: Date.now() };
        this.updatePointer(actor, command, Number(packet.sequence));
      }
      if (oldOwner !== actor) this.changed();
      const title = command.kind === 'close-tab' ? this.state.tabs.find(tab => tab.id === command.id)?.title || '' : undefined;
      const state = await this.native.call<BrowserState | null>('control_shared_browser', { scope: this.scope, command });
      if (epoch === this.epoch) {
        this.acceptNativeState(state);
        if (ACTIVITY_ACTIONS.includes(command.kind)) {
          const action = command.kind === 'navigate' && command.url === 'https://www.google.com/' ? 'home' : command.kind;
          this.activity = { id: ++this.activityId, actor, action, ...(title !== undefined ? { title } : {}) };
          for (const peer of this.members) if (peer !== this.host) void this.context.send?.({ type: 'activity', ...this.activity,
            session: this.session, hostTerm: this.ownership.term }, peer).catch(() => {});
          this.context.changed();
        }
      }
    }).catch(() => {});
  }
  togglePause(): void {
    if (this.localView) { void this.localRequests.request('pause').catch(error => this.fail(error)); return; }
    if (!this.isHost || !this.joined) return;
    this.paused = !this.paused; void this.queue(() => this.release()).catch(() => {}); this.changed();
  }
  async finish(): Promise<void> {
    if (this.localView) return this.localRequests.request('finish');
    if (!this.isHost || !this.joined || !this.running || this.busy) return;
    this.busy = true; this.stop(false);
    this.state = { tabs: [], active: 0, temporary: this.state.temporary };
    this.pointer = null; this.changed();
    try { await this.native.call('stop_shared_browser', { scope: this.scope }); }
    finally { await this.ownership.release().catch(() => {}); this.busy = false; this.context.changed(); }
  }
  async setLocalVolume(volume: number, muted: boolean): Promise<void> {
    if (this.localView) return this.localRequests.request('volume', [volume, muted]);
    if (!this.isHost || !this.joined || !this.running || this.disposed) return;
    if (!Number.isFinite(volume) || volume < 0 || volume > 1) return;
    // This local IPC never enters the shared input queue or room snapshots.
    const epoch = this.epoch;
    try { await this.native.call('set_shared_browser_volume', { scope: this.scope, volume, muted }); }
    catch (error) { if (epoch === this.epoch && this.running && !this.disposed) throw error; }
  }
  dismissExtensionRequest(): void {
    if (this.localView) { void this.localRequests.request('dismiss-extension').catch(error => this.fail(error)); return; }
    this.extensionRequest = null; this.context.changed();
  }
  async clear(mode: 'cache' | 'sites' | 'history' | 'reset'): Promise<void> {
    if (this.localView) return this.localRequests.request('clear', [mode]);
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
    if (mode === 'reset' && this.joined && this.isHost) await this.startNative(temporary);
  }
  async manageExtensions(action: 'install' | 'install-folder' | 'install-store' | 'list' | 'enable' | 'disable' | 'remove' | 'popup', id?: string): Promise<void> {
    if (this.localView) return this.localRequests.request('extensions', [action, id]);
    if (!this.isHost || !this.joined || !this.running || this.busy) return;
    this.busy = true; this.context.changed();
    try {
      const result = await this.native.call('browser_extensions', { scope: this.scope, action, id: id ?? null, language: getLanguage() });
      if (action === 'popup') this.acceptNativeState(result);
      this.extensions = await this.native.call('browser_extensions', { scope: this.scope, action: 'list', id: null, language: getLanguage() });
    } finally { this.busy = false; this.context.changed(); }
  }
  setParticipants(participants: string[]): void {
    if (this.localView) { this.members = new Set(participants); return; }
    const previous = this.members; this.members = new Set(participants);
    this.ownership.updateMembers(participants);
    for (const peer of previous) if (!this.members.has(peer)) {
      this.memberEpochs.set(peer, (this.memberEpochs.get(peer) ?? 0) + 1);
      this.media?.remove(peer); this.received.delete(peer);
      this.pendingMoves.delete(peer); this.visualSequences.delete(peer);
      this.leftSequences.delete(peer);
      if (this.lease.owner === peer && this.isHost) void this.queue(() => this.release()).catch(() => {});
    }
    if (!this.joined) { this.stop(); return; }
    this.ensureMedia();
    if (!this.isHost) {
      if (!this.hostOnline) { this.media?.stop(); this.controller = ''; this.gameOwner = ''; this.running = false; this.dialog = null; this.pointer = null; this.context.changed(); }
      else if (!previous.has(this.context.localActor) || !previous.has(this.host)) {
        void this.media?.start().then(() => this.context.send?.({ type: 'media-request' }, this.host)).catch(e => this.fail(e));
      }
    } else if (this.running) for (const peer of this.members) if (peer !== this.host && !previous.has(peer)) {
      this.publish(peer); void this.media?.offer(peer).catch(e => this.fail(e));
    }
  }
  private stop(native = true): void {
    this.clipboardRequests.destroy();
    this.epoch++; clearInterval(this.timer); this.media?.stop(); this.media = null;
    this.session = '';
    this.pendingMoves.clear(); this.visualSequences.clear();
    this.leftSequences.clear(); this.activity = null; this.extensionRequest = null;
    this.contextActor = null; this.contextMenu = null;
    this.cursorShape = 'default';
    this.gameRequest = null;
    this.presentation = 0;
    this.lease.clear(); this.controller = ''; this.gameOwner = ''; this.running = false;
    this.dialog = null;
    if (native && !this.localView && this.isHost && this.desktop) void this.native.call('stop_shared_browser', { scope: this.scope }).catch(() => {});
  }
  destroy(): void { this.disposed = true; this.localRequests.destroy(); this.ownership.cancel(); this.stop(); this.unlisten?.(); }
}
