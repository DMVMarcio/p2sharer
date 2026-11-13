import type {
  RemoteControlClientPacket,
  RemoteControlHostPacket,
  RemoteControllerInfo,
  RemoteControlRequest,
  RemoteCursorShape,
  RemoteInputEvent,
} from '../core/remote_control.ts';

export interface RemoteScreenTarget {
  sessionId?: string;
  cursorCaptured: boolean;
}

export interface RemoteControlHostAdapter {
  isHostSupported: () => boolean;
  getScreenStream: (mediaId: string) => RemoteScreenTarget | null;
  sendToPeer: (peerId: string, packet: RemoteControlHostPacket) => void;
  setMonitorActive: (active: boolean) => Promise<void> | void;
  applyInput: (
    controllerId: string,
    sessionId: string | undefined,
    event: RemoteInputEvent,
  ) => Promise<{ accepted: boolean; hostBusy: boolean }>;
  releaseInputs: (controllerId?: string) => Promise<void> | void;
  onChange: () => void;
}

function controllerKey(peerId: string, mediaId: string): string {
  return `${peerId}:${mediaId}`;
}

export class RemoteControlHostManager {
  private readonly adapter: RemoteControlHostAdapter;
  private requests = new Map<string, RemoteControlRequest>();
  private controllers = new Map<string, RemoteControllerInfo>();
  private monitorActive = false;
  private hostBusy = false;
  private cursorShape: RemoteCursorShape = 'default';

  constructor(adapter: RemoteControlHostAdapter) {
    this.adapter = adapter;
  }

  public getRequests(): RemoteControlRequest[] {
    return Array.from(this.requests.values());
  }

  public getControllers(): RemoteControllerInfo[] {
    return Array.from(this.controllers.values());
  }

  public isHostBusy(): boolean {
    return this.hostBusy;
  }

  public receiveClientPacket(packet: RemoteControlClientPacket, peerId: string): void {
    const key = controllerKey(peerId, packet.mediaId);
    switch (packet.type) {
      case 'request': {
        const screen = this.adapter.getScreenStream(packet.mediaId);
        if (!screen || !this.adapter.isHostSupported()) {
          this.adapter.sendToPeer(peerId, {
            type: 'revoke',
            mediaId: packet.mediaId,
            reason: screen ? 'unsupported' : 'stream-ended',
          });
          return;
        }
        const existing = this.controllers.get(key);
        if (existing) {
          this.sendState(existing, 'accept', screen.cursorCaptured);
          return;
        }
        if (this.requests.has(key)) return;
        this.requests.set(key, {
          id: key,
          peerId,
          mediaId: packet.mediaId,
          createdAt: Date.now(),
        });
        this.adapter.onChange();
        break;
      }
      case 'cancel': {
        if (this.requests.delete(key)) {
          this.adapter.onChange();
        }
        break;
      }
      case 'release': {
        const removedReq = this.requests.delete(key);
        const removedCtrl = this.controllers.delete(key);
        if (removedCtrl) {
          void Promise.resolve(this.adapter.releaseInputs(key)).catch(() => {});
          this.syncMonitor();
        }
        if (removedReq || removedCtrl) {
          this.adapter.onChange();
        }
        break;
      }
      case 'input': {
        const ctrl = this.controllers.get(key);
        if (!ctrl) return;
        const screen = this.adapter.getScreenStream(packet.mediaId);
        if (!screen) {
          this.revokeController(peerId, packet.mediaId, 'stream-ended');
          return;
        }
        const { event } = packet;
        if (
          (event.kind === 'mouseMove' || event.kind === 'mouseButton' || event.kind === 'mouseWheel') &&
          !ctrl.mouseEnabled
        ) {
          return;
        }
        if (event.kind === 'key' && !ctrl.keyboardEnabled) {
          return;
        }
        void Promise.resolve(this.adapter.applyInput(key, screen.sessionId, event))
          .then((res) => {
            if (res && res.hostBusy !== this.hostBusy) {
              this.setHostPriorityState(res.hostBusy, this.cursorShape);
            }
          })
          .catch(() => {});
        break;
      }
    }
  }

  public answerRequest(requestId: string, accept: boolean): void {
    const req = this.requests.get(requestId);
    if (!req) return;
    this.requests.delete(requestId);
    if (!accept) {
      this.adapter.sendToPeer(req.peerId, { type: 'decline', mediaId: req.mediaId });
      this.adapter.onChange();
      return;
    }
    const screen = this.adapter.getScreenStream(req.mediaId);
    if (!screen || !this.adapter.isHostSupported()) {
      this.adapter.sendToPeer(req.peerId, {
        type: 'revoke',
        mediaId: req.mediaId,
        reason: screen ? 'unsupported' : 'stream-ended',
      });
      this.adapter.onChange();
      return;
    }
    const info: RemoteControllerInfo = {
      peerId: req.peerId,
      mediaId: req.mediaId,
      mouseEnabled: true,
      keyboardEnabled: true,
      connectedAt: Date.now(),
    };
    this.controllers.set(controllerKey(req.peerId, req.mediaId), info);
    this.syncMonitor();
    this.sendState(info, 'accept', screen.cursorCaptured);
    this.adapter.onChange();
  }

