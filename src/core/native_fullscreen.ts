export interface FullscreenWindow { isFullscreen(): Promise<boolean>; setFullscreen(value: boolean): Promise<void> }

/** Restore the native state we inherited, including disposal during an IPC request. */
export class NativeFullscreenSession {
  active = false;
  private native: FullscreenWindow | null;
  private previous = false;
  private pending = false;
  private disposed = false;
  constructor(native: FullscreenWindow | null) { this.native = native; }
  async enter(): Promise<boolean> {
    if (this.disposed || this.pending || this.active) return this.active;
    this.pending = true;
    try {
      this.previous = await this.native?.isFullscreen() ?? false;
      if (this.disposed) return false;
      await this.native?.setFullscreen(true);
      if (this.disposed) { await this.native?.setFullscreen(this.previous); return false; }
      this.active = true; return true;
    } finally { this.pending = false; }
  }
  async exit(): Promise<void> {
    if (!this.active || this.pending) return;
    this.pending = true;
    try { await this.native?.setFullscreen(this.previous); this.active = false; }
    finally { this.pending = false; }
  }
  dispose(): void { this.disposed = true; void this.exit().catch(() => {}); }
}
