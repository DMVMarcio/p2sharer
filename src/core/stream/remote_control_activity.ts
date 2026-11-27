import type { RemoteInputEvent } from './remote_control.ts';

export type RemoteInputDevice = 'mouse' | 'keyboard' | 'gamepad';

export interface ControllerInputActivity {
  mouseActive: boolean;
  keyboardActive: boolean;
  gamepadActive: boolean;
  mouseSeq: number;
  keyboardSeq: number;
  gamepadSeq: number;
}

export interface GamepadInputActivity {
  active: boolean;
  seq: number;
}

export interface RemoteControllerOverlayItem {
  peerId: string;
  name: string;
  color: string;
  avatarDataUrl: string | null;
  mouseEnabled: boolean;
  keyboardEnabled: boolean;
  gamepadEnabled: boolean;
  mouseActive: boolean;
  keyboardActive: boolean;
  gamepadActive: boolean;
  mouseSeq: number;
  keyboardSeq: number;
  gamepadSeq: number;
}

interface InternalControllerRecord {
  mouseAt: number;
  keyboardAt: number;
  gamepadAt: number;
  mousePulseAt: number;
  keyboardPulseAt: number;
  gamepadPulseAt: number;
  mouseSeq: number;
  keyboardSeq: number;
  gamepadSeq: number;
}

interface InternalGamepadRecord {
  activeAt: number;
  pulseAt: number;
  seq: number;
}

export const INPUT_ACTIVITY_HOLD_MS = 480;
export const INPUT_PULSE_MIN_GAP_MS = 180;
const NOTIFY_THROTTLE_MS = 85;

export function classifyRemoteInputDevice(event: RemoteInputEvent): RemoteInputDevice | null {
  switch (event.kind) {
    case 'mouseMove':
    case 'mouseDelta':
    case 'mouseButton':
    case 'mouseWheel':
      return 'mouse';
    case 'key':
      return 'keyboard';
    case 'gamepadState': {
      const nonNeutral =
        event.buttons !== 0 ||
        event.leftTrigger > 8 ||
        event.rightTrigger > 8 ||
        Math.abs(event.thumbLx) >= 2400 ||
        Math.abs(event.thumbLy) >= 2400 ||
        Math.abs(event.thumbRx) >= 2400 ||
        Math.abs(event.thumbRy) >= 2400;
      return nonNeutral ? 'gamepad' : null;
    }
    default:
      return null;
  }
}