  public setControllerPermissions(
    peerId: string,
    mediaId: string,
    patch: { mouseEnabled?: boolean; keyboardEnabled?: boolean },
  ): void {
    const key = controllerKey(peerId, mediaId);
    const ctrl = this.controllers.get(key);
    if (!ctrl) return;
    const nextMouse = patch.mouseEnabled ?? ctrl.mouseEnabled;
    const nextKeyboard = patch.keyboardEnabled ?? ctrl.keyboardEnabled;
    if (nextMouse === ctrl.mouseEnabled && nextKeyboard === ctrl.keyboardEnabled) return;
    const updated: RemoteControllerInfo = {
      ...ctrl,
      mouseEnabled: nextMouse,
      keyboardEnabled: nextKeyboard,
    };
    this.controllers.set(key, updated);
    if ((!nextMouse && ctrl.mouseEnabled) || (!nextKeyboard && ctrl.keyboardEnabled)) {
      // Drop any lingering held mouse button or modifier key before disabling input.
      void Promise.resolve(this.adapter.releaseInputs(key)).catch(() => {});
    }
    const screen = this.adapter.getScreenStream(mediaId);
    if (screen) this.sendState(updated, 'state', screen.cursorCaptured);
    this.adapter.onChange();
  }

  public revokeController(
    peerId: string,
    mediaId: string,
    reason: 'revoked' | 'stream-ended' = 'revoked',
  ): void {
    const key = controllerKey(peerId, mediaId);
    const hadReq = this.requests.delete(key);
    const hadCtrl = this.controllers.delete(key);
    if (hadCtrl) {
      void Promise.resolve(this.adapter.releaseInputs(key)).catch(() => {});
      this.adapter.sendToPeer(peerId, { type: 'revoke', mediaId, reason });
      this.syncMonitor();
    } else if (hadReq) {
      this.adapter.sendToPeer(peerId, { type: 'decline', mediaId });
    }
    if (hadReq || hadCtrl) this.adapter.onChange();
  }

  public setHostPriorityState(hostBusy: boolean, cursorShape: RemoteCursorShape): void {
    if (this.hostBusy === hostBusy && this.cursorShape === cursorShape) return;
    this.hostBusy = hostBusy;
    this.cursorShape = cursorShape;
    if (this.controllers.size === 0) return;
    for (const ctrl of this.controllers.values()) {
      const screen = this.adapter.getScreenStream(ctrl.mediaId);
      if (screen) this.sendState(ctrl, 'state', screen.cursorCaptured);
    }
    this.adapter.onChange();
  }

  public notifyStreamUpdated(mediaId: string): void {
    const screen = this.adapter.getScreenStream(mediaId);
    if (!screen) {
      this.forgetMedia(mediaId);
      return;
    }
    for (const ctrl of this.controllers.values()) {
      if (ctrl.mediaId === mediaId) {
        this.sendState(ctrl, 'state', screen.cursorCaptured);
      }
    }
  }

  public forgetMedia(mediaId: string): void {
    let changed = false;
    for (const [key, req] of this.requests) {
      if (req.mediaId === mediaId) {
        this.requests.delete(key);
        this.adapter.sendToPeer(req.peerId, { type: 'decline', mediaId });
        changed = true;
      }
    }
    for (const [key, ctrl] of this.controllers) {
      if (ctrl.mediaId === mediaId) {
        this.controllers.delete(key);
        void Promise.resolve(this.adapter.releaseInputs(key)).catch(() => {});
        this.adapter.sendToPeer(ctrl.peerId, { type: 'revoke', mediaId, reason: 'stream-ended' });
        changed = true;
      }
    }
    if (changed) {
      this.syncMonitor();
      this.adapter.onChange();
    }
  }

  public forgetPeer(peerId: string): void {
    let changed = false;
    for (const [key, req] of this.requests) {
      if (req.peerId === peerId) {
        this.requests.delete(key);
        changed = true;
      }
    }
    for (const [key, ctrl] of this.controllers) {
      if (ctrl.peerId === peerId) {
        this.controllers.delete(key);
        void Promise.resolve(this.adapter.releaseInputs(key)).catch(() => {});
        changed = true;
      }
    }
    if (changed) {
      this.syncMonitor();
      this.adapter.onChange();
    }
  }

  public clear(): void {
    const hadAny = this.requests.size > 0 || this.controllers.size > 0;
    for (const req of this.requests.values()) {
      this.adapter.sendToPeer(req.peerId, { type: 'decline', mediaId: req.mediaId });
    }
    for (const ctrl of this.controllers.values()) {
      this.adapter.sendToPeer(ctrl.peerId, { type: 'revoke', mediaId: ctrl.mediaId, reason: 'stream-ended' });
    }
    this.requests.clear();
    this.controllers.clear();
    this.hostBusy = false;
    this.cursorShape = 'default';
    if (this.monitorActive) {
      void Promise.resolve(this.adapter.releaseInputs()).catch(() => {});
    }
    this.syncMonitor();
    if (hadAny) this.adapter.onChange();
  }

  private sendState(ctrl: RemoteControllerInfo, type: 'accept' | 'state', cursorCaptured: boolean): void {
    this.adapter.sendToPeer(ctrl.peerId, {
      type,
      mediaId: ctrl.mediaId,
      mouseEnabled: ctrl.mouseEnabled,
      keyboardEnabled: ctrl.keyboardEnabled,
      cursorCaptured,
      hostBusy: this.hostBusy,
      cursorShape: this.cursorShape,
    });
  }

  private syncMonitor(): void {
    const nextActive = this.controllers.size > 0;
    if (nextActive === this.monitorActive) return;
    this.monitorActive = nextActive;
    if (!nextActive) {
      this.hostBusy = false;
      this.cursorShape = 'default';
    }
    void Promise.resolve(this.adapter.setMonitorActive(nextActive)).catch(() => {});
  }
}
