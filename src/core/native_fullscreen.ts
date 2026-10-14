export interface FullscreenWindow { isFullscreen(): Promise<boolean>; setFullscreen(value: boolean): Promise<void> }

/** Restore the native state we inherited, including disposal during an IPC request. */
export class NativeFullscreenSession {
  active = false;
  private native: FullscreenWindow | null;
  private previous = false;
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
      if (this.disposed) return false;
      await this.native?.setFullscreen(true);
      if (this.disposed) { await this.native?.setFullscreen(this.previous); return false; }
      this.active = true; return true;
    });
  }
  exit(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.active) return;
      await this.native?.setFullscreen(this.previous); this.active = false;
    });
  }
  dispose(): void { this.disposed = true; void this.exit().catch(() => {}); }
}