export class RemoteControlActivityTracker {
  private controllers = new Map<string, InternalControllerRecord>();
  private gamepads = new Map<string, InternalGamepadRecord>();
  private listeners = new Set<() => void>();
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;
  private decayTimer: ReturnType<typeof setTimeout> | null = null;
  private lastNotifyAt = 0;

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.clearTimers();
      }
    };
  }

  public recordEvent(
    peerId: string,
    mediaId: string,
    event: RemoteInputEvent,
    now = Date.now(),
  ): boolean {
    const device = classifyRemoteInputDevice(event);
    if (!device) return false;

    const controllerKey = `${peerId}:${mediaId}`;
    this.recordControllerDevice(controllerKey, device, now);

    if (device === 'gamepad' && event.kind === 'gamepadState') {
      const padId = `${peerId}:${mediaId}:${event.padIndex}`;
      this.recordGamepad(padId, now);
    }

    this.scheduleNotify(now);
    return true;
  }

  private recordControllerDevice(key: string, device: RemoteInputDevice, now: number): void {
    let rec = this.controllers.get(key);
    if (!rec) {
      rec = {
        mouseAt: 0,
        keyboardAt: 0,
        gamepadAt: 0,
        mousePulseAt: 0,
        keyboardPulseAt: 0,
        gamepadPulseAt: 0,
        mouseSeq: 0,
        keyboardSeq: 0,
        gamepadSeq: 0,
      };
      this.controllers.set(key, rec);
    }
    if (device === 'mouse') {
      rec.mouseAt = now;
      if (now - rec.mousePulseAt >= INPUT_PULSE_MIN_GAP_MS) {
        rec.mousePulseAt = now;
        rec.mouseSeq += 1;
      }
    } else if (device === 'keyboard') {
      rec.keyboardAt = now;
      if (now - rec.keyboardPulseAt >= INPUT_PULSE_MIN_GAP_MS) {
        rec.keyboardPulseAt = now;
        rec.keyboardSeq += 1;
      }
    } else {
      rec.gamepadAt = now;
      if (now - rec.gamepadPulseAt >= INPUT_PULSE_MIN_GAP_MS) {
        rec.gamepadPulseAt = now;
        rec.gamepadSeq += 1;
      }
    }
  }

  private recordGamepad(slotId: string, now: number): void {
    let rec = this.gamepads.get(slotId);
    if (!rec) {
      rec = { activeAt: 0, pulseAt: 0, seq: 0 };
      this.gamepads.set(slotId, rec);
    }
    rec.activeAt = now;
    if (now - rec.pulseAt >= INPUT_PULSE_MIN_GAP_MS) {
      rec.pulseAt = now;
      rec.seq += 1;
    }
  }

  public getControllerActivity(controllerKey: string, now = Date.now()): ControllerInputActivity {
    const rec = this.controllers.get(controllerKey);
    if (!rec) {
      return {
        mouseActive: false,
        keyboardActive: false,
        gamepadActive: false,
        mouseSeq: 0,
        keyboardSeq: 0,
        gamepadSeq: 0,
      };
    }
    return {
      mouseActive: now - rec.mouseAt <= INPUT_ACTIVITY_HOLD_MS,
      keyboardActive: now - rec.keyboardAt <= INPUT_ACTIVITY_HOLD_MS,
      gamepadActive: now - rec.gamepadAt <= INPUT_ACTIVITY_HOLD_MS,
      mouseSeq: rec.mouseSeq,
      keyboardSeq: rec.keyboardSeq,
      gamepadSeq: rec.gamepadSeq,
    };
  }

  public getGamepadActivity(slotId: string, now = Date.now()): GamepadInputActivity {
    const rec = this.gamepads.get(slotId);
    if (!rec) return { active: false, seq: 0 };
    return {
      active: now - rec.activeAt <= INPUT_ACTIVITY_HOLD_MS,
      seq: rec.seq,
    };
  }

  public clearController(controllerKey: string): void {
    this.controllers.delete(controllerKey);
    const prefix = `${controllerKey}:`;
    for (const key of this.gamepads.keys()) {
      if (key.startsWith(prefix)) this.gamepads.delete(key);
    }
    this.emitNow();
  }

  public clearPeer(peerId: string): void {
    const prefix = `${peerId}:`;
    for (const key of this.controllers.keys()) {
      if (key.startsWith(prefix)) this.controllers.delete(key);
    }
    for (const key of this.gamepads.keys()) {
      if (key.startsWith(prefix)) this.gamepads.delete(key);
    }
    this.emitNow();
  }

  public clearMedia(mediaId: string): void {
    const mid = `:${mediaId}`;
    for (const key of this.controllers.keys()) {
      if (key.endsWith(mid)) this.controllers.delete(key);
    }
    const padMid = `:${mediaId}:`;
    for (const key of this.gamepads.keys()) {
      if (key.includes(padMid)) this.gamepads.delete(key);
    }
    this.emitNow();
  }

  public clear(): void {
    this.controllers.clear();
    this.gamepads.clear();
    this.clearTimers();
    this.emitNow();
  }

  private clearTimers(): void {
    if (this.notifyTimer !== null) {
      clearTimeout(this.notifyTimer);
      this.notifyTimer = null;
    }
    if (this.decayTimer !== null) {
      clearTimeout(this.decayTimer);
      this.decayTimer = null;
    }
  }

  private scheduleNotify(now: number): void {
    if (this.listeners.size === 0) return;

    if (this.decayTimer !== null) {
      clearTimeout(this.decayTimer);
    }
    this.decayTimer = setTimeout(() => {
      this.decayTimer = null;
      this.emitNow();
    }, INPUT_ACTIVITY_HOLD_MS + 25);

    const elapsed = now - this.lastNotifyAt;
    if (elapsed >= NOTIFY_THROTTLE_MS) {
      if (this.notifyTimer !== null) {
        clearTimeout(this.notifyTimer);
        this.notifyTimer = null;
      }
      this.emitNow();
    } else if (this.notifyTimer === null) {
      this.notifyTimer = setTimeout(() => {
        this.notifyTimer = null;
        this.emitNow();
      }, NOTIFY_THROTTLE_MS - elapsed);
    }
  }

  private emitNow(): void {
    this.lastNotifyAt = Date.now();
    this.listeners.forEach((listener) => listener());
  }
}
