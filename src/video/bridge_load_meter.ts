/** Measure real JPEG work and bounded-queue replacement, excluding static ticks. */
export class BridgeLoadMeter {
  private started: number;
  private received = 0;
  private replaced = 0;
  private completed = 0;
  private processingMs = 0;

  private effectiveFps: number;
  constructor(requestedFps: number, now: number) {
    this.effectiveFps = requestedFps;
    this.started = now;
  }

  public setEffectiveFps(fps: number): void {
    if (Number.isFinite(fps) && fps >= 15 && fps <= 120) this.effectiveFps = fps;
  }

  public complete(processingMs: number): void {
    if (!Number.isFinite(processingMs) || processingMs < 0) return;
    this.completed++;
    this.processingMs += processingMs;
  }

  public receive(realImage: boolean, replacedImage: boolean, now: number): number | undefined {
    if (!realImage) return undefined;
    this.received++;
    if (replacedImage) this.replaced++;
    if (now - this.started < 2000) return undefined;
    const pressure = this.received >= 15
      ? Math.min(200, Math.round(Math.max(
        this.replaced / this.received * 400,
        this.completed ? this.processingMs / this.completed * this.effectiveFps / 10 : 0,
      ))) : undefined;
    this.started = now;
    this.received = this.replaced = this.completed = this.processingMs = 0;
    return pressure;
  }
}
