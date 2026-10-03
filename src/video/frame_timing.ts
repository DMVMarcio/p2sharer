/** Keep frame timestamps monotonic without advancing them by artificial frame periods. */
export class VideoFrameClock {
  private lastTimestampUs = 0;

  public reset(): void { this.lastTimestampUs = 0; }

  public next(nowMs: number, effectiveFps: number): VideoFrameInit {
    const timestamp = Math.max(Math.round(nowMs * 1000), this.lastTimestampUs + 1);
    this.lastTimestampUs = timestamp;
    return { timestamp, duration: Math.round(1_000_000 / effectiveFps) };
  }
}
