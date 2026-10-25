import { logDiagnostic } from '../core/logger.ts';

/** Recover Web Audio after autoplay gating or a device/window interruption. */
export class AudioContextRecovery {
  private context: AudioContext;
  private direction: 'capture' | 'playback';
  private lastState: string | undefined;
  private retryPlayback?: () => void;
  private pending: Promise<void> | undefined;
  private disposed = false;
  private readonly target = typeof window === 'undefined' ? undefined : window;
  private readonly visibilityTarget = typeof document === 'undefined' ? undefined : document;
  private readonly events = ['pointerdown', 'keydown', 'touchstart', 'focus', 'pageshow'];
  private readonly interact = () => {
    // Chromium can leave resume() pending until activation. A new gesture must
    // retry synchronously even when an earlier resume promise has not settled.
    this.resume(true);
    this.retryPlayback?.();
  };
  private readonly stateChanged = () => this.resume();
  private readonly visible = () => {
    if (!this.visibilityTarget?.hidden) this.interact();
  };

  constructor(context: AudioContext, retryPlayback?: () => void, direction: 'capture' | 'playback' = 'playback') {
    this.context = context;
    this.direction = direction;
    this.retryPlayback = retryPlayback;
    for (const event of this.events) this.target?.addEventListener?.(event, this.interact, true);
    this.visibilityTarget?.addEventListener?.('visibilitychange', this.visible);
    this.context.addEventListener?.('statechange', this.stateChanged);
    this.resume();
  }

  public resume(activation = false): void {
    if (this.disposed) return;
    this.reportState();
    if (this.context.state === 'closed') return;
    if (this.context.state === 'running') { this.pending = undefined; return; }
    if (this.pending && !activation) return;
    try {
      const pending = this.context.resume();
      this.pending = pending;
      const settled = () => { if (this.pending === pending) this.pending = undefined; if (!this.disposed) this.reportState(); };
      void pending.then(settled, settled);
    } catch {
      // Keep activation listeners armed for another attempt.
      this.pending = undefined;
    }
  }

  private reportState(): void {
    if (this.lastState === this.context.state) return;
    this.lastState = this.context.state;
    logDiagnostic('INFO', 'audio.context', 'Audio context state changed', { direction: this.direction, state: this.lastState });
  }

  public dispose(): void {
    this.disposed = true;
    for (const event of this.events) this.target?.removeEventListener?.(event, this.interact, true);
    this.visibilityTarget?.removeEventListener?.('visibilitychange', this.visible);
    this.context.removeEventListener?.('statechange', this.stateChanged);
    this.pending = undefined;
  }
}
