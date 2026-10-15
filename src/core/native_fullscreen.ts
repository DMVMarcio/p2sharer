export interface WindowPlacement { x: number; y: number; width: number; height: number; maximized: boolean }
export interface FullscreenWindow {
  isFullscreen(): Promise<boolean>;
  setFullscreen(value: boolean): Promise<void>;
  capturePlacement?(): Promise<WindowPlacement>;
  restorePlacement?(placement: WindowPlacement): Promise<void>;
}

/** Restore the native state we inherited, including disposal during an IPC request. */
export class NativeFullscreenSession {
  active = false;
  private native: FullscreenWindow | null;
  private previous = false;
  private placement: WindowPlacement | undefined;
  private operations: Promise<unknown> = Promise.resolve();
  private disposed = false;
  constructor(native: FullscreenWindow | null) { this.native = native; }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operations.then(operation);
    this.operations = next.catch(() => {});
    return next;
  }
  enter(): Promise<boolean> {
    return this.enqueue(async () => {
      if (this.disposed) return false;
      if (this.active) return true;
      this.previous = await this.native?.isFullscreen() ?? false;
      this.placement = this.previous ? undefined : await this.native?.capturePlacement?.();
      if (this.disposed) return false;
      await this.native?.setFullscreen(true);
      if (this.disposed) { await this.restore(); return false; }
      this.active = true; return true;
    });
  }
  exit(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.active) return;
      await this.restore(); this.active = false;
    });
  }
  private async restore(): Promise<void> {
    await this.native?.setFullscreen(this.previous);
    if (this.placement) await this.native?.restorePlacement?.(this.placement);
  }
  dispose(): void { this.disposed = true; void this.exit().catch(() => {}); }
}
